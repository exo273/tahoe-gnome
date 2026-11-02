// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Dock flotante estilo macOS Tahoe para GNOME Shell 48/49/50.
//
// Contrato con extension.js:
//   const dock = new TahoeDock(this);
//   dock.refreshGlass();      // opcional, tras cambios externos de tema
//   dock.destroy();
//
// El módulo no toca prefs.js ni el esquema: lee todas las claves dock-* con
// valores por defecto defensivos. El dock visual vive en uiGroup mediante
// Main.layoutManager.addChrome() sin affectsStruts; además mantiene un actor
// de reserva transparente (solo con autohide desactivado) que sí afecta a los
// struts para que las ventanas maximizadas no queden debajo del dock.
// Esconde el dash nativo mientras está activo (restaurándolo en destroy).

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {glassLook} from '../liquidGlass.js';
import {
    DockAppItem,
    DockControlItem,
    DockSeparator,
} from './items.js';
import {
    DownloadsModel,
    MountsModel,
    TrashModel,
    populateDownloadsMenu,
    populateTrashMenu,
    populateVolumeMenu,
} from './downloads.js';

const LOG = '[tahoe-dock]';

const DOCK_MARGIN = 8;
const GLASS_RADIUS = 20;
const INDICATOR_SPACE = 7;
const TOOLTIP_DELAY = 320;
const MAG_FRAME_MS = 16;
const MAG_TAU = 0.045;
const MAX_ICON_SIZE = 128;
const POSITIONS = ['bottom', 'left', 'right'];
const INDICATORS = ['dots', 'lines'];

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function arraysEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}

export class TahoeDock {
    constructor(extension) {
        this._extension = extension ?? null;
        this._settings = null;
        this._theme = extension?._theme ?? null;
        this._themeId = 0;
        this._settingsId = 0;
        this._destroyed = false;

        try {
            this._settings = extension?.getSettings?.() ?? null;
        } catch (e) {
            console.error(`${LOG} No se pudieron leer los ajustes:`, e);
            this._settings = null;
        }

        this._extensionDir = extension?.dir?.get_path?.() ??
            extension?.path ?? null;
        this._scaleFactor = this._getScaleFactor();

        this._items = [];
        this._appItems = [];
        this._favoriteItems = [];
        this._controlItems = [];
        this._appIds = [];
        this._favoriteApps = [];
        this._extraApps = [];
        this._favoritesOverride = [];
        this._dragSession = null;
        this._dropIndicator = null;
        this._dropIndicatorIndex = -1;
        this._dragMonitor = null;
        // Proxy flotante propio, por encima de top chrome. DND sigue siendo
        // quien gestiona el grasp, los targets y el drop; su actor se mantiene
        // invisible mientras este proxy exista.
        this._dragProxy = null;
        this._dragProxyItem = null;
        this._dragProxyTimer = 0;
        this._dragProxyChrome = false;
        this._dragProxyShown = false;
        this._dragProxyFinishing = false;
        this._dragProxyBaseScale = 1;
        this._dragProxyHome = null;

        this._signalIds = [];
        this._windowSignalIds = [];
        this._laterIds = new Set();
        this._openMenus = new Set();
        this._rebuildId = 0;
        this._indicatorId = 0;
        this._magTimer = 0;
        this._magLast = 0;
        this._magCenters = null;
        this._magCurrent = new Map();
        this._magTargets = new Map();
        this._hideTimerId = 0;
        this._tooltipShowId = 0;
        this._dashRetryId = 0;
        this._dashRetryCount = 0;
        this._revealSignalId = 0;
        this._glassHandle = null;
        this._glassEngine = null;
        this._glassUnsubscribe = null;

        this._revealed = undefined;
        this._hiddenTranslation = {x: 0, y: 0};
        this._ready = false;
        this._position = 'bottom';
        this._iconSizeSetting = 48;
        this._iconSizePx = 48;
        this._indicatorSpacePx = INDICATOR_SPACE;
        this._magnification = 1.5;
        this._autohide = false;
        this._hideDelay = 600;
        this._showApps = true;
        this._appGridPath = '';
        this._showDownloads = true;
        this._showTrash = true;
        this._showRunning = true;
        this._showRecentDownloads = true;
        this._showMounts = false;
        this._glassEnabled = true;
        this._indicatorStyle = 'dots';
        this._animationStyle = 'aladdin';
        this._enabled = true;

        this._dash = null;
        this._dashWasVisible = true;
        this._dashWasReactive = true;
        this._dashDestroyId = 0;
        this._trashDialog = null;

        // Actor invisible que reserva el borde inferior/lateral en los
        // struts de Meta. No es el dock visual: se añade y quita del chrome
        // según enabled/autohide porque cambiar su visibilidad no actualiza
        // los struts en GNOME Shell.
        this._reserve = null;
        this._reserveChrome = false;
        this._rootWidth = 0;
        this._rootHeight = 0;

        this._interfaceSettings = null;
        this._interfaceSignalId = 0;

        this._appSystem = Shell.AppSystem.get_default();
        this._appFavorites = AppFavorites.getAppFavorites();
        this._windowTracker = Shell.WindowTracker.get_default();

        this._readConfig();
        this._loadStylesheet();
        this._createIconProto();

        this._buildRoot();
        this._buildTooltip();
        this._connectDragMonitor();

        this._menuManager = new PopupMenu.PopupMenuManager(this._root);
        this._createModels();

        this._connectSettings();
        this._connectTheme();
        this._connectSystemSignals();
        this._connectGlass();

        if (this._enabled)
            this._hideOriginalDash();

        this._rebuild();
        this._updateRevealHandler();
    }

    /* ------------------------------------------------------------------ */
    /* Ajustes y utilidades                                                */
    /* ------------------------------------------------------------------ */

    _getScaleFactor() {
        try {
            return St.ThemeContext.get_for_stage(global.stage)?.scale_factor || 1;
        } catch (_e) {
            return 1;
        }
    }

    _px(value) {
        return Math.round(value * this._scaleFactor);
    }

    _readKey(key, kind, fallback) {
        if (!this._settings)
            return fallback;

        try {
            const schema = this._settings.settings_schema;
            if (schema && typeof schema.has_key === 'function' && !schema.has_key(key))
                return fallback;

            switch (kind) {
            case 'boolean':
                return this._settings.get_boolean(key);
            case 'int':
                return this._settings.get_int(key);
            case 'double':
                return this._settings.get_double(key);
            case 'string':
                return this._settings.get_string(key);
            case 'strv':
                return this._settings.get_strv(key);
            default:
                return fallback;
            }
        } catch (_e) {
            return fallback;
        }
    }

    _readConfig() {
        this._enabled = this._readKey('dock-enabled', 'boolean', true);

        const position = this._readKey('dock-position', 'string', 'bottom');
        this._position = POSITIONS.includes(position) ? position : 'bottom';

        const size = this._readKey('dock-icon-size', 'int', 48);
        this._iconSizeSetting = clamp(size, 16, MAX_ICON_SIZE);
        this._iconSizePx = this._px(this._iconSizeSetting);
        this._indicatorSpacePx = this._px(INDICATOR_SPACE);

        const magnification = this._readKey('dock-magnification', 'double', 1.5);
        this._magnification = clamp(magnification, 1.0, 3.0);

        this._autohide = this._readKey('dock-autohide', 'boolean', false);
        this._hideDelay = clamp(this._readKey('dock-hide-delay', 'int', 600), 0, 10000);

        this._showApps = this._readKey('dock-show-apps', 'boolean', true);
        this._appGridPath = this._readKey('dock-app-grid-icon-path', 'string', '');
        this._showDownloads = this._readKey('dock-show-downloads', 'boolean', true);
        this._showTrash = this._readKey('dock-show-trash', 'boolean', true);
        this._showRunning = this._readKey('dock-show-running', 'boolean', true);
        this._showRecentDownloads = this._readKey('dock-show-recent-downloads', 'boolean', true);
        this._showMounts = this._readKey('dock-show-mounts', 'boolean', false);
        this._glassEnabled = this._readKey('dock-glass', 'boolean', true);

        const indicators = this._readKey('dock-indicators', 'string', 'dots');
        this._indicatorStyle = INDICATORS.includes(indicators) ? indicators : 'dots';
        this._animationStyle = this._readKey('dock-animation-style', 'string', 'aladdin');

        const favorites = this._readKey('dock-favorites', 'strv', []);
        this._favoritesOverride = Array.isArray(favorites) ? favorites : [];

        if (!this._autohide)
            this._revealed = true;
        else if (this._revealed === undefined)
            this._revealed = false;
    }

    _createIconProto() {
        const dir = this._extensionDir;

        let gridPath = null;
        if (dir)
            gridPath = GLib.build_filenamev([dir, 'dock', 'icons', 'app-grid.svg']);

        this._defaultAppGridIcon = null;
        if (gridPath && GLib.file_test(gridPath, GLib.FileTest.IS_REGULAR)) {
            this._defaultAppGridIcon = new Gio.FileIcon({
                file: Gio.File.new_for_path(gridPath),
            });
        }

        let fallbackPath = null;
        if (dir)
            fallbackPath = GLib.build_filenamev([dir, 'dock', 'icons', 'app-fallback.svg']);

        if (fallbackPath && GLib.file_test(fallbackPath, GLib.FileTest.IS_REGULAR)) {
            this._fallbackIcon = new Gio.FileIcon({
                file: Gio.File.new_for_path(fallbackPath),
            });
        } else {
            this._fallbackIcon = Gio.ThemedIcon.new('application-x-executable');
        }
    }

    get iconSizePx() {
        return this._iconSizePx;
    }

    get indicatorSpacePx() {
        return this._indicatorSpacePx;
    }

    get indicatorStyle() {
        return this._indicatorStyle;
    }

    get fallbackIcon() {
        return this._fallbackIcon;
    }

    get position() {
        return this._position;
    }

    applyIconPivot(actor) {
        if (!actor)
            return;
        switch (this._position) {
        case 'left':
            actor.set_pivot_point(0.0, 0.5);
            break;
        case 'right':
            actor.set_pivot_point(1.0, 0.5);
            break;
        default:
            actor.set_pivot_point(0.5, 1.0);
            break;
        }
    }

    _appGridGIcon() {
        const custom = (this._appGridPath ?? '').trim();
        if (custom) {
            let path = custom;
            if (!GLib.path_is_absolute(path) && this._extensionDir)
                path = GLib.build_filenamev([this._extensionDir, path]);

            if (GLib.file_test(path, GLib.FileTest.IS_REGULAR)) {
                return new Gio.FileIcon({file: Gio.File.new_for_path(path)});
            }
            console.warn(`${LOG} dock-app-grid-icon-path no existe: ${path}`);
        }
        return this._defaultAppGridIcon;
    }

    /* ------------------------------------------------------------------ */
    /* Construcción                                                        */
    /* ------------------------------------------------------------------ */

