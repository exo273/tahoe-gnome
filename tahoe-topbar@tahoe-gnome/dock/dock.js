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
// valores por defecto defensivos. Vive enteramente en uiGroup mediante
// Main.layoutManager.addChrome(), sin affectsStruts, y esconde el dash nativo
// mientras está activo (restaurándolo en destroy).

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
        const imagePath = GLib.build_filenamev([
            this._extensionDir, 'dock', 'icons', 'downloads.svg',
        ]);
        item = new DockControlItem(this, {
            id: 'downloads',
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(imagePath)}),
            label: count > 0 ? `Descargas (${count})` : 'Descargas',
            styleClass: 'tahoe-dock-downloads',
            badge: true,
            onClick: () => this._openItemMenu(item),
            onSecondary: () => this._openFolder(this._downloads?.folder),
        });
        item.setBadge(count);
        this._downloadsItem = item;
        this._controlItems.push(item);
        return item;
    }

    _createTrashItem() {
        let item = null;
        const count = this._trash?.count ?? 0;
        item = new DockControlItem(this, {
            id: 'trash',
            iconName: count > 0 ? 'user-trash-full-symbolic' : 'user-trash-symbolic',
            label: count > 0 ? `Papelera (${count})` : 'Papelera',
            styleClass: 'tahoe-dock-trash',
            badge: true,
            onClick: () => this._openFolder(Gio.File.new_for_uri('trash:///')),
            onSecondary: () => this._openItemMenu(item),
        });
        item.setBadge(count);
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
    }

    _applyEnabled() {
        if (!this._enabled) {
            this._cancelHideTimer();
            this._resetMagnification(true);
            this._root?.hide();
            if (this._root)
                this._root.reactive = false;
            this._closeMenus();
            this._hideTooltip();
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

        if (!this._enabled) {
            this._root.hide();
            this._root.reactive = false;
            return;
        }

        if (!this._autohide) {
            this._revealed = true;
            this._cancelHideTimer();
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
        if (this._usingCustomFavorites())
            return Boolean(this._settings);
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
        const id = app.get_id();

        if (this._usingCustomFavorites()) {
            const list = this._favoritesOverride.filter(entry => entry !== id);
            const index = clamp(position, 0, list.length);
            list.splice(index, 0, id);
            this._settings?.set_strv('dock-favorites', list);
            return;
        }

        try {
            if (this._appFavorites.isFavorite(id))
                this._appFavorites.moveFavoriteToPos(id, position);
            else
                this._appFavorites.addFavoriteAtPos(id, position);
        } catch (e) {
            console.error(`${LOG} No se pudo reordenar ${id}:`, e);
        }
    }

    _appFromDragSource(source) {
        if (!source)
            return null;
        if (source.app)
            return source.app;
        if (source._delegate?.app)
            return source._delegate.app;
        return null;
    }

    handleDragOver(source, _actor, _x, _y, _time) {
        const app = this._appFromDragSource(source);
        if (!app || app.is_window_backed?.())
            return DND.DragMotionResult.NO_DROP;
        if (!this._canEditFavorites())
            return DND.DragMotionResult.NO_DROP;
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, _actor, x, y, _time) {
        const app = this._appFromDragSource(source);
        if (!app || app.is_window_backed?.() || !this._canEditFavorites())
            return false;

        const position = this._favoriteDropIndex(x, y);
        this._later(() => this._insertFavorite(app, position));
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
            item.setBadge(count);
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
            item.setBadge(count);
            item.setName(count > 0 ? `Papelera (${count})` : 'Papelera');
            item.setIconName(count > 0
                ? 'user-trash-full-symbolic'
                : 'user-trash-symbolic');
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
