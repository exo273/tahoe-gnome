// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Búsqueda del Launchpad flotante.
//
// Combina dos fuentes:
//
//   * aplicaciones instaladas (Shell.AppSystem), tolerante a acentos;
//   * proveedores de búsqueda remotos de GNOME Shell (Calculator, Settings,
//     Nautilus, …), consultados en paralelo por D-Bus.
//
// La clase no crea actores ni toca la UI: entrega datos y factories de iconos
// para que la vista decida cómo dibujarlos. Las peticiones antiguas se
// cancelan y nunca pueden publicar resultados después de una búsqueda nueva.

'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {loadRemoteSearchProviders} from 'resource:///org/gnome/shell/ui/remoteSearch.js';

const LOG = '[tahoe-launchpad/search]';
const SEARCH_PROVIDERS_SCHEMA = 'org.gnome.desktop.search-providers';
const SEARCH_PROVIDER_KEYS = new Set([
    'disable-external',
    'disabled',
    'enabled',
    'sort-order',
]);

const DEBOUNCE_MS = 130;
const PROVIDER_LIMIT = 5;
const OTHERS_LIMIT = 15;
const APPS_LIMIT = 15;
// Un proveedor que no responde no puede bloquear la búsqueda entera: GNOME
// Shell consulta cada proveedor por separado y permite cancelar el suyo.
const PROVIDER_TIMEOUT_MS = 1200;

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_PROVIDER_NAME_LENGTH = 128;

// Los proveedores son datos externos: acotamos cuántos ids/metas procesamos
// aunque un servicio devuelva una lista desproporcionada.
const RAW_RESULTS_LIMIT = 64;
const RAW_METAS_LIMIT = 64;

const ICON_MIN_SIZE = 8;
const ICON_MAX_SIZE = 128;
const DEFAULT_ICON_SIZE = 36;

function emptyResults() {
    return {apps: [], others: []};
}

function clampIconSize(size) {
    const value = Number(size);
    if (!Number.isFinite(value))
        return DEFAULT_ICON_SIZE;
    return Math.max(ICON_MIN_SIZE, Math.min(ICON_MAX_SIZE, Math.round(value)));
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string')
        return '';

    let text = value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (text.length > maxLength)
        text = text.slice(0, maxLength).trimEnd();

    return text;
}

function cleanId(value) {
    if (typeof value !== 'string')
        return '';

    let id = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (id.length > MAX_ID_LENGTH)
        id = id.slice(0, MAX_ID_LENGTH);

    return id;
}

