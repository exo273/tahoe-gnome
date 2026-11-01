// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Centro de control estilo macOS Tahoe.
//
// La interfaz replica la rejilla de 4 columnas de Tahoe: módulos de cristal
// flotantes sobre el fondo, sin panel contenedor. Los controladores de estado
// (NM, Bluetooth, UPower, MPRIS, Gvc) y la restauración de QuickSettings se
// mantienen separados de la construcción visual.

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {getRfkillManager} from 'resource:///org/gnome/shell/ui/status/rfkill.js';

import {applyGlass, removeGlass} from './glass.js';
import {glassLook, stageRect} from '../liquidGlass.js';
import {
    BatteryIcon,
    CircleButton,
    createFooterPill,
    createDetailHeader,
    createSectionHeader,
    createListRow,
    createControlCenterGlyph,
    TahoeSlider,
} from './widgets.js';
import {ControlRegistry} from './registry.js';
import {ControlCenterEditor} from './editor.js';
import {
    cloneLayout,
    layoutToJSON,
    parseLayout,
    sizeSpan,
    TahoeGridLayout,
    TahoeItemLayout,
    TahoeOverlayLayout,
} from './layout.js';

import {NetworkController} from './network.js';
import {BluetoothController} from './bluetooth.js';
import {BatteryController, PowerProfilesController, PROFILE_INFO, formatDuration} from './power.js';
import {MediaController} from './media.js';
import {TahoeNotifications} from './notifications.js';

const LOG = '[tahoe-topbar/cc]';

const ROLES = {
    battery: 'tahoeCCBattery',
    sound: 'tahoeCCSound',
    wifi: 'tahoeCCWifi',
    controlCenter: 'tahoeControlCenter',
};

const COLOR_SETTINGS = 'org.gnome.desktop.interface';
const NOTIFICATION_SETTINGS = 'org.gnome.desktop.notifications';
const COLOR_PLUGIN_SETTINGS = 'org.gnome.settings-daemon.plugins.color';

