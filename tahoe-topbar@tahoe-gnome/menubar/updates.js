// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Insignia «N actualizaciones» del menú de Apple (App Store…).
//
// Consulta `flatpak remote-ls --updates --columns=application` de forma
// totalmente asíncrona, sólo cuando el menú se abre, y cachea el resultado
// 30 minutos. Si flatpak no está disponible o falla, no se muestra nada.

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const CACHE_US = 30 * 60 * 1000 * 1000;
const COMMAND = ['flatpak', 'remote-ls', '--updates', '--columns=application'];

const cache = {
    count: null,
    timestamp: 0,
    pending: null,
};

function nowUs() {
    return GLib.get_monotonic_time();
}

function fetchUpdateCount() {
    return new Promise(resolve => {
        let subprocess;
        let timeoutId = 0;

        try {
            subprocess = Gio.Subprocess.new(
                COMMAND,
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            resolve(null);
            return;
        }

        const finish = count => {
            if (timeoutId) {
                try {
                    GLib.source_remove(timeoutId);
                } catch {
                    // Ya ejecutado.
                }
                timeoutId = 0;
            }
            resolve(count);
        };

        // Un `flatpak` colgado no debe dejar la consulta pendiente para
        // siempre; se mata a los 8 segundos.
        timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
            timeoutId = 0;
            try {
                subprocess.force_exit();
            } catch {
                // El proceso ya terminó.
            }
            resolve(null);
            return GLib.SOURCE_REMOVE;
        });

        subprocess.communicate_utf8_async(null, null, (process, result) => {
            try {
                const [, stdout] = process.communicate_utf8_finish(result);
                if (!process.get_successful()) {
                    finish(null);
                    return;
                }

                const count = `${stdout ?? ''}`
                    .split('\n')
                    .filter(line => line.trim().length > 0)
                    .length;

                finish(count);
            } catch {
                finish(null);
            }
        });
    });
}

/**
 * Devuelve el número de actualizaciones pendientes (o null si no se pudo
 * consultar). El resultado se cachea 30 minutos y las llamadas simultáneas
 * comparten la misma petición.
 */
export function getUpdateCount() {
    const elapsed = nowUs() - cache.timestamp;
    if (cache.timestamp && elapsed < CACHE_US)
        return Promise.resolve(cache.count);

    if (cache.pending)
        return cache.pending;

    cache.pending = fetchUpdateCount().then(count => {
        cache.count = count;
        cache.timestamp = nowUs();
        cache.pending = null;
        return count;
    });

    return cache.pending;
}

function setBadge(badge, count) {
    if (count === null || count === undefined || count <= 0) {
        badge.visible = false;
        badge.text = '';
        return;
    }

    badge.text = count === 1 ? '1 actualización' : `${count} actualizaciones`;
    badge.visible = true;
}

/**
 * Añade a un PopupMenuItem una insignia que se actualiza al abrir el menú.
 *
 * @param {PopupMenu.PopupMenuBase} menu menú al que pertenece el ítem
 * @param {PopupMenu.PopupBaseMenuItem} item ítem que recibe la insignia
 */
export function attachUpdatesBadge(menu, item) {
    if (!menu || !item)
        return null;

    const badge = new St.Label({
        text: '',
        style_class: 'tahoe-menu-badge',
        visible: false,
        y_align: Clutter.ActorAlign.CENTER,
    });

    item.add_child(badge);

    let destroyed = false;
    let openId = 0;
    let refreshId = 0;

    const refresh = () => {
        if (destroyed)
            return;

        setBadge(badge, cache.timestamp &&
            nowUs() - cache.timestamp < CACHE_US ? cache.count : null);

        getUpdateCount().then(count => {
            if (!destroyed && count !== null)
                setBadge(badge, count);
        });
    };

    try {
        openId = menu.connect('open-state-changed', (_menu, open) => {
            if (!open || destroyed)
                return;

            // La consulta real se hace en un idle para no retrasar la
            // animación de apertura del menú.
            refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                refreshId = 0;
                refresh();
                return GLib.SOURCE_REMOVE;
            });
        });
    } catch {
        openId = 0;
    }

    item.connect('destroy', () => {
        destroyed = true;

        if (refreshId) {
            try {
                GLib.source_remove(refreshId);
            } catch {
                // Ya ejecutado.
            }
            refreshId = 0;
        }

        if (openId) {
            try {
                menu.disconnect(openId);
            } catch {
                // El menú ya no existe.
            }
            openId = 0;
        }
    });

    return badge;
}