function normalizeForMatch(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isCancelled(error) {
    try {
        return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
    } catch (_e) {
        return false;
    }
}

function providerDisplayName(provider) {
    let name = '';
    try {
        name = provider?.appInfo?.get_name?.() ?? '';
    } catch (_e) {
        name = '';
    }

    if (!name)
        name = provider?.id ?? '';

    return cleanText(name, MAX_PROVIDER_NAME_LENGTH);
}

function providerId(provider) {
    return cleanId(provider?.id ?? '');
}

function uniqueCleanIds(values, limit) {
    const result = [];
    const seen = new Set();

    if (!Array.isArray(values))
        return result;

    for (const value of values) {
        const id = cleanId(value);
        if (!id || seen.has(id))
            continue;

        seen.add(id);
        result.push(id);

        if (result.length >= limit)
            break;
    }

    return result;
}

export class LaunchpadSearch {
    constructor() {
        this._destroyed = false;
        this._generation = 0;
        this._request = null;

        this._appSystem = null;
        this._appSearch = null;
        try {
            this._appSystem = Shell.AppSystem.get_default();

            // GNOME Shell 50 expone search() como método estático de
            // Shell.AppSystem; en versiones anteriores era de instancia.
            if (typeof this._appSystem?.search === 'function')
                this._appSearch = query => this._appSystem.search(query);
            else if (typeof Shell.AppSystem.search === 'function')
                this._appSearch = query => Shell.AppSystem.search(query);
        } catch (e) {
            console.error(`${LOG} No se pudo obtener AppSystem:`, e);
        }

        this._settings = null;
        try {
            this._settings = new Gio.Settings({schema_id: SEARCH_PROVIDERS_SCHEMA});
        } catch (e) {
            console.error(`${LOG} No se pudo abrir ${SEARCH_PROVIDERS_SCHEMA}:`, e);
        }

        this._providers = [];
        this._reloadProviders();

        this._settingsChangedId = 0;
        if (this._settings) {
            this._settingsChangedId = this._settings.connect('changed',
                (_settings, key) => {
                    if (SEARCH_PROVIDER_KEYS.has(key))
                        this._reloadProviders();
                });
        }

        // Instalar/desinstalar una app también puede añadir o retirar su
        // fichero .ini de proveedor de búsqueda.
        this._installedChangedId = 0;
        if (this._appSystem) {
            try {
                this._installedChangedId = this._appSystem.connect(
                    'installed-changed', () => this._reloadProviders());
            } catch (e) {
                console.error(`${LOG} No se pudo vigilar installed-changed:`, e);
            }
        }
    }

    /**
     * Busca aplicaciones y resultados de proveedores externos.
     *
     * Una llamada nueva cancela la anterior. La promesa de la llamada
     * cancelada se resuelve con listas vacías, de modo que una petición
     * antigua jamás pueda repintar resultados obsoletos.
     *
     * @param {string} text texto de búsqueda
     * @returns {Promise<{apps: Array<object>, others: Array<object>}>}
     */
    async search(text) {
        const raw = Array.isArray(text) ? text.join(' ') : String(text ?? '');
        const query = raw.trim();
        const generation = ++this._generation;

        this._cancelRequest();

        if (this._destroyed || !query)
            return emptyResults();

        return new Promise(resolve => {
            const request = {
                generation,
                query,
                resolve,
                settled: false,
                cancellable: null,
                timerId: 0,
            };
            this._request = request;

            request.timerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                DEBOUNCE_MS,
                () => {
                    request.timerId = 0;
                    this._runRequest(request).catch(e => {
                        if (!isCancelled(e))
                            console.error(`${LOG} Error inesperado en la búsqueda:`, e);
                        this._finishRequest(request, [], []);
                    });
                    return GLib.SOURCE_REMOVE;
                });
        });
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this._generation++;
        this._cancelRequest();

        if (this._settings && this._settingsChangedId) {
            try {
                this._settings.disconnect(this._settingsChangedId);
            } catch (_e) {
                // La señal ya no existe.
            }
        }
        this._settingsChangedId = 0;

        if (this._appSystem && this._installedChangedId) {
            try {
                this._appSystem.disconnect(this._installedChangedId);
            } catch (_e) {
                // La señal ya no existe.
            }
        }
        this._installedChangedId = 0;

        this._providers = [];
        this._settings = null;
        this._appSystem = null;
        this._appSearch = null;
    }

    _reloadProviders() {
        if (this._destroyed)
            return;

        if (!this._settings) {
            this._providers = [];
            return;
        }

        try {
            // loadRemoteSearchProviders() ya respeta disable-external, la
            // lista disabled/enabled y el orden configurado por el usuario.
            this._providers = loadRemoteSearchProviders(this._settings) ?? [];
        } catch (e) {
            this._providers = [];
            console.error(`${LOG} No se pudieron cargar los proveedores:`, e);
        }
    }

    _cancelRequest() {
        const request = this._request;
        if (!request)
            return;

        this._request = null;
        request.settled = true;

        if (request.timerId) {
            try {
                GLib.source_remove(request.timerId);
            } catch (_e) {
                // El timeout ya se ejecutó o la fuente ya no existe.
            }
            request.timerId = 0;
        }

        if (request.cancellable)
            request.cancellable.cancel();

        request.resolve(emptyResults());
    }

    async _runRequest(request) {
        if (request.settled || this._destroyed)
            return;

        const cancellable = new Gio.Cancellable();
        request.cancellable = cancellable;

        let apps = [];
        try {
            apps = this._searchApps(request.query);
        } catch (e) {
            console.error(`${LOG} Error buscando aplicaciones:`, e);
        }

        let others = [];
        try {
            others = await this._searchRemote(request.query, cancellable);
        } catch (e) {
            if (!isCancelled(e))
                console.error(`${LOG} Error buscando en proveedores:`, e);
        }

        this._finishRequest(request, apps, others);
    }

    _finishRequest(request, apps, others) {
        if (request.settled)
            return;

        request.settled = true;
        if (this._request === request)
            this._request = null;

        const stale = this._destroyed ||
            request.generation !== this._generation ||
            request.cancellable?.is_cancelled?.() === true;

        request.resolve(stale ? emptyResults() : {apps, others});
    }

    _searchApps(query) {
        if (!this._appSystem)
            return [];

        const results = [];
        const seen = new Set();
        // El mismo id puede aparecer desde AppSystem.search() y desde
        // get_installed(); si una de las dos vistas carece de AppInfo, no
        // debe colarse un panel oculto en la segunda pasada.
        const ignored = new Set();

        const addApp = app => {
            if (!app || results.length >= APPS_LIMIT)
                return;

            let id = '';
            try {
                id = cleanId(app.get_id());
            } catch (_e) {
                return;
            }

            if (!id || seen.has(id) || ignored.has(id))
                return;

            let appInfo = null;
            try {
                appInfo = app.get_app_info();
            } catch (_e) {
                appInfo = null;
            }

            // El Launchpad muestra aplicaciones, no paneles internos de
            // Configuración ni ayudantes ocultos.
            try {
                if (typeof appInfo?.should_show === 'function' && !appInfo.should_show()) {
                    ignored.add(id);
                    return;
                }
            } catch (_e) {
                // Sin metadatos fiables, se deja pasar la app.
            }

            let name = '';
            try {
                name = app.get_name();
            } catch (_e) {
                name = '';
            }
            if (!name)
                name = appInfo?.get_display_name?.() ?? appInfo?.get_name?.() ?? id;

            name = cleanText(name, MAX_NAME_LENGTH);
            if (!name)
                return;

            seen.add(id);
            results.push(this._createAppResult(app, appInfo, id, name));
        };

        // La búsqueda nativa de Shell conserva la relevancia y agrupa los
        // resultados por tipo de coincidencia.
        try {
            const groups = this._appSearch ? (this._appSearch(query) ?? []) : [];
            for (const group of groups) {
                if (Array.isArray(group)) {
                    for (const iconOrId of group) {
                        if (typeof iconOrId !== 'string')
                            continue;
                        const app = this._appSystem.lookup_app(iconOrId);
                        if (app)
                            addApp(app);
                        if (results.length >= APPS_LIMIT)
                            break;
                    }
                } else if (typeof group === 'string') {
                    const app = this._appSystem.lookup_app(group);
                    if (app)
                        addApp(app);
                }

                if (results.length >= APPS_LIMIT)
                    break;
            }
        } catch (e) {
            console.error(`${LOG} Error en AppSystem.search:`, e);
        }

        if (results.length >= APPS_LIMIT)
            return results;

        // Complemento tolerante a acentos: Shell no normaliza «cámara» a
        // «camara» en todos los casos. Sólo añadimos coincidencias que no
        // hayan aparecido ya, ordenadas por calidad de coincidencia.
        const normalizedQuery = normalizeForMatch(query);
        if (!normalizedQuery)
            return results;

        const extras = [];
        try {
            for (const app of this._appSystem.get_installed() ?? []) {
                let id = '';
                try {
                    id = cleanId(app.get_id());
                } catch (_e) {
                    continue;
                }
                if (!id || seen.has(id) || ignored.has(id))
                    continue;

                const rank = this._appMatchRank(app, normalizedQuery);
                if (rank >= 0)
                    extras.push({app, id, rank});
            }
        } catch (e) {
            console.error(`${LOG} Error enumerando aplicaciones:`, e);
        }

        extras.sort((a, b) => {
            if (a.rank !== b.rank)
                return a.rank - b.rank;

            let nameA = '';
            let nameB = '';
            try {
                nameA = a.app.get_name();
                nameB = b.app.get_name();
            } catch (_e) {
                // Se comparan por id como último recurso.
            }
            return GLib.utf8_collate(nameA || a.id, nameB || b.id);
        });

        for (const {app} of extras) {
            addApp(app);
            if (results.length >= APPS_LIMIT)
                break;
        }

        return results;
    }

    _appMatchRank(app, normalizedQuery) {
        let appInfo = null;
        try {
            appInfo = app.get_app_info();
        } catch (_e) {
            appInfo = null;
        }

        const names = [];
        try {
            names.push(app.get_name());
        } catch (_e) {
            // Sin nombre nativo.
        }
        try {
            names.push(appInfo?.get_display_name?.());
            names.push(appInfo?.get_name?.());
            names.push(appInfo?.get_generic_name?.());
        } catch (_e) {
            // Algunos AppInfo no implementan todos los campos.
        }

        for (const name of names) {
            const rank = this._textMatchRank(name, normalizedQuery);
            if (rank >= 0)
                return rank;
        }

        let keywords = [];
        try {
            keywords = appInfo?.get_keywords?.() ?? [];
        } catch (_e) {
            keywords = [];
        }
        for (const keyword of keywords) {
            const rank = this._textMatchRank(keyword, normalizedQuery);
            if (rank >= 0)
                return rank + 2;
        }

        // Id y ejecutable al final: permiten «org.gnome.Nautilus» o
        // «nautilus», pero no compiten con el nombre visible.
        const haystacks = [];
        try {
            haystacks.push(app.get_id());
        } catch (_e) {
            // Sin id.
        }
        try {
            haystacks.push(appInfo?.get_commandline?.());
            haystacks.push(appInfo?.get_executable?.());
        } catch (_e) {
            // Sin ejecutable.
        }
        for (const value of haystacks) {
            if (normalizeForMatch(value).includes(normalizedQuery))
                return 8;
        }

        return -1;
    }

    _textMatchRank(value, normalizedQuery) {
        const text = normalizeForMatch(value);
        if (!text)
            return -1;

        if (text === normalizedQuery)
            return 0;
        if (text.startsWith(normalizedQuery))
            return 1;

        const index = text.indexOf(normalizedQuery);
        if (index < 0)
            return -1;

        const before = text[index - 1];
        if (index === 0 || before === ' ' || before === '-' || before === '_')
            return 2;

        return 3;
    }

    _createAppResult(app, appInfo, id, name) {
        return {
            id,
            name,
            icon: this._appIcon(app, appInfo),
            createIcon: size => {
                const iconSize = clampIconSize(size);
                const gicon = this._appIcon(app, appInfo);
                if (gicon) {
                    try {
                        return new St.Icon({gicon, icon_size: iconSize});
                    } catch (_e) {
                        // create_icon_texture() es el siguiente recurso.
                    }
                }

                try {
                    const actor = app.create_icon_texture?.(iconSize) ?? null;
                    if (actor instanceof St.Icon)
                        return actor;
                    actor?.destroy?.();
                } catch (_e) {
                    // La app no tiene icono utilizable.
                }

                return null;
            },
            activate: () => {
                if (this._destroyed)
                    return;
                try {
                    app.activate();
                } catch (e) {
                    try {
                        app.open_new_window(-1);
                    } catch (e2) {
                        console.error(`${LOG} No se pudo activar ${name}:`, e, e2);
                    }
                }
            },
        };
    }

    _appIcon(app, appInfo) {
        try {
            const icon = appInfo?.get_icon?.() ?? null;
            if (icon)
                return icon;
        } catch (_e) {
            // Probar la API de Shell.App.
        }

        try {
            const icon = app.get_icon?.() ?? null;
            if (icon)
                return icon;
        } catch (_e) {
            // Sin GIcon; la UI usará createIcon().
        }

        return null;
    }

    async _searchRemote(query, cancellable) {
        const providers = this._providers;
        if (!providers.length || cancellable.is_cancelled())
            return [];

        const terms = query.split(/\s+/).filter(Boolean);
        if (!terms.length)
            return [];

        const tasks = providers.map(provider =>
            this._searchProvider(provider, terms, cancellable)
                .catch(error => {
                    if (!isCancelled(error))
                        console.error(`${LOG} Proveedor ${providerId(provider)}:`, error);
                    return [];
                }));

        // Promise.allSettled evita que un proveedor caído (o un D-Bus que no
        // responde) impida devolver los resultados de los demás.
        const outcomes = await Promise.allSettled(tasks);
        const others = [];

        for (const outcome of outcomes) {
            if (others.length >= OTHERS_LIMIT)
                break;
            if (outcome.status !== 'fulfilled' || !Array.isArray(outcome.value))
                continue;

            for (const item of outcome.value) {
                others.push(item);
                if (others.length >= OTHERS_LIMIT)
                    break;
            }
        }

        return others;
    }

    async _searchProvider(provider, terms, cancellable) {
        if (cancellable.is_cancelled())
            return [];

        // Cada proveedor recibe su propio Cancellable, enlazado al de la
        // búsqueda. Así un timeout (o una búsqueda nueva) detiene también
        // la llamada D-Bus concreta que se haya quedado colgada.
        const providerCancellable = new Gio.Cancellable();
        let linkId = 0;
        try {
            linkId = cancellable.connect(() => {
                try {
                    providerCancellable.cancel();
                } catch (_e) {
                    // Ya estaba cancelado.
                }
            });
        } catch (_e) {
            linkId = 0;
        }

        let timerId = 0;
        const timeout = new Promise(resolve => {
            timerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                PROVIDER_TIMEOUT_MS,
                () => {
                    timerId = 0;
                    try {
                        providerCancellable.cancel();
                    } catch (_e) {
                        // Ya estaba cancelado.
                    }
                    resolve([]);
                    return GLib.SOURCE_REMOVE;
                });
        });

        try {
            const result = await Promise.race([
                this._queryProvider(provider, terms, providerCancellable),
                timeout,
            ]);
            return Array.isArray(result) ? result : [];
        } finally {
            if (timerId) {
                try {
                    GLib.source_remove(timerId);
                } catch (_e) {
                    // El timeout ya se ejecutó.
                }
                timerId = 0;
            }

            try {
                providerCancellable.cancel();
            } catch (_e) {
                // Ya estaba cancelado.
            }

            if (linkId) {
                try {
                    cancellable.disconnect(linkId);
                } catch (_e) {
                    // La señal ya no existe.
                }
            }
        }
    }

    async _queryProvider(provider, terms, cancellable) {
        if (cancellable.is_cancelled())
            return [];

        let rawIds = [];
        try {
            rawIds = await provider.getInitialResultSet(terms, cancellable);
        } catch (e) {
            if (!isCancelled(e))
                throw e;
            return [];
        }

        if (cancellable.is_cancelled())
            return [];

        let selected = uniqueCleanIds(rawIds, RAW_RESULTS_LIMIT);

        try {
            const filtered = provider.filterResults(selected, PROVIDER_LIMIT);
            if (Array.isArray(filtered))
                selected = uniqueCleanIds(filtered, PROVIDER_LIMIT);
            else
                selected = selected.slice(0, PROVIDER_LIMIT);
        } catch (_e) {
            selected = selected.slice(0, PROVIDER_LIMIT);
        }

        // Algunos proveedores devuelven más de `maxNumber` (por ejemplo,
        // resultados «special:»); el contrato del Launchpad es 5 por fuente.
        selected = selected.slice(0, PROVIDER_LIMIT);
        if (!selected.length)
            return [];

        let metas = [];
        try {
            metas = await provider.getResultMetas(selected, cancellable);
        } catch (e) {
            if (!isCancelled(e))
                throw e;
            return [];
        }

        if (cancellable.is_cancelled() || !Array.isArray(metas))
            return [];

        const selectedSet = new Set(selected);
        const metasById = new Map();
        for (const meta of metas.slice(0, RAW_METAS_LIMIT)) {
            if (!meta || typeof meta !== 'object')
                continue;

            // El meta viene por D-Bus y no es de confianza: nunca se expone
            // el objeto completo ni se acepta un actor ajeno. Sólo se toman
            // id/nombre/descripción como texto y la factory del proveedor.
            const id = cleanId(meta.id);
            if (!id || !selectedSet.has(id) || metasById.has(id))
                continue;

            metasById.set(id, meta);
        }

        if (!metasById.size)
            return [];

        const label = providerDisplayName(provider);
        const sourceId = providerId(provider);
        const items = [];

        for (const id of selected) {
            const meta = metasById.get(id);
            if (!meta)
                continue;

            const name = cleanText(meta.name, MAX_NAME_LENGTH);
            if (!name)
                continue;

            const description = cleanText(meta.description, MAX_DESCRIPTION_LENGTH);

            items.push({
                id,
                name,
                description,
                icon: null,
                provider: label || sourceId,
                createIcon: size => this._createProviderIcon(meta, size),
                activate: () => {
                    if (this._destroyed)
                        return;
                    try {
                        provider.activateResult(id, terms);
                    } catch (e) {
                        console.error(`${LOG} No se pudo activar ${id} en ${sourceId}:`, e);
                    }
                },
            });

            if (items.length >= PROVIDER_LIMIT)
                break;
        }

        return items;
    }

    _createProviderIcon(meta, size) {
        const iconSize = clampIconSize(size);

        try {
            if (typeof meta.createIcon !== 'function')
                return null;

            const actor = meta.createIcon(iconSize);
            if (actor instanceof St.Icon)
                return actor;

            // Una implementación hostil de meta no puede colar un actor
            // arbitrario en la escena: se descarta.
            actor?.destroy?.();
        } catch (_e) {
            // Icono inválido o datos corruptos del proveedor.
        }

        return null;
    }
}