    _loadStylesheet() {
        if (!this._extensionDir)
            return;

        const path = GLib.build_filenamev([this._extensionDir, 'dock', 'dock.css']);
        if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR)) {
            console.warn(`${LOG} No existe ${path}`);
            return;
        }

        try {
            this._cssFile = Gio.File.new_for_path(path);
            this._themeContext = St.ThemeContext.get_for_stage(global.stage);
            this._themeContext.get_theme().load_stylesheet(this._cssFile);
        } catch (e) {
            console.error(`${LOG} No se pudo cargar dock.css:`, e);
            this._cssFile = null;
        }
    }

    _unloadStylesheet() {
        if (!this._cssFile || !this._themeContext)
            return;

        try {
            this._themeContext.get_theme().unload_stylesheet(this._cssFile);
        } catch (e) {
            console.error(`${LOG} No se pudo descargar dock.css:`, e);
        }
        this._cssFile = null;
        this._themeContext = null;
    }

    _buildRoot() {
        this._root = new St.BoxLayout({
            name: 'tahoe-dock',
            style_class: 'tahoe-dock',
            reactive: true,
            track_hover: true,
            can_focus: false,
            clip_to_allocation: false,
            accessible_name: 'Dock',
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        this._root._delegate = this;

        this._root.connect('destroy', () => {
            // Si el shell destruye uiGroup antes que nosotros (apagado),
            // evitar que idles pendientes toquen actores ya liberados.
            this._root = null;
            this._ready = false;
            this._stopMagnificationTimer();
            this._cancelHideTimer();
            if (this._hideTimerId) {
                try {
                    GLib.source_remove(this._hideTimerId);
                } catch (_e) {
                    // ya ejecutado
                }
                this._hideTimerId = 0;
            }
        });

        this._root.connect('motion-event', (_actor, event) => {
            this._onPointerMotion(event);
            return Clutter.EVENT_PROPAGATE;
        });
        this._root.connect('leave-event', () => {
            this._resetMagnificationTargets();
            this._startMagnificationTimer();
            if (this._autohide)
                this._scheduleHide();
            return Clutter.EVENT_PROPAGATE;
        });
        this._root.connect('notify::hover', () => {
            if (!this._autohide)
                return;
            if (this._root.hover) {
                this._revealDock();
                this._cancelHideTimer();
            } else {
                this._scheduleHide();
            }
        });

        try {
            Main.layoutManager.addChrome(this._root, {
                affectsStruts: false,
                trackFullscreen: false,
            });
            this._rootChrome = true;
        } catch (e) {
            console.error(`${LOG} addChrome falló; se usa uiGroup directamente:`, e);
            Main.uiGroup.add_child(this._root);
            this._rootChrome = false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Reserva de struts (workarea)                                        */
    /* ------------------------------------------------------------------ */

    _isMonitorFullscreen() {
        try {
            return Boolean(Main.layoutManager.primaryMonitor?.inFullscreen);
        } catch (_e) {
            return false;
        }
    }

    _createReserve() {
        if (this._reserve)
            return this._reserve;

        this._reserve = new St.Widget({
            name: 'tahoe-dock-reserve',
            reactive: false,
            can_focus: false,
            track_hover: false,
            opacity: 0,
            visible: true,
        });
        this._reserveChrome = false;
        try {
            // El actor de reserva cubre el dock y se pinta por encima de él.
            // DND usa PickMode.ALL, así que reactive:false no basta: sin esto
            // cualquier drop sobre el dock acabaría en el padre de la reserva
            // (uiGroup) y nunca llegaría a TahoeDock.handleDragOver().
            Shell.util_set_hidden_from_pick(this._reserve, true);
        } catch (e) {
            console.warn(`${LOG} No se pudo ocultar la reserva del picking:`, e);
        }
        this._reserve.connect('destroy', () => {
            if (this._reserve) {
                this._reserve = null;
                this._reserveChrome = false;
            }
        });
        return this._reserve;
    }

    /*
     * Añade o actualiza el actor de reserva. Solo debe existir con el dock
     * habilitado y sin autohide: con autohide el borde se libera. Se coloca
     * pegado al borde correspondiente del monitor primario y con el tamaño
     * del dock más sus dos márgenes, de modo que el workarea termina justo
     * por encima del dock (dejando su margen) y las maximizadas no lo tapan.
     */
    _syncReserve() {
        if (this._destroyed) {
            this._removeReserve();
            return;
        }

        if (!this._enabled || this._autohide) {
            this._removeReserve();
            return;
        }

        const monitor = Main.layoutManager.primaryMonitor;
        const width = this._rootWidth;
        const height = this._rootHeight;
        if (!monitor || !(width > 0) || !(height > 0)) {
            this._removeReserve();
            return;
        }

        const gap = this._px(DOCK_MARGIN);
        let x;
        let y;
        let reserveWidth;
        let reserveHeight;

        if (this._position === 'bottom') {
            // Debe abarcar todo el ancho del monitor para que LayoutManager
            // lo clasifique como strut inferior. Se suman los dos márgenes
            // (inferior y superior) para que el workarea termine un margen
            // por encima del borde visible del dock.
            reserveWidth = monitor.width;
            reserveHeight = height + gap * 2;
            x = monitor.x;
            y = monitor.y + monitor.height - reserveHeight;
        } else if (this._position === 'left') {
            reserveWidth = width + gap * 2;
            reserveHeight = monitor.height;
            x = monitor.x;
            y = monitor.y;
        } else {
            reserveWidth = width + gap * 2;
            reserveHeight = monitor.height;
            x = monitor.x + monitor.width - reserveWidth;
            y = monitor.y;
        }

        const reserve = this._createReserve();
        reserve.set_size(Math.max(1, Math.round(reserveWidth)),
            Math.max(1, Math.round(reserveHeight)));
        reserve.set_position(Math.round(x), Math.round(y));
        reserve.show();

        if (this._reserveChrome)
            return;

        try {
            Main.layoutManager.addChrome(reserve, {
                affectsStruts: true,
                trackFullscreen: false,
            });
            this._reserveChrome = true;
        } catch (e) {
            console.error(`${LOG} No se pudo añadir la reserva de struts:`, e);
            this._removeReserve();
        }
    }

    _removeReserve() {
        if (!this._reserve)
            return;

        const reserve = this._reserve;
        this._reserve = null;
        try {
            if (this._reserveChrome)
                Main.layoutManager.removeChrome(reserve);
            else
                reserve.get_parent()?.remove_child(reserve);
        } catch (_e) {
            // Ya estaba fuera del chrome.
        }
        this._reserveChrome = false;
        try {
            reserve.destroy();
        } catch (_e) {
            // Ya destruido con el uiGroup.
        }
    }

    _buildTooltip() {
        this._tooltip = new St.Label({
            style_class: 'tahoe-dock-tooltip',
            reactive: false,
            visible: false,
            opacity: 0,
        });

        try {
            Main.layoutManager.addTopChrome(this._tooltip, {
                affectsStruts: false,
                trackFullscreen: false,
            });
            this._tooltipChrome = true;
        } catch (e) {
            console.error(`${LOG} No se pudo añadir el tooltip al chrome:`, e);
            if (!this._tooltip.get_parent())
                Main.uiGroup.add_child(this._tooltip);
            this._tooltipChrome = false;
        }
        this._tooltip.connect('destroy', () => {
            this._tooltip = null;
            this._tooltipChrome = false;
        });
        this._tooltipItem = null;
    }

    _createModels() {
        this._downloads = new DownloadsModel();
        this._downloadsChanged = this._downloads.connect(() => this._onDownloadsChanged());
        this._downloads.start();

        this._trash = new TrashModel();
        this._trashChanged = this._trash.connect(() => this._onTrashChanged());
        this._trash.start();

        this._mounts = new MountsModel();
        this._mountsChanged = this._mounts.connect(() => this._queueRebuild());
    }

    /* ------------------------------------------------------------------ */
    /* Señales                                                             */
    /* ------------------------------------------------------------------ */

    _connectSettings() {
        if (!this._settings)
            return;
        this._settingsId = this._settings.connect('changed', (_settings, key) => {
            this._onSettingsChanged(key);
        });
    }

    _onSettingsChanged(key) {
        if (this._destroyed || !key?.startsWith?.('dock-'))
            return;

        switch (key) {
        case 'dock-enabled':
            this._enabled = this._readKey('dock-enabled', 'boolean', true);
            if (this._enabled) {
                this._hideOriginalDash();
                this._queueRebuild();
            } else {
                this._applyEnabled();
            }
            break;
        case 'dock-glass':
            this._glassEnabled = this._readKey('dock-glass', 'boolean', true);
            this.refreshGlass();
            break;
        case 'dock-autohide':
            this._autohide = this._readKey('dock-autohide', 'boolean', false);
            this._applyAutohideSetting();
            break;
        case 'dock-hide-delay':
            this._hideDelay = clamp(this._readKey('dock-hide-delay', 'int', 600), 0, 10000);
            break;
        case 'dock-magnification':
            this._magnification = clamp(
                this._readKey('dock-magnification', 'double', 1.5), 1.0, 3.0);
            this._magCenters = null;
            break;
        case 'dock-animation-style':
            this._animationStyle = this._readKey('dock-animation-style', 'string', 'aladdin');
            break;
        default:
            this._queueRebuild();
            break;
        }
    }

    _connectTheme() {
        if (this._theme && typeof this._theme.connect === 'function') {
            this._themeId = this._theme.connect(() => {
                if (this._destroyed)
                    return;
                this._root.queue_redraw();
                this.refreshGlass();
            });
            return;
        }

        // Fallback si el Dock se usa sin TahoeTheme.
        try {
            this._interfaceSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.interface',
            });
            this._interfaceSignalId = this._interfaceSettings.connect(
                'changed::color-scheme', () => {
                    if (!this._destroyed)
                        this.refreshGlass();
                });
        } catch (_e) {
            this._interfaceSettings = null;
            this._interfaceSignalId = 0;
        }
    }

    _connectSystemSignals() {
        const connect = (object, signal, callback) => {
            try {
                const id = object.connect(signal, callback);
                this._signalIds.push([object, id]);
                return id;
            } catch (e) {
                console.error(`${LOG} No se pudo conectar ${signal}:`, e);
                return 0;
            }
        };

        connect(this._appSystem, 'app-state-changed', () => this._onAppsChanged());
        connect(this._appSystem, 'installed-changed', () => this._queueRebuild());

        if (this._appFavorites) {
            connect(this._appFavorites, 'changed', () => {
                if (!this._usingCustomFavorites())
                    this._queueRebuild();
            });
        }

        connect(global.display, 'notify::focus-window', () => this._queueIndicatorSync());
        connect(global.display, 'window-created', () => {
            this._bindWindowSignals();
            this._queueIndicatorSync();
        });

        connect(Main.layoutManager, 'monitors-changed', () => this._onMonitorsChanged());
        connect(global.display, 'in-fullscreen-changed', () => {
            if (!this._destroyed)
                this._applyVisibility(false);
        });

        try {
            const context = St.ThemeContext.get_for_stage(global.stage);
            if (context) {
                connect(context, 'notify::scale-factor', () => this._onMonitorsChanged());
            }
        } catch (_e) {
            // Sin ThemeContext no hay nada que seguir.
        }

        connect(Main.overview, 'showing', () => this._hideOriginalDash());
        connect(global.workspace_manager, 'active-workspace-changed',
            () => this._queueIndicatorSync());
    }

    _connectGlass() {
        this._glassEngine = this._extension?._glassEngine ?? null;

        if (typeof this._extension?.onGlassEngineChanged === 'function') {
            this._glassUnsubscribe = this._extension.onGlassEngineChanged(engine => {
                this._glassEngine = engine;
                this.refreshGlass();
            });
        } else {
            this.refreshGlass();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Construcción del contenido                                          */
    /* ------------------------------------------------------------------ */

    _applyRootStyle() {
        for (const position of POSITIONS)
            this._root.remove_style_class_name(`tahoe-dock-${position}`);

        this._root.add_style_class_name(`tahoe-dock-${this._position}`);
        this._root.orientation = this._position === 'bottom'
            ? Clutter.Orientation.HORIZONTAL
            : Clutter.Orientation.VERTICAL;
    }

    _usingCustomFavorites() {
        return (this._favoritesOverride?.length ?? 0) > 0;
    }

    _favoriteAppsList() {
        if (this._usingCustomFavorites()) {
            const apps = [];
            const seen = new Set();
            for (const id of this._favoritesOverride) {
                if (seen.has(id))
                    continue;
                const app = this._appSystem.lookup_app(id);
                if (app) {
                    seen.add(id);
                    apps.push(app);
                }
            }
            return apps;
        }

        try {
            return this._appFavorites?.getFavorites() ?? [];
        } catch (e) {
            console.error(`${LOG} No se pudieron leer los favoritos de GNOME:`, e);
            try {
                return global.settings.get_strv('favorite-apps')
                    .map(id => this._appSystem.lookup_app(id))
                    .filter(app => app !== null);
            } catch (_e) {
                return [];
            }
        }
    }

    _desiredApps() {
        const favorites = this._favoriteAppsList();
        const favoriteIds = new Set(favorites.map(app => app.get_id()));
        const extras = [];

        if (this._showRunning) {
            for (const app of this._appSystem.get_running()) {
                if (!favoriteIds.has(app.get_id()))
                    extras.push(app);
            }
        }

        return {favorites, extras};
    }

    _rebuild() {
        if (this._destroyed || !this._root)
            return;

        this._readConfig();
        this._applyRootStyle();
        this._destroyItems();
        this._stopMagnificationTimer();
        this._magCenters = null;
        this._magCurrent = new Map();
        this._magTargets = new Map();

        const {favorites, extras} = this._desiredApps();
        this._favoriteApps = favorites;
        this._extraApps = extras;
        this._appIds = [...favorites, ...extras].map(app => app.get_id());

        if (this._showApps)
            this._addItem(this._createAppGridItem());

        for (const app of favorites)
            this._addAppItem(app, true);

        if (favorites.length > 0 && extras.length > 0)
            this._addItem(new DockSeparator(this, this._position === 'bottom'));

        for (const app of extras)
            this._addAppItem(app, false);

        const mounts = this._showMounts ? this._mounts?.entries() ?? [] : [];
        const hasPlaces = this._showDownloads || this._showTrash || mounts.length > 0;
        const appCount = favorites.length + extras.length;

        if (appCount > 0 && hasPlaces)
            this._addItem(new DockSeparator(this, this._position === 'bottom'));

        if (this._showDownloads)
            this._addItem(this._createDownloadsItem());

        for (const entry of mounts)
            this._addItem(this._createMountItem(entry));

        if (this._showTrash)
            this._addItem(this._createTrashItem());

        this._syncIndicators();
        this._positionDock();
        this._applyVisibility(false);
        this._ready = true;
        this.refreshGlass();
        this._updateRevealHandler();
    }

    _addItem(item) {
        this._items.push(item);
        this._root.add_child(item.actor);
        if (item.actor)
            item.actor.connect('destroy', () => {
                const index = this._items.indexOf(item);
                if (index >= 0)
                    this._items.splice(index, 1);
            });
    }

    _addAppItem(app, favorite) {
        const item = new DockAppItem(this, app, {favorite});
        if (favorite)
            this._favoriteItems.push(item);
        this._appItems.push(item);
        this._addItem(item);
        return item;
    }

    _createAppGridItem() {
        const item = new DockControlItem(this, {
            id: 'app-grid',
            gicon: this._appGridGIcon(),
            iconName: 'view-app-grid-symbolic',
            iconSize: this._iconSizePx,
            label: 'Aplicaciones',
            styleClass: 'tahoe-dock-appgrid',
            onClick: () => {
                this._hideTooltip();
                this._openAppGrid();
            },
        });
        this._controlItems.push(item);
        return item;
    }

    _openAppGrid() {
        try {
            if (Main.overview.visible) {
                // El dash nativo sigue existiendo aunque esté oculto: su
                // botón es la forma pública de cambiar a la página de apps
                // cuando el overview ya está abierto.
                const button = Main.overview.dash?.showAppsButton;
                if (button) {
                    button.checked = true;
                    return;
                }
            }
            Main.overview.showApps();
        } catch (e) {
            console.error(`${LOG} No se pudo abrir la página de aplicaciones:`, e);
        }
    }

    _createDownloadsItem() {
        let item = null;
        const count = this._downloads?.count ?? 0;
        const iconSize = this._iconSizePx;

        let theme = null;
        try {
            theme = new St.IconTheme();
        } catch (_e) {
            theme = null;
        }
        const hasIcon = name => {
            try {
                return Boolean(theme?.has_icon?.(name));
            } catch (_e) {
                return false;
            }
        };

        // Igual que Finder: carpeta de Descargas del tema (nunca un SVG
        // inventado ni la variante -symbolic, que sale blanca y plana).
        let gicon = null;
        let iconName = 'folder-download';
        if (hasIcon('folder-download')) {
            gicon = Gio.ThemedIcon.new('folder-download');
            iconName = 'folder-download';
        } else {
            try {
                const folder = this._downloads?.folder;
                if (folder) {
                    const info = folder.query_info('standard::icon',
                        Gio.FileQueryInfoFlags.NONE, null);
                    gicon = info.get_icon();
                }
            } catch (_e) {
                gicon = null;
            }
            if (!gicon)
                iconName = hasIcon('folder') ? 'folder' : 'folder-download';
        }

        item = new DockControlItem(this, {
            id: 'downloads',
            gicon,
            iconName,
            iconSize,
            label: count > 0 ? `Descargas (${count})` : 'Descargas',
            styleClass: 'tahoe-dock-downloads',
            onClick: () => this._openItemMenu(item),
            onSecondary: () => this._openFolder(this._downloads?.folder),
        });
        this._downloadsItem = item;
        this._controlItems.push(item);
        return item;
    }

    _createTrashItem() {
        let item = null;
        const count = this._trash?.count ?? 0;

        let theme = null;
        try {
            theme = new St.IconTheme();
        } catch (_e) {
            theme = null;
        }
        const hasIcon = name => {
            try {
                return Boolean(theme?.has_icon?.(name));
            } catch (_e) {
                return false;
            }
        };

        // La papelera usa el icono del tema (llena/vacía), no el symbolic.
        let iconName = count > 0 ? 'user-trash-full' : 'user-trash';
        if (!hasIcon(iconName))
            iconName = hasIcon('user-trash') ? 'user-trash' : 'user-trash-full';

        let gicon = hasIcon(iconName) ? Gio.ThemedIcon.new(iconName) : null;
        if (!gicon) {
            try {
                const info = Gio.File.new_for_uri('trash:///').query_info(
                    'standard::icon', Gio.FileQueryInfoFlags.NONE, null);
                gicon = info.get_icon();
            } catch (_e) {
                gicon = null;
            }
        }

        item = new DockControlItem(this, {
            id: 'trash',
            gicon,
            iconName,
            iconSize: this._iconSizePx,
            label: count > 0 ? `Papelera (${count})` : 'Papelera',
            styleClass: 'tahoe-dock-trash',
            onClick: () => this._openFolder(Gio.File.new_for_uri('trash:///')),
            onSecondary: () => this._openItemMenu(item),
        });
        this._trashItem = item;
        this._controlItems.push(item);
        return item;
    }

    _createMountItem(entry) {
        const item = new DockControlItem(this, {
            id: `mount:${entry.uri}`,
            gicon: entry.icon,
            label: entry.name,
            onClick: () => this._mounts.open(entry),
            onSecondary: () => this._openItemMenu(item),
        });
        item._volumeEntry = entry;
        this._controlItems.push(item);
        return item;
    }

    _destroyItems() {
        this._hideTooltip();
        this._hideDropIndicator(false);
        for (const item of [...this._items]) {
            if (!item)
                continue;
            try {
                item.destroy();
            } catch (e) {
                console.error(`${LOG} Error al destruir un actor del dock:`, e);
            }
        }
        this._items = [];
        this._appItems = [];
        this._favoriteItems = [];
        this._controlItems = [];
        this._downloadsItem = null;
        this._trashItem = null;

        if (this._root)
            this._root.destroy_all_children();
    }

    /* ------------------------------------------------------------------ */
    /* Posición, tamaño y visibilidad                                      */
    /* ------------------------------------------------------------------ */

    _positionDock() {
        if (this._destroyed || !this._root)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        // El tamaño fijo de la pasada anterior también fija el tamaño
        // preferido de Clutter; liberarlo antes de medir es imprescindible
        // para que icon-size y position cambien de verdad.
        this._root.set_width(-1);
        this._root.set_height(-1);
        this._root.queue_relayout();
        let [, , natWidth, natHeight] = this._root.get_preferred_size();
        let width = Math.ceil(natWidth);
        let height = Math.ceil(natHeight);

        if (!(width > 0) || !(height > 0)) {
            width = this._px(60);
            height = this._px(70);
        }

        const gap = this._px(DOCK_MARGIN);
        const maxWidth = Math.max(this._px(80), monitor.width - gap * 2);
        const maxHeight = Math.max(this._px(80), monitor.height - gap * 2);

        if (this._position === 'bottom')
            width = Math.min(width, maxWidth);
        else
            height = Math.min(height, maxHeight);

        let x = 0;
        let y = 0;
        if (this._position === 'bottom') {
            x = monitor.x + (monitor.width - width) / 2;
            y = monitor.y + monitor.height - height - gap;
            this._hiddenTranslation = {x: 0, y: height + gap * 2};
        } else if (this._position === 'left') {
            x = monitor.x + gap;
            y = monitor.y + (monitor.height - height) / 2;
            this._hiddenTranslation = {x: -(width + gap * 2), y: 0};
        } else {
            x = monitor.x + monitor.width - width - gap;
            y = monitor.y + (monitor.height - height) / 2;
            this._hiddenTranslation = {x: width + gap * 2, y: 0};
        }

        this._root.set_size(width, height);
        this._root.set_position(Math.round(x), Math.round(y));
        this._rootWidth = width;
        this._rootHeight = height;
        this._magCenters = null;
        this._syncReserve();
    }

    _applyEnabled() {
        if (!this._enabled) {
            this._cancelHideTimer();
            this._resetMagnification(true);
            this._hideDropIndicator(false);
            this._root?.hide();
            if (this._root)
                this._root.reactive = false;
            this._closeMenus();
            this._hideTooltip();
            this._removeReserve();
            this._restoreOriginalDash();
            this.refreshGlass();
            this._updateRevealHandler();
            return;
        }

        this._hideOriginalDash();
        this._applyVisibility(false);
        this.refreshGlass();
        this._updateRevealHandler();
    }

    _applyVisibility(animated = false) {
        if (this._destroyed || !this._root)
            return;

        this._syncReserve();

        if (!this._enabled) {
            this._root.hide();
            this._root.reactive = false;
            return;
        }

        if (!this._autohide) {
            this._revealed = true;
            this._cancelHideTimer();
            // En pantalla completa Meta ignora el workarea; ocultar el dock
            // visual evita tapar la app. La reserva se mantiene y no molesta.
            if (this._isMonitorFullscreen()) {
                this._root.hide();
                this._root.reactive = false;
                return;
            }
            this._showRoot(animated);
            return;
        }

        if (this._revealed)
            this._showRoot(animated);
        else
            this._hideRoot(animated);
    }

    _showRoot(animated = true) {
        if (!this._root || this._destroyed)
            return;

        this._revealed = true;
        const wasHidden = !this._root.visible;
        this._root.show();
        this._root.reactive = true;

        if (!animated || !wasHidden) {
            this._root.translation_x = 0;
            this._root.translation_y = 0;
            this._root.opacity = 255;
            return;
        }

        this._root.ease({
            translation_x: 0,
            translation_y: 0,
            opacity: 255,
            duration: 170,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideRoot(animated = true) {
        if (!this._root || this._destroyed)
            return;

        this._revealed = false;
        const target = this._hiddenTranslation;
        this._root.reactive = false;

        if (!animated) {
            this._root.translation_x = target.x;
            this._root.translation_y = target.y;
            this._root.opacity = 0;
            this._root.hide();
            return;
        }

        this._root.ease({
            translation_x: target.x,
            translation_y: target.y,
            opacity: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._revealed && this._root)
                    this._root.hide();
            },
        });
    }

    _revealDock() {
        if (this._destroyed || !this._enabled || !this._root)
            return;

        this._cancelHideTimer();
        const wasHidden = !this._root.visible || this._root.opacity < 255;
        this._revealed = true;
        this._showRoot(wasHidden);
    }

    _applyAutohideSetting() {
        if (this._destroyed)
            return;

        this._cancelHideTimer();
        if (!this._autohide) {
            this._revealed = true;
        } else if (this._revealed === undefined) {
            this._revealed = false;
        } else {
            this._scheduleHide();
        }

        this._applyVisibility(false);
        this._updateRevealHandler();
    }

    _updateRevealHandler() {
        const shouldConnect = this._enabled && this._autohide;

        if (shouldConnect && !this._revealSignalId) {
            this._revealSignalId = global.stage.connect('captured-event', (_actor, event) => {
                if (this._destroyed || !this._enabled || !this._autohide || this._revealed)
                    return Clutter.EVENT_PROPAGATE;
                if (event.type() !== Clutter.EventType.MOTION)
                    return Clutter.EVENT_PROPAGATE;
                const [x, y] = event.get_coords();
                if (this._inRevealZone(x, y))
                    this._revealDock();
                return Clutter.EVENT_PROPAGATE;
            });
        } else if (!shouldConnect && this._revealSignalId) {
            try {
                global.stage.disconnect(this._revealSignalId);
            } catch (_e) {
                // ya desconectado
            }
            this._revealSignalId = 0;
        }
    }

    _inRevealZone(x, y) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;

        const edge = Math.max(2, this._px(4));
        if (this._position === 'bottom') {
            return y >= monitor.y + monitor.height - edge &&
                x >= monitor.x && x <= monitor.x + monitor.width;
        } else if (this._position === 'left') {
            return x <= monitor.x + edge &&
                y >= monitor.y && y <= monitor.y + monitor.height;
        }

        return x >= monitor.x + monitor.width - edge &&
            y >= monitor.y && y <= monitor.y + monitor.height;
    }

    _scheduleHide() {
        if (this._destroyed || !this._autohide || !this._enabled)
            return;

        this._cancelHideTimer();
        if (this._anyMenuOpen() || this._root?.hover)
            return;

        this._hideTimerId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            Math.max(0, this._hideDelay), () => {
                this._hideTimerId = 0;
                if (this._destroyed || !this._autohide || !this._enabled)
                    return GLib.SOURCE_REMOVE;
                if (this._anyMenuOpen() || this._root?.hover)
                    return GLib.SOURCE_REMOVE;
                this._hideRoot(true);
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(this._hideTimerId, '[tahoe-dock] autohide');
    }

    _cancelHideTimer() {
        if (!this._hideTimerId)
            return;
        GLib.source_remove(this._hideTimerId);
        this._hideTimerId = 0;
    }

    _onMonitorsChanged() {
        if (this._destroyed)
            return;
        this._scaleFactor = this._getScaleFactor();
        this._queueRebuild();
    }

    /* ------------------------------------------------------------------ */
    /* Magnificación                                                       */
    /* ------------------------------------------------------------------ */

    _onPointerMotion(event) {
        if (this._destroyed)
            return;
        const [x, y] = event.get_coords();
        if (this._autohide) {
            this._revealDock();
            this._cancelHideTimer();
        }
        this._updateMagnificationTargets(x, y);
        this._startMagnificationTimer();
    }

    _ensureMagCenters() {
        if (this._magCenters)
            return;

        const centers = new Map();
        for (const item of this._items) {
            if (!item?.actor || !item.iconActor)
                continue;
            const [x, y] = item.actor.get_transformed_position();
            centers.set(item, {
                x: x + item.actor.width / 2,
                y: y + item.actor.height / 2,
            });
        }
        this._magCenters = centers;
    }

    _updateMagnificationTargets(pointerX, pointerY) {
        const magnify = this._magnification;
        if (!(magnify > 1.001)) {
            this._resetMagnificationTargets();
            return;
        }

        this._ensureMagCenters();
        const sigma = Math.max(1, this._iconSizePx * 0.95);
        const sigma2 = sigma * sigma;
        const vertical = this._position !== 'bottom';

        for (const item of this._items) {
            const center = this._magCenters.get(item);
            if (!center || !item.iconActor)
                continue;
            const distance = vertical
                ? pointerY - center.y
                : pointerX - center.x;
            const gaussian = Math.exp(-0.5 * (distance * distance) / sigma2);
            this._magTargets.set(item, 1 + (magnify - 1) * gaussian);
        }
    }

    _resetMagnificationTargets() {
        for (const item of this._items) {
            if (item?.iconActor)
                this._magTargets.set(item, 1);
        }
    }

    _resetMagnification(immediate = false) {
        this._stopMagnificationTimer();
        for (const item of this._items) {
            if (!item?.iconActor)
                continue;
            this._magTargets.set(item, 1);
            this._magCurrent.set(item, 1);
            item.setMagnification(1);
        }
        if (immediate)
            this._magCenters = null;
    }

    _startMagnificationTimer() {
        if (this._magTimer || this._destroyed)
            return;

        this._magLast = GLib.get_monotonic_time();
        this._magTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAG_FRAME_MS, () => {
            this._magTimer = 0;
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            return this._magnificationFrame();
        });
        GLib.Source.set_name_by_id(this._magTimer, '[tahoe-dock] magnification');
    }

    _stopMagnificationTimer() {
        if (!this._magTimer)
            return;
        GLib.source_remove(this._magTimer);
        this._magTimer = 0;
    }

    _magnificationFrame() {
        const now = GLib.get_monotonic_time();
        const dt = this._magLast
            ? clamp((now - this._magLast) / 1_000_000, 0.001, 0.05)
            : MAG_FRAME_MS / 1000;
        this._magLast = now;
        const alpha = 1 - Math.exp(-dt / MAG_TAU);

        let moving = false;
        for (const item of this._items) {
            if (!item?.iconActor)
                continue;

            const target = this._magTargets.get(item) ?? 1;
            let current = this._magCurrent.get(item) ?? 1;

            if (Math.abs(target - current) > 0.0015) {
                current += (target - current) * alpha;
                moving = true;
            } else {
                current = target;
            }

            this._magCurrent.set(item, current);
            item.setMagnification(current);
        }

        if (!moving)
            return GLib.SOURCE_REMOVE;

        this._magTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAG_FRAME_MS, () => {
            this._magTimer = 0;
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            return this._magnificationFrame();
        });
        return GLib.SOURCE_REMOVE;
    }

    /* ------------------------------------------------------------------ */
    /* Tooltip                                                             */
    /* ------------------------------------------------------------------ */

    _onItemHover(item, hovered) {
        if (this._destroyed)
            return;

        if (hovered) {
            if (this._autohide) {
                this._revealDock();
                this._cancelHideTimer();
            }
        } else if (this._autohide && !this._root?.hover) {
            this._scheduleHide();
        }
    }

    _showTooltip(item) {
        if (this._destroyed || !item || item._destroyed || !this._tooltip)
            return;
        if (this._anyMenuOpen())
            return;

        if (this._tooltipShowId) {
            GLib.source_remove(this._tooltipShowId);
            this._tooltipShowId = 0;
        }

        this._tooltipItem = item;
        this._tooltipShowId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            TOOLTIP_DELAY, () => {
                this._tooltipShowId = 0;
                if (this._destroyed || this._tooltipItem !== item ||
                    !item.actor?.hover || !this._tooltip)
                    return GLib.SOURCE_REMOVE;
                this._displayTooltip(item);
                return GLib.SOURCE_REMOVE;
            });
    }

    _displayTooltip(item) {
        const text = item.tooltipText || item.actor?.accessible_name || '';
        if (!text)
            return;

        this._tooltip.set_text(text);
        this._tooltip.opacity = 0;
        this._tooltip.show();

        const [, , naturalWidth, naturalHeight] = this._tooltip.get_preferred_size();
        const width = Math.max(1, Math.ceil(naturalWidth));
        const height = Math.max(1, Math.ceil(naturalHeight));
        const geometry = item.getIconGeometry();
        if (!geometry)
            return;

        const offset = this._px(8);
        let x;
        let y;

        if (this._position === 'bottom') {
            x = geometry.x + geometry.width / 2 - width / 2;
            y = geometry.y - height - offset;
        } else if (this._position === 'left') {
            x = geometry.x + geometry.width + offset;
            y = geometry.y + geometry.height / 2 - height / 2;
        } else {
            x = geometry.x - width - offset;
            y = geometry.y + geometry.height / 2 - height / 2;
        }

        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            x = clamp(x, monitor.x + offset, monitor.x + monitor.width - width - offset);
            y = clamp(y, monitor.y + offset, monitor.y + monitor.height - height - offset);
        }

        this._tooltip.set_position(Math.round(x), Math.round(y));
        this._tooltip.ease({
            opacity: 255,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideTooltip(item = null) {
        if (item && this._tooltipItem && item !== this._tooltipItem)
            return;

        if (this._tooltipShowId) {
            GLib.source_remove(this._tooltipShowId);
            this._tooltipShowId = 0;
        }
        this._tooltipItem = null;

        if (!this._tooltip || !this._tooltip.visible)
            return;

        this._tooltip.ease({
            opacity: 0,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._tooltip)
                    this._tooltip.hide();
            },
        });
    }

    /* ------------------------------------------------------------------ */
    /* Menús                                                               */
    /* ------------------------------------------------------------------ */

    _menuSide() {
        if (this._position === 'bottom')
            return St.Side.BOTTOM;
        if (this._position === 'left')
            return St.Side.LEFT;
        return St.Side.RIGHT;
    }

    _createMenuFor(item) {
        const menu = new PopupMenu.PopupMenu(item.actor, 0.5, this._menuSide());
        menu.actor.add_style_class_name('tahoe-dock-menu');
        try {
            menu.box.add_style_class_name('tahoe-dock-menu-content');
        } catch (_e) {
            // PopupMenu antiguo sin .box público.
        }
        Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (_menu, open) => {
            this._onMenuOpenChanged(menu, open);
        });
        item._menu = menu;
        return menu;
    }

    _onMenuOpenChanged(menu, open) {
        if (this._destroyed)
            return;
        if (open) {
            this._openMenus.add(menu);
            this._cancelHideTimer();
            this._hideTooltip();
        } else {
            this._openMenus.delete(menu);
            if (this._openMenus.size === 0 && this._autohide)
                this._scheduleHide();
        }
    }

    _anyMenuOpen() {
        return this._openMenus.size > 0;
    }

    _closeMenus() {
        for (const menu of [...this._openMenus]) {
            try {
                menu.close(BoxPointer.PopupAnimation.FULL);
            } catch (_e) {
                // El menú ya se cerró.
            }
        }
    }

    _openItemMenu(item) {
        if (this._destroyed || !item || item._destroyed)
            return;

        if (item._menu?.isOpen) {
            item._menu.close(BoxPointer.PopupAnimation.FULL);
            return;
        }

        const menu = item._menu ?? this._createMenuFor(item);

        if (item instanceof DockAppItem)
            this._populateAppMenu(menu, item);
        else if (item === this._downloadsItem)
            populateDownloadsMenu(menu, this._downloads, {
                showRecent: this._showRecentDownloads,
            });
        else if (item === this._trashItem)
            populateTrashMenu(menu, this._trash, {
                onConfirm: () => this._emptyTrash(),
                onDialog: dialog => this._trackTrashDialog(dialog),
            });
        else if (item._volumeEntry)
            populateVolumeMenu(menu, item._volumeEntry, {
                onEject: entry => this._mounts.eject(entry),
            });
        else
            return;

        if (!menu.isEmpty())
            menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _addMenuHeader(menu, text) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        item.add_style_class_name('tahoe-dock-menu-title');
        menu.addMenuItem(item);
        return item;
    }

    _populateAppMenu(menu, item) {
        const app = item.app;
        menu.removeAll();
        this._addMenuHeader(menu, app.get_name());

        let windows = [];
        try {
            windows = app.get_windows().filter(window => !window.skip_taskbar);
        } catch (_e) {
            windows = [];
        }

        if (windows.length > 0) {
            const submenu = new PopupMenu.PopupSubMenuMenuItem('Ventanas', true);
            for (const window of windows) {
                let title = window.title || app.get_name();
                if (window.minimized)
                    title = `${title} — minimizada`;
                const windowItem = submenu.menu.addAction(title, () => {
                    this._activateWindow(window);
                });
                if (global.display.focus_window === window)
                    windowItem.setOrnament(PopupMenu.Ornament.DOT);
            }
            menu.addMenuItem(submenu);
        }

        const newWindow = menu.addAction('Nueva ventana', () => {
            if (app.can_open_new_window())
                app.open_new_window(-1);
            else
                app.activate();
        }, 'window-new-symbolic');
        newWindow.setSensitive(app.can_open_new_window());

        if (windows.length > 1) {
            menu.addAction('Activar la ventana más reciente',
                () => this._activateApp(app, Clutter.BUTTON_PRIMARY),
                'focus-windows-symbolic');
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const favorite = this._isFavorite(app);
        const pin = menu.addAction(
            favorite ? 'Quitar del Dock' : 'Anclar al Dock',
            () => this._togglePin(app),
            favorite ? 'window-close-symbolic' : 'view-pin-symbolic');
        pin.setSensitive(!app.is_window_backed() && this._canEditFavorites());
    }

    _trackTrashDialog(dialog) {
        if (this._trashDialog && this._trashDialog !== dialog) {
            try {
                this._trashDialog.destroy();
            } catch (_e) {
                // ya destruido
            }
        }
        this._trashDialog = dialog;
        dialog.connect('closed', () => {
            if (this._trashDialog === dialog)
                this._trashDialog = null;
        });
    }

    async _emptyTrash() {
        if (this._destroyed)
            return;
        try {
            const deleted = await this._trash.empty();
            console.log(`${LOG} Papelera vaciada: ${deleted} elementos`);
        } catch (e) {
            console.error(`${LOG} Error al vaciar la papelera:`, e);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Acciones de aplicaciones                                            */
    /* ------------------------------------------------------------------ */

    _isFavorite(app) {
        const id = app?.get_id?.();
        if (!id)
            return false;
        if (this._usingCustomFavorites())
            return this._favoritesOverride.includes(id);
        try {
            return this._appFavorites.isFavorite(id);
        } catch (_e) {
            return false;
        }
    }

    _canEditFavorites() {
        if (this._usingCustomFavorites()) {
            try {
                return Boolean(this._settings?.is_writable?.('dock-favorites') ??
                    this._settings);
            } catch (_e) {
                return Boolean(this._settings);
            }
        }
        try {
            return global.settings.is_writable('favorite-apps');
        } catch (_e) {
            return false;
        }
    }

    _togglePin(app) {
        if (!app || app.is_window_backed())
            return;

        const id = app.get_id();
        if (this._usingCustomFavorites()) {
            const list = [...this._favoritesOverride];
            const index = list.indexOf(id);
            if (index >= 0)
                list.splice(index, 1);
            else
                list.push(id);
            this._settings?.set_strv('dock-favorites', list);
            return;
        }

        try {
            if (this._appFavorites.isFavorite(id))
                this._appFavorites.removeFavorite(id);
            else
                this._appFavorites.addFavorite(id);
        } catch (e) {
            console.error(`${LOG} No se pudo cambiar el favorito ${id}:`, e);
        }
    }

    _activateWindow(window) {
        if (!window)
            return;
        try {
            if (window.minimized)
                window.unminimize();
            Main.activateWindow(window, global.get_current_time());
        } catch (e) {
            console.error(`${LOG} No se pudo activar la ventana:`, e);
        }
    }

    _activateApp(app, button) {
        if (!app)
            return;

        const event = Clutter.get_current_event();
        const modifiers = event ? event.get_state() : 0;
        const middle = button === Clutter.BUTTON_MIDDLE;
        const ctrl = Boolean(modifiers & Clutter.ModifierType.CONTROL_MASK);

        let windows = [];
        try {
            windows = app.get_windows().filter(window => !window.skip_taskbar);
        } catch (_e) {
            windows = [];
        }

        if (middle || ctrl) {
            try {
                if (app.can_open_new_window())
                    app.open_new_window(-1);
                else
                    app.activate();
            } catch (e) {
                console.error(`${LOG} No se pudo abrir una ventana nueva:`, e);
            }
            return;
        }

        if (windows.length === 0) {
            try {
                app.activate();
            } catch (e) {
                console.error(`${LOG} No se pudo activar ${app.get_id()}:`, e);
            }
            return;
        }

        let target = null;
        try {
            const tabs = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
            target = tabs.find(window => windows.includes(window)) ?? null;
        } catch (_e) {
            target = null;
        }

        if (!target)
            target = windows.find(window => !window.minimized) ?? windows[0];

        if (target) {
            this._activateWindow(target);
            return;
        }

        try {
            app.activate();
        } catch (e) {
            console.error(`${LOG} No se pudo activar ${app.get_id()}:`, e);
        }
    }

    _openFolder(fileOrUri) {
        if (!fileOrUri)
            return;
        try {
            const uri = fileOrUri instanceof Gio.File
                ? fileOrUri.get_uri()
                : String(fileOrUri);
            Gio.AppInfo.launch_default_for_uri(uri, null);
            Main.overview.hide();
        } catch (e) {
            console.error(`${LOG} No se pudo abrir ${fileOrUri}:`, e);
        }
    }

    _later(callback) {
        try {
            const laters = global.compositor.get_laters();
            const id = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._laterIds.delete(id);
                if (!this._destroyed)
                    callback();
                return GLib.SOURCE_REMOVE;
            });
            this._laterIds.add(id);
        } catch (_e) {
            if (!this._destroyed)
                callback();
        }
    }

    _favoriteDropIndex(x, y) {
        const items = this._favoriteItems.filter(item => !item._destroyed);
        const vertical = this._position !== 'bottom';
        const coordinate = vertical ? y : x;

        for (let i = 0; i < items.length; i++) {
            const actor = items[i].actor;
            if (!actor)
                continue;
            const center = vertical
                ? actor.y + actor.height / 2
                : actor.x + actor.width / 2;
            if (coordinate < center)
                return i;
        }

        return items.length;
    }

    _insertFavorite(app, position) {
        if (!app || !this._canEditFavorites())
            return;

        const id = app.get_id();

        if (this._usingCustomFavorites()) {
            const list = this._favoritesOverride.filter(entry => entry !== id);
            const index = clamp(position, 0, list.length);
            list.splice(index, 0, id);
            this._settings?.set_strv('dock-favorites', list);
            console.log(`${LOG} favorito insertado ${id} en ${index} (dock-favorites)`);
            return;
        }

        try {
            if (this._appFavorites.isFavorite(id))
                this._appFavorites.moveFavoriteToPos(id, position);
            else
                this._appFavorites.addFavoriteAtPos(id, position);
            console.log(`${LOG} favorito insertado ${id} en ${position} (favorite-apps)`);
        } catch (e) {
            console.error(`${LOG} No se pudo reordenar ${id}:`, e);
        }
    }

    _unfavorite(app, reason = '') {
        if (this._destroyed || !app || !this._canEditFavorites())
            return false;

        const id = app.get_id();
        if (!id || !this._isFavorite(app))
            return false;

        if (this._usingCustomFavorites()) {
            const list = this._favoritesOverride.filter(entry => entry !== id);
            try {
                this._settings?.set_strv('dock-favorites', list);
            } catch (e) {
                console.error(`${LOG} No se pudo desanclar ${id} del dock:`, e);
                return false;
            }
        } else {
            try {
                this._appFavorites.removeFavorite(id);
            } catch (e) {
                console.error(`${LOG} No se pudo desanclar ${id}:`, e);
                return false;
            }
        }

        console.log(`${LOG} desanclado ${id}${reason ? ` (${reason})` : ''}`);
        return true;
    }

    _appFromDragSource(source) {
        if (!source)
            return null;
        // Fuente del propio dock: DockDragSource (sin .app para que otros
        // targets del shell no abran ventanas al soltar fuera).
        if (source._dockItem?.app)
            return source._dockItem.app;
        if (source.app)
            return source.app;
        if (source._delegate?.app)
            return source._delegate.app;
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Indicador de inserción y sesión de arrastre                         */
    /* ------------------------------------------------------------------ */

    _connectDragMonitor() {
        if (this._dragMonitor)
            return;

        this._dragMonitor = {
            dragMotion: event => this._onDragMonitorMotion(event),
            dragDrop: event => this._onDragMonitorDrop(event),
        };

        try {
            DND.addDragMonitor(this._dragMonitor);
        } catch (e) {
            console.error(`${LOG} No se pudo conectar el monitor DND:`, e);
            this._dragMonitor = null;
        }
    }

    _onDragMonitorMotion(event) {
        if (!this._destroyed && this._dropIndicatorIndex >= 0 &&
            !this._isPointInsideDock(event.x, event.y))
            this._hideDropIndicator();

        return DND.DragMotionResult.CONTINUE;
    }

    _onDragMonitorDrop(event) {
        if (!this._destroyed && this._dragSession) {
            let x = event.x;
            let y = event.y;
            try {
                [x, y] = event.clutterEvent.get_coords();
            } catch (_e) {
                // Algunos consumidores no entregan el evento Clutter.
            }
            const inside = this._isPointInsideDock(x, y);
            this._dragSession.drop = {x, y, inside};
            console.log(`${LOG} drop ${inside ? 'dentro' : 'fuera'} del dock ` +
                `(${Math.round(x)},${Math.round(y)})`);
        }

        this._hideDropIndicator(false);
        return DND.DragDropResult.CONTINUE;
    }

    _isPointInsideDock(x, y) {
        if (!this._root || !this._root.visible || !this._root.mapped)
            return false;

        const rect = this._root.get_transformed_extents();
        return x >= rect.origin.x && x <= rect.origin.x + rect.size.width &&
            y >= rect.origin.y && y <= rect.origin.y + rect.size.height;
    }

    _isOverDockControl(x, y) {
        // Papelera, Descargas, montajes y rejilla de apps no son zonas de
        // inserción de favoritos. Soltar ahí no debe reordenar ni desanclar.
        for (const item of this._controlItems) {
            const actor = item.actor;
            if (!actor || item._destroyed)
                continue;
            if (x >= actor.x && x <= actor.x + actor.width &&
                y >= actor.y && y <= actor.y + actor.height)
                return true;
        }
        return false;
    }

    /* ------------------------------------------------------------------ */
    /* Proxy visual del arrastre                                           */
    /* ------------------------------------------------------------------ */

    _raiseDragProxy() {
        const proxy = this._dragProxy;
        if (!proxy || !proxy.visible)
            return;
        const group = Main.layoutManager.uiGroup ?? Main.uiGroup;
        try {
            if (proxy.get_parent() === group && group.get_last_child() !== proxy)
                group.set_child_above_sibling(proxy, null);
        } catch (_e) {
            // El actor salió de uiGroup durante el apagado.
        }
    }

    _syncDragProxy() {
        this._dragProxyTimer = 0;
        const proxy = this._dragProxy;
        const item = this._dragProxyItem;
        if (this._destroyed || !proxy || !item ||
            this._dragSession?.item !== item) {
            return GLib.SOURCE_REMOVE;
        }

        // DND crea _dragActor después de emitir drag-begin. Su posición es la
        // fuente de verdad: el proxy la copia cada frame y no depende de que
        // llegue un movimiento ni de que el actor nativo sea visible.
        const native = item._draggable?._dragActor;
        if (!native) {
            this._dragProxyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16,
                () => this._syncDragProxy());
            return GLib.SOURCE_REMOVE;
        }

        try {
            const x = Math.round(native.x);
            const y = Math.round(native.y);
            proxy.set_position(x, y);
            if (!this._dragProxyShown) {
                this._dragProxyShown = true;
                // Pequeña entrada: evita el "pop" seco y deja ver la elevación.
                const baseScale = this._dragProxyBaseScale;
                proxy.set_scale(baseScale * 0.82, baseScale * 0.82);
                proxy.opacity = 0;
                proxy.show();
                proxy.ease({
                    opacity: 255,
                    scale_x: baseScale,
                    scale_y: baseScale,
                    duration: 130,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            this._raiseDragProxy();
        } catch (e) {
            console.error(`${LOG} No se pudo seguir el icono de arrastre:`, e);
            this._finishDragProxy(false);
            return GLib.SOURCE_REMOVE;
        }

        this._dragProxyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16,
            () => this._syncDragProxy());
        return GLib.SOURCE_REMOVE;
    }

    _startDragProxy(item) {
        this._destroyDragProxy();
        if (this._destroyed || !item || typeof item.createDragProxy !== 'function')
            return false;

        let proxy = null;
        try {
            proxy = item.createDragProxy();
        } catch (e) {
            console.error(`${LOG} No se pudo crear el proxy de arrastre:`, e);
            return false;
        }
        if (!proxy)
            return false;

        let added = false;
        try {
            Main.layoutManager.addTopChrome(proxy, {
                affectsStruts: false,
                trackFullscreen: false,
            });
            this._dragProxyChrome = true;
            added = true;
        } catch (e) {
            console.warn(`${LOG} addTopChrome falló para el proxy; ` +
                `se usa uiGroup:`, e);
        }
        if (!added) {
            try {
                // addTopChrome pudo añadir el actor y fallar al trackearlo.
                if (!proxy.get_parent())
                    Main.uiGroup.add_child(proxy);
                this._dragProxyChrome = false;
                added = true;
            } catch (e) {
                console.error(`${LOG} No se pudo añadir el proxy de arrastre:`, e);
                proxy.destroy();
                return false;
            }
        }

        try {
            // No debe interceptar el picking de DND (PickMode.ALL).
            Shell.util_set_hidden_from_pick(proxy, true);
        } catch (e) {
            console.error(`${LOG} No se pudo ocultar el proxy del picking; ` +
                `se usa el actor nativo:`, e);
            try {
                if (this._dragProxyChrome)
                    Main.layoutManager.removeChrome(proxy);
                else
                    proxy.get_parent()?.remove_child(proxy);
            } catch (_e2) {
                // ya estaba fuera del chrome
            }
            proxy.destroy();
            return false;
        }

        this._dragProxy = proxy;
        this._dragProxyItem = item;
        this._dragProxyShown = false;
        this._dragProxyFinishing = false;
        this._dragProxyBaseScale = proxy.scale_x || 1;
        proxy.visible = false;
        proxy.opacity = 0;
        proxy.reactive = false;
        this._dragProxyHome = item.getIconGeometry?.() ?? null;
        this._raiseDragProxy();

        this._dragProxyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16,
            () => this._syncDragProxy());
        GLib.Source.set_name_by_id(this._dragProxyTimer,
            '[tahoe-dock] drag proxy');
        return true;
    }

    _finishDragProxy(success) {
        if (this._dragProxyTimer) {
            GLib.source_remove(this._dragProxyTimer);
            this._dragProxyTimer = 0;
        }

        const proxy = this._dragProxy;
        if (!proxy || this._dragProxyFinishing)
            return;
        this._dragProxyFinishing = true;

        if (!this._dragProxyShown) {
            this._destroyDragProxy();
            return;
        }

        if (success) {
            // El drop ya se aceptó: el icono se desvanece en el puntero.
            const scale = Math.max(0.75, proxy.scale_x * 0.82);
            proxy.ease({
                opacity: 0,
                scale_x: scale,
                scale_y: scale,
                duration: 130,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._destroyDragProxy(),
            });
            return;
        }

        // Cancelación (Esc, drop no aceptado): vuela de vuelta al icono de
        // origen mientras DND hace lo mismo con su actor invisible.
        let target = this._dragProxyHome;
        try {
            const live = this._dragProxyItem?.getIconGeometry?.();
            if (live)
                target = live;
        } catch (_e) {
            // El origen ya se destruyó; se usa la geometría guardada.
        }

        const width = proxy.width || this._iconSizePx;
        const targetScale = target?.width > 0
            ? clamp(target.width / width, 0.25, 1.6)
            : Math.max(0.35, proxy.scale_x);
        const targetX = target
            ? target.x + target.width / 2 - width / 2
            : proxy.x;
        const targetY = target
            ? target.y + target.height / 2 - width / 2
            : proxy.y;

        proxy.ease({
            x: targetX,
            y: targetY,
            opacity: 0,
            scale_x: targetScale,
            scale_y: targetScale,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._destroyDragProxy(),
        });
    }

    _destroyDragProxy() {
        if (this._dragProxyTimer) {
            try {
                GLib.source_remove(this._dragProxyTimer);
            } catch (_e) {
                // La fuente ya se ejecutó.
            }
            this._dragProxyTimer = 0;
        }

        const proxy = this._dragProxy;
        const wasChrome = this._dragProxyChrome;
        this._dragProxy = null;
        this._dragProxyItem = null;
        this._dragProxyChrome = false;
        this._dragProxyShown = false;
        this._dragProxyFinishing = false;
        this._dragProxyBaseScale = 1;
        this._dragProxyHome = null;
        if (!proxy)
            return;

        try {
            if (wasChrome)
                Main.layoutManager.removeChrome(proxy);
            else
                proxy.get_parent()?.remove_child(proxy);
        } catch (_e) {
            // El actor ya estaba fuera del chrome o destruido.
        }
        try {
            proxy.destroy();
        } catch (_e) {
            // Ya estaba destruido.
        }
    }

    _onItemDragBegin(item) {
        if (this._destroyed || !item)
            return;

        this._hideTooltip();
        this._dragSession = {
            item,
            app: item.app,
            favorite: Boolean(item.isFavorite),
            drop: null,
        };
        // Si el proxy no se puede crear, el actor compuesto que devuelve DND
        // queda visible como respaldo.
        const proxyReady = this._startDragProxy(item);
        item.setNativeDragActorVisible?.(!proxyReady);
        console.log(`${LOG} drag-begin ${item.app?.get_id?.() ?? '?'} ` +
            `favorito=${item.isFavorite} proxy=${proxyReady}`);
    }

    _onItemDragCancelled(item) {
        if (this._destroyed || this._dragSession?.item !== item)
            return;
        this._hideDropIndicator();
        this._finishDragProxy(false);
        console.log(`${LOG} drag-cancelled ${item.app?.get_id?.() ?? '?'}`);
    }

    _onItemDestroyed(item) {
        // Un rebuild puede destruir el actor de origen mientras se arrastra.
        // Se limpia la sesión sin tocar favoritos: destruir no es un drop.
        if (this._dragSession?.item !== item)
            return;
        this._dragSession = null;
        this._hideDropIndicator();
        // Sin origen no hay a dónde volver: retirar el proxy de inmediato para
        // no dejar un icono fantasma sobre la pantalla.
        this._destroyDragProxy();
        console.log(`${LOG} drag-session limpiada al destruir ` +
            `${item.app?.get_id?.() ?? '?'}`);
    }

    _onItemDragEnd(item, success) {
        const session = this._dragSession;
        this._dragSession = null;
        this._hideDropIndicator();
        this._finishDragProxy(Boolean(success));

        if (!session || session.item !== item)
            return;

        const drop = session.drop;
        console.log(`${LOG} drag-end ${session.app?.get_id?.() ?? '?'} ` +
            `success=${Boolean(success)} ` +
            `drop=${drop ? (drop.inside ? 'dentro' : 'fuera') : 'ninguno'}`);

        // Sin un drop real (Esc, destrucción del actor, cancelación) no se
        // toca la lista de favoritos. Sólo un favorito soltado fuera del dock
        // se desancla; si la app sigue en ejecución se reconstruirá como
        // icono de app en ejecución.
        if (!drop || drop.inside || !session.favorite ||
            !this._canEditFavorites() || !this._isFavorite(session.app))
            return;

        const app = session.app;
        this._later(() => {
            if (!this._destroyed && this._isFavorite(app))
                this._unfavorite(app, 'arrastrado fuera del dock');
        });
    }

    _createDropIndicator() {
        if (this._dropIndicator)
            return this._dropIndicator;

        const indicator = new St.Widget({
            name: 'tahoe-dock-drop-indicator',
            style_class: 'tahoe-dock-drop-indicator',
            style: 'background-color: rgba(10, 132, 255, 0.95);' +
                'border-radius: 2px;' +
                'box-shadow: 0 0 6px rgba(10, 132, 255, 0.75);',
            reactive: false,
            can_focus: false,
            track_hover: false,
            visible: false,
            opacity: 0,
        });

        const group = Main.layoutManager.uiGroup ?? Main.uiGroup;
        try {
            group.add_child(indicator);
            group.set_child_above_sibling(indicator, null);
            // No debe interceptar el picking de DND (PickMode.ALL).
            Shell.util_set_hidden_from_pick(indicator, true);
        } catch (e) {
            console.error(`${LOG} No se pudo añadir el indicador de inserción:`, e);
            indicator.destroy();
            return null;
        }

        indicator.connect('destroy', () => {
            if (this._dropIndicator === indicator)
                this._dropIndicator = null;
        });

        this._dropIndicator = indicator;
        return indicator;
    }

    _favoriteSlotRect(index) {
        const items = this._favoriteItems.filter(item =>
            !item._destroyed && item.actor);
        const vertical = this._position !== 'bottom';
        const thickness = Math.max(2, this._px(3));
        const gap = Math.max(2, this._px(4));
        const barSize = Math.max(this._px(12), this._iconSizePx + this._px(4));
        const rootRect = this._root.get_transformed_extents();
        let along;

        if (items.length === 0) {
            const firstApp = this._appItems.find(item =>
                !item._destroyed && item.actor)?.actor;
            if (firstApp) {
                const rect = firstApp.get_transformed_extents();
                along = vertical
                    ? rect.origin.y - gap / 2
                    : rect.origin.x - gap / 2;
            } else {
                along = vertical
                    ? rootRect.origin.y + gap
                    : rootRect.origin.x + gap;
            }
        } else if (index < items.length) {
            const rect = items[index].actor.get_transformed_extents();
            along = vertical
                ? rect.origin.y - gap / 2
                : rect.origin.x - gap / 2;
        } else {
            const rect = items[items.length - 1].actor.get_transformed_extents();
            along = vertical
                ? rect.origin.y + rect.size.height + gap / 2
                : rect.origin.x + rect.size.width + gap / 2;
        }

        if (vertical) {
            const x = rootRect.origin.x + (rootRect.size.width - barSize) / 2;
            return [Math.round(x), Math.round(along - thickness / 2),
                Math.round(barSize), thickness];
        }

        const y = rootRect.origin.y + (rootRect.size.height - barSize) / 2;
        return [Math.round(along - thickness / 2), Math.round(y),
            thickness, Math.round(barSize)];
    }

    _showDropIndicator(index) {
        if (this._destroyed || !this._root || !this._enabled ||
            !this._root.visible || !this._canEditFavorites()) {
            this._hideDropIndicator();
            return;
        }

        const rect = this._favoriteSlotRect(index);
        const indicator = this._createDropIndicator();
        if (!indicator)
            return;

        // handleDragOver() se invoca en cada movimiento. Si el índice no
        // cambia no hay que reiniciar la animación de opacidad: eso la dejaba
        // congelada a medio fundido.
        if (this._dropIndicatorIndex === index && indicator.visible &&
            indicator.opacity > 0)
            return;

        const wasVisible = indicator.visible && indicator.opacity > 0;
        indicator.set_size(rect[2], rect[3]);
        if (wasVisible) {
            indicator.ease({
                x: rect[0],
                y: rect[1],
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            // Si estaba a medio fundido (por ejemplo al volver a entrar en el
            // dock antes de que terminase el fade-out), retomar la entrada.
            if (indicator.opacity < 255) {
                try {
                    indicator.remove_transition('opacity');
                } catch (_e) {
                    // Sin transición previa.
                }
                indicator.ease({
                    opacity: 255,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        } else {
            try {
                indicator.remove_transition('opacity');
            } catch (_e) {
                // Sin transición previa.
            }
            indicator.set_position(rect[0], rect[1]);
            indicator.opacity = 0;
            indicator.show();
            indicator.ease({
                opacity: 255,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._dropIndicatorIndex = index;
    }

    _hideDropIndicator(animated = true) {
        this._dropIndicatorIndex = -1;
        const indicator = this._dropIndicator;
        if (!indicator)
            return;

        try {
            indicator.remove_transition('opacity');
        } catch (_e) {
            // Sin transición previa.
        }

        if (!indicator.visible)
            return;

        if (!animated) {
            indicator.opacity = 0;
            indicator.hide();
            return;
        }

        indicator.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._dropIndicator === indicator &&
                    this._dropIndicatorIndex < 0)
                    indicator.hide();
            },
        });
    }

    _destroyDropIndicator() {
        const indicator = this._dropIndicator;
        this._dropIndicator = null;
        this._dropIndicatorIndex = -1;
        if (!indicator)
            return;

        try {
            indicator.get_parent()?.remove_child(indicator);
            indicator.destroy();
        } catch (_e) {
            // Ya estaba destruido.
        }
    }

    handleDragOver(source, _actor, x, y, _time) {
        const app = this._appFromDragSource(source);
        if (!app || app.is_window_backed?.() || !this._canEditFavorites() ||
            this._isOverDockControl(x, y)) {
            this._hideDropIndicator();
            return DND.DragMotionResult.NO_DROP;
        }

        // El indicador es un actor superpuesto en uiGroup (no un hijo del
        // BoxLayout), así que no altera la posición de los iconos ni el
        // índice calculado en acceptDrop().
        const index = this._favoriteDropIndex(x, y);
        if (index !== this._dropIndicatorIndex)
            console.log(`${LOG} drag-over indice=${index} (${Math.round(x)},${Math.round(y)})`);
        this._showDropIndicator(index);
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, _actor, x, y, _time) {
        const app = this._appFromDragSource(source);
        if (!app || app.is_window_backed?.() || !this._canEditFavorites() ||
            this._isOverDockControl(x, y)) {
            this._hideDropIndicator(false);
            return false;
        }

        // El índice visual incluye el icono arrastrado. Al quitarlo de la
        // lista antes de insertarlo hay que compensar si estaba a la
        // izquierda/arriba del punto de inserción.
        let position = this._favoriteDropIndex(x, y);
        const id = app.get_id();
        const current = this._favoriteAppsList()
            .findIndex(favorite => favorite.get_id() === id);
        if (current >= 0 && current < position)
            position--;

        this._hideDropIndicator(false);
        this._later(() => {
            if (!this._destroyed)
                this._insertFavorite(app, position);
        });
        return true;
    }

    /* ------------------------------------------------------------------ */
    /* Indicadores de aplicaciones en ejecución                            */
    /* ------------------------------------------------------------------ */

    _onAppsChanged() {
        if (this._destroyed)
            return;

        const {favorites, extras} = this._desiredApps();
        const ids = [...favorites, ...extras].map(app => app.get_id());
        if (!arraysEqual(ids, this._appIds))
            this._queueRebuild();
        else
            this._queueIndicatorSync();
    }

    _queueRebuild() {
        if (this._destroyed || this._rebuildId)
            return;

        this._rebuildId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => {
            this._rebuildId = 0;
            if (!this._destroyed)
                this._rebuild();
        });
    }

    _queueIndicatorSync() {
        if (this._destroyed || this._indicatorId)
            return;

        this._indicatorId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => {
            this._indicatorId = 0;
            if (!this._destroyed)
                this._syncIndicators();
        });
    }

    _bindWindowSignals() {
        for (const [window, id] of this._windowSignalIds) {
            try {
                window.disconnect(id);
            } catch (_e) {
                // La ventana ya desapareció.
            }
        }
        this._windowSignalIds = [];

        const seen = new Set();
        for (const item of this._appItems) {
            let windows = [];
            try {
                windows = item.app.get_windows().filter(window => !window.skip_taskbar);
            } catch (_e) {
                windows = [];
            }

            for (const window of windows) {
                if (seen.has(window))
                    continue;
                seen.add(window);
                for (const signal of ['notify::minimized', 'notify::title',
                    'notify::skip-taskbar']) {
                    try {
                        this._windowSignalIds.push([
                            window,
                            window.connect(signal, () => this._queueIndicatorSync()),
                        ]);
                    } catch (_e) {
                        // Señal no disponible.
                    }
                }
                try {
                    this._windowSignalIds.push([
                        window,
                        window.connect('unmanaged', () => this._onAppsChanged()),
                    ]);
                } catch (_e) {
                    // Señal no disponible.
                }
            }
        }
    }

    _syncIndicators() {
        if (this._destroyed)
            return;

        this._bindWindowSignals();

        let focusedApp = null;
        try {
            const focus = global.display.focus_window;
            if (focus)
                focusedApp = this._windowTracker.get_window_app(focus);
        } catch (_e) {
            focusedApp = null;
        }

        for (const item of this._appItems) {
            let windows = [];
            try {
                windows = item.app.get_windows().filter(window => !window.skip_taskbar);
            } catch (_e) {
                windows = [];
            }
            const focused = focusedApp &&
                (focusedApp === item.app ||
                 focusedApp.get_id?.() === item.app.get_id());
            item.syncWindows(windows, focused);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Modelos de Descargas / Papelera / Volúmenes                         */
    /* ------------------------------------------------------------------ */

    _onDownloadsChanged() {
        if (this._destroyed)
            return;

        const count = this._downloads?.count ?? 0;
        const item = this._downloadsItem;
        if (item && !item._destroyed) {
            item.setName(count > 0 ? `Descargas (${count})` : 'Descargas');
            if (item._menu?.isOpen) {
                populateDownloadsMenu(item._menu, this._downloads, {
                    showRecent: this._showRecentDownloads,
                });
            }
        }
    }

    _onTrashChanged() {
        if (this._destroyed)
            return;

        const count = this._trash?.count ?? 0;
        const item = this._trashItem;
        if (item && !item._destroyed) {
            item.setName(count > 0 ? `Papelera (${count})` : 'Papelera');

            let theme = null;
            try {
                theme = new St.IconTheme();
            } catch (_e) {
                theme = null;
            }
            const hasIcon = name => {
                try {
                    return Boolean(theme?.has_icon?.(name));
                } catch (_e) {
                    return false;
                }
            };
            let iconName = count > 0 ? 'user-trash-full' : 'user-trash';
            if (!hasIcon(iconName))
                iconName = hasIcon('user-trash') ? 'user-trash' : 'user-trash-full';
            if (hasIcon(iconName))
                item.setGIcon(Gio.ThemedIcon.new(iconName));
            else
                item.setIconName(iconName);

            if (item._menu?.isOpen) {
                populateTrashMenu(item._menu, this._trash, {
                    onConfirm: () => this._emptyTrash(),
                    onDialog: dialog => this._trackTrashDialog(dialog),
                });
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Cristal Liquid Glass                                                */
    /* ------------------------------------------------------------------ */

    _isDark() {
        if (this._theme && typeof this._theme.isDark === 'boolean')
            return this._theme.isDark;
        if (this._interfaceSettings) {
            try {
                return this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
            } catch (_e) {
                return false;
            }
        }
        try {
            return Main.uiGroup.has_style_class_name('tahoe-theme-dark');
        } catch (_e) {
            return false;
        }
    }

    refreshGlass() {
        if (this._destroyed || !this._root || !this._ready)
            return;

        const wanted = this._glassEnabled && this._enabled && Boolean(this._glassEngine);
        if (!wanted) {
            this._destroyGlassHandle();
            this._root.remove_style_class_name('tahoe-dock-glass');
            return;
        }
        const look = glassLook(
            this._theme ?? {isDark: this._isDark()}, {
                cornerRadius: this._px(GLASS_RADIUS),
                blurRadius: this._px(16),
                owner: 'tahoe-dock',
                shadow: true,
            });

        if (this._glassHandle) {
            try {
                this._glassHandle.update(look);
                this._root.add_style_class_name('tahoe-dock-glass');
            } catch (e) {
                console.error(`${LOG} No se pudo actualizar el cristal:`, e);
                this._destroyGlassHandle();
                this._root.remove_style_class_name('tahoe-dock-glass');
            }
            return;
        }

        try {
            this._glassHandle = this._glassEngine.attach(this._root, look);
            this._root.add_style_class_name('tahoe-dock-glass');
        } catch (e) {
            console.error(`${LOG} No se pudo crear el cristal del dock:`, e);
            this._glassHandle = null;
            this._root.remove_style_class_name('tahoe-dock-glass');
        }
    }

    _destroyGlassHandle() {
        if (!this._glassHandle)
            return;
        try {
            this._glassHandle.destroy();
        } catch (e) {
            console.error(`${LOG} Error al destruir el cristal del dock:`, e);
        }
        this._glassHandle = null;
    }

    /* ------------------------------------------------------------------ */
    /* Dash nativo                                                         */
    /* ------------------------------------------------------------------ */

    _hideOriginalDash() {
        if (this._destroyed || !this._enabled || this._dash)
            return;

        let dash = null;
        try {
            dash = Main.overview.dash ?? null;
        } catch (_e) {
            dash = null;
        }

        if (!dash) {
            if (this._dashRetryId || this._dashRetryCount >= 40)
                return;
            this._dashRetryCount++;
            this._dashRetryId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 250, () => {
                this._dashRetryId = 0;
                this._hideOriginalDash();
            });
            GLib.Source.set_name_by_id(this._dashRetryId, '[tahoe-dock] hide dash');
            return;
        }

        this._dash = dash;
        this._dashWasVisible = dash.visible;
        this._dashWasReactive = dash.reactive;
        this._dashDestroyId = dash.connect('destroy', () => {
            if (this._dash === dash) {
                this._dash = null;
                this._dashDestroyId = 0;
            }
        });
        try {
            dash.hide();
            dash.reactive = false;
        } catch (e) {
            console.error(`${LOG} No se pudo ocultar el dash nativo:`, e);
            this._dash = null;
            this._dashDestroyId = 0;
        }
    }

    _restoreOriginalDash() {
        if (this._dashRetryId) {
            GLib.source_remove(this._dashRetryId);
            this._dashRetryId = 0;
        }

        const dash = this._dash;
        this._dash = null;
        if (!dash)
            return;

        if (this._dashDestroyId) {
            try {
                dash.disconnect(this._dashDestroyId);
            } catch (_e) {
                // ya destruido
            }
            this._dashDestroyId = 0;
        }

        try {
            dash.visible = this._dashWasVisible ?? true;
            dash.reactive = this._dashWasReactive ?? true;
        } catch (e) {
            console.error(`${LOG} No se pudo restaurar el dash nativo:`, e);
        }
    }

    /* ------------------------------------------------------------------ */
    /* API pública para el animador externo y para extension.js            */
    /* ------------------------------------------------------------------ */

    /**
     * Rectángulo en coordenadas del stage del icono de una aplicación o de
     * una ventana concreta. Devuelve null si esa app no está en el dock.
     */
    getIconGeometry(appOrWindow) {
        if (this._destroyed || !appOrWindow)
            return null;

        let app = null;

        if (appOrWindow instanceof Shell.App) {
            app = appOrWindow;
        } else if (this._windowTracker) {
            try {
                app = this._windowTracker.get_window_app(appOrWindow);
            } catch (_e) {
                app = null;
            }
        }

        if (!app) {
            for (const item of this._appItems) {
                let windows = [];
                try {
                    windows = item.app.get_windows();
                } catch (_e) {
                    windows = [];
                }
                if (windows.includes(appOrWindow)) {
                    app = item.app;
                    break;
                }
            }
        }

        if (!app)
            return null;

        const id = app.get_id?.();
        const item = this._appItems.find(entry =>
            entry.app === app || entry.app.get_id?.() === id);
        return item?.getIconGeometry() ?? null;
    }

    /** Alias para el contrato del animador Aladdin/genie. */
    getTargetRect(windowOrApp) {
        return this.getIconGeometry(windowOrApp);
    }

    /* ------------------------------------------------------------------ */
    /* Destrucción                                                         */
    /* ------------------------------------------------------------------ */

    _disconnectSignals() {
        for (const [object, id] of this._signalIds) {
            try {
                object.disconnect(id);
            } catch (_e) {
                // El objeto ya no existe.
            }
        }
        this._signalIds = [];

        for (const [window, id] of this._windowSignalIds) {
            try {
                window.disconnect(id);
            } catch (_e) {
                // La ventana ya no existe.
            }
        }
        this._windowSignalIds = [];
    }

    _disconnectTheme() {
        if (this._theme && this._themeId) {
            try {
                this._theme.disconnect(this._themeId);
            } catch (_e) {
                // ya desconectado
            }
        }
        this._themeId = 0;

        if (this._interfaceSettings && this._interfaceSignalId) {
            try {
                this._interfaceSettings.disconnect(this._interfaceSignalId);
            } catch (_e) {
                // ya desconectado
            }
        }
        this._interfaceSignalId = 0;
        this._interfaceSettings = null;
    }

    _destroyTooltip() {
        this._hideTooltip();
        const tooltip = this._tooltip;
        this._tooltip = null;
        if (!tooltip)
            return;

        try {
            if (this._tooltipChrome)
                Main.layoutManager.removeChrome(tooltip);
            else
                tooltip.get_parent()?.remove_child(tooltip);
        } catch (_e) {
            // ya estaba fuera del chrome
        }
        tooltip.destroy();
    }

    _destroyModels() {
        this._downloads?.destroy();
        this._trash?.destroy();
        this._mounts?.destroy();
        this._downloads = null;
        this._trash = null;
        this._mounts = null;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._ready = false;

        if (this._dragMonitor) {
            try {
                DND.removeDragMonitor(this._dragMonitor);
            } catch (_e) {
                // Ya estaba desconectado.
            }
            this._dragMonitor = null;
        }
        this._dragSession = null;
        this._destroyDragProxy();
        this._destroyDropIndicator();

        this._removeReserve();

        for (const id of [this._rebuildId, this._indicatorId, this._hideTimerId,
            this._tooltipShowId, this._dashRetryId]) {
            if (id) {
                try {
                    GLib.source_remove(id);
                } catch (_e) {
                    // ya ejecutado
                }
            }
        }
        this._rebuildId = 0;
        this._indicatorId = 0;
        this._hideTimerId = 0;
        this._tooltipShowId = 0;
        this._dashRetryId = 0;

        this._stopMagnificationTimer();
        this._cancelHideTimer();

        if (this._revealSignalId) {
            try {
                global.stage.disconnect(this._revealSignalId);
            } catch (_e) {
                // ya desconectado
            }
            this._revealSignalId = 0;
        }

        if (this._settingsId) {
            try {
                this._settings.disconnect(this._settingsId);
            } catch (_e) {
                // ya desconectado
            }
            this._settingsId = 0;
        }

        this._disconnectSignals();
        this._disconnectTheme();

        if (this._glassUnsubscribe) {
            try {
                this._glassUnsubscribe();
            } catch (_e) {
                // ya cancelado
            }
            this._glassUnsubscribe = null;
        }
        this._destroyGlassHandle();
        this._glassEngine = null;

        if (this._trashDialog) {
            try {
                this._trashDialog.destroy();
            } catch (_e) {
                // ya destruido
            }
            this._trashDialog = null;
        }

        this._closeMenus();
        this._openMenus.clear();
        this._destroyModels();
        this._destroyItems();
        this._destroyTooltip();

        if (this._root) {
            const root = this._root;
            this._root = null;
            try {
                if (this._rootChrome)
                    Main.layoutManager.removeChrome(root);
                else
                    root.get_parent()?.remove_child(root);
            } catch (_e) {
                // ya estaba fuera del chrome
            }
            root.destroy();
        }

        for (const id of [...this._laterIds]) {
            try {
                global.compositor.get_laters().remove(id);
            } catch (_e) {
                // ya ejecutado
            }
        }
        this._laterIds.clear();

        this._restoreOriginalDash();
        this._unloadStylesheet();

        this._magCurrent.clear();
        this._magTargets.clear();
        this._magCenters = null;
        this._items = [];
        this._appItems = [];
        this._favoriteItems = [];
        this._controlItems = [];
        this._menuManager = null;
        this._settings = null;
        this._theme = null;
        this._extension = null;
        this._downloadsItem = null;
        this._trashItem = null;
        this._tooltipItem = null;
    }
}
