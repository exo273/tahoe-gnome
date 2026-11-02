// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Launchpad flotante al estilo macOS Tahoe.
//
// Contrato con extension.js:
//   const launchpad = new TahoeLaunchpad(this);
//   launchpad.open(); launchpad.close(); launchpad.toggle();
//   launchpad.destroy();
//
// El panel vive en una capa de chrome superior que cubre el monitor, pero no
// usa un grab global: las pulsaciones se siguen por captured-event del stage
// y cualquier clic fuera de la hoja la cierra. El buscador consulta
// launchpad/search.js de forma perezosa; si el módulo todavía no existe (o su
// API no está disponible) la rejilla y un filtro local siguen funcionando.

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {glassLook} from '../liquidGlass.js';

const LOG = '[tahoe-launchpad]';

const PANE_WIDTH = 640;
const PANE_TOP = 55;
const PANE_MARGIN = 20;
const GLASS_RADIUS = 22;
const OPEN_DURATION = 180;
const CLOSE_DURATION = 150;
const SEARCH_DELAY = 140;

const GRID_COLUMNS = 8;
const GRID_ROWS = 4;
const CELL_WIDTH = 66;
const CELL_HEIGHT = 86;
const APP_ICON_SIZE = 48;
const RESULT_ICON_SIZE = 34;

const CATEGORIES = [
    {
        id: 'all',
        label: 'Todas',
        tokens: [],
    },
    {
        id: 'productivity',
        label: 'Productividad',
        tokens: [
            'office', 'wordprocessor', 'spreadsheet', 'presentation',
            'database', 'projectmanagement', 'calendar',
            'contactmanagement', 'finance', 'accounting', 'flowchart',
            'ide', 'development', 'debugger',
        ],
    },
    {
        id: 'utilities',
        label: 'Utilidades',
        tokens: [
            'utility', 'utilities', 'system', 'settings', 'filemanager',
            'filetools', 'filesystem', 'terminalemulator', 'archiving',
            'compression', 'calculator', 'packagemanager', 'security',
            'accessibility', 'disk', 'monitor', 'benchmark', 'clock',
            'texteditor', 'x-gnome-settings-panel', 'x-gnome-utilities',
        ],
    },
    {
        id: 'creativity',
        label: 'Creatividad',
        tokens: [
            'graphics', 'photography', '2dgraphics', '3dgraphics',
            'vectorgraphics', 'rastergraphics', 'publishing',
            'audiovideoediting', 'art', 'design',
        ],
    },
    {
        id: 'social',
        label: 'Social',
        tokens: [
            'network', 'chat', 'instantmessaging', 'email', 'telephony',
            'videoconference', 'ircclient', 'feed', 'social',
        ],
    },
    {
        id: 'entertainment',
        label: 'Entretenimiento',
        tokens: [
            'game', 'emulator', 'audiovideo', 'player', 'video', 'music',
            'tv', 'media',
        ],
    },
    {
        id: 'information',
        label: 'Información',
        tokens: [
            'webbrowser', 'news', 'documentation', 'education', 'science',
            'math', 'reference', 'weather', 'dictionary', 'help',
        ],
    },
    {
        id: 'others',
        label: 'Otros',
        tokens: [],
    },
];

// El orden de la barra de categorías es el de CATEGORIES; para clasificar una
// app se prueba antes Información que Social, de modo que un navegador con
// «Network;WebBrowser» no acabe en Social.
const CLASSIFY_ORDER = [
    'productivity',
    'information',
    'creativity',
    'social',
    'entertainment',
    'utilities',
];

const CATEGORY_BY_ID = new Map(CATEGORIES.map(category => [category.id, category]));

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function categoryTokens(appInfo) {
    let raw = '';
    try {
        raw = appInfo?.get_categories?.() ?? '';
    } catch (_e) {
        raw = '';
    }

    const tokens = new Set();
    for (const token of String(raw).split(/[;,]/)) {
        const value = token.trim().toLowerCase();
        if (value)
            tokens.add(value);
    }
    return tokens;
}