function scaleFactor() {
    try {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (_e) {
        return 1;
    }
}

function px(value) {
    return Math.max(1, Math.round(value * scaleFactor()));
}

function openSettingsPanel(panel) {
    try {
        const app = Shell.AppSystem.get_default()
            .lookup_app('org.gnome.Settings.desktop');

        if (app) {
            if (Main.overview?.visible)
                Main.overview.hide();

            const param = new GLib.Variant('av', [
                new GLib.Variant('(sav)', [panel, []]),
            ]);
            app.activate_action('launch-panel', param, 0, -1, null)
                .catch(e => console.error(`${LOG} No se pudo abrir el panel «${panel}»:`, e));
            return;
        }
    } catch (e) {
        console.error(`${LOG} No se pudo usar la acción launch-panel:`, e);
    }

    try {
        Util.spawn(['gnome-control-center', panel]);
    } catch (e) {
        console.error(`${LOG} No se pudo lanzar gnome-control-center ${panel}:`, e);
    }
}

function openSettingsApp() {
    try {
        const app = Shell.AppSystem.get_default()
            .lookup_app('org.gnome.Settings.desktop');
        if (app) {
            if (Main.overview?.visible)
                Main.overview.hide();
            app.activate();
            return;
        }
    } catch (e) {
        console.error(`${LOG} No se pudo abrir Ajustes:`, e);
    }

    try {
        Util.spawn(['gnome-control-center']);
    } catch (e) {
        console.error(`${LOG} No se pudo lanzar gnome-control-center:`, e);
    }
}

function signalName(strength) {
    if (strength < 20)
        return 'none';
    if (strength < 40)
        return 'weak';
    if (strength < 50)
        return 'ok';
    if (strength < 80)
        return 'good';
    return 'excellent';
}

export class TahoeControlCenter {
    constructor(extension) {
        this._extension = extension ?? null;
        this._destroyed = false;
        this._tracked = new Set();
        this._timeoutIds = new Set();
        this._idleIds = new Set();
        this._glassActors = new Set();
        this._roundActors = new Set();
        this._cardActors = new Set();
        this._footerActors = new Set();
        this._mainGlassHandles = [];
        this._sheetHandles = new Set();
        this._popoverHandles = new Map();
        this._glassEngine = null;
        this._glassStyle = 'liquid';
        this._glassUnsubscribe = null;

        this._theme = null;
        this._cssFile = null;
        this._tahoeTheme = null;
        this._themeChangedId = 0;
        this._isLight = true;

        this._settings = null;
        this._interfaceSettings = null;
        this._notificationSettings = null;
        this._colorSettings = null;

        this._panel = Main.panel;
        this._originalToggleQuickSettings = null;
        this._toggleQuickSettingsOverride = null;

        this._qs = null;
        this._qsIndicators = null;
        this._qsDetached = [];
        this._qsDetachedSet = new Set();
        this._qsWatchedChildren = new Set();
        this._qsWasVisible = true;
        this._qsTempVisible = false;
        this._qsPanelGone = false;
        this._qsContainerGone = false;
        this._qsMenuGone = false;
        this._qsGridActor = null;
        this._panelButtonsGone = false;
        this._qsRestoring = false;
        this._qsScanIdleId = 0;
        this._brightnessAnchor = null;
        this._brightnessIndicator = null;
        this._originalAddExternalIndicator = null;
        this._addExternalIndicatorOverride = null;

        this._batteryButton = null;
        this._soundButton = null;
        this._wifiButton = null;
        this._ccButton = null;

        this._batteryLabel = null;
        this._batteryIcon = null;
        this._soundPanelIcon = null;
        this._wifiPanelIcon = null;

        this._batteryPopoverBox = null;
        this._wifiPopoverBox = null;
        this._soundPopoverBox = null;
        this._soundPopoverRefs = null;

        this._ccRoot = null;
        this._ccRow = null;
        this._ccColumn = null;
        this._ccStage = null;
        this._notifications = null;
        this._editorOverlay = null;
        this._editor = null;
        this._menubarControls = [];
        this._menubarExtra = new Map();
        this._menubarPopovers = new Map();
        this._catalogJson = '';
        this._view = 'main';
        this._mainRefs = null;
        this._detailRefs = null;
        this._detailView = null;

        this._network = null;
        this._bluetooth = null;
        this._battery = null;
        this._powerProfiles = null;
        this._media = null;
        this._rfkill = null;

        this._mixer = null;
        this._sink = null;
        this._updatingBrightnessSlider = false;
        this._updatingVolumeSlider = false;

        this._syncTimeoutId = 0;

        this._registry = null;
        this._externalEntries = [];
        this._externalSyncId = 0;
        this._layout = null;
        this._layoutApplying = false;
        this._availabilityKey = '';
        this._editMode = false;
        this._rendering = false;
        this._keyboardBacklight = null;
        this._externalMenuHome = null;

        this._loadStylesheet();
        this._loadSettings();
        this._bindTheme();

        this._glassStyle = this._getString('glass-style', 'liquid');
        this._glassUnsubscribe = this._extension?.onGlassEngineChanged?.(
            engine => this._setGlassEngine(engine)) ?? null;

        this._createControllers();
        try {
            this._registry = new ControlRegistry(this);
        } catch (e) {
            console.error(`${LOG} No se pudo crear el registro de controles:`, e);
            this._registry = null;
        }
        this._bindControllers();
        this._setupVolume();

        this._createPanelButtons();
        try {
            this._notifications = new TahoeNotifications(this);
            this._ccColumn?.add_child(this._notifications.actor);
        } catch (e) {
            console.error(`${LOG} No se pudieron crear las notificaciones:`, e);
            this._notifications = null;
        }
        this._watchPanelLifetimes();
        try {
            this._editor = new ControlCenterEditor(this);
        } catch (e) {
            console.error(`${LOG} No se pudo crear el editor:`, e);
            this._editor = null;
        }
        this._loadMenubarControls();
        this._hideQuickSettingsIndicators();
        this._overrideQuickSettingsShortcut();
        this._connectDesktopSignals();

        this._syncAll();
    }

    // ------------------------------------------------------------------
    // Estilos y ajustes
    // ------------------------------------------------------------------

    _loadStylesheet() {
        try {
            const base = this._extension?.path ?? '';
            if (!base)
                throw new Error('La extensión no tiene ruta');

            const path = GLib.build_filenamev([
                base,
                'controlCenter',
                'controlCenter.css',
            ]);

            this._cssFile = Gio.File.new_for_path(path);
            this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            this._theme.load_stylesheet(this._cssFile);
        } catch (e) {
            console.error(`${LOG} No se pudo cargar controlCenter.css:`, e);
            this._theme = null;
            this._cssFile = null;
        }
    }

    _unloadStylesheet() {
        if (!this._theme || !this._cssFile)
            return;

        try {
            this._theme.unload_stylesheet(this._cssFile);
        } catch (e) {
            console.error(`${LOG} No se pudo descargar controlCenter.css:`, e);
        }

        this._theme = null;
        this._cssFile = null;
    }

    _loadSettings() {
        try {
            this._settings = this._extension?.getSettings() ?? null;
        } catch (e) {
            console.error(`${LOG} No se pudieron leer los ajustes:`, e);
            this._settings = null;
        }

        try {
            this._interfaceSettings = new Gio.Settings({schema_id: COLOR_SETTINGS});
        } catch (e) {
            console.error(`${LOG} No se pudo leer org.gnome.desktop.interface:`, e);
            this._interfaceSettings = null;
        }

        try {
            this._notificationSettings = new Gio.Settings({schema_id: NOTIFICATION_SETTINGS});
        } catch (e) {
            console.error(`${LOG} No se pudo leer org.gnome.desktop.notifications:`, e);
            this._notificationSettings = null;
        }

        try {
            this._colorSettings = new Gio.Settings({schema_id: COLOR_PLUGIN_SETTINGS});
        } catch (e) {
            console.error(`${LOG} No se pudo leer el complemento de color:`, e);
            this._colorSettings = null;
        }

        if (this._settings) {
            for (const key of [
                'control-center-show-battery-percent',
                'control-center-show-now-playing',
                'control-center-notifications',
                'control-center-layout',
                'menubar-controls',
                'glass-style',
            ]) {
                this._connect(this._settings, `changed::${key}`,
                    () => this._onSettingsChanged(key));
            }
        }
    }

    _bindTheme() {
        this._tahoeTheme = this._extension?._theme ?? null;
        this._isLight = !(this._tahoeTheme?.isDark ?? true);

        if (this._tahoeTheme)
            this._themeChangedId = this._tahoeTheme.connect(() => this._onThemeChanged());
    }

    _onThemeChanged() {
        if (this._destroyed)
            return;

        this._isLight = !(this._tahoeTheme?.isDark ?? true);

        // El CSS global recolorea todos los actores; hay que refrescar el
        // cristal (motor o blur) y los elementos pintados con Cairo.
        this._refreshGlass();
        this._applyGlassLook();
        this._repaintDrawings();
        this._notifications?.refreshLook();
        this._editor?.refreshLook?.();
        this._queueSync();
    }

    _setGlassEngine(engine) {
        this._glassEngine = engine;
        this._glassStyle = this._getString('glass-style', 'liquid');
        if (!this._destroyed)
            this._rebuildGlass();
    }

    _refreshGlass() {
        for (const actor of this._glassActors) {
            try {
                if (!actor?.get_stage())
                    continue;
                if (this._glassStyle !== 'blur') {
                    removeGlass(actor);
                    continue;
                }
                const radius = actor._tahoeGlass?.radius ??
                    actor._tahoeGlassRadius ?? 24;
                applyGlass(actor, {
                    radius,
                    blur: true,
                    dark: !this._isLight,
                });
            } catch (e) {
                console.error(`${LOG} No se pudo actualizar el cristal:`, e);
            }
        }
    }

    _applyGlassLook() {
        const look = glassLook(this._tahoeTheme);
        for (const handle of this._mainGlassHandles)
            handle.update(look);
        for (const handle of this._sheetHandles)
            handle.update(look);
        for (const handle of this._popoverHandles.values())
            handle.update(look);
    }

    /**
     * Suelta todas las superficies y las rehace según el estilo actual. Se
     * llama al cambiar glass-style o cuando aparece/desaparece el motor.
     */
    _rebuildGlass() {
        this._destroyAllGlassHandles();
        this._refreshGlass();
        if (this._glassStyle !== 'liquid' || !this._glassEngine)
            return;

        if (this._ccButton?.menu.isOpen) {
            if (this._view === 'main')
                this._renderMain();
            else
                this._renderDetail();
        }

        this._editor?.refreshGlass?.();
        this._notifications?.refreshGlass();

        for (const [menu, owner] of [
            [this._batteryButton?.menu, 'cc-battery'],
            [this._soundButton?.menu, 'cc-sound'],
            [this._wifiButton?.menu, 'cc-wifi'],
        ]) {
            if (menu?.isOpen)
                this._attachPopoverGlass(menu, owner);
        }
    }

    _destroyAllGlassHandles() {
        this._destroyMainGlassHandles();
        for (const handle of [...this._sheetHandles])
            handle.destroy();
        this._sheetHandles.clear();
        for (const handle of this._popoverHandles.values())
            handle.destroy();
        this._popoverHandles.clear();
    }

    _destroyMainGlassHandles() {
        for (const handle of this._mainGlassHandles)
            handle.destroy();
        this._mainGlassHandles = [];
    }

    _attachPopoverGlass(menu, owner) {
        if (!this._glassEngine || !menu?.box)
            return;
        if (this._popoverHandles.has(menu))
            return;

        const handle = this._glassEngine.attach(menu.box, glassLook(this._tahoeTheme, {
            cornerRadius: 22,
            blurRadius: 10,
            owner,
        }));
        this._popoverHandles.set(menu, handle);
    }

    _detachPopoverGlass(menu) {
        const handle = this._popoverHandles.get(menu);
        if (!handle)
            return;
        handle.destroy();
        this._popoverHandles.delete(menu);
    }

    _repaintDrawings() {
        for (const item of this._mainRefs?.controls ?? []) {
            try {
                item.built?.repaint?.();
            } catch (_e) {
                // Actor ya destruido.
            }
        }

        for (const actor of [
            this._batteryIcon,
            this._detailRefs?.slider,
            this._soundPopoverRefs?.slider,
        ]) {
            try {
                actor?.queue_repaint?.();
            } catch (_e) {
                // Actor ya destruido.
            }
        }
    }

    _onSettingsChanged(key) {
        if (this._destroyed)
            return;

        switch (key) {
        case 'glass-style': {
            const style = this._getString('glass-style', 'liquid');
            if (style === this._glassStyle)
                break;
            this._glassStyle = style;
            this._rebuildGlass();
            break;
        }
        case 'control-center-layout':
            this._onLayoutChanged();
            break;
        case 'control-center-notifications':
            this._notifications?.setEnabled(
                this._getBoolean('control-center-notifications', true));
            break;
        case 'menubar-controls':
            this._onMenubarControlsChanged();
            break;
        default:
            this._queueSync();
            break;
        }
    }

    _getBoolean(key, fallback = false) {
        try {
            return this._settings?.get_boolean(key) ?? fallback;
        } catch (_e) {
            return fallback;
        }
    }

    _getString(key, fallback = '') {
        try {
            return this._settings?.get_string(key) ?? fallback;
        } catch (_e) {
            return fallback;
        }
    }

    // ------------------------------------------------------------------
    // Señales
    // ------------------------------------------------------------------

    _connect(object, signal, callback) {
        if (!object)
            return 0;

        try {
            const id = object.connectObject(signal, callback, this);
            this._tracked.add(object);
            return id;
        } catch (e) {
            console.error(`${LOG} No se pudo conectar «${signal}»:`, e);
            return 0;
        }
    }

    _disconnectTracked() {
        for (const object of this._tracked) {
            try {
                object.disconnectObject(this);
            } catch (_e) {
                // El objeto ya no existe.
            }
        }
        this._tracked.clear();
    }

    _addTimeout(interval, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._timeoutIds.delete(id);
            if (!this._destroyed)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutIds.add(id);
        return id;
    }

    _addIdle(callback) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleIds.delete(id);
            if (!this._destroyed)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._idleIds.add(id);
        return id;
    }

    _queueSync() {
        if (this._destroyed || this._syncTimeoutId)
            return;

        this._syncTimeoutId = this._addTimeout(60, () => {
            this._syncTimeoutId = 0;
            this._syncAll();
        });
    }

    // ------------------------------------------------------------------
    // Controladores
    // ------------------------------------------------------------------

    _createControllers() {
        try {
            this._network = new NetworkController();
        } catch (e) {
            console.error(`${LOG} No se pudo crear el controlador de red:`, e);
            this._network = null;
        }

        try {
            this._bluetooth = new BluetoothController();
        } catch (e) {
            console.error(`${LOG} No se pudo crear el controlador Bluetooth:`, e);
            this._bluetooth = null;
        }

        try {
            this._battery = new BatteryController();
        } catch (e) {
            console.error(`${LOG} No se pudo crear el controlador de batería:`, e);
            this._battery = null;
        }

        try {
            this._powerProfiles = new PowerProfilesController();
        } catch (e) {
            console.error(`${LOG} No se pudo crear el controlador de perfiles:`, e);
            this._powerProfiles = null;
        }

        try {
            this._media = new MediaController();
        } catch (e) {
            console.error(`${LOG} No se pudo crear el controlador MPRIS:`, e);
            this._media = null;
        }

        try {
            this._rfkill = getRfkillManager();
        } catch (e) {
            console.error(`${LOG} No se pudo obtener el gestor de rfkill:`, e);
            this._rfkill = null;
        }
    }

    _bindControllers() {
        for (const controller of [
            this._network,
            this._bluetooth,
            this._battery,
            this._powerProfiles,
            this._media,
        ]) {
            if (controller)
                this._connect(controller, 'changed', () => this._queueSync());
        }

        if (this._rfkill) {
            this._connect(this._rfkill, 'notify::airplane-mode', () => this._queueSync());
            this._connect(this._rfkill, 'notify::hw-airplane-mode', () => this._queueSync());
            this._connect(this._rfkill, 'notify::show-airplane-mode', () => this._queueSync());
        }
    }

    _setupVolume() {
        try {
            this._mixer = getMixerControl();
        } catch (e) {
            console.error(`${LOG} No se pudo obtener el mezclador de audio:`, e);
            this._mixer = null;
            return;
        }

        this._connect(this._mixer, 'state-changed', () => {
            this._readSink();
            this._queueSync();
        });
        this._connect(this._mixer, 'default-sink-changed', () => {
            this._readSink();
            this._queueSync();
        });
        this._connect(this._mixer, 'output-added', () => this._queueSync());
        this._connect(this._mixer, 'output-removed', () => this._queueSync());
        this._connect(this._mixer, 'active-output-update', () => this._queueSync());

        this._readSink();
    }

    _readSink() {
        let sink = null;
        try {
            sink = this._mixer?.get_default_sink() ?? null;
        } catch (_e) {
            sink = null;
        }

        if (sink === this._sink) {
            this._queueSync();
            return;
        }

        if (this._sink) {
            try {
                this._sink.disconnectObject(this);
            } catch (_e) {
                // Ignorar.
            }
        }

        this._sink = sink;

        if (sink) {
            this._connect(sink, 'notify::volume', () => this._queueSync());
            this._connect(sink, 'notify::is-muted', () => this._queueSync());
            this._connect(sink, 'notify::port', () => this._queueSync());
        }

        this._queueSync();
    }

    // ------------------------------------------------------------------
    // Cristal
    // ------------------------------------------------------------------

    _bucketForRadius(radius) {
        if (radius >= 30)
            return this._roundActors;
        if (radius >= 20)
            return this._cardActors;
        return this._footerActors;
    }

    _addGlass(actor, radius) {
        if (!actor || this._destroyed)
            return actor;

        this._glassActors.add(actor);
        actor._tahoeGlassRadius = radius;
        actor.connect('destroy', () => {
            this._glassActors.delete(actor);
            this._roundActors.delete(actor);
            this._cardActors.delete(actor);
            this._footerActors.delete(actor);
        });

        if (this._glassStyle === 'liquid' && this._glassEngine) {
            if (radius === 22) {
                const handle = this._glassEngine.attach(actor,
                    glassLook(this._tahoeTheme, {
                        cornerRadius: 22,
                        blurRadius: 12,
                        owner: 'cc-sheet',
                    }));
                this._sheetHandles.add(handle);
                actor.connect('destroy', () => {
                    handle.destroy();
                    this._sheetHandles.delete(handle);
                });
                return actor;
            }

            this._bucketForRadius(radius).add(actor);
            return actor;
        }

        // Con blur o sin efecto, el viejo Shell.BlurEffect sólo se aplica en
        // el estilo blur; el idle espera a que el actor esté en el escenario.
        this._addIdle(() => {
            if (this._destroyed || this._glassStyle !== 'blur')
                return;
            try {
                if (!actor.get_stage())
                    return;
                applyGlass(actor, {
                    radius,
                    blur: true,
                    dark: !this._isLight,
                });
            } catch (e) {
                console.error(`${LOG} No se pudo aplicar el cristal:`, e);
            }
        });

        return actor;
    }

    _animateIn(actor) {
        if (!actor)
            return;

        actor.set_pivot_point(0.5, 0.5);
        actor.opacity = 0;
        actor.set_scale(0.96, 0.96);
        actor.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // ------------------------------------------------------------------
    // Botones de la barra
    // ------------------------------------------------------------------

    _createPanelButtons() {
        this._createBatteryButton();
        this._createSoundButton();
        this._createWifiButton();
        this._createControlCenterButton();
    }

    /**
     * El shell puede destruir el panel (o sus hijos) antes que la extensión,
     * p. ej. al apagar la sesión. Se anulan las referencias en el mismo
     * instante para que los idles de sincronización no toquen actores
     * disposed.
     */
    _watchPanelLifetimes() {
        const watch = (actor, key) => {
            if (!actor)
                return;
            actor.connect('destroy', () => {
                if (this[key] === actor)
                    this[key] = null;
            });
        };

        watch(this._batteryButton, '_batteryButton');
        watch(this._batteryLabel, '_batteryLabel');
        watch(this._batteryIcon, '_batteryIcon');
        watch(this._batteryPopoverBox, '_batteryPopoverBox');
        watch(this._soundButton, '_soundButton');
        watch(this._soundPanelIcon, '_soundPanelIcon');
        watch(this._soundPopoverBox, '_soundPopoverBox');
        watch(this._wifiButton, '_wifiButton');
        watch(this._wifiPanelIcon, '_wifiPanelIcon');
        watch(this._wifiPopoverBox, '_wifiPopoverBox');
        watch(this._ccButton, '_ccButton');
        watch(this._ccRoot, '_ccRoot');

        for (const button of [this._batteryButton, this._soundButton,
            this._wifiButton, this._ccButton]) {
            button?.connect('destroy', () => {
                this._panelButtonsGone = true;
            });
        }
    }

    _setButtonOpen(button, open) {
        if (!button)
            return;
        try {
            if (open)
                button.add_style_class_name('tahoe-cc-open');
            else
                button.remove_style_class_name('tahoe-cc-open');
        } catch (_e) {
            // Ignorar.
        }
    }

    _createBatteryButton() {
        this._batteryButton = new PanelMenu.Button(0.0, 'Batería', false);
        this._batteryButton.add_style_class_name('tahoe-cc-panel-button');
        this._batteryButton.add_style_class_name('tahoe-cc-battery-button');

        const box = new St.BoxLayout({
            style_class: 'tahoe-cc-battery-box',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._batteryLabel = new St.Label({
            style_class: 'tahoe-cc-battery-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._batteryIcon = new BatteryIcon();

        box.add_child(this._batteryLabel);
        box.add_child(this._batteryIcon);
        this._batteryButton.add_child(box);

        this._batteryButton.menu.actor.add_style_class_name('tahoe-cc-menu');
        this._batteryButton.menu.actor.add_style_class_name('tahoe-cc-popover');
        this._batteryButton.menu.actor.add_style_class_name('tahoe-cc-battery-popover');

        this._batteryPopoverBox = new St.BoxLayout({
            style_class: 'tahoe-cc-popover-inner',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._batteryButton.menu.box.add_child(this._batteryPopoverBox);

        this._connect(this._batteryButton.menu, 'open-state-changed', (_menu, open) => {
            this._setButtonOpen(this._batteryButton, open);
            if (open) {
                this._buildBatteryPopover();
                this._attachPopoverGlass(this._batteryButton.menu, 'cc-battery');
            }
        });
        this._connect(this._batteryButton.menu, 'menu-closed',
            () => this._detachPopoverGlass(this._batteryButton.menu));

        this._insertPanelButton(ROLES.battery, this._batteryButton);
    }

    _createSoundButton() {
        this._soundButton = new PanelMenu.Button(0.0, 'Sonido', false);
        this._soundButton.add_style_class_name('tahoe-cc-panel-button');
        this._soundButton.add_style_class_name('tahoe-cc-sound-button');

        this._soundPanelIcon = new St.Icon({
            style_class: 'tahoe-cc-panel-icon',
            icon_size: 16,
            icon_name: 'audio-volume-medium-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._soundButton.add_child(this._soundPanelIcon);

        this._soundButton.menu.actor.add_style_class_name('tahoe-cc-menu');
        this._soundButton.menu.actor.add_style_class_name('tahoe-cc-popover');
        this._soundButton.menu.actor.add_style_class_name('tahoe-cc-sound-popover');

        this._soundPopoverBox = new St.BoxLayout({
            style_class: 'tahoe-cc-popover-inner',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._soundButton.menu.box.add_child(this._soundPopoverBox);

        this._connect(this._soundButton.menu, 'open-state-changed', (_menu, open) => {
            this._setButtonOpen(this._soundButton, open);
            if (open) {
                this._buildSoundPopover();
                this._attachPopoverGlass(this._soundButton.menu, 'cc-sound');
            } else {
                this._soundPopoverRefs = null;
            }
        });
        this._connect(this._soundButton.menu, 'menu-closed',
            () => this._detachPopoverGlass(this._soundButton.menu));

        this._connect(this._soundButton, 'scroll-event', (actor, event) => {
            this._onSoundScroll(event);
            return Clutter.EVENT_STOP;
        });

        this._insertPanelButton(ROLES.sound, this._soundButton);
    }

    _createWifiButton() {
        this._wifiButton = new PanelMenu.Button(0.0, 'Wi-Fi', false);
        this._wifiButton.add_style_class_name('tahoe-cc-panel-button');
        this._wifiButton.add_style_class_name('tahoe-cc-wifi-button');

        this._wifiPanelIcon = new St.Icon({
            style_class: 'tahoe-cc-panel-icon',
            icon_size: 16,
            icon_name: 'network-wireless-signal-none-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._wifiButton.add_child(this._wifiPanelIcon);

        this._wifiButton.menu.actor.add_style_class_name('tahoe-cc-menu');
        this._wifiButton.menu.actor.add_style_class_name('tahoe-cc-popover');
        this._wifiButton.menu.actor.add_style_class_name('tahoe-cc-wifi-popover');

        this._wifiPopoverBox = new St.BoxLayout({
            style_class: 'tahoe-cc-popover-inner',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._wifiButton.menu.box.add_child(this._wifiPopoverBox);

        this._connect(this._wifiButton.menu, 'open-state-changed', (_menu, open) => {
            this._setButtonOpen(this._wifiButton, open);
            if (open) {
                this._buildWifiPopover();
                this._attachPopoverGlass(this._wifiButton.menu, 'cc-wifi');
                this._network?.requestScan();
                this._addTimeout(900, () => {
                    if (this._wifiButton?.menu.isOpen)
                        this._buildWifiPopover();
                });
            }
        });
        this._connect(this._wifiButton.menu, 'menu-closed',
            () => this._detachPopoverGlass(this._wifiButton.menu));

        this._insertPanelButton(ROLES.wifi, this._wifiButton);
    }

    _createControlCenterButton() {
        this._ccButton = new PanelMenu.Button(0.0, 'Centro de control', false);
        this._ccButton.add_style_class_name('tahoe-cc-panel-button');
        this._ccButton.add_style_class_name('tahoe-cc-panel-center');
        this._ccButton.add_child(createControlCenterGlyph());

        this._ccButton.menu.actor.add_style_class_name('tahoe-cc-menu');
        this._ccButton.menu.actor.add_style_class_name('tahoe-cc-main-menu');

        this._ccRoot = new St.BoxLayout({
            style_class: 'tahoe-cc-root',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });

        // La fila alberga [galería | columna]. La columna contiene el CC y,
        // debajo, la pila de notificaciones; así el CC se puede limpiar al
        // cambiar de vista sin arrastrar la pila y la galería conserva su
        // posición a la izquierda.
        this._ccRow = new St.BoxLayout({
            style_class: 'tahoe-cc-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
        });

        this._ccColumn = new St.BoxLayout({
            style_class: 'tahoe-cc-column',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: false,
            y_align: Clutter.ActorAlign.START,
        });
        this._ccColumn.add_child(this._ccRoot);
        this._ccRow.add_child(this._ccColumn);

        // Escenario con BinLayout: fila + capa para menú contextual y
        // proxies de arrastre (posicionados por translation_x/y).
        this._ccStage = new St.Widget({
            style_class: 'tahoe-cc-stage',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._editorOverlay = new St.Widget({
            style_class: 'tahoe-cc-editor-overlay',
            layout_manager: new TahoeOverlayLayout(),
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._ccStage.add_child(this._ccRow);
        this._ccStage.add_child(this._editorOverlay);
        this._ccButton.menu.box.add_child(this._ccStage);

        this._connect(this._ccButton.menu, 'open-state-changed', (_menu, open) => {
            this._setButtonOpen(this._ccButton, open);
            if (open) {
                this._view = 'main';
                this._renderMain();
                this._notifications?.setOpen(true);
                this._network?.requestScan();
                this._queueSync();
            }
        });

        this._connect(this._ccButton.menu, 'menu-closed', () => {
            this._notifications?.setOpen(false);
            this._clearView();
        });

        this._insertPanelButton(ROLES.controlCenter, this._ccButton);
    }

    _insertPanelButton(role, button) {
        const existing = this._panel?.statusArea?.[role];
        if (existing) {
            try {
                delete this._panel.statusArea[role];
                existing.destroy();
            } catch (_e) {
                // Indicador residual.
            }
        }

        let index = 0;
        try {
            const rightBox = this._panel._rightBox;
            const clock = this._panel.statusArea?.dateMenu?.container;
            if (clock && clock.get_parent() === rightBox)
                index = rightBox.get_children().indexOf(clock);
            else
                index = rightBox.get_n_children();

            this._panel.addToStatusArea(role, button, Math.max(0, index), 'right');
        } catch (e) {
            console.error(`${LOG} No se pudo añadir el botón «${role}»:`, e);
            try {
                this._panel.addToStatusArea(role, button, 0, 'right');
            } catch (error) {
                console.error(`${LOG} Tampoco se pudo añadir al final:`, error);
            }
        }
    }

    _removePanelButton(role, button) {
        if (!button)
            return;

        try {
            if (this._panel?.statusArea?.[role] === button)
                delete this._panel.statusArea[role];
        } catch (_e) {
            // Ignorar.
        }

        try {
            button.destroy();
        } catch (e) {
            console.error(`${LOG} No se pudo destruir el botón «${role}»:`, e);
        }
    }

    // ------------------------------------------------------------------
    // Ajustes rápidos de GNOME (misma lógica que la versión anterior)
    // ------------------------------------------------------------------

    _isManagedIndicator(actor) {
        const qs = this._qs;
        if (!qs || !actor)
            return false;

        if (this._brightnessAnchor && actor === this._brightnessAnchor)
            return false;

        if (this._qsDetachedSet.has(actor))
            return true;

        return [
            '_network',
            '_bluetooth',
            '_volumeOutput',
            '_system',
            '_brightness',
            '_nightLight',
            '_darkMode',
            '_doNotDisturb',
            '_powerProfiles',
            '_rfkill',
            '_autoRotate',
            '_backlight',
            '_thunderbolt',
        ].some(name => qs[name] === actor);
    }

    _hideQuickSettingsIndicators() {
        const qs = Main.panel?.statusArea?.quickSettings;
        if (!qs?._indicators)
            return;

        this._qs = qs;
        this._qsIndicators = qs._indicators;
        this._qsGridActor = qs.menu?._grid ?? null;
        this._qsPanelGone = false;
        this._qsContainerGone = false;
        this._qsMenuGone = false;
        this._qsWasVisible = qs.container?.visible ?? true;

        this._qsIndicators.connect('destroy', () => {
            this._qsIndicators = null;
            this._qsPanelGone = true;
        });
        qs.container?.connect('destroy', () => {
            this._qsContainerGone = true;
        });
        qs.menu?.actor?.connect('destroy', () => {
            this._qsMenuGone = true;
            this._qsGridActor = null;
        });

        // Si el ancla de brillo no está disponible (por ejemplo, porque el
        // escaneo diferido aún no ha corrido), desviamos la inserción de
        // indicadores externos para no depender de quickSettings._brightness.
        if (!this._originalAddExternalIndicator) {
            this._originalAddExternalIndicator = qs.addExternalIndicator;
            this._addExternalIndicatorOverride = (indicator, colSpan = 1) => {
                let sibling = null;
                if (this._brightnessAnchor?.get_parent() === this._qsIndicators)
                    sibling = this._brightnessAnchor;
                else if (qs._brightness?.get_parent() === this._qsIndicators)
                    sibling = qs._brightness;

                try {
                    this._qsIndicators.insert_child_below(indicator, sibling);
                } catch (_e) {
                    this._qsIndicators.add_child(indicator);
                }

                try {
                    const itemSibling = qs._backgroundApps?.quickSettingsItems?.at(-1) ?? null;
                    qs._addItemsBefore(indicator.quickSettingsItems, itemSibling, colSpan);
                } catch (e) {
                    console.error(`${LOG} No se pudieron añadir los ítems externos:`, e);
                }
            };
            qs.addExternalIndicator = this._addExternalIndicatorOverride;
        }

        // Al iniciar sesión, QuickSettings._setupIndicators() añade los
        // indicadores y justo después usa qs._brightness.quickSettingsItems.
        // Si los quitamos en el mismo instante rompemos esa inicialización,
        // así que diferimos el escaneo a un idle (ya habrá terminado).
        this._connect(this._qsIndicators, 'child-added', () => {
            if (this._qsRestoring)
                return;
            this._queueQuickSettingsScan();
        });
        this._connect(this._qsIndicators, 'child-removed', () => {
            if (this._qsRestoring)
                return;
            this._syncQuickSettingsVisibility();
        });

        const grid = this._quickSettingsGrid();
        if (grid) {
            this._connect(grid, 'child-added', () => {
                if (!this._qsRestoring)
                    this._queueExternalRefresh();
            });
            this._connect(grid, 'child-removed', () => {
                if (!this._qsRestoring)
                    this._queueExternalRefresh();
            });
        }

        this._connect(qs.menu, 'open-state-changed', (_menu, open) => {
            if (!open) {
                this._qsTempVisible = false;
                this._syncQuickSettingsVisibility();
            }
        });

        this._scanQuickSettingsIndicators();
    }

    _queueQuickSettingsScan() {
        if (this._qsScanIdleId)
            return;

        this._qsScanIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._qsScanIdleId = 0;
            if (!this._qsRestoring && !this._qsPanelGone && !this._destroyed)
                this._scanQuickSettingsIndicators();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scanQuickSettingsIndicators() {
        if (!this._qsIndicators || this._qsPanelGone || this._destroyed)
            return;

        for (const child of [...this._qsIndicators.get_children()]) {
            if (this._isManagedIndicator(child))
                this._detachIndicator(child);
            else
                this._watchIndicator(child);
        }

        this._syncQuickSettingsVisibility();
    }

    _watchIndicator(actor) {
        if (!actor || this._qsWatchedChildren.has(actor))
            return;

        this._qsWatchedChildren.add(actor);
        this._connect(actor, 'notify::visible',
            () => this._syncQuickSettingsVisibility());
    }

    _detachIndicator(actor) {
        if (!this._qsIndicators || !actor)
            return;
        if (actor.get_parent() !== this._qsIndicators)
            return;

        const children = this._qsIndicators.get_children();
        const index = children.indexOf(actor);
        const sibling = index >= 0 ? children[index + 1] ?? null : null;

        let insertedAnchor = false;
        if (this._qs?._brightness === actor && !this._brightnessAnchor) {
            try {
                const anchor = new St.Widget({
                    visible: false,
                    width: 0,
                    height: 0,
                });
                anchor.quickSettingsItems = [];
                this._qsIndicators.insert_child_at_index(anchor, index);
                this._brightnessAnchor = anchor;
                this._brightnessIndicator = actor;
                this._qs._brightness = anchor;
                insertedAnchor = true;
            } catch (e) {
                console.error(`${LOG} No se pudo crear el ancla de brillo:`, e);
            }
        }

        const current = this._qsIndicators.get_children();
        const currentIndex = current.indexOf(actor);
        const currentSibling = currentIndex >= 0 ? current[currentIndex + 1] ?? null : null;

        try {
            this._qsIndicators.remove_child(actor);
        } catch (e) {
            console.error(`${LOG} No se pudo ocultar un indicador del sistema:`, e);
            return;
        }

        this._qsDetached.push({
            actor,
            index: currentIndex >= 0 ? currentIndex : index,
            sibling: currentSibling ?? sibling,
            anchor: insertedAnchor,
        });
        this._qsDetachedSet.add(actor);
    }

    _syncQuickSettingsVisibility() {
        if (this._destroyed || !this._qs?.container || !this._qsIndicators)
            return;
        if (this._qsPanelGone || this._qsContainerGone)
            return;

        if (Main.sessionMode?.currentMode !== 'user')
            return;

        let hasVisible = false;
        try {
            hasVisible = this._qsIndicators.get_children().some(child => child.visible);
        } catch (_e) {
            hasVisible = false;
        }

        this._qs.container.visible = hasVisible || this._qsTempVisible;
    }

    _showGnomeQuickSettings() {
        const qs = this._qs;
        if (!qs?.menu)
            return;

        try {
            this._ccButton?.menu.close();
        } catch (_e) {
            // Ignorar.
        }

        this._qsTempVisible = true;
        this._syncQuickSettingsVisibility();

        this._addIdle(() => {
            try {
                if (qs.container)
                    qs.container.visible = true;
                qs.menu.open();
            } catch (e) {
                console.error(`${LOG} No se pudo abrir los Ajustes rápidos de GNOME:`, e);
            }
        });
    }

    _restoreQuickSettingsIndicators() {
        if (this._qsPanelGone) {
            this._qsDetached = [];
            this._qsDetachedSet.clear();
            this._qsIndicators = null;
            this._brightnessAnchor = null;
            this._brightnessIndicator = null;
            this._qsRestoring = false;
            return;
        }

        const indicators = this._qsIndicators;

        this._qsRestoring = true;
        if (this._qsScanIdleId) {
            GLib.source_remove(this._qsScanIdleId);
            this._qsScanIdleId = 0;
        }
        this._qsDetachedSet.clear();

        if (indicators && this._qsDetached.length > 0) {
            for (const record of [...this._qsDetached].reverse()) {
                const {actor, sibling, index} = record;
                if (!actor)
                    continue;

                if (actor === this._brightnessIndicator)
                    continue;

                try {
                    if (actor.get_parent())
                        continue;

                    if (sibling && sibling !== actor &&
                        sibling.get_parent() === indicators) {
                        indicators.insert_child_below(actor, sibling);
                    } else {
                        const count = indicators.get_n_children();
                        indicators.insert_child_at_index(actor,
                            Math.min(Math.max(index, 0), count));
                    }
                } catch (e) {
                    console.error(`${LOG} No se pudo restaurar un indicador:`, e);
                }
            }
        }

        if (this._brightnessAnchor && this._brightnessIndicator && indicators) {
            try {
                const anchor = this._brightnessAnchor;
                let anchorIndex = 0;

                if (anchor.get_parent() === indicators) {
                    anchorIndex = indicators.get_children().indexOf(anchor);
                    indicators.remove_child(anchor);
                }

                if (this._qs)
                    this._qs._brightness = this._brightnessIndicator;

                if (!this._brightnessIndicator.get_parent()) {
                    indicators.insert_child_at_index(
                        this._brightnessIndicator,
                        Math.min(Math.max(anchorIndex, 0),
                            indicators.get_n_children()));
                }
            } catch (e) {
                console.error(`${LOG} No se pudo restaurar el indicador de brillo:`, e);
            }
        }

        this._brightnessAnchor = null;
        this._brightnessIndicator = null;
        this._qsDetached = [];
        this._qsDetachedSet.clear();
        this._qsRestoring = false;

        if (this._qs && this._originalAddExternalIndicator) {
            try {
                this._qs.addExternalIndicator = this._originalAddExternalIndicator;
            } catch (_e) {
                // Ignorar.
            }
        }
        this._originalAddExternalIndicator = null;
        this._addExternalIndicatorOverride = null;

        if (this._qs?.container) {
            try {
                this._qs.container.visible = this._qsWasVisible;
            } catch (_e) {
                // El contenedor ya no existe.
            }
        }

        this._qsTempVisible = false;
    }

    _overrideQuickSettingsShortcut() {
        this._originalToggleQuickSettings = this._panel.toggleQuickSettings;
        this._toggleQuickSettingsOverride = () => {
            if (!this._destroyed)
                this._ccButton?.menu.toggle();
        };
        this._panel.toggleQuickSettings = this._toggleQuickSettingsOverride;
    }

    _restoreQuickSettingsShortcut() {
        if (!this._panel || !this._originalToggleQuickSettings)
            return;

        if (this._panel.toggleQuickSettings === this._toggleQuickSettingsOverride)
            this._panel.toggleQuickSettings = this._originalToggleQuickSettings;

        this._originalToggleQuickSettings = null;
        this._toggleQuickSettingsOverride = null;
    }

    // ------------------------------------------------------------------
    // Señales del escritorio
    // ------------------------------------------------------------------

    _connectDesktopSignals() {
        if (this._notificationSettings) {
            this._connect(this._notificationSettings, 'changed::show-banners',
                () => this._queueSync());
        }

        if (this._colorSettings) {
            this._connect(this._colorSettings, 'changed::night-light-enabled',
                () => this._queueSync());
        }

        try {
            const monitorManager = global.backend.get_monitor_manager();
            this._connect(monitorManager, 'notify::night-light-supported',
                () => this._queueSync());
        } catch (_e) {
            // No disponible en este backend.
        }

        try {
            if (Main.brightnessManager)
                this._connect(Main.brightnessManager, 'changed', () => this._queueSync());
        } catch (e) {
            console.error(`${LOG} No se pudo seguir el brillo de la pantalla:`, e);
        }

        this._connect(Main.sessionMode, 'updated', () => {
            if (this._destroyed || this._panelButtonsGone)
                return;

            if (Main.sessionMode.currentMode === 'user') {
                this._syncQuickSettingsVisibility();
                this._reorderPanelButtons();
            }
            this._queueSync();
        });
    }

    _reorderPanelButtons() {
        if (this._panelButtonsGone || this._destroyed)
            return;

        this._applyMenubarOrder();
    }

    // ------------------------------------------------------------------
    // Vistas del panel
    // ------------------------------------------------------------------

    _clearChildren(actor) {
        if (!actor)
            return;

        try {
            actor.destroy_all_children();
        } catch (_e) {
            // Ignorar.
        }
    }

    _clearView() {
        this._leaveEditMode(false);
        this._restoreExternalMenu();
        this._mainRefs = null;
        this._detailRefs = null;
        // Los popovers de la barra tienen su propio ciclo de vida: cerrar el
        // panel principal no debe arrancarles el cristal (puede ocurrir al
        // abrir un popover y cerrarse el otro menú a la vez).
        this._destroyMainGlassHandles();
        for (const handle of [...this._sheetHandles])
            handle.destroy();
        this._sheetHandles.clear();
        this._clearChildren(this._ccRoot);
        this._view = 'main';
    }

    _createSheet(styleClass, radius, extraClass = '', glass = true) {
        const sheet = new St.BoxLayout({
            style_class: `tahoe-cc-glass tahoe-cc-sheet ${styleClass} ${extraClass}`.trim(),
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        if (glass)
            this._addGlass(sheet, radius);
        return sheet;
    }

    _createSheetLink(text, onClick) {
        const button = new St.Button({
            style_class: 'tahoe-cc-sheet-link',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
            accessible_name: text,
        });
        button.set_child(new St.Label({
            text,
            style_class: 'tahoe-cc-sheet-link-label',
            x_align: Clutter.ActorAlign.START,
        }));
        button.connect('clicked', () => onClick());
        return button;
    }

    _createSeparator(classExtra = '') {
        return new St.Widget({
            style_class: `tahoe-cc-separator ${classExtra}`.trim(),
            x_expand: true,
        });
    }

    _createScrollList(rows, rowHeight = 28, maxHeight = 420) {
        const scroll = new St.ScrollView({
            style_class: 'tahoe-cc-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });

        const content = new St.BoxLayout({
            style_class: 'tahoe-cc-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        for (const row of rows)
            content.add_child(row);
        scroll.set_child(content);

        const height = Math.min(
            Math.max(rows.length, 1) * px(rowHeight) + px(4),
            px(maxHeight));
        const holder = new St.Bin({
            style_class: 'tahoe-cc-scroll-holder',
            x_expand: true,
            height,
        });
        holder.set_child(scroll);
        return holder;
    }

    // ------------------------------------------------------------------
    // Rejilla principal
    // ------------------------------------------------------------------

    _collectGlassRects(actors) {
        const rects = [];
        for (const actor of actors) {
            if (!actor || !actor.mapped || !actor.visible)
                continue;
            // Un toggle activo pinta un relleno opaco (acento o blanco); no
            // necesita cristal detrás y ahorra copia y blur.
            if (actor.has_style_class_name('tahoe-cc-on'))
                continue;
            const [x, y, w, h] = stageRect(actor);
            if (!(w >= 1) || !(h >= 1))
                continue;
            rects.push([x, y, w, h]);
        }
        return rects;
    }

    _syncMainGlassHandles(grid) {
        this._destroyMainGlassHandles();
        if (this._editMode)
            return;
        if (this._glassStyle !== 'liquid' || !this._glassEngine || !grid)
            return;

        const make = (actors, radius, owner) => this._glassEngine.attachRegions(
            grid,
            () => this._collectGlassRects(actors),
            glassLook(this._tahoeTheme, {
                cornerRadius: radius,
                blurRadius: 12,
                owner,
            }));

        // El shader admite 16 regiones por superficie. Un layout grande puede
        // superarlo, así que se reparte en varias superficies del mismo radio.
        const makeChunks = (actors, radius, owner) => {
            const list = [...actors];
            const handles = [];
            for (let i = 0; i < list.length; i += 16) {
                const chunk = list.slice(i, i + 16);
                handles.push(make(chunk, radius, owner));
            }
            return handles;
        };

        this._mainGlassHandles = [
            ...makeChunks(this._roundActors, 31, 'cc-round'),
            ...makeChunks(this._cardActors, 24, 'cc-card'),
            ...makeChunks(this._footerActors, 13, 'cc-footer'),
        ];
    }

    _renderMain() {
        if (!this._ccRoot || this._rendering)
            return;

        this._rendering = true;
        try {
            this._destroyMainGlassHandles();
            this._restoreExternalMenu();
            this._clearChildren(this._ccRoot);
            this._mainRefs = {};
            this._detailRefs = null;
            this._view = 'main';

            // Los controles externos se descubren antes de leer el layout:
            // la primera vez que aparece uno se añade al final como "small".
            const externals = this._refreshExternalRegistry();
            this._autoAddExternals(externals);

            const layout = this.getLayout();
            const grid = new St.Widget({
                style_class: 'tahoe-cc-grid',
                layout_manager: new TahoeGridLayout(),
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });

            this._ccRoot.add_child(grid);

            const placed = [];
            const seen = new Set();
            let layoutIndex = 0;

            for (const entry of layout) {
                entry.__index = layoutIndex++;
                if (!entry?.id || seen.has(entry.id))
                    continue;
                seen.add(entry.id);

                const control = this._registry?.get(entry.id);
                if (!control)
                    continue;

                let available = false;
                try {
                    available = Boolean(control.available());
                } catch (e) {
                    console.error(`${LOG} available() falló para «${entry.id}»:`, e);
                    available = false;
                }
                if (!available)
                    continue;

                let size = control.sizes.includes(entry.size)
                    ? entry.size
                    : control.defaultSize;
                if (!control.sizes.includes(size))
                    size = control.sizes[0];

                let built = null;
                try {
                    built = control.create(size);
                } catch (e) {
                    console.error(`${LOG} No se pudo crear «${entry.id}» (${size}):`, e);
                    built = null;
                }
                if (!built?.actor)
                    continue;

                const span = sizeSpan(size);

                // Cada módulo va dentro de un contenedor con BinLayout: en
                // modo edición aloja el "−" y el tirador sin tocar el widget
                // real; en modo normal es transparente a los eventos.
                const wrapper = new St.Widget({
                    style_class: 'tahoe-cc-item',
                    layout_manager: this._editMode
                        ? new TahoeItemLayout()
                        : new Clutter.BinLayout(),
                    reactive: false,
                    x_expand: true,
                    y_expand: true,
                });
                wrapper.add_child(built.actor);

                grid.add_child(wrapper);
                grid.layout_manager.setSpan(grid, wrapper,
                    span.columns, span.rows);
                this._addGlass(built.actor, built.radius ?? span.radius);

                placed.push({
                    control,
                    size,
                    built,
                    wrapper,
                    layoutIndex: entry.__index ?? 0,
                });
            }

            if (placed.length === 0) {
                const empty = new St.BoxLayout({
                    style_class: 'tahoe-cc-empty-layout',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                empty.add_child(new St.Label({
                    text: 'No hay controles disponibles',
                    style_class: 'tahoe-cc-empty-label',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
                this._ccRoot.add_child(empty);
            }

            const footer = new St.BoxLayout({
                style_class: 'tahoe-cc-footer',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });

            const editButton = createFooterPill('Editar controles',
                () => this.enterEditMode());
            editButton.add_style_class_name('tahoe-cc-edit-button');
            editButton.visible = !this._editMode;
            this._addGlass(editButton, 15);
            footer.add_child(editButton);

            const gnomeLink = createFooterPill('Más ajustes de GNOME…',
                () => this._showGnomeQuickSettings());
            this._addGlass(gnomeLink, 15);
            footer.add_child(gnomeLink);

            this._ccRoot.add_child(footer);

            this._mainRefs = {grid, controls: placed, footer, editButton};
            this._availabilityKey = this._availabilityKeyForLayout();

            for (const item of placed) {
                const index = layout.findIndex(entry => entry.id === item.control.id);
                item.layoutIndex = index >= 0 ? index : item.layoutIndex;
            }

            this._editor?.onMainRendered(placed, grid);
            this._publishCatalog();
            this._syncMainView();
            if (!this._editMode) {
                this._animateIn(grid);
            } else {
                grid.opacity = 255;
                grid.set_scale(1, 1);
            }
            if (this._editMode) {
                // Mientras se edita, los módulos usan el material CSS para
                // evitar que el motor congele un backdrop con el frame
                // anterior al cambiar el ancho del menú. Galería, menú
                // contextual y popovers siguen usando Liquid Glass.
                this._destroyMainGlassHandles();
            } else {
                this._syncMainGlassHandles(grid);
            }
        } finally {
            this._rendering = false;
        }
    }

    _availabilityKeyForLayout() {
        return this.getLayout().map(entry => {
            const control = this._registry?.get(entry.id);
            let available = false;
            try {
                available = Boolean(control?.available());
            } catch (_e) {
                available = false;
            }
            return `${entry.id}:${available ? 1 : 0}:${entry.size}`;
        }).join('|');
    }

    _syncMainView() {
        const refs = this._mainRefs;
        if (!refs || this._destroyed)
            return;

        for (const item of refs.controls) {
            try {
                item.built?.sync?.();
            } catch (e) {
                console.error(`${LOG} No se pudo sincronizar «${item.control.id}»:`, e);
            }
        }

        if (this._rendering || this._view !== 'main' || this._layoutApplying)
            return;

        const key = this._availabilityKeyForLayout();
        if (key === this._availabilityKey)
            return;

        this._availabilityKey = key;
        this._addIdle(() => {
            if (!this._destroyed && this._view === 'main' &&
                this._ccButton?.menu.isOpen)
                this._renderMain();
        });
    }

    // ------------------------------------------------------------------
    // Hojas de detalle
    // ------------------------------------------------------------------

    _showDetail(view) {
        if (!this._ccRoot)
            return;

        this._view = view;
        this._renderDetail();
    }

    _goBack() {
        this._view = 'main';
        this._renderMain();
    }

    _renderDetail() {
        if (!this._ccRoot)
            return;

        if (this._view.startsWith('ext:')) {
            this._renderExternalMenu(this._view.slice(4));
            return;
        }

        this._destroyMainGlassHandles();
        this._restoreExternalMenu();
        this._clearChildren(this._ccRoot);
        this._mainRefs = null;
        this._detailRefs = {};

        let result = null;
        switch (this._view) {
        case 'wifi':
            result = this._buildWifiSheet({showBack: true});
            break;
        case 'bluetooth':
            result = this._buildBluetoothSheet({showBack: true});
            break;
        case 'sound':
            result = this._buildSoundSheet({showBack: true, popup: false});
            break;
        default:
            this._renderMain();
            return;
        }

        if (!result)
            return;

        this._ccRoot.add_child(result.sheet);
        this._addGlass(result.sheet, 22);
        this._detailRefs = result.refs;
        this._animateIn(result.sheet);

        if (this._view === 'wifi' || this._view === 'bluetooth') {
            this._addTimeout(1000, () => {
                if (this._view === this._detailView && this._ccButton?.menu.isOpen)
                    this._renderDetail();
            });
            this._detailView = this._view;
        }
    }

    _buildWifiSheet({showBack = false, popup = false} = {}) {
        const refs = {};
        // El cristal se adjunta cuando la hoja ya cuelga del menú (si se
        // adjunta antes, el motor la inserta por encima del contenido).
        const sheet = this._createSheet('tahoe-cc-sheet-wifi', 22, '', false);

        const header = createDetailHeader({
            title: 'Wi‑Fi',
            onBack: showBack ? () => this._goBack() : null,
            withSwitch: true,
        });
        refs.header = header;
        header.toggle.setChecked(Boolean(this._network?.wifiEnabled));
        header.toggle.connect('changed', (_switch, checked) => {
            this._network?.setWifiEnabled(checked);
            this._addTimeout(900, () => {
                if (this._ccButton?.menu.isOpen)
                    this._refreshWifiSheet(showBack);
            });
        });
        sheet.add_child(header.header);

        const network = this._network;
        const active = network?.accessPoints?.find(ap => ap.active) ?? null;

        if (network && !network.failed && network.hasWifi && network.wifiEnabled) {
            if (active) {
                const row = createListRow({
                    iconName: `network-wireless-signal-${signalName(active.strength)}-symbolic`,
                    title: active.ssid,
                    active: true,
                    onClick: showBack ? null : null,
                });
                refs.activeRow = row;
                sheet.add_child(row.button);
            }

            sheet.add_child(this._createSeparator('tahoe-cc-section-separator'));
            sheet.add_child(createSectionHeader('Otras redes'));

            const rows = [];
            for (const ap of network.accessPoints) {
                if (ap.active)
                    continue;

                const row = createListRow({
                    iconName: `network-wireless-signal-${signalName(ap.strength)}-symbolic`,
                    title: ap.ssid,
                    suffixIconName: ap.secure
                        ? 'network-wireless-encrypted-symbolic'
                        : null,
                    onClick: () => {
                        if (!ap.saved) {
                            network.openWifiSettings();
                            this._closeParentMenu(showBack);
                            return;
                        }
                        if (network.connectSaved(ap.ssid))
                            this._closeParentMenu(showBack);
                    },
                });
                rows.push(row.button);
            }

            if (rows.length === 0)
                sheet.add_child(this._createEmptyLabel('No se encontraron redes'));
            else
                sheet.add_child(this._createScrollList(rows, 28, 420));
        } else {
            let message = 'Wi‑Fi desactivado';
            if (!network || network.failed)
                message = 'NetworkManager no está disponible';
            else if (!network.hasWifi)
                message = network.ethernetConnected
                    ? 'Conectado por Ethernet'
                    : 'No hay adaptador Wi‑Fi';
            sheet.add_child(this._createEmptyLabel(message));
        }

        sheet.add_child(this._createSeparator('tahoe-cc-section-separator'));
        sheet.add_child(this._createSheetLink('Ajustes de Wi‑Fi…', () => {
            this._closeParentMenu(showBack);
            openSettingsPanel('wifi');
        }));

        return {sheet, refs};
    }

    _refreshWifiSheet(showBack) {
        if (showBack) {
            if (this._view === 'wifi')
                this._renderDetail();
            return;
        }

        if (this._wifiButton?.menu.isOpen)
            this._buildWifiPopover();
    }

    _buildBluetoothSheet({showBack = false} = {}) {
        const refs = {};
        const sheet = this._createSheet('tahoe-cc-sheet-bluetooth', 22, '', false);

        const header = createDetailHeader({
            title: 'Bluetooth',
            onBack: showBack ? () => this._goBack() : null,
            withSwitch: true,
        });
        refs.header = header;
        header.toggle.setChecked(Boolean(this._bluetooth?.enabled));
        header.toggle.connect('changed', (_switch, checked) => {
            this._bluetooth?.setEnabled(checked);
            this._addTimeout(1000, () => {
                if (this._ccButton?.menu.isOpen)
                    this._renderDetail();
            });
        });
        sheet.add_child(header.header);

        const bluetooth = this._bluetooth;
        if (!bluetooth || !bluetooth.available) {
            sheet.add_child(this._createEmptyLabel('No hay adaptador Bluetooth'));
        } else if (!bluetooth.enabled) {
            sheet.add_child(this._createEmptyLabel('Bluetooth desactivado'));
        } else {
            const devices = bluetooth.devices;
            sheet.add_child(this._createSeparator('tahoe-cc-section-separator'));
            sheet.add_child(createSectionHeader('Dispositivos'));

            if (devices.length === 0) {
                sheet.add_child(this._createEmptyLabel('No hay dispositivos emparejados'));
            } else {
                const rows = devices.map(item => createListRow({
                    iconName: item.icon,
                    title: item.name,
                    active: item.connected,
                    onClick: () => {
                        bluetooth.toggleDevice(item);
                        this._addTimeout(900, () => {
                            if (this._view === 'bluetooth' &&
                                this._ccButton?.menu.isOpen)
                                this._renderDetail();
                        });
                    },
                }).button);
                sheet.add_child(this._createScrollList(rows, 28, 420));
            }
        }

        sheet.add_child(this._createSeparator('tahoe-cc-section-separator'));
        sheet.add_child(this._createSheetLink('Ajustes de Bluetooth…', () => {
            this._ccButton?.menu.close();
            openSettingsPanel('bluetooth');
        }));

        return {sheet, refs};
    }

    _buildSoundSheet({showBack = false, popup = false} = {}) {
        const refs = {};
        const sheet = this._createSheet(popup
            ? 'tahoe-cc-sheet-sound-popup'
            : 'tahoe-cc-sheet-sound', 22, '', false);

        if (showBack) {
            const header = createDetailHeader({
                title: 'Salida de sonido',
                onBack: () => this._goBack(),
            });
            refs.header = header;
            sheet.add_child(header.header);
        } else {
            const titleBox = new St.BoxLayout({
                style_class: 'tahoe-cc-sheet-title-row',
                x_expand: true,
            });
            titleBox.add_child(new St.Label({
                text: 'Sonido',
                style_class: 'tahoe-cc-sheet-title',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            }));
            sheet.add_child(titleBox);
        }

        const sliderRow = new St.BoxLayout({
            style_class: 'tahoe-cc-sound-slider-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const outputDevice = this._deviceForSink(this._sink);
        const outputIcon = new St.Icon({
            icon_name: this._sinkIconName(this._sink, true),
            icon_size: 14,
            style_class: 'tahoe-cc-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._setDeviceIcon(outputIcon, outputDevice, this._sink);
        sliderRow.add_child(outputIcon);

        const slider = new TahoeSlider(0);
        slider.maximum_value = 1;
        slider.accessible_name = 'Volumen';
        slider.x_expand = true;
        if (this._sink) {
            try {
                const max = this._mixer?.get_vol_max_norm() || 1;
                slider.value = this._sink.is_muted
                    ? 0
                    : this._sink.volume / max;
            } catch (_e) {
                slider.value = 0;
            }
        }
        slider.connect('notify::value', () => {
            if (this._updatingVolumeSlider)
                return;
            this._setVolumeFromSlider(slider.value);
        });
        sliderRow.add_child(slider);
        sheet.add_child(sliderRow);

        sheet.add_child(this._createSeparator('tahoe-cc-section-separator'));
        sheet.add_child(createSectionHeader('Salida', false));

        const devices = this._getOutputDevices();

        if (devices.length === 0) {
            sheet.add_child(this._createEmptyLabel('No hay salidas de audio'));
        } else {
            const rows = devices.map(item => {
                const row = createListRow({
                    iconName: item.iconName,
                    gicon: item.gicon,
                    title: item.description,
                    subtitle: item.origin,
                    active: item.active,
                    activeWhite: item.active,
                    large: true,
                    check: item.active,
                    onClick: () => this._changeOutput(item.sink),
                });
                this._attachBluetoothBattery(item.sink, row, item.origin);
                return row.button;
            });
            sheet.add_child(this._createScrollList(rows, 40, 300));
        }

        sheet.add_child(this._createSeparator('tahoe-cc-section-separator'));
        const settings = this._createSheetLink('Ajustes de sonido…', () => {
            if (popup)
                this._soundButton?.menu.close();
            else
                this._ccButton?.menu.close();
            openSettingsPanel('sound');
        });
        sheet.add_child(settings);

        refs.slider = slider;
        refs.outputIcon = outputIcon;
        return {sheet, refs};
    }

    _createEmptyLabel(text) {
        const box = new St.BoxLayout({
            style_class: 'tahoe-cc-sheet-padded',
            x_expand: true,
        });
        box.add_child(new St.Label({
            text,
            style_class: 'tahoe-cc-empty-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        return box;
    }

    _closeParentMenu(fromDetail) {
        if (fromDetail)
            this._ccButton?.menu.close();
        else
            this._wifiButton?.menu.close();
    }

    // ------------------------------------------------------------------
    // Popovers de la barra
    // ------------------------------------------------------------------

    _buildBatteryPopover() {
        const box = this._batteryPopoverBox;
        if (!box)
            return;

        this._clearChildren(box);
        const sheet = this._createSheet('tahoe-cc-sheet-battery', 22, '', false);

        const battery = this._battery;
        if (!battery?.present) {
            sheet.add_child(this._createEmptyLabel('No hay batería'));
            box.add_child(sheet);
            return;
        }

        const header = new St.BoxLayout({
            style_class: 'tahoe-cc-battery-popover-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(new St.Label({
            text: 'Batería',
            style_class: 'tahoe-cc-sheet-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        header.add_child(new St.Label({
            text: `${battery.percentage}%`,
            style_class: 'tahoe-cc-battery-percentage',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        sheet.add_child(header);

        const source = new St.Label({
            text: `Fuente de alimentación: ${battery.powerSource || '—'}`,
            style_class: 'tahoe-cc-info-line',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        source.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        sheet.add_child(source);

        let timeText = '';
        if (battery.fullyCharged)
            timeText = 'Batería llena';
        else if (battery.charging)
            timeText = formatDuration(battery.timeRemaining) || 'Cargando…';
        else
            timeText = formatDuration(battery.timeRemaining) || 'Calculando…';

        sheet.add_child(this._createInfoRow(
            battery.charging ? 'Tiempo para cargar' : 'Tiempo restante',
            timeText));

        const profiles = this._powerProfiles;
        if (profiles?.available && profiles.profiles.length > 0) {
            sheet.add_child(this._createSeparator('tahoe-cc-section-separator'));
            sheet.add_child(createSectionHeader('Perfil de energía', false));

            for (const profile of profiles.profiles) {
                const info = PROFILE_INFO[profile];
                if (!info)
                    continue;

                const row = createListRow({
                    iconName: info.iconName,
                    title: info.name,
                    active: profile === profiles.activeProfile,
                    activeWhite: true,
                    large: true,
                    check: profile === profiles.activeProfile,
                    onClick: () => profiles.setProfile(profile),
                });
                sheet.add_child(row.button);
            }
        }

        sheet.add_child(this._createSeparator('tahoe-cc-section-separator'));
        sheet.add_child(this._createSheetLink('Ajustes de batería…', () => {
            this._batteryButton?.menu.close();
            openSettingsPanel('power');
        }));

        box.add_child(sheet);
    }

    _createInfoRow(title, value) {
        const row = new St.BoxLayout({
            style_class: 'tahoe-cc-info-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(new St.Label({
            text: title,
            style_class: 'tahoe-cc-info-key',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        row.add_child(new St.Label({
            text: value,
            style_class: 'tahoe-cc-info-value',
            x_align: Clutter.ActorAlign.END,
        }));
        return row;
    }

    _buildWifiPopover() {
        const box = this._wifiPopoverBox;
        if (!box)
            return;

        this._clearChildren(box);
        const result = this._buildWifiSheet({showBack: false, popup: true});
        box.add_child(result.sheet);
    }

    _buildSoundPopover() {
        const box = this._soundPopoverBox;
        if (!box)
            return;

        this._clearChildren(box);
        const result = this._buildSoundSheet({showBack: false, popup: true});
        box.add_child(result.sheet);
        this._soundPopoverRefs = result.refs;
    }

    _updateSoundPopover() {
        const refs = this._soundPopoverRefs;
        if (!refs || !this._soundButton?.menu.isOpen)
            return;

        if (this._sink) {
            try {
                const max = this._mixer?.get_vol_max_norm() || 1;
                const value = this._sink.is_muted ? 0 : this._sink.volume / max;
                this._updatingVolumeSlider = true;
                refs.slider.value = value;
                this._updatingVolumeSlider = false;
            } catch (_e) {
                this._updatingVolumeSlider = false;
            }
            this._setDeviceIcon(refs.outputIcon,
                this._deviceForSink(this._sink), this._sink);
        }
    }

    // ------------------------------------------------------------------
    // Sonido
    // ------------------------------------------------------------------

    _sinkIconName(sink, deviceIcon = false) {
        if (!sink)
            return 'audio-volume-medium-symbolic';

        let formFactor = '';
        try {
            formFactor = `${sink.get_form_factor?.() ?? ''}`.toLowerCase();
        } catch (_e) {
            formFactor = '';
        }

        const text = `${sink.description ?? ''} ${sink.origin ?? ''} ${sink.name ?? ''}`
            .toLowerCase();

        if (deviceIcon) {
            if (formFactor.includes('headset') || formFactor.includes('headphone') ||
                text.includes('bluetooth') || text.includes('head'))
                return 'audio-headphones-symbolic';
            if (text.includes('hdmi') || text.includes('display'))
                return 'video-display-symbolic';
            return 'audio-speakers-symbolic';
        }

        let volume = 0;
        let muted = true;
        try {
            muted = Boolean(sink.is_muted);
            const max = this._mixer?.get_vol_max_norm() || 1;
            volume = muted ? 0 : sink.volume / max;
        } catch (_e) {
            volume = 0;
            muted = true;
        }

        if (formFactor.includes('headset') || formFactor.includes('headphone') ||
            text.includes('bluetooth') || text.includes('head'))
            return 'audio-headphones-symbolic';

        if (muted)
            return 'audio-volume-muted-symbolic';
        if (volume < 0.33)
            return 'audio-volume-low-symbolic';
        if (volume < 0.66)
            return 'audio-volume-medium-symbolic';
        return 'audio-volume-high-symbolic';
    }

    _isBluetoothSink(sink) {
        if (!sink)
            return false;
        try {
            const formFactor = `${sink.get_form_factor?.() ?? ''}`.toLowerCase();
            const text = `${sink.description ?? ''} ${sink.origin ?? ''} ${sink.name ?? ''}`
                .toLowerCase();
            return formFactor.includes('headset') ||
                formFactor.includes('headphone') ||
                text.includes('bluetooth') ||
                text.includes('head');
        } catch (_e) {
            return false;
        }
    }

    _attachBluetoothBattery(sink, row, origin = '') {
        // La batería de periféricos Bluetooth se expone mediante UPower.
        // Se consulta de forma diferida y sólo si la fila sigue viva.
        if (!this._isBluetoothSink(sink))
            return;

        this._findBluetoothBattery(sink).then(text => {
            if (!text || !row.button.get_stage())
                return;
            row.setSubtitle(origin ? `${origin} · ${text}` : text);
        }).catch(_e => {
            // Sin batería disponible.
        });
    }

    async _findBluetoothBattery(sink) {
        if (!this._upowerCache) {
            this._upowerCache = await this._readUPowerDevices();
            this._addTimeout(15000, () => {
                this._upowerCache = null;
            });
        }

        const text = `${sink.description ?? ''} ${sink.origin ?? ''} ${sink.name ?? ''}`
            .toLowerCase();
        const match = this._upowerCache.find(device => {
            const model = `${device.model ?? ''} ${device.nativePath ?? ''}`.toLowerCase();
            if (!model)
                return false;
            return model.split(/[\s\-_/]+/).some(token =>
                token.length > 3 && text.includes(token));
        });

        if (!match)
            return '';

        return `Batería ${Math.round(match.percentage)} %`;
    }

    async _readUPowerDevices() {
        try {
            const result = await new Promise((resolve, reject) => {
                Gio.DBus.system.call(
                    'org.freedesktop.UPower',
                    '/org/freedesktop/UPower',
                    'org.freedesktop.UPower',
                    'EnumerateDevices',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (connection, res) => {
                        try {
                            resolve(connection.call_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });

            const paths = result.deepUnpack()[0] ?? [];
            const devices = [];
            for (const path of paths) {
                try {
                    const propsVariant = await new Promise((resolve, reject) => {
                        Gio.DBus.system.call(
                            'org.freedesktop.DBus',
                            path,
                            'org.freedesktop.DBus.Properties',
                            'GetAll',
                            new GLib.Variant('(s)', ['org.freedesktop.UPower.Device']),
                            null,
                            Gio.DBusCallFlags.NONE,
                            -1,
                            null,
                            (connection, res) => {
                                try {
                                    resolve(connection.call_finish(res));
                                } catch (e) {
                                    reject(e);
                                }
                            });
                    });

                    const [props] = propsVariant.deepUnpack();
                    const type = props.Type?.deepUnpack?.() ?? props.Type;
                    if (Number(type) !== 2)
                        continue;

                    devices.push({
                        model: props.Model?.deepUnpack?.() ?? '',
                        nativePath: props.NativePath?.deepUnpack?.() ?? '',
                        percentage: Number(props.Percentage?.deepUnpack?.() ?? 0),
                    });
                } catch (_e) {
                    // Ignorar dispositivos sin propiedades.
                }
            }
            return devices;
        } catch (e) {
            console.debug(`${LOG} UPower no enumeró dispositivos: ${e.message}`);
            return [];
        }
    }

    _deviceForSink(sink) {
        if (!sink || !this._mixer)
            return null;
        try {
            return this._mixer.lookup_device_from_stream(sink) ?? null;
        } catch (_e) {
            return null;
        }
    }

    _deviceIconName(device, sink) {
        let icon = '';
        try {
            icon = device?.get_icon_name?.() ?? '';
        } catch (_e) {
            icon = '';
        }
        if (icon) {
            if (icon.endsWith('-symbolic'))
                return icon;
            const known = new Set([
                'audio-speakers', 'audio-card', 'audio-headphones',
                'audio-headset', 'video-display', 'bluetooth-active',
                'audio-input-microphone',
            ]);
            if (known.has(icon))
                return `${icon}-symbolic`;
        }

        let formFactor = '';
        try {
            formFactor = `${sink?.get_form_factor?.() ?? ''}`.toLowerCase();
        } catch (_e) {
            formFactor = '';
        }

        let port = '';
        try {
            port = `${device?.get_port?.() ?? ''} ${device?.port_name ?? ''}`.toLowerCase();
        } catch (_e) {
            port = '';
        }

        const text = `${port} ${device?.get_description?.() ?? ''} ` +
            `${device?.get_origin?.() ?? ''} ${sink?.description ?? ''} ` +
            `${sink?.name ?? ''}`.toLowerCase();

        if (formFactor.includes('headset') || formFactor.includes('headphone') ||
            text.includes('headphone') || text.includes('headset') ||
            text.includes('auricular'))
            return 'audio-headphones-symbolic';
        if (text.includes('hdmi') || text.includes('displayport') ||
            text.includes('display'))
            return 'video-display-symbolic';
        if (text.includes('bluetooth'))
            return 'bluetooth-active-symbolic';
        if (text.includes('usb'))
            return 'audio-card-symbolic';
        return 'audio-speakers-symbolic';
    }

    _setDeviceIcon(iconActor, device, sink) {
        if (!iconActor)
            return;

        const iconName = this._deviceIconName(device, sink);
        if (iconName) {
            iconActor.gicon = null;
            iconActor.icon_name = iconName;
            return;
        }

        try {
            const gicon = device?.get_gicon?.() ?? null;
            if (gicon) {
                iconActor.icon_name = null;
                iconActor.gicon = gicon;
            }
        } catch (_e) {
            // Sin icono.
        }
    }

    _getOutputDevices() {
        const sinks = this._getSinks();
        const byKey = new Map();

        for (const sink of sinks) {
            const device = this._deviceForSink(sink);
            let description = '';
            let origin = '';
            try {
                description = device?.get_description?.() ?? '';
                origin = device?.get_origin?.() ?? '';
            } catch (_e) {
                description = '';
                origin = '';
            }

            if (!description)
                description = sink.description || sink.name || 'Salida de audio';
            if (!origin)
                origin = sink.origin || '';

            const active = this._sameSink(sink, this._sink);
            const key = `${description}\u0000${origin}`;
            const previous = byKey.get(key);

            // Preferimos la entrada activa si dos sinks comparten dispositivo.
            if (previous && !active)
                continue;

            byKey.set(key, {
                sink,
                device,
                description,
                origin,
                iconName: this._deviceIconName(device, sink),
                gicon: (() => {
                    try {
                        return device?.get_gicon?.() ?? null;
                    } catch (_e) {
                        return null;
                    }
                })(),
                active,
            });
        }

        return [...byKey.values()];
    }

    _sameSink(a, b) {
        if (!a || !b)
            return false;
        if (a === b)
            return true;
        try {
            if (a.name && b.name && a.name === b.name)
                return true;
            if (typeof a.get_id === 'function' && typeof b.get_id === 'function' &&
                a.get_id() === b.get_id())
                return true;
        } catch (_e) {
            // Ignorar.
        }
        return false;
    }

    _getSinks() {
        let sinks = [];
        try {
            sinks = this._mixer?.get_sinks() ?? [];
        } catch (_e) {
            sinks = [];
        }

        if (this._sink && !sinks.some(sink => this._sameSink(sink, this._sink)))
            sinks = [this._sink, ...sinks];

        return sinks;
    }

    _changeOutput(sink) {
        try {
            this._mixer.change_output(sink);
            this._addTimeout(400, () => {
                if (this._soundButton?.menu.isOpen)
                    this._buildSoundPopover();
                if (this._view === 'sound' && this._ccButton?.menu.isOpen)
                    this._renderDetail();
            });
        } catch (e) {
            console.error(`${LOG} No se pudo cambiar la salida de audio:`, e);
        }
    }

    _onSoundScroll(event) {
        if (!this._sink)
            return;

        let delta = 0;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP)
            delta = 0.05;
        else if (direction === Clutter.ScrollDirection.DOWN)
            delta = -0.05;
        else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            delta = -dy * 0.05;
        }

        if (delta === 0)
            return;

        let current = 0;
        try {
            const max = this._mixer?.get_vol_max_norm() || 1;
            current = this._sink.is_muted ? 0 : this._sink.volume / max;
        } catch (_e) {
            current = 0;
        }

        this._setVolumeFromSlider(Math.clamp(current + delta, 0, 1));
    }

    _toggleMute() {
        if (!this._sink)
            return;
        try {
            this._sink.change_is_muted(!this._sink.is_muted);
        } catch (e) {
            console.error(`${LOG} No se pudo silenciar el audio:`, e);
        }
    }

    _setVolumeFromSlider(value) {
        if (!this._sink)
            return;

        try {
            const max = this._mixer?.get_vol_max_norm() || 1;
            const volume = Math.round(value * max);

            if (value <= 0.001) {
                this._sink.set_volume(0);
                if (!this._sink.is_muted)
                    this._sink.change_is_muted(true);
            } else {
                this._sink.set_volume(volume);
                if (this._sink.is_muted)
                    this._sink.change_is_muted(false);
            }
            this._sink.push_volume();
            this._updateSoundPopover();
        } catch (e) {
            console.error(`${LOG} No se pudo cambiar el volumen:`, e);
        }
    }

    // ------------------------------------------------------------------
    // Registro, layout y controles externos
    // ------------------------------------------------------------------

    /**
     * Entradas del registro con sus metadatos, para el editor futuro.
     * Devuelve [{id, name, category, icon, sizes, defaultSize, available,
     * external}].
     */
    getRegistry() {
        // El editor puede pedir el catálogo antes de abrir el panel: descubre
        // los QuickToggle/QuickSlider que ya estén en el menú de GNOME.
        if (!this._destroyed && this._qs && !this._qsMenuGone && this._registry) {
            this._refreshExternalRegistry();
            this._publishCatalog();
        }
        return this._registry?.list() ?? [];
    }

    /** Copia de la distribución efectiva. */
    getLayout() {
        if (!this._layout) {
            const raw = this._getString('control-center-layout', '');
            this._layout = parseLayout(raw);
        }
        return cloneLayout(this._layout);
    }

    /**
     * Reemplaza la distribución. Acepta la lista [{id, size}] o su JSON.
     * La clave de GSettings se actualiza y el Centro de control abierto se
     * reconstruye en el acto.
     */
    setLayout(layout) {
        const next = parseLayout(layout, []);
        this._layout = next;

        if (this._settings) {
            this._layoutApplying = true;
            try {
                this._settings.set_string('control-center-layout',
                    layoutToJSON(next));
            } catch (e) {
                console.error(`${LOG} No se pudo guardar el layout:`, e);
            } finally {
                this._layoutApplying = false;
            }
        }

        if (this._ccButton?.menu.isOpen && this._view === 'main')
            this._renderMain();
    }

    /** Vuelve a la distribución de referencia de Tahoe. */
    resetLayout() {
        this.setLayout(parseLayout(''));
    }

    /** Abre el editor in situ (galería + controles editables). */
    enterEditMode() {
        if (this._destroyed || this._editMode || !this._editor)
            return;

        this._editMode = true;
        this._ccRoot?.add_style_class_name('tahoe-cc-edit-surface');
        this._editor.enter();

        if (this._ccButton?.menu.isOpen) {
            this._view = 'main';
            this._renderMain();
        } else {
            try {
                this._ccButton?.menu.open();
            } catch (e) {
                console.error(`${LOG} No se pudo abrir el CC para editar:`, e);
                this._editMode = false;
                this._editor.leave();
            }
        }
    }

    /** Sale del editor dejando el Centro de control abierto. */
    exitEditMode() {
        this._leaveEditMode(true);
    }

    _leaveEditMode(render = true) {
        if (!this._editMode) {
            this._editor?.leave?.();
            return;
        }

        this._editMode = false;
        this._ccRoot?.remove_style_class_name('tahoe-cc-edit-surface');
        this._editor?.leave();

        if (render && !this._destroyed && this._ccButton?.menu.isOpen &&
            this._view === 'main')
            this._renderMain();
    }

    /** Persiste un layout ya calculado, opcionalmente sin reconstruir. */
    _persistLayout(layout, render = false) {
        const next = parseLayout(layout, []);
        this._layout = next;

        if (this._settings) {
            this._layoutApplying = true;
            try {
                this._settings.set_string('control-center-layout',
                    layoutToJSON(next));
            } catch (e) {
                console.error(`${LOG} No se pudo guardar el layout:`, e);
            } finally {
                this._layoutApplying = false;
            }
        }

        if (render && this._ccButton?.menu.isOpen && this._view === 'main')
            this._renderMain();
        else
            this._editor?.refreshGallery?.();
    }

    /** Catálogo serializado para que prefs (otro proceso) vea los externos. */
    _publishCatalog() {
        if (!this._settings || !this._registry)
            return;

        let json = '';
        try {
            json = JSON.stringify(this._registry.list());
        } catch (e) {
            console.error(`${LOG} No se pudo serializar el catálogo:`, e);
            return;
        }

        if (json === this._catalogJson)
            return;

        this._catalogJson = json;
        try {
            this._settings.set_string('control-center-catalog', json);
        } catch (e) {
            console.error(`${LOG} No se pudo guardar el catálogo:`, e);
        }
    }

    // ------------------------------------------------------------------
    // Controles de la barra de menús
    // ------------------------------------------------------------------

    _normalizeMenubarList(list) {
        const result = [];
        const seen = new Set();

        for (const raw of Array.isArray(list) ? list : []) {
            const id = typeof raw === 'string' ? raw.trim() : '';
            if (!id || id.length > 120 || seen.has(id))
                continue;
            seen.add(id);
            result.push(id);
            if (result.length >= 24)
                break;
        }

        return result;
    }

    _parseMenubarList(raw) {
        if (Array.isArray(raw))
            return this._normalizeMenubarList(raw);
        try {
            return this._normalizeMenubarList(JSON.parse(raw));
        } catch (_e) {
            return [];
        }
    }

    _loadMenubarControls() {
        let list = this._parseMenubarList(
            this._getString('menubar-controls', ''));

        if (list.length === 0)
            list = ['battery', 'sound', 'wifi'];

        // Migración: control-center-show-sound-icon = false quitaba el
        // altavoz de la barra. Ahora eso lo decide la presencia de "sound".
        if (this._settings) {
            try {
                const legacy = this._settings.get_boolean(
                    'control-center-show-sound-icon');
                if (!legacy) {
                    list = list.filter(id => id !== 'sound');
                    this._settings.set_boolean(
                        'control-center-show-sound-icon', true);
                }
            } catch (_e) {
                // Clave antigua no disponible.
            }
        }

        this._menubarControls = list;
        this._syncMenubarControls();
    }

    getMenubarControls() {
        return [...this._menubarControls];
    }

    setMenubarControls(list) {
        const next = this._normalizeMenubarList(list);
        this._menubarControls = next;

        if (this._settings) {
            try {
                this._settings.set_string('menubar-controls',
                    JSON.stringify(next));
            } catch (e) {
                console.error(`${LOG} No se pudo guardar menubar-controls:`, e);
            }
        }

        this._syncMenubarControls();
    }

    addMenubarControl(id, index = 0) {
        if (!id || this._menubarControls.includes(id))
            return false;

        const next = [...this._menubarControls];
        next.splice(Math.clamp(index, 0, next.length), 0, id);
        this.setMenubarControls(next);
        return true;
    }

    removeMenubarControl(id) {
        if (!this._menubarControls.includes(id))
            return false;

        this.setMenubarControls(
            this._menubarControls.filter(entry => entry !== id));
        return true;
    }

    moveMenubarControl(id, index) {
        if (!this._menubarControls.includes(id))
            return;

        const next = this._menubarControls.filter(entry => entry !== id);
        next.splice(Math.clamp(index, 0, next.length), 0, id);
        this.setMenubarControls(next);
    }

    _onMenubarControlsChanged() {
        if (this._destroyed)
            return;

        const next = this._parseMenubarList(
            this._getString('menubar-controls', ''));
        if (JSON.stringify(next) === JSON.stringify(this._menubarControls))
            return;

        this._menubarControls = next;
        this._syncMenubarControls();
    }

    _menubarEnabled(id) {
        return this._menubarControls.includes(id);
    }

    _getMenubarButton(id) {
        switch (id) {
        case 'battery':
            return this._batteryButton;
        case 'sound':
            return this._soundButton;
        case 'wifi':
            return this._wifiButton;
        default:
            return this._menubarExtra.get(id)?.button ?? null;
        }
    }

    _isSimpleMenubarControl(control) {
        return ['lock', 'screenshot', 'screen-recording', 'calculator',
            'settings'].includes(control.id);
    }

    _runMenubarAction(control) {
        switch (control.id) {
        case 'lock':
            this._lockScreen();
            break;
        case 'screenshot':
            this._takeScreenshot();
            break;
        case 'screen-recording':
            this._startScreenRecording();
            break;
        case 'calculator':
            this._openCalculator();
            break;
        case 'settings':
            this._openSettings();
            break;
        default:
            break;
        }
    }

    _menubarIconProps(control) {
        const icon = control.icon ?? 'application-x-addon-symbolic';
        if (icon.includes('/') || icon.startsWith('file:')) {
            try {
                return {
                    gicon: new Gio.FileIcon({
                        file: Gio.File.new_for_path(icon.replace(/^file:\/\//, '')),
                    }),
                };
            } catch (_e) {
                return {icon_name: 'application-x-addon-symbolic'};
            }
        }
        return {icon_name: icon};
    }

    _createMenubarExtra(id) {
        const control = this._registry?.get(id);
        if (!control)
            return null;

        let available = false;
        try {
            available = Boolean(control.available());
        } catch (_e) {
            available = false;
        }
        if (!available)
            return null;

        const simple = this._isSimpleMenubarControl(control);
        const button = new PanelMenu.Button(0.0, control.name, simple);
        button.add_style_class_name('tahoe-cc-panel-button');
        button.add_style_class_name('tahoe-cc-menubar-control');

        const icon = new St.Icon({
            ...this._menubarIconProps(control),
            icon_size: 16,
            style_class: 'tahoe-cc-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.add_child(icon);

        const extra = {id, button, control, icon, box: null, built: null};

        if (simple) {
            try {
                button._clickGesture.set_enabled(true);
                button._clickGesture.connect('recognize',
                    () => this._runMenubarAction(control));
            } catch (e) {
                console.error(`${LOG} No se pudo activar «${id}» en la barra:`, e);
            }
        } else {
            button.menu.actor.add_style_class_name('tahoe-cc-menu');
            button.menu.actor.add_style_class_name('tahoe-cc-popover');
            button.menu.actor.add_style_class_name('tahoe-cc-menubar-popover');

            extra.box = new St.BoxLayout({
                style_class: 'tahoe-cc-menubar-popover-box',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            button.menu.box.add_child(extra.box);

            button.menu.connect('open-state-changed', (_menu, open) => {
                if (open) {
                    this._buildMenubarPopover(id);
                    this._attachPopoverGlass(button.menu, `menubar-${id}`);
                } else {
                    this._detachPopoverGlass(button.menu);
                    extra.built = null;
                    this._clearChildren(extra.box);
                }
            });
            button.menu.connect('menu-closed',
                () => this._detachPopoverGlass(button.menu));
        }

        button.connect('destroy', () => {
            if (this._menubarExtra.get(id)?.button === button) {
                this._menubarExtra.delete(id);
                this._menubarPopovers.delete(button.menu);
            }
        });

        this._menubarExtra.set(id, extra);

        const role = `tahoeCC_${id.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 60);
        try {
            const rightBox = this._panel?._rightBox;
            const clock = this._panel?.statusArea?.dateMenu?.container;
            const index = clock && clock.get_parent() === rightBox
                ? rightBox.get_children().indexOf(clock)
                : rightBox?.get_n_children() ?? 0;
            this._panel?.addToStatusArea(role, button, Math.max(0, index), 'right');
        } catch (e) {
            console.error(`${LOG} No se pudo añadir «${id}» a la barra:`, e);
            button.destroy();
            return null;
        }

        return extra;
    }

    _buildMenubarPopover(id) {
        const extra = this._menubarExtra.get(id);
        if (!extra?.box || !extra.control)
            return;

        this._clearChildren(extra.box);
        extra.built = null;

        const control = extra.control;
        const size = control.sizes.includes('wide')
            ? 'wide'
            : control.sizes.includes('medium')
                ? 'medium'
                : control.defaultSize;

        let built = null;
        try {
            built = control.create(size);
        } catch (e) {
            console.error(`${LOG} No se pudo crear el popover de «${id}»:`, e);
            return;
        }
        if (!built?.actor)
            return;

        const sheet = new St.BoxLayout({
            style_class: 'tahoe-cc-glass tahoe-cc-menubar-sheet',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        sheet.add_child(built.actor);
        extra.box.add_child(sheet);
        extra.built = built;
        extra.sheet = sheet;
        built.sync?.();
    }

    _syncMenubarPopovers() {
        for (const extra of this._menubarExtra.values()) {
            if (extra.built && extra.button?.menu.isOpen) {
                try {
                    extra.built.sync?.();
                } catch (_e) {
                    // Widget destruido.
                }
            }
        }
    }

    _closeMenubarPopovers() {
        for (const extra of this._menubarExtra.values()) {
            try {
                extra.button?.menu?.close();
            } catch (_e) {
                // Ignorar.
            }
        }
    }

    _syncMenubarControls() {
        if (this._destroyed)
            return;

        // Controles extra
        for (const [id, extra] of [...this._menubarExtra]) {
            if (!this._menubarControls.includes(id)) {
                extra.button?.destroy();
                this._menubarExtra.delete(id);
                continue;
            }

            let available = false;
            try {
                available = Boolean(extra.control?.available());
            } catch (_e) {
                available = false;
            }
            if (!available) {
                extra.button?.destroy();
                this._menubarExtra.delete(id);
            }
        }

        for (const id of this._menubarControls) {
            if (['battery', 'sound', 'wifi'].includes(id))
                continue;
            if (!this._menubarExtra.has(id))
                this._createMenubarExtra(id);
        }

        this._applyMenubarOrder();
        this._updatePanelButtons();
        this._editor?.refreshBarEdit?.();
    }

    _applyMenubarOrder() {
        const rightBox = this._panel?._rightBox;
        const clock = this._panel?.statusArea?.dateMenu?.container;
        if (!rightBox || !clock || clock.get_parent() !== rightBox)
            return;

        const containers = [];
        for (const id of this._menubarControls) {
            const container = this._getMenubarButton(id)?.container;
            if (container)
                containers.push(container);
        }
        if (this._ccButton?.container)
            containers.push(this._ccButton.container);

        if (containers.length === 0)
            return;

        try {
            // Añadir sólo los nuevos; reordenar con set_child_at_index no
            // desmapea los botones (desmapear el CC cerraría su menú).
            for (const container of containers) {
                if (container.get_parent() !== rightBox)
                    rightBox.add_child(container);
            }

            const clockIndex = rightBox.get_children().indexOf(clock);
            const base = Math.max(0, clockIndex - containers.length);
            const count = rightBox.get_n_children();

            for (let i = 0; i < containers.length; i++) {
                rightBox.set_child_at_index(containers[i],
                    Math.min(base + i, count - 1));
            }
        } catch (e) {
            console.error(`${LOG} No se pudo ordenar la barra:`, e);
        }
    }

    _onLayoutChanged() {
        if (this._destroyed || this._layoutApplying)
            return;

        const next = parseLayout(this._getString('control-center-layout', ''));
        const current = this._layout ?? [];
        if (JSON.stringify(current) === JSON.stringify(next))
            return;

        this._layout = next;
        if (this._ccButton?.menu.isOpen && this._view === 'main')
            this._renderMain();
    }

    _quickSettingsGrid() {
        if (this._qsMenuGone || this._destroyed)
            return null;
        return this._qsGridActor;
    }

    /** Ítems de GNOME que ya están representados por nuestros controles. */
    _knownQuickSettingsActors() {
        const known = new Set();
        const indicatorNames = [
            '_network', '_bluetooth', '_system', '_volumeOutput',
            '_volumeInput', '_brightness', '_nightLight', '_darkMode',
            '_doNotDisturb', '_powerProfiles', '_rfkill', '_autoRotate',
            '_backlight', '_thunderbolt', '_camera', '_remoteAccess',
            '_location', '_unsafeMode', '_backgroundApps',
        ];

        for (const name of indicatorNames) {
            const indicator = this._qs?.[name];
            for (const item of indicator?.quickSettingsItems ?? [])
                known.add(item);
        }

        return known;
    }

    _discoverExternalItems() {
        if (this._destroyed || this._qsMenuGone)
            return [];
        const grid = this._quickSettingsGrid();
        if (!grid || !this._qs)
            return [];

        const known = this._knownQuickSettingsActors();
        const items = [];

        for (const child of grid.get_children()) {
            if (!child || known.has(child))
                continue;
            // El placeholder del QuickSettingsLayout y la capa de menús no
            // son botones; los ítems de otras extensiones sí.
            if (!(child instanceof St.Button))
                continue;
            if (!child.visible)
                continue;
            items.push(child);
        }

        return items;
    }

    _refreshExternalRegistry() {
        if (!this._registry)
            return [];

        try {
            this._externalEntries = this._registry.updateExternals(
                this._discoverExternalItems());
        } catch (e) {
            console.error(`${LOG} No se pudieron registrar los controles externos:`, e);
            this._externalEntries = [];
        }

        return this._externalEntries;
    }

    _queueExternalRefresh() {
        if (this._destroyed || this._externalSyncId)
            return;

        this._externalSyncId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._externalSyncId = 0;
                if (this._destroyed || this._qsMenuGone)
                    return GLib.SOURCE_REMOVE;

                const entries = this._refreshExternalRegistry();
                this._autoAddExternals(entries);
                this._publishCatalog();

                if (this._view.startsWith('ext:') &&
                    !this._registry?.getExternal(this._view.slice(4))) {
                    this._view = 'main';
                    if (this._ccButton?.menu.isOpen)
                        this._renderMain();
                } else if (this._ccButton?.menu.isOpen &&
                    this._view === 'main') {
                    this._renderMain();
                } else {
                    this._queueSync();
                }

                return GLib.SOURCE_REMOVE;
            });
    }

    _getStrv(key, fallback = []) {
        try {
            return this._settings?.get_strv(key) ?? fallback;
        } catch (_e) {
            return fallback;
        }
    }

    /**
     * La primera vez que se descubre un control externo se añade al final
     * como "small" (así Caffeine sigue accesible sin editor). Se recuerda en
     * `control-center-known-externals` para no reañadirlo si el usuario lo
     * quita después.
     */
    _autoAddExternals(entries) {
        if (!this._settings || !entries.length)
            return;

        const knownSet = new Set(
            this._getStrv('control-center-known-externals'));
        const layout = this.getLayout();
        const ids = new Set(layout.map(entry => entry.id));
        let knownChanged = false;
        let layoutChanged = false;

        for (const entry of entries) {
            if (!entry?.external)
                continue;
            if (!knownSet.has(entry.id)) {
                knownSet.add(entry.id);
                knownChanged = true;

                if (!ids.has(entry.id)) {
                    layout.push({
                        id: entry.id,
                        size: entry.defaultSize ?? 'small',
                    });
                    ids.add(entry.id);
                    layoutChanged = true;
                }
            }
        }

        if (!knownChanged && !layoutChanged)
            return;

        this._layout = layout;
        this._layoutApplying = true;
        try {
            if (knownChanged) {
                this._settings.set_strv('control-center-known-externals',
                    [...knownSet]);
            }
            if (layoutChanged) {
                this._settings.set_string('control-center-layout',
                    layoutToJSON(layout));
            }
        } catch (e) {
            console.error(`${LOG} No se pudo registrar un control externo:`, e);
        } finally {
            this._layoutApplying = false;
        }
    }

    /**
     * Ejecuta el clic real del control original. En los QuickToggle de St
     * Button el clic invierte `checked` antes de emitir la señal; se replica
     * ese orden para que las extensiones que escuchan `checked` funcionen.
     */
    _invokeExternal(entry) {
        if (!entry || entry.destroyed || !entry.item)
            return;

        const item = entry.item;
        try {
            let toggleMode = false;
            try {
                toggleMode = Boolean(item.toggleMode ?? item.toggle_mode);
            } catch (_e) {
                toggleMode = false;
            }

            if (toggleMode && item.find_property?.('checked'))
                item.checked = !item.checked;

            // St.Button::clicked recibe el botón pulsado como único
            // parámetro; las extensiones pueden declarar la señal sin args.
            item.emit('clicked', 0);
        } catch (e) {
            console.error(`${LOG} No se pudo activar «${entry.id}»:`, e);
        }

        this._queueSync();
    }

    _showExternalMenu(id) {
        const entry = this._registry?.getExternal(id);
        if (!entry?.menu?.box) {
            if (entry)
                this._invokeExternal(entry);
            return;
        }

        this._view = `ext:${id}`;
        this._renderExternalMenu(id);
    }

    _renderExternalMenu(id) {
        const entry = this._registry?.getExternal(id);
        if (!this._ccRoot || !entry?.menu?.box) {
            this._view = 'main';
            if (this._ccRoot)
                this._renderMain();
            return;
        }

        this._destroyMainGlassHandles();
        this._restoreExternalMenu();
        this._clearChildren(this._ccRoot);
        this._mainRefs = null;
        this._view = `ext:${id}`;
        this._detailRefs = {refs: {}};

        const sheet = this._createSheet('tahoe-cc-sheet-external', 22, '', false);
        const header = createDetailHeader({
            title: entry.name,
            onBack: () => this._goBack(),
        });
        sheet.add_child(header.header);

        const box = entry.menu.box;
        try {
            const parent = box.get_parent();
            if (parent) {
                this._externalMenuHome = {
                    parent,
                    index: parent.get_children().indexOf(box),
                    box,
                };
                parent.remove_child(box);
            }

            box.x_expand = true;
            box.add_style_class_name('tahoe-cc-external-menu');
            sheet.add_child(box);
        } catch (e) {
            console.error(`${LOG} No se pudo abrir el menú externo:`, e);
            this._externalMenuHome = null;
        }

        this._ccRoot.add_child(sheet);
        this._addGlass(sheet, 22);
        this._animateIn(sheet);
    }

    _restoreExternalMenu() {
        const home = this._externalMenuHome;
        this._externalMenuHome = null;
        if (!home)
            return;

        const {box, parent, index} = home;
        try {
            if (!box)
                return;

            box.remove_style_class_name('tahoe-cc-external-menu');
            if (box.get_parent())
                box.get_parent().remove_child(box);

            if (parent) {
                const count = parent.get_n_children();
                parent.insert_child_at_index(box,
                    Math.min(Math.max(index, 0), count));
            }
        } catch (e) {
            console.error(`${LOG} No se pudo devolver el menú externo:`, e);
        }
    }

    _startScreenRecording() {
        try {
            this._ccButton?.menu.close();
        } catch (_e) {
            // Ignorar.
        }

        this._addIdle(() => {
            try {
                // UIMode.SCREENCAST = 1 (no está exportado por screenshot.js).
                Main.screenshotUI?.open(1)?.catch(e =>
                    console.error(`${LOG} No se pudo grabar la pantalla:`, e));
            } catch (e) {
                console.error(`${LOG} No se pudo grabar la pantalla:`, e);
            }
        });
    }

    _openBatteryPopover() {
        try {
            this._ccButton?.menu.close();
        } catch (_e) {
            // Ignorar.
        }

        this._addIdle(() => {
            try {
                this._batteryButton?.menu.open();
            } catch (e) {
                console.error(`${LOG} No se pudo abrir la batería:`, e);
            }
        });
    }

    _calculatorAvailable() {
        try {
            if (Shell.AppSystem.get_default()
                .lookup_app('org.gnome.Calculator.desktop'))
                return true;
        } catch (_e) {
            // Sin AppSystem.
        }

        return Boolean(GLib.find_program_in_path('gnome-calculator'));
    }

    _openCalculator() {
        try {
            this._ccButton?.menu.close();
        } catch (_e) {
            // Ignorar.
        }

        try {
            const app = Shell.AppSystem.get_default()
                .lookup_app('org.gnome.Calculator.desktop');
            if (app) {
                app.activate();
                return;
            }
        } catch (e) {
            console.error(`${LOG} No se pudo abrir la Calculadora:`, e);
        }

        try {
            Util.spawn(['gnome-calculator']);
        } catch (e) {
            console.error(`${LOG} No se pudo lanzar gnome-calculator:`, e);
        }
    }

    // ------------------------------------------------------------------
    // Acciones
    // ------------------------------------------------------------------

    _getShowBanners() {
        try {
            return this._notificationSettings?.get_boolean('show-banners') ?? true;
        } catch (_e) {
            return true;
        }
    }

    _toggleDoNotDisturb() {
        if (!this._notificationSettings)
            return;
        try {
            const show = this._notificationSettings.get_boolean('show-banners');
            this._notificationSettings.set_boolean('show-banners', !show);
            this._queueSync();
        } catch (e) {
            console.error(`${LOG} No se pudo cambiar No molestar:`, e);
        }
    }

    _toggleDarkMode() {
        if (!this._interfaceSettings)
            return;
        try {
            const dark = this._interfaceSettings.get_string('color-scheme') ===
                'prefer-dark';
            try {
                Main.layoutManager.screenTransition?.run();
            } catch (_e) {
                // Sin transición disponible.
            }
            this._interfaceSettings.set_string('color-scheme',
                dark ? 'default' : 'prefer-dark');
            this._queueSync();
        } catch (e) {
            console.error(`${LOG} No se pudo cambiar el modo oscuro:`, e);
        }
    }

    _toggleNightLight() {
        if (!this._colorSettings)
            return;
        try {
            const enabled = this._colorSettings.get_boolean('night-light-enabled');
            this._colorSettings.set_boolean('night-light-enabled', !enabled);
            this._queueSync();
        } catch (e) {
            console.error(`${LOG} No se pudo cambiar la luz nocturna:`, e);
        }
    }

    _takeScreenshot() {
        try {
            this._ccButton?.menu.close();
        } catch (_e) {
            // Ignorar.
        }

        this._addIdle(() => {
            try {
                Main.screenshotUI?.open()?.catch(e =>
                    console.error(`${LOG} No se pudo abrir la captura:`, e));
            } catch (e) {
                console.error(`${LOG} No se pudo abrir la captura:`, e);
            }
        });
    }

    _lockScreen() {
        try {
            this._ccButton?.menu.close();
            Main.screenShield?.lock(true);
        } catch (e) {
            console.error(`${LOG} No se pudo bloquear la pantalla:`, e);
        }
    }

    _openSettings() {
        try {
            this._ccButton?.menu.close();
        } catch (_e) {
            // Ignorar.
        }
        openSettingsApp();
    }

    // ------------------------------------------------------------------
    // Sincronización
    // ------------------------------------------------------------------

    _syncAll() {
        if (this._destroyed || this._panelButtonsGone)
            return;

        this._updatePanelButtons();
        this._syncMenubarPopovers();

        if (this._view === 'main' && this._mainRefs)
            this._syncMainView();
    }

    _updatePanelButtons() {
        if (this._batteryButton) {
            const battery = this._battery;
            const present = Boolean(battery?.present) &&
                this._menubarEnabled('battery');

            try {
                this._batteryButton.container.visible = present;
            } catch (_e) {
                // Ignorar.
            }

            if (present && this._batteryLabel && this._batteryIcon) {
                const showPercent = this._getBoolean(
                    'control-center-show-battery-percent', true);
                this._batteryLabel.text = `${battery.percentage}%`;
                this._batteryLabel.visible = showPercent;
                this._batteryIcon.setLevel(battery.percentage / 100);
                this._batteryIcon.setCharging(battery.charging);
            }
        }

        if (this._soundButton) {
            const visible = Boolean(this._sink) &&
                this._menubarEnabled('sound');
            try {
                this._soundButton.container.visible = visible;
            } catch (_e) {
                // Ignorar.
            }

            if (visible && this._soundPanelIcon) {
                this._soundPanelIcon.icon_name =
                    this._sinkIconName(this._sink, false);
            }

            if (this._soundButton.menu.isOpen)
                this._updateSoundPopover();
        }

        if (this._wifiButton) {
            const network = this._network;
            const visible = Boolean(network && !network.failed) &&
                this._menubarEnabled('wifi');
            try {
                this._wifiButton.container.visible = visible;
            } catch (_e) {
                // Ignorar.
            }
            if (visible && this._wifiPanelIcon)
                this._wifiPanelIcon.icon_name = network.wifiIconName;
        }

        if (this._ccButton) {
            try {
                this._ccButton.container.visible = true;
            } catch (_e) {
                // Ignorar.
            }
        }

        if (this._batteryButton?.menu.isOpen)
            this._buildBatteryPopover();

        for (const extra of this._menubarExtra.values()) {
            try {
                if (extra.button?.container)
                    extra.button.container.visible = true;
            } catch (_e) {
                // El botón ya no existe.
            }
        }
    }

    // ------------------------------------------------------------------
    // Destrucción
    // ------------------------------------------------------------------

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        // Si hay un menú externo prestado, devolverlo antes de destruir el
        // actor del Centro de control.
        this._restoreExternalMenu();
        this._restoreQuickSettingsShortcut();

        if (this._notifications) {
            try {
                this._notifications.destroy();
            } catch (e) {
                console.error(`${LOG} No se pudieron destruir las notificaciones:`, e);
            }
            this._notifications = null;
        }

        if (this._externalSyncId) {
            try {
                GLib.source_remove(this._externalSyncId);
            } catch (_e) {
                // Ya retirado.
            }
            this._externalSyncId = 0;
        }

        for (const button of [this._ccButton, this._batteryButton,
            this._soundButton, this._wifiButton]) {
            try {
                button?.menu?.close();
            } catch (_e) {
                // Ignorar.
            }
        }

        this._removePanelButton(ROLES.controlCenter, this._ccButton);
        this._removePanelButton(ROLES.battery, this._batteryButton);
        this._removePanelButton(ROLES.sound, this._soundButton);
        this._removePanelButton(ROLES.wifi, this._wifiButton);

        this._ccButton = null;
        this._batteryButton = null;
        this._soundButton = null;
        this._wifiButton = null;
        this._ccRoot = null;
        this._ccColumn = null;
        this._batteryPopoverBox = null;
        this._wifiPopoverBox = null;
        this._soundPopoverBox = null;
        this._soundPopoverRefs = null;
        this._mainRefs = null;
        this._detailRefs = null;
        this._batteryLabel = null;
        this._batteryIcon = null;
        this._soundPanelIcon = null;
        this._wifiPanelIcon = null;

        this._destroyAllGlassHandles();
        if (this._glassUnsubscribe) {
            this._glassUnsubscribe();
            this._glassUnsubscribe = null;
        }
        this._glassEngine = null;

        for (const actor of [...this._glassActors]) {
            try {
                actor.remove_all_effects?.();
            } catch (_e) {
                // Ignorar.
            }
        }
        this._glassActors.clear();

        this._restoreQuickSettingsIndicators();

        this._closeMenubarPopovers();

        for (const extra of [...this._menubarExtra.values()]) {
            try {
                extra.button?.destroy();
            } catch (_e) {
                // Ignorar.
            }
        }
        this._menubarExtra.clear();
        this._menubarPopovers.clear();
        this._menubarControls = [];

        if (this._editor) {
            try {
                this._editor.destroy();
            } catch (e) {
                console.error(`${LOG} No se pudo destruir el editor:`, e);
            }
            this._editor = null;
        }

        if (this._registry) {
            try {
                this._registry.destroy();
            } catch (e) {
                console.error(`${LOG} No se pudo destruir el registro:`, e);
            }
            this._registry = null;
        }
        this._externalEntries = [];

        for (const id of [...this._timeoutIds]) {
            try {
                GLib.source_remove(id);
            } catch (_e) {
                // Ignorar.
            }
        }
        this._timeoutIds.clear();
        this._syncTimeoutId = 0;

        for (const id of [...this._idleIds]) {
            try {
                GLib.source_remove(id);
            } catch (_e) {
                // Ignorar.
            }
        }
        this._idleIds.clear();

        this._disconnectTracked();

        if (this._tahoeTheme && this._themeChangedId)
            this._tahoeTheme.disconnect(this._themeChangedId);
        this._themeChangedId = 0;
        this._tahoeTheme = null;

        if (this._sink) {
            try {
                this._sink.disconnectObject(this);
            } catch (_e) {
                // Ignorar.
            }
            this._sink = null;
        }

        for (const controller of [
            this._network,
            this._bluetooth,
            this._battery,
            this._powerProfiles,
            this._media,
        ]) {
            try {
                if (typeof controller?.destroy === 'function') {
                    controller.destroy();
                } else if (controller) {
                    console.debug(`${LOG} Controlador sin destroy(): ` +
                        `${controller.constructor?.name ?? '?'}`);
                }
            } catch (e) {
                console.error(`${LOG} No se pudo destruir el controlador ` +
                    `«${controller?.constructor?.name ?? '?'}»:`, e);
            }
        }

        this._network = null;
        this._bluetooth = null;
        this._battery = null;
        this._powerProfiles = null;
        this._media = null;
        this._rfkill = null;
        this._mixer = null;
        this._qs = null;
        this._qsIndicators = null;
        this._qsWatchedChildren.clear();
        this._settings = null;
        this._interfaceSettings = null;
        this._notificationSettings = null;
        this._colorSettings = null;
        this._panel = null;
        this._extension = null;
        this._layout = null;
        this._keyboardBacklight = null;
        this._externalMenuHome = null;

        this._unloadStylesheet();
    }
}