function inferCategory(appInfo) {
    const tokens = categoryTokens(appInfo);
    if (tokens.size === 0)
        return 'others';

    const matches = token => {
        for (const candidate of tokens) {
            if (candidate === token || candidate.endsWith(token) ||
                candidate.startsWith(token))
                return true;
        }
        return false;
    };

    for (const id of CLASSIFY_ORDER) {
        const category = CATEGORY_BY_ID.get(id);
        if (category?.tokens.some(matches))
            return id;
    }
    return 'others';
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function eventActor(event) {
    try {
        return global.stage.get_event_actor(event);
    } catch (_e) {
        try {
            return event.get_source() ?? null;
        } catch (_fallbackError) {
            return null;
        }
    }
}

export class TahoeLaunchpad {
    constructor(extension) {
        this._extension = extension ?? null;
        this._destroyed = false;
        this._isOpen = false;
        this._closing = false;

        this._settings = null;
        try {
            this._settings = extension?.getSettings?.() ?? null;
        } catch (e) {
            console.error(`${LOG} No se pudieron leer los ajustes:`, e);
        }

        this._settingsId = 0;
        this._theme = extension?._theme ?? null;
        this._themeId = 0;
        this._scaleId = 0;
        this._appSystemId = 0;
        this._monitorsId = 0;
        this._overviewId = 0;
        this._stageCaptureId = 0;

        this._themeContext = null;
        this._cssFile = null;
        this._chromeAdded = false;

        this._glassEngine = extension?._glassEngine ?? null;
        this._glassUnsubscribe = null;
        this._glassHandle = null;

        this._appSystem = Shell.AppSystem.get_default();
        this._apps = [];
        this._appsDirty = true;

        this._category = 'all';
        this._searchText = '';
        this._searchTimerId = 0;
        this._searchGeneration = 0;
        this._search = null;
        this._searchLoad = null;
        this._searchUnavailable = false;
        this._lastSearchResult = null;
        this._suppressText = false;

        this._overlay = null;
        this._pane = null;
        this._searchBar = null;
        this._entry = null;
        this._clearButton = null;
        this._chipButtons = new Map();
        this._scroll = null;
        this._content = null;
        this._footerInfo = null;
        this._footerHint = null;
        this._previousKeyFocus = null;

        this._items = [];
        this._selectedIndex = -1;
        this._gridContentHeight = 0;
        this._maxGridHeight = 0;

        this._loadStylesheet();
        this._connectSettings();
        this._connectTheme();
        this._connectGlass();
        this._connectSignals();
    }

    /* ------------------------------------------------------------------ */
    /* Ciclo de vida                                                       */
    /* ------------------------------------------------------------------ */

    get isOpen() {
        return this._isOpen;
    }

    open() {
        if (this._destroyed || !this._extension)
            return;

        if (this._isOpen) {
            this._raise();
            this._grabEntryFocus();
            return;
        }

        this._prepareEnvironment();
        this._ensureUI();
        this._ensureChrome();

        this._isOpen = true;
        this._closing = false;
        this._previousKeyFocus = this._currentKeyFocus();
        this._overlay.reactive = true;
        this._overlay.show();

        // Cada apertura empieza en la rejilla completa. Un cierre durante una
        // búsqueda pendiente invalida también su generación.
        this._searchGeneration++;
        this._cancelSearchTimer();
        this._searchText = '';
        this._lastSearchResult = null;
        this._category = 'all';
        this._searchUnavailable = false;
        this._setEntryText('');
        this._clearButton?.hide();
        this._updateChipState();

        if (this._appsDirty)
            this._collectApps();
        this._applyLayout();
        this._renderBrowse();

        this._connectStageCapture();
        this._raise();

        this._pane.remove_all_transitions();
        this._pane.set_pivot_point(0.5, 0.5);
        this._pane.opacity = 0;
        this._pane.set_scale(0.95, 0.95);
        this._syncGlass();
        this._grabEntryFocus();

        this._pane.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: OPEN_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (this._destroyed || !this._isOpen)
            return;

        this._isOpen = false;
        this._closing = true;
        this._disconnectStageCapture();
        this._cancelSearchTimer();
        this._searchGeneration++;
        this._overlay.reactive = false;

        const finish = () => {
            if (!this._closing || this._isOpen || this._destroyed)
                return;
            this._finishClose();
        };

        if (!this._pane) {
            finish();
            return;
        }

        this._pane.remove_all_transitions();
        this._pane.ease({
            opacity: 0,
            scale_x: 0.95,
            scale_y: 0.95,
            duration: CLOSE_DURATION,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: finish,
        });
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._isOpen = false;
        this._closing = false;

        this._cancelSearchTimer();
        this._searchGeneration++;
        this._disconnectStageCapture();
        this._disconnectSignals();
        this._disconnectTheme();
        this._disconnectSettings();

        if (this._glassUnsubscribe) {
            try {
                this._glassUnsubscribe();
            } catch (_e) {
                // Ya estaba cancelado.
            }
            this._glassUnsubscribe = null;
        }

        this._destroyGlass();
        this._destroySearch();

        if (this._overlay) {
            this._restoreKeyFocus();
            const overlay = this._overlay;
            this._overlay = null;
            this._pane = null;
            this._searchBar = null;
            this._entry = null;
            this._clearButton = null;
            this._chipButtons.clear();
            this._scroll = null;
            this._content = null;
            this._footerInfo = null;
            this._footerHint = null;
            this._items = [];

            try {
                if (this._chromeAdded)
                    Main.layoutManager.removeChrome(overlay);
                else
                    overlay.get_parent()?.remove_child(overlay);
            } catch (_e) {
                // El actor ya no estaba en el chrome.
            }
            this._chromeAdded = false;

            try {
                overlay.destroy();
            } catch (_e) {
                // El shell pudo destruirlo antes durante el apagado.
            }
        }

        this._unloadStylesheet();
        this._settings = null;
        this._theme = null;
        this._themeContext = null;
        this._appSystem = null;
        this._apps = [];
        this._extension = null;
    }

    /* ------------------------------------------------------------------ */
    /* Estilos y señales                                                   */
    /* ------------------------------------------------------------------ */

    _extensionPath() {
        try {
            return this._extension?.path ??
                this._extension?.dir?.get_path?.() ?? '';
        } catch (_e) {
            return '';
        }
    }

    _loadStylesheet() {
        try {
            const base = this._extensionPath();
            if (!base)
                throw new Error('La extensión no tiene ruta');

            const path = GLib.build_filenamev([base, 'launchpad', 'launchpad.css']);
            this._cssFile = Gio.File.new_for_path(path);
            this._themeContext = St.ThemeContext.get_for_stage(global.stage);
            this._themeContext.get_theme().load_stylesheet(this._cssFile);
        } catch (e) {
            console.error(`${LOG} No se pudo cargar launchpad.css:`, e);
            this._cssFile = null;
            this._themeContext = null;
        }
    }

    _unloadStylesheet() {
        if (!this._cssFile || !this._themeContext)
            return;

        try {
            this._themeContext.get_theme().unload_stylesheet(this._cssFile);
        } catch (e) {
            console.error(`${LOG} No se pudo descargar launchpad.css:`, e);
        }
        this._cssFile = null;
        this._themeContext = null;
    }

    _connectSettings() {
        if (!this._settings)
            return;

        try {
            this._settingsId = this._settings.connect(
                'changed::glass-style', () => this._syncGlass());
        } catch (e) {
            console.error(`${LOG} No se pudo seguir glass-style:`, e);
            this._settingsId = 0;
        }
    }

    _disconnectSettings() {
        if (!this._settings || !this._settingsId)
            return;
        try {
            this._settings.disconnect(this._settingsId);
        } catch (_e) {
            // Ya estaba desconectado.
        }
        this._settingsId = 0;
    }

    _connectTheme() {
        try {
            if (typeof this._theme?.connect === 'function')
                this._themeId = this._theme.connect(() => this._onThemeChanged());
        } catch (e) {
            console.error(`${LOG} No se pudo seguir el tema:`, e);
            this._themeId = 0;
        }

        try {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            this._scaleId = themeContext.connect('notify::scale-factor',
                () => this._onScaleChanged());
        } catch (_e) {
            this._scaleId = 0;
        }
    }

    _disconnectTheme() {
        if (this._theme && this._themeId) {
            try {
                this._theme.disconnect(this._themeId);
            } catch (_e) {
                // Ya estaba desconectado.
            }
        }
        this._themeId = 0;

        if (this._scaleId) {
            try {
                St.ThemeContext.get_for_stage(global.stage)
                    .disconnect(this._scaleId);
            } catch (_e) {
                // El context ya no existe.
            }
            this._scaleId = 0;
        }
    }

    _connectGlass() {
        this._glassEngine = this._extension?._glassEngine ?? null;

        if (typeof this._extension?.onGlassEngineChanged === 'function') {
            try {
                this._glassUnsubscribe = this._extension.onGlassEngineChanged(
                    engine => {
                        this._glassEngine = engine;
                        this._syncGlass();
                    });
            } catch (e) {
                console.error(`${LOG} No se pudo seguir el motor de cristal:`, e);
                this._glassUnsubscribe = null;
            }
        }
    }

    _connectSignals() {
        try {
            this._appSystemId = this._appSystem.connect('installed-changed', () => {
                this._appsDirty = true;
                if (this._isOpen && !this._searchText)
                    this._renderBrowse();
            });
        } catch (_e) {
            this._appSystemId = 0;
        }

        try {
            this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
                if (this._isOpen)
                    this._applyLayout();
            });
        } catch (_e) {
            this._monitorsId = 0;
        }

        try {
            this._overviewId = Main.overview.connect('showing', () => {
                if (this._isOpen)
                    this.close();
            });
        } catch (_e) {
            this._overviewId = 0;
        }
    }

    _disconnectSignals() {
        if (this._appSystem && this._appSystemId) {
            try {
                this._appSystem.disconnect(this._appSystemId);
            } catch (_e) {
                // Ya estaba desconectado.
            }
        }
        this._appSystemId = 0;

        if (this._monitorsId) {
            try {
                Main.layoutManager.disconnect(this._monitorsId);
            } catch (_e) {
                // Ya estaba desconectado.
            }
        }
        this._monitorsId = 0;

        if (this._overviewId) {
            try {
                Main.overview.disconnect(this._overviewId);
            } catch (_e) {
                // Ya estaba desconectado.
            }
        }
        this._overviewId = 0;
    }

    _onThemeChanged() {
        if (this._destroyed)
            return;
        this._theme = this._extension?._theme ?? this._theme;
        if (this._isOpen)
            this._syncGlass();
    }

    _onScaleChanged() {
        if (!this._isOpen || this._destroyed)
            return;
        this._applyLayout();

        if (this._searchText) {
            if (this._lastSearchResult)
                this._renderSearch(this._lastSearchResult, this._searchText);
            else
                this._renderSearchLoading(this._searchText);
        } else {
            this._renderBrowse();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Construcción de la interfaz                                         */
    /* ------------------------------------------------------------------ */

    _px(value) {
        let scale = 1;
        try {
            scale = St.ThemeContext.get_for_stage(global.stage)?.scale_factor || 1;
        } catch (_e) {
            scale = 1;
        }
        return Math.round(value * scale);
    }

    _clearChildren(actor) {
        if (!actor)
            return;
        const children = actor.get_children?.() ?? [];
        for (const child of children)
            child.destroy();
    }

    _ensureUI() {
        if (this._overlay)
            return;

        this._overlay = new St.Widget({
            name: 'tahoe-launchpad-overlay',
            style_class: 'tahoe-launchpad-overlay',
            reactive: true,
            can_focus: false,
            track_hover: false,
            clip_to_allocation: false,
        });
        this._overlay.connect('button-press-event', (_actor, event) => {
            if (!this._isOpen)
                return Clutter.EVENT_PROPAGATE;

            const source = eventActor(event);
            if (source && this._isInsidePane(source))
                return Clutter.EVENT_PROPAGATE;

            this.close();
            return Clutter.EVENT_STOP;
        });

        this._pane = new St.BoxLayout({
            name: 'tahoe-launchpad-pane',
            style_class: 'tahoe-launchpad-pane',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            can_focus: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            clip_to_allocation: false,
        });
        this._overlay.add_child(this._pane);

        this._buildSearchBar();
        this._buildChips();
        this._buildGrid();
        this._buildFooter();

        this._pane.connect('destroy', () => {
            this._pane = null;
            this._entry = null;
            this._content = null;
            this._scroll = null;
        });
    }

    _buildSearchBar() {
        this._searchBar = new St.BoxLayout({
            style_class: 'tahoe-launchpad-searchbar',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._entry = new St.Entry({
            style_class: 'tahoe-launchpad-entry',
            hint_text: 'Buscar aplicaciones',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({
                icon_name: 'edit-find-symbolic',
                icon_size: this._px(15),
                style_class: 'tahoe-launchpad-search-icon',
            }),
        });
        this._entry.clutter_text.connect('notify::text',
            () => this._onSearchTextChanged());
        this._searchBar.add_child(this._entry);

        this._clearButton = new St.Button({
            style_class: 'tahoe-launchpad-clear',
            can_focus: false,
            reactive: true,
            track_hover: true,
            visible: false,
            accessible_name: 'Borrar búsqueda',
            child: new St.Icon({
                icon_name: 'edit-clear-symbolic',
                icon_size: this._px(14),
            }),
        });
        this._clearButton.connect('clicked', () => this._clearSearch());
        this._searchBar.add_child(this._clearButton);

        this._pane.add_child(this._searchBar);
    }

    _buildChips() {
        const chips = new St.BoxLayout({
            style_class: 'tahoe-launchpad-chips',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });

        // Ocho categorías en dos filas: la etiqueta «Entretenimiento» no cabe
        // junto a las otras siete en el ancho de la hoja.
        for (let start = 0; start < CATEGORIES.length; start += 4) {
            const row = new St.BoxLayout({
                style_class: 'tahoe-launchpad-chip-row',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });

            for (const category of CATEGORIES.slice(start, start + 4)) {
                const button = new St.Button({
                    style_class: 'tahoe-launchpad-chip',
                    can_focus: false,
                    reactive: true,
                    track_hover: true,
                    label: category.label,
                    accessible_name: category.label,
                });
                button.connect('clicked', () => this._selectCategory(category.id));
                this._chipButtons.set(category.id, button);
                row.add_child(button);
            }
            chips.add_child(row);
        }

        this._pane.add_child(chips);
        this._updateChipState();
    }

    _buildGrid() {
        this._scroll = new St.ScrollView({
            style_class: 'tahoe-launchpad-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: false,
        });

        this._content = new St.BoxLayout({
            style_class: 'tahoe-launchpad-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: false,
        });
        this._scroll.set_child(this._content);
        this._pane.add_child(this._scroll);
    }

    _buildFooter() {
        const footer = new St.BoxLayout({
            style_class: 'tahoe-launchpad-footer',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._footerInfo = new St.Label({
            style_class: 'tahoe-launchpad-footer-info',
            text: '',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._footerHint = new St.Label({
            style_class: 'tahoe-launchpad-footer-hint',
            text: '↑↓ navegar  ·  ↵ abrir  ·  Esc cerrar',
            x_align: Clutter.ActorAlign.END,
        });
        this._footerHint.clutter_text.set_single_line_mode(true);

        footer.add_child(this._footerInfo);
        footer.add_child(this._footerHint);
        this._pane.add_child(footer);
    }

    _ensureChrome() {
        if (this._chromeAdded || !this._overlay)
            return;

        try {
            Main.layoutManager.addTopChrome(this._overlay, {
                affectsStruts: false,
                trackFullscreen: false,
            });
            this._chromeAdded = true;
        } catch (e) {
            console.warn(`${LOG} addTopChrome falló; se usa uiGroup:`, e);
            try {
                Main.uiGroup.add_child(this._overlay);
            } catch (addError) {
                console.error(`${LOG} No se pudo añadir el Launchpad al stage:`, addError);
            }
            this._chromeAdded = false;
        }
    }

    _applyLayout() {
        if (!this._overlay || !this._pane || !this._scroll)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const width = clamp(
            this._px(PANE_WIDTH),
            this._px(320),
            Math.max(this._px(320), monitor.width - this._px(PANE_MARGIN * 2)));
        const top = this._px(PANE_TOP);
        const available = Math.max(this._px(220),
            monitor.height - top - this._px(PANE_MARGIN));
        // El buscador, las categorías y el pie dejan sitio a cuatro filas;
        // el resto de apps se desplaza dentro de la hoja.
        const gridHeight = clamp(
            available - this._px(200),
            this._px(CELL_HEIGHT * 4),
            this._px(CELL_HEIGHT * GRID_ROWS));

        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);

        this._maxGridHeight = gridHeight;
        this._pane.set_width(width);
        this._setGridHeight(this._gridContentHeight || gridHeight);
        // La referencia Tahoe coloca la hoja cerca del centro visual,
        // no inmediatamente bajo la barra: centrar según su altura real.
        const paneHeight = this._pane.get_preferred_height(width)[1];
        const centeredY = Math.round((monitor.height - paneHeight) / 2);
        this._pane.set_position(
            Math.round((monitor.width - width) / 2),
            clamp(centeredY, top, Math.max(top, monitor.height - paneHeight - this._px(PANE_MARGIN))));
    }

    _setGridHeight(height) {
        if (!this._scroll)
            return;

        const maxHeight = this._maxGridHeight ||
            this._px(CELL_HEIGHT * GRID_ROWS);
        this._gridContentHeight = Math.max(0, Math.round(height));
        this._scroll.set_height(clamp(
            this._gridContentHeight,
            this._px(110),
            maxHeight));
    }

    _raise() {
        if (!this._overlay)
            return;
        const parent = this._overlay.get_parent();
        if (parent)
            parent.set_child_above_sibling(this._overlay, null);
    }

    _currentKeyFocus() {
        try {
            const focus = global.stage.get_key_focus();
            return this._isInsidePane(focus) || this._isInsideOverlay(focus)
                ? null
                : focus;
        } catch (_e) {
            return null;
        }
    }

    _grabEntryFocus() {
        if (!this._entry)
            return;
        try {
            global.stage.grab_key_focus();
        } catch (_e) {
            // El stage puede no aceptar foco durante el apagado.
        }
        try {
            this._entry.grab_key_focus();
        } catch (e) {
            console.error(`${LOG} No se pudo enfocar el buscador:`, e);
        }
    }

    _restoreKeyFocus() {
        const focus = this._previousKeyFocus;
        this._previousKeyFocus = null;
        if (!focus) {
            try {
                global.stage.set_key_focus(null);
            } catch (_e) {
                // El stage ya no acepta foco durante el apagado.
            }
            return;
        }
        try {
            if (focus.get_parent())
                focus.grab_key_focus();
        } catch (_e) {
            // El actor anterior ya no existe.
        }
    }

    _isInsideOverlay(actor) {
        let current = actor;
        while (current) {
            if (current === this._overlay)
                return true;
            current = current.get_parent();
        }
        return false;
    }

    _isInsidePane(actor) {
        let current = actor;
        while (current) {
            if (current === this._pane)
                return true;
            current = current.get_parent();
        }
        return false;
    }

    /* ------------------------------------------------------------------ */
    /* Entorno y cristal                                                   */
    /* ------------------------------------------------------------------ */

    _prepareEnvironment() {
        // No abrir nunca sobre la vista de aplicaciones del overview: se
        // oculta el overview y se muestra sólo esta hoja.
        try {
            if (Main.overview?.visible)
                Main.overview.hide();
        } catch (e) {
            console.warn(`${LOG} No se pudo ocultar el overview:`, e);
        }

        // Si venimos de un menú del panel o del dock, su grab modal puede
        // interceptar el primer clic fuera. Cerrarlo antes de abrir evita que
        // ese clic cierre el menú en vez de interactuar con el Launchpad.
        const dock = this._extension?._dock;
        if (typeof dock?._closeMenus === 'function') {
            try {
                dock._closeMenus();
            } catch (e) {
                console.warn(`${LOG} No se pudo cerrar el menú del dock:`, e);
            }
        }

        try {
            const activeMenu = Main.panel?.menuManager?.activeMenu;
            if (activeMenu && typeof activeMenu.close === 'function')
                activeMenu.close();
        } catch (_e) {
            // Sin menú activo.
        }
    }

    _glassStyle() {
        try {
            return this._settings?.get_string('glass-style') ?? 'liquid';
        } catch (_e) {
            return 'liquid';
        }
    }

    _syncGlass() {
        if (!this._isOpen || !this._pane) {
            this._destroyGlass();
            return;
        }

        const engine = this._glassEngine ?? this._extension?._glassEngine ?? null;
        if (this._glassStyle() !== 'liquid' || !engine) {
            this._destroyGlass();
            this._pane.remove_style_class_name('tahoe-launchpad-glass');
            return;
        }

        const currentTheme = this._theme ?? this._extension?._theme;
        const dark = Boolean(currentTheme?.isDark);
        const look = glassLook(currentTheme, {
            cornerRadius: this._px(GLASS_RADIUS),
            blurRadius: 4,
            // El Launchpad cubre una zona grande: un tinte algo más fuerte que
            // el de un menú mantiene legibles las etiquetas sobre fondos
            // oscuros también en modo claro, sin poner una capa CSS opaca
            // encima del shader.
            tintStrength: dark ? 0.12 : 0.45,
            brightness: dark ? 0.97 : 1.10,
            owner: 'tahoe-launchpad',
            shadow: true,
        });

        if (this._glassHandle) {
            try {
                this._glassHandle.update(look);
                this._pane.add_style_class_name('tahoe-launchpad-glass');
            } catch (e) {
                console.error(`${LOG} No se pudo actualizar el cristal:`, e);
                this._destroyGlass();
                this._pane.remove_style_class_name('tahoe-launchpad-glass');
            }
            return;
        }

        try {
            this._glassHandle = engine.attach(this._pane, look);
            this._pane.add_style_class_name('tahoe-launchpad-glass');
        } catch (e) {
            console.error(`${LOG} No se pudo crear el cristal:`, e);
            this._glassHandle = null;
            this._pane.remove_style_class_name('tahoe-launchpad-glass');
        }
    }

    _destroyGlass() {
        if (this._glassHandle) {
            try {
                this._glassHandle.destroy();
            } catch (e) {
                console.error(`${LOG} Error al destruir el cristal:`, e);
            }
            this._glassHandle = null;
        }
        if (this._pane)
            this._pane.remove_style_class_name('tahoe-launchpad-glass');
    }

    /* ------------------------------------------------------------------ */
    /* Aplicaciones locales                                                */
    /* ------------------------------------------------------------------ */

    _collectApps() {
        const apps = [];
        const seen = new Set();

        let installed = [];
        try {
            installed = this._appSystem?.get_installed?.() ?? [];
        } catch (e) {
            console.error(`${LOG} No se pudo leer la lista de aplicaciones:`, e);
            installed = [];
        }

        for (const appInfo of installed) {
            try {
                if (!appInfo?.should_show?.())
                    continue;

                const id = appInfo.get_id?.() ?? '';
                if (!id || seen.has(id))
                    continue;

                const app = this._appSystem.lookup_app(id);
                if (!app)
                    continue;

                seen.add(id);
                const name = appInfo.get_name?.() ?? app.get_name?.() ?? id;
                let generic = '';
                try {
                    generic = appInfo.get_generic_name?.() ?? '';
                } catch (_e) {
                    generic = '';
                }

                apps.push({
                    id,
                    name,
                    icon: app,
                    app,
                    category: inferCategory(appInfo),
                    searchText: normalizeText(
                        `${name} ${generic} ${id} ${appInfo.get_categories?.() ?? ''}`),
                });
            } catch (e) {
                console.warn(`${LOG} Se omitió una aplicación no válida:`, e);
            }
        }

        apps.sort((a, b) => a.name.localeCompare(b.name, 'es', {
            sensitivity: 'base',
        }));

        this._apps = apps;
        this._appsDirty = false;
    }

    _appsForCategory() {
        if (this._appsDirty)
            this._collectApps();
        if (this._category === 'all')
            return this._apps;
        return this._apps.filter(app => app.category === this._category);
    }

    _selectCategory(id) {
        if (this._destroyed || !CATEGORY_BY_ID.has(id))
            return;
        this._category = id;
        this._updateChipState();

        if (this._searchText)
            this._clearSearch();
        else
            this._renderBrowse();
    }

    _updateChipState() {
        for (const [id, button] of this._chipButtons) {
            if (!button)
                continue;
            if (id === this._category)
                button.add_style_class_name('tahoe-launchpad-chip-active');
            else
                button.remove_style_class_name('tahoe-launchpad-chip-active');
        }
    }

    /* ------------------------------------------------------------------ */
    /* Buscador                                                            */
    /* ------------------------------------------------------------------ */

    _setEntryText(text) {
        if (!this._entry)
            return;
        this._suppressText = true;
        try {
            this._entry.set_text(text);
        } catch (_e) {
            try {
                this._entry.text = text;
            } catch (_fallbackError) {
                // Sin entrada no hay nada que sincronizar.
            }
        }
        this._suppressText = false;
    }

    _entryText() {
        try {
            return this._entry?.text ?? '';
        } catch (_e) {
            return '';
        }
    }

    _onSearchTextChanged() {
        if (this._destroyed || !this._entry)
            return;

        if (this._suppressText)
            return;

        const text = this._entryText().trim();
        this._searchText = text;
        if (this._clearButton)
            this._clearButton.visible = Boolean(text);
        this._cancelSearchTimer();
        this._searchGeneration++;

        if (!text) {
            this._lastSearchResult = null;
            this._renderBrowse();
            return;
        }

        const generation = this._searchGeneration;
        this._renderSearchLoading(text);
        this._searchTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SEARCH_DELAY, () => {
                this._searchTimerId = 0;
                this._runSearch(text, generation).catch(e =>
                    console.error(`${LOG} Error inesperado en la búsqueda:`, e));
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelSearchTimer() {
        if (!this._searchTimerId)
            return;
        try {
            GLib.source_remove(this._searchTimerId);
        } catch (_e) {
            // Ya se había ejecutado.
        }
        this._searchTimerId = 0;
    }

    _clearSearch() {
        if (this._destroyed)
            return;
        this._cancelSearchTimer();
        this._searchGeneration++;
        this._searchText = '';
        this._lastSearchResult = null;
        this._setEntryText('');
        this._clearButton?.hide();
        this._renderBrowse();
        this._grabEntryFocus();
    }

    async _getSearch() {
        if (this._search)
            return this._search;
        if (this._searchUnavailable)
            return null;
        if (this._searchLoad)
            return this._searchLoad;

        this._searchLoad = (async () => {
            try {
                // GJS no expone la clase web URL: se resuelve el hermano con
                // la propia URL del módulo para que funcione también cuando
                // la extensión se carga a través de un symlink.
                const base = import.meta.url;
                const url = `${base.slice(0, base.lastIndexOf('/') + 1)}search.js`;
                const module = await import(url);
                if (this._destroyed)
                    return null;

                const SearchClass = module?.LaunchpadSearch ?? module?.default;
                if (typeof SearchClass !== 'function')
                    throw new Error('search.js no exporta LaunchpadSearch');

                const search = new SearchClass();
                if (typeof search.search !== 'function')
                    throw new Error('LaunchpadSearch no implementa search()');

                if (this._destroyed) {
                    try {
                        search.destroy?.();
                    } catch (_e) {
                        // Nada que liberar.
                    }
                    return null;
                }

                this._search = search;
                return search;
            } catch (e) {
                this._searchUnavailable = true;
                console.warn(`${LOG} Búsqueda externa no disponible; ` +
                    `se usa el filtro local:`, e.message ?? e);
                return null;
            } finally {
                this._searchLoad = null;
            }
        })();

        return this._searchLoad;
    }

    async _runSearch(text, generation) {
        let result = null;
        try {
            const search = await this._getSearch();
            if (search)
                result = await search.search(text);
        } catch (e) {
            console.warn(`${LOG} La búsqueda externa falló:`, e);
        }

        if (this._destroyed || !this._isOpen ||
            generation !== this._searchGeneration ||
            this._searchText !== text)
            return;

        this._lastSearchResult = this._normalizeResult(result) ??
            this._localSearch(text);
        this._renderSearch(this._lastSearchResult, text);
    }

    _normalizeResult(result) {
        if (!result || typeof result !== 'object')
            return null;

        const apps = Array.isArray(result.apps) ? result.apps : null;
        const others = Array.isArray(result.others) ? result.others : null;
        if (!apps && !others)
            return null;

        return {
            apps: (apps ?? []).filter(Boolean).slice(0, 60),
            others: (others ?? []).filter(Boolean).slice(0, 120),
        };
    }

    _localSearch(text) {
        const needle = normalizeText(text);
        if (!needle)
            return {apps: [], others: []};

        if (this._appsDirty)
            this._collectApps();

        const apps = this._apps
            .filter(app => app.searchText.includes(needle))
            .slice(0, 60)
            .map(app => ({
                id: app.id,
                name: app.name,
                icon: app.app,
                activate: () => this._launchApp(app.app),
            }));

        return {apps, others: []};
    }

    /* ------------------------------------------------------------------ */
    /* Render de la rejilla                                                */
    /* ------------------------------------------------------------------ */

    _resetContent() {
        this._items = [];
        this._selectedIndex = -1;
        this._clearChildren(this._content);
    }

    _renderBrowse() {
        if (!this._content)
            return;

        const apps = this._appsForCategory();
        this._resetContent();

        if (apps.length === 0) {
            this._addEmptyState('No hay aplicaciones en esta categoría.');
            this._setGridHeight(this._px(180));
            this._setFooter(`${apps.length} aplicaciones`);
            return;
        }

        this._addAppRows(apps.map(app => ({
            id: app.id,
            name: app.name,
            icon: app.app,
            activate: () => this._launchApp(app.app),
        })));

        const rows = Math.ceil(apps.length / GRID_COLUMNS);
        this._setGridHeight(rows * this._px(CELL_HEIGHT) + this._px(3));
        this._setFooter(apps.length === 1
            ? '1 aplicación'
            : `${apps.length} aplicaciones`);
    }

    _renderSearch(result, text) {
        if (!this._content)
            return;

        this._resetContent();

        const apps = result?.apps ?? [];
        const others = result?.others ?? [];
        const total = apps.length + others.length;

        if (total === 0) {
            this._addEmptyState(`No se encontraron resultados para “${text}”.`);
            this._setGridHeight(this._px(180));
            this._setFooter('0 resultados');
            return;
        }

        let contentHeight = this._px(3);
        if (apps.length > 0) {
            contentHeight += this._px(29) +
                Math.ceil(apps.length / GRID_COLUMNS) * this._px(CELL_HEIGHT);
            this._addSectionHeader('Aplicaciones');
            this._addAppRows(apps.map(app => ({
                id: app.id ?? '',
                name: app.name ?? app.id ?? 'Aplicación',
                icon: app.icon ?? this._lookupAppIcon(app.id),
                createIcon: app.createIcon,
                activate: typeof app.activate === 'function'
                    ? () => app.activate()
                    : () => this._launchById(app.id),
            })));
        }

        // Cada proveedor externo es un encabezado de sección. Si el módulo no
        // indica proveedor se agrupa bajo «Resultados web».
        const groups = new Map();
        for (const other of others) {
            const provider = String(other.provider ?? 'Resultados web').trim() ||
                'Resultados web';
            if (!groups.has(provider))
                groups.set(provider, []);
            groups.get(provider).push(other);
        }

        for (const [provider, entries] of groups) {
            this._addSectionHeader(provider);
            for (const entry of entries)
                this._addResultRow(entry);
            contentHeight += this._px(29) + entries.length * this._px(54);
        }

        this._setGridHeight(contentHeight);
        this._setFooter(total === 1 ? '1 resultado' : `${total} resultados`);
    }

    _renderSearchLoading(text) {
        if (!this._content)
            return;
        this._resetContent();
        this._addEmptyState(`Buscando “${text}”…`);
        this._setGridHeight(this._px(180));
        this._setFooter('Buscando…');
    }

    _addAppRows(items) {
        for (let start = 0; start < items.length; start += GRID_COLUMNS) {
            const row = new St.BoxLayout({
                style_class: 'tahoe-launchpad-row',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });

            for (const item of items.slice(start, start + GRID_COLUMNS))
                row.add_child(this._createAppCell(item));

            this._content.add_child(row);
        }
    }

    _createAppCell(item) {
        const cell = new St.Button({
            style_class: 'tahoe-launchpad-app',
            can_focus: false,
            reactive: true,
            track_hover: true,
            width: this._px(CELL_WIDTH),
            height: this._px(CELL_HEIGHT),
            accessible_name: item.name,
        });

        const box = new St.BoxLayout({
            style_class: 'tahoe-launchpad-app-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const iconWrap = new St.Bin({
            style_class: 'tahoe-launchpad-icon-wrap',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: this._px(52),
            height: this._px(52),
        });
        iconWrap.set_child(this._makeItemIcon(
            item, APP_ICON_SIZE, 'application-x-executable'));
        box.add_child(iconWrap);

        const label = new St.Label({
            style_class: 'tahoe-launchpad-app-label',
            text: item.name,
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        label.clutter_text.set_single_line_mode(true);
        label.set_width(this._px(CELL_WIDTH - 2));
        box.add_child(label);

        cell.set_child(box);
        cell.connect('clicked', () => this._activateItem(item));

        this._items.push({
            actor: cell,
            activate: () => this._activateItem(item),
        });
        return cell;
    }

    _addResultRow(entry) {
        const row = new St.Button({
            style_class: 'tahoe-launchpad-result',
            can_focus: false,
            reactive: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            // St.Bin no siempre estira un botón con x_expand dentro del
            // viewport del scroll; el ancho explícito mantiene la fila
            // completa y el resaltado de teclado de lado a lado.
            width: Math.max(1,
                (this._pane?.width || this._px(PANE_WIDTH)) - this._px(42)),
            height: this._px(54),
            accessible_name: entry.name ?? entry.description ?? 'Resultado',
        });

        const box = new St.BoxLayout({
            style_class: 'tahoe-launchpad-result-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const iconWrap = new St.Bin({
            style_class: 'tahoe-launchpad-result-icon-wrap',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: this._px(38),
            height: this._px(38),
        });
        iconWrap.set_child(this._makeItemIcon(
            entry, RESULT_ICON_SIZE, 'web-browser-symbolic'));
        box.add_child(iconWrap);

        const textBox = new St.BoxLayout({
            style_class: 'tahoe-launchpad-result-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const title = new St.Label({
            style_class: 'tahoe-launchpad-result-title',
            text: entry.name ?? 'Resultado',
            x_align: Clutter.ActorAlign.START,
        });
        title.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        title.clutter_text.set_single_line_mode(true);
        textBox.add_child(title);

        const description = new St.Label({
            style_class: 'tahoe-launchpad-result-description',
            text: entry.description ?? '',
            x_align: Clutter.ActorAlign.START,
            visible: Boolean(entry.description),
        });
        description.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        description.clutter_text.set_single_line_mode(true);
        textBox.add_child(description);

        box.add_child(textBox);
        row.set_child(box);
        row.connect('clicked', () => this._activateItem(entry));

        this._items.push({
            actor: row,
            activate: () => this._activateItem(entry),
        });
        this._content.add_child(row);
    }

    _addSectionHeader(text) {
        const row = new St.BoxLayout({
            style_class: 'tahoe-launchpad-section-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const label = new St.Label({
            style_class: 'tahoe-launchpad-section-title',
            text,
            x_align: Clutter.ActorAlign.START,
        });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        label.clutter_text.set_single_line_mode(true);
        row.add_child(label);
        this._content.add_child(row);
    }

    _addEmptyState(text) {
        const box = new St.BoxLayout({
            style_class: 'tahoe-launchpad-empty-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const label = new St.Label({
            style_class: 'tahoe-launchpad-empty',
            text,
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        label.set_width(this._px(PANE_WIDTH - 120));
        box.add_child(label);
        this._content.add_child(box);
    }

    _setFooter(text) {
        if (this._footerInfo)
            this._footerInfo.text = text;
    }

    _makeItemIcon(item, size, fallbackName) {
        if (typeof item?.createIcon === 'function') {
            try {
                const actor = item.createIcon(this._px(size));
                if (actor instanceof Clutter.Actor)
                    return actor;
                actor?.destroy?.();
            } catch (e) {
                console.warn(`${LOG} La factoría de icono de ` +
                    `${item.name ?? 'un resultado'} falló:`, e);
            }
        }

        return this._makeIcon(
            item?.icon, size, item?.name, fallbackName);
    }

    _makeIcon(icon, size, name, fallbackName) {
        const pixelSize = this._px(size);
        const fallback = () => new St.Icon({
            icon_name: fallbackName ?? 'application-x-executable',
            icon_size: pixelSize,
        });

        try {
            if (icon?.create_icon_texture)
                return icon.create_icon_texture(pixelSize);

            if (icon instanceof Clutter.Actor) {
                if (!icon.get_parent())
                    return icon;
                return new Clutter.Clone({
                    source: icon,
                    width: pixelSize,
                    height: pixelSize,
                });
            }

            if (typeof icon === 'string' && icon.trim()) {
                const value = icon.trim();
                if (value.startsWith('/') || value.startsWith('file://')) {
                    const file = value.startsWith('file://')
                        ? Gio.File.new_for_uri(value)
                        : Gio.File.new_for_path(value);
                    return new St.Icon({
                        gicon: new Gio.FileIcon({file}),
                        icon_size: pixelSize,
                    });
                }
                return new St.Icon({
                    icon_name: value,
                    icon_size: pixelSize,
                });
            }

            if (icon) {
                try {
                    return new St.Icon({
                        gicon: icon,
                        icon_size: pixelSize,
                    });
                } catch (_e) {
                    // No es un GIcon: se intenta el icono de respaldo.
                }
            }
        } catch (e) {
            console.warn(`${LOG} No se pudo crear el icono de ${name ?? 'una app'}:`, e);
        }

        return fallback();
    }

    _lookupAppIcon(id) {
        if (!id)
            return null;
        try {
            return this._appSystem?.lookup_app(id) ?? null;
        } catch (_e) {
            return null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Activación                                                          */
    /* ------------------------------------------------------------------ */

    _activateItem(item) {
        if (!item || typeof item.activate !== 'function')
            return;
        this.close();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                const result = item.activate();
                if (result && typeof result.catch === 'function') {
                    result.catch(e =>
                        console.error(`${LOG} La acción del resultado falló:`, e));
                }
            } catch (e) {
                console.error(`${LOG} No se pudo abrir el resultado:`, e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _launchApp(app) {
        if (!app)
            return;
        try {
            app.activate();
        } catch (e) {
            console.error(`${LOG} No se pudo activar ${app.get_name?.() ?? 'la app'}:`, e);
            try {
                app.open_new_window(-1);
            } catch (secondError) {
                console.error(`${LOG} Tampoco se pudo abrir una ventana nueva:`,
                    secondError);
            }
        }
    }

    _launchById(id) {
        const app = this._lookupAppIcon(id);
        if (app)
            this._launchApp(app);
    }

    /* ------------------------------------------------------------------ */
    /* Teclado y clic fuera                                                */
    /* ------------------------------------------------------------------ */

    _connectStageCapture() {
        if (this._stageCaptureId)
            return;
        try {
            this._stageCaptureId = global.stage.connect('captured-event',
                (_stage, event) => this._onStageCaptured(event));
        } catch (e) {
            console.error(`${LOG} No se pudo escuchar el teclado:`, e);
            this._stageCaptureId = 0;
        }
    }

    _disconnectStageCapture() {
        if (!this._stageCaptureId)
            return;
        try {
            global.stage.disconnect(this._stageCaptureId);
        } catch (_e) {
            // Ya estaba desconectado.
        }
        this._stageCaptureId = 0;
    }

    _onStageCaptured(event) {
        if (!this._isOpen || this._destroyed)
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS)
            return this._onKeyPress(event);

        if (type === Clutter.EventType.BUTTON_PRESS) {
            const source = eventActor(event);
            if (source && this._isInsidePane(source))
                return Clutter.EVENT_PROPAGATE;

            this.close();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_ISO_Enter) {
            const item = this._items[this._selectedIndex] ?? this._items[0];
            if (item)
                item.activate();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Down) {
            this._moveSelection(1);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Up) {
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _moveSelection(delta) {
        if (this._items.length === 0)
            return;

        let index;
        if (this._selectedIndex < 0)
            index = delta > 0 ? 0 : this._items.length - 1;
        else
            index = (this._selectedIndex + delta + this._items.length) %
                this._items.length;

        this._setSelectedIndex(index);
    }

    _setSelectedIndex(index) {
        const previous = this._items[this._selectedIndex];
        if (previous?.actor)
            previous.actor.remove_style_class_name('tahoe-launchpad-selected');

        this._selectedIndex = index;
        const current = this._items[index];
        if (!current?.actor)
            return;

        current.actor.add_style_class_name('tahoe-launchpad-selected');
        this._ensureSelectedVisible(current.actor);
    }

    _ensureSelectedVisible(actor) {
        if (!this._scroll?.vadjustment || !actor)
            return;

        const adjustment = this._scroll.vadjustment;
        let actorRect;
        let scrollRect;
        try {
            actorRect = actor.get_transformed_extents();
            scrollRect = this._scroll.get_transformed_extents();
        } catch (_e) {
            return;
        }

        const margin = this._px(6);
        const top = scrollRect.origin.y + margin;
        const bottom = scrollRect.origin.y + scrollRect.size.height - margin;
        const actorTop = actorRect.origin.y;
        const actorBottom = actorRect.origin.y + actorRect.size.height;

        let value = adjustment.value;
        if (actorTop < top)
            value -= top - actorTop;
        else if (actorBottom > bottom)
            value += actorBottom - bottom;

        try {
            adjustment.value = clamp(
                value, adjustment.lower, adjustment.upper - adjustment.page_size);
        } catch (_e) {
            // Sin ajuste disponible.
        }
    }

    _finishClose() {
        if (this._destroyed)
            return;
        this._closing = false;
        this._destroyGlass();
        this._overlay?.hide();
        if (this._overlay)
            this._overlay.reactive = true;
        this._restoreKeyFocus();
    }

    _destroySearch() {
        const search = this._search;
        this._search = null;
        this._searchUnavailable = false;
        this._searchLoad = null;
        if (!search)
            return;
        try {
            search.destroy?.();
        } catch (e) {
            console.error(`${LOG} Error al destruir la búsqueda:`, e);
        }
    }
}
