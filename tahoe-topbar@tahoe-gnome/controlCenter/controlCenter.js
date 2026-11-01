// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Centro de control estilo macOS Tahoe (macOS 26).
//
// Se instala desde extension.js con:
//
//     const cc = new TahoeControlCenter(extension);
//     cc.destroy();
//
// El módulo añade tres botones a la barra (batería, Wi-Fi y Centro de
// control), oculta los indicadores del botón de Ajustes rápidos de GNOME
// (devolviéndolos a su sitio en destroy) y sustituye el atajo Super+S.

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

import {
    CircleButton,
    createModuleRow,
    createTile,
    createQuickAction,
    createTahoeSlider,
    createListRow,
    createSectionLabel,
    createSeparator,
    createDetailHeader,
    createFooterLink,
    createControlCenterGlyph,
} from './widgets.js';

import {NetworkController} from './network.js';
import {BluetoothController} from './bluetooth.js';
import {BatteryController, PowerProfilesController, PROFILE_INFO, formatDuration} from './power.js';
import {MediaController} from './media.js';

const LOG = '[tahoe-topbar/cc]';

const ROLES = {
    battery: 'tahoeCCBattery',
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

function escapeCssUrl(url) {
    return String(url).replace(/(["\\])/g, '\\$1').replace(/\n/g, '');
}

function parseArtwork(artUrl) {
    if (!artUrl)
        return '';

    if (artUrl.startsWith('file://') || artUrl.startsWith('http://') ||
        artUrl.startsWith('https://'))
        return artUrl;

    return '';
}

/**
 * Abre un panel concreto de gnome-control-center. Usa la acción
 * "launch-panel" de la aplicación (como GNOME Shell) y cae a spawn si la
 * aplicación no está disponible.
 */
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

export class TahoeControlCenter {
    constructor(extension) {
        this._extension = extension ?? null;
        this._destroyed = false;
        this._tracked = new Set();
        this._timeoutIds = new Set();
        this._idleIds = new Set();

        this._theme = null;
        this._cssFile = null;

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
        this._qsRestoring = false;
        this._brightnessAnchor = null;
        this._brightnessIndicator = null;

        this._batteryButton = null;
        this._wifiButton = null;
        this._ccButton = null;

        this._batteryLabel = null;
        this._batteryIcon = null;
        this._wifiPanelIcon = null;

        this._batteryPopoverBox = null;
        this._wifiPopoverBox = null;

        this._ccRoot = null;
        this._view = 'main';
        this._mainRefs = null;
        this._detailRefs = null;

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

        this._loadStylesheet();
        this._loadSettings();
        this._applyColorScheme();

        this._createControllers();
        this._bindControllers();
        this._setupVolume();

        this._createPanelButtons();
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
            ]) {
                this._connect(this._settings, `changed::${key}`,
                    () => this._onSettingsChanged(key));
            }
        }
    }

    _onSettingsChanged(key) {
        if (this._destroyed)
            return;

        switch (key) {
        case 'control-center-show-battery-percent':
        case 'control-center-show-now-playing':
            this._queueSync();
            break;
        default:
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

        this._syncTimeoutId = this._addTimeout(80, () => {
            this._syncTimeoutId = 0;
            this._syncAll();
        });
    }

    // ------------------------------------------------------------------
    // Controladores de estado
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
    // Botones del panel
    // ------------------------------------------------------------------

    _createPanelButtons() {
        this._createBatteryButton();
        this._createWifiButton();
        this._createControlCenterButton();
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

        this._batteryIcon = new St.Icon({
            style_class: 'tahoe-cc-panel-icon',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });

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
            if (open) {
                this._applyColorScheme();
                this._buildBatteryPopover();
            }
        });

        this._insertPanelButton(ROLES.battery, this._batteryButton);
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
            if (open) {
                this._applyColorScheme();
                this._buildWifiPopover();
                this._network?.requestScan();
                this._addTimeout(900, () => {
                    if (this._wifiButton?.menu.isOpen)
                        this._buildWifiPopover();
                });
            }
        });

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
        });
        this._ccButton.menu.box.add_child(this._ccRoot);

        this._connect(this._ccButton.menu, 'open-state-changed', (_menu, open) => {
            if (open) {
                this._view = 'main';
                this._applyColorScheme();
                this._renderMain();
                this._network?.requestScan();
                this._queueSync();
            }
        });

        // Al terminar la animación de cierre liberamos los widgets.
        this._connect(this._ccButton.menu, 'menu-closed', () => {
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
    // Ajustes rápidos de GNOME
    // ------------------------------------------------------------------

    _isManagedIndicator(actor) {
        const qs = this._qs;
        if (!qs || !actor)
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
        this._qsWasVisible = qs.container?.visible ?? true;

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
            if (!this._qsRestoring)
                this._scanQuickSettingsIndicators();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scanQuickSettingsIndicators() {
        if (!this._qsIndicators)
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

        // El botón de Ajustes rápidos usa quickSettings._brightness como
        // ancla para insertar indicadores de otras extensiones. Sustituimos
        // el indicador real por un actor invisible para que esa API siga
        // funcionando mientras el brillo está oculto.
        let insertedAnchor = false;
        if (this._qs?._brightness === actor && !this._brightnessAnchor) {
            try {
                const anchor = new St.Widget({
                    visible: false,
                    width: 0,
                    height: 0,
                });
                // Por si algún código de GNOME lee el ancla como indicador.
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

                // El brillo se restaura después, en la posición de su ancla.
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

        if (this._panel.toggleQuickSettings === this._toggleQuickSettingsOverride) {
            this._panel.toggleQuickSettings = this._originalToggleQuickSettings;
        }

        this._originalToggleQuickSettings = null;
        this._toggleQuickSettingsOverride = null;
    }

    // ------------------------------------------------------------------
    // Señales del escritorio
    // ------------------------------------------------------------------

    _connectDesktopSignals() {
        if (this._interfaceSettings) {
            this._connect(this._interfaceSettings, 'changed::color-scheme', () => {
                this._applyColorScheme();
                this._queueSync();
            });
        }

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
            this._applyColorScheme();
            if (Main.sessionMode.currentMode === 'user') {
                this._syncQuickSettingsVisibility();
                this._reorderPanelButtons();
            }
            this._queueSync();
        });
    }

    _reorderPanelButtons() {
        const rightBox = this._panel?._rightBox;
        const clock = this._panel?.statusArea?.dateMenu?.container;
        if (!rightBox || !clock || clock.get_parent() !== rightBox)
            return;

        for (const button of [this._batteryButton, this._wifiButton, this._ccButton]) {
            const container = button?.container;
            if (!container || container.get_parent() !== rightBox)
                continue;

            try {
                rightBox.remove_child(container);
                const index = rightBox.get_children().indexOf(clock);
                rightBox.insert_child_at_index(container,
                    index >= 0 ? index : rightBox.get_n_children());
            } catch (e) {
                console.error(`${LOG} No se pudo recolocar un botón del panel:`, e);
            }
        }
    }

    _applyColorScheme() {
        let light = false;
        try {
            light = this._interfaceSettings?.get_string('color-scheme') !== 'prefer-dark';
        } catch (_e) {
            light = false;
        }

        this._isLight = light;

        for (const button of [this._ccButton, this._batteryButton, this._wifiButton]) {
            const actor = button?.menu?.actor;
            if (!actor)
                continue;

            try {
                if (light)
                    actor.add_style_class_name('tahoe-cc-light');
                else
                    actor.remove_style_class_name('tahoe-cc-light');
            } catch (_e) {
                // Actor destruido.
            }
        }
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
        this._mainRefs = null;
        this._detailRefs = null;
        this._clearChildren(this._ccRoot);
        this._view = 'main';
    }

    _renderMain() {
        if (!this._ccRoot)
            return;

        this._clearChildren(this._ccRoot);
        this._mainRefs = {};
        this._detailRefs = null;
        this._view = 'main';

        const root = this._ccRoot;

        // --- Rejilla de dos columnas ----------------------------------
        const grid = new St.Widget({
            style_class: 'tahoe-cc-grid',
            layout_manager: new Clutter.GridLayout(),
            x_expand: true,
        });
        const gridLayout = grid.layout_manager;
        gridLayout.column_spacing = px(10);
        gridLayout.row_spacing = px(10);
        gridLayout.column_homogeneous = true;

        const connectivity = new St.BoxLayout({
            style_class: 'tahoe-cc-card tahoe-cc-connectivity',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        const rightColumn = new St.BoxLayout({
            style_class: 'tahoe-cc-right-column',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        gridLayout.attach(connectivity, 0, 0, 1, 1);
        gridLayout.attach(rightColumn, 1, 0, 1, 1);
        root.add_child(grid);

        // Wi-Fi
        const wifiRow = createModuleRow({
            iconName: 'network-wireless-signal-none-symbolic',
            title: 'Wi‑Fi',
            onToggle: () => this._network?.toggleWifi(),
            onActivate: () => this._showDetail('wifi'),
        });
        connectivity.add_child(wifiRow.row);

        // Bluetooth
        const bluetoothRow = createModuleRow({
            iconName: 'bluetooth-disabled-symbolic',
            title: 'Bluetooth',
            onToggle: () => this._bluetooth?.toggle(),
            onActivate: () => this._showDetail('bluetooth'),
        });
        connectivity.add_child(bluetoothRow.row);

        // Modo avión
        const airplaneRow = createModuleRow({
            iconName: 'airplane-mode-symbolic',
            title: 'Modo avión',
            onToggle: () => {
                if (this._rfkill)
                    this._rfkill.airplane_mode = !this._rfkill.airplane_mode;
            },
        });
        connectivity.add_child(airplaneRow.row);

        this._mainRefs.wifi = wifiRow;
        this._mainRefs.bluetooth = bluetoothRow;
        this._mainRefs.airplane = airplaneRow;

        // Concentración
        const focusCard = new St.BoxLayout({
            style_class: 'tahoe-cc-card tahoe-cc-focus-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });

        const focusRow = createModuleRow({
            iconName: 'weather-clear-night-symbolic',
            title: 'Concentración',
            onToggle: () => this._toggleDoNotDisturb(),
            onActivate: () => this._toggleDoNotDisturb(),
        });
        focusCard.add_child(focusRow.row);
        rightColumn.add_child(focusCard);

        // Modo oscuro + Luz nocturna
        const tiles = new St.BoxLayout({
            style_class: 'tahoe-cc-tiles',
            x_expand: true,
            y_expand: true,
        });

        const darkTile = createTile({
            iconName: 'dark-mode-symbolic',
            title: 'Modo oscuro',
            onToggle: () => this._toggleDarkMode(),
        });

        const nightTile = createTile({
            iconName: 'night-light-symbolic',
            title: 'Luz nocturna',
            onToggle: () => this._toggleNightLight(),
        });

        tiles.add_child(darkTile.tile);
        tiles.add_child(nightTile.tile);
        rightColumn.add_child(tiles);

        this._mainRefs.focus = focusRow;
        this._mainRefs.dark = darkTile;
        this._mainRefs.night = nightTile;

        // --- Pantalla --------------------------------------------------
        const brightnessCard = new St.BoxLayout({
            style_class: 'tahoe-cc-card tahoe-cc-slider-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        brightnessCard.add_child(new St.Label({
            text: 'Pantalla',
            style_class: 'tahoe-cc-card-title',
            x_align: Clutter.ActorAlign.START,
        }));

        const brightness = createTahoeSlider({
            iconName: 'display-brightness-symbolic',
            accessibleName: 'Brillo de la pantalla',
        });
        brightness.slider.connect('notify::value', () => {
            if (this._updatingBrightnessSlider)
                return;

            const scale = Main.brightnessManager?.globalScale;
            if (scale)
                scale.value = brightness.slider.value;
        });
        brightnessCard.add_child(brightness.actor);
        root.add_child(brightnessCard);
        this._mainRefs.brightnessCard = brightnessCard;
        this._mainRefs.brightness = brightness;

        // --- Sonido ----------------------------------------------------
        const soundCard = new St.BoxLayout({
            style_class: 'tahoe-cc-card tahoe-cc-slider-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });

        const soundHeader = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        soundHeader.add_child(new St.Label({
            text: 'Sonido',
            style_class: 'tahoe-cc-card-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));

        const outputButton = new CircleButton({
            iconName: 'audio-headphones-symbolic',
            iconSize: 14,
            accessibleName: 'Elegir salida de sonido',
            styleClass: 'tahoe-cc-small-circle',
        });
        outputButton.connect('clicked', () => this._showDetail('sound'));
        soundHeader.add_child(outputButton);
        soundCard.add_child(soundHeader);

        const volume = createTahoeSlider({
            iconName: 'audio-volume-high-symbolic',
            accessibleName: 'Volumen',
            onIconClick: () => this._toggleMute(),
        });
        volume.slider.connect('notify::value', () => {
            if (this._updatingVolumeSlider)
                return;
            this._setVolumeFromSlider(volume.slider.value);
        });
        soundCard.add_child(volume.actor);
        root.add_child(soundCard);
        this._mainRefs.soundCard = soundCard;
        this._mainRefs.volume = volume;

        // --- Reproduciendo --------------------------------------------
        const mediaCard = new St.BoxLayout({
            style_class: 'tahoe-cc-card tahoe-cc-media-card',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const art = new St.Bin({
            style_class: 'tahoe-cc-media-art',
            width: px(44),
            height: px(44),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const artIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 18,
            style_class: 'tahoe-cc-media-art-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        art.set_child(artIcon);
        mediaCard.add_child(art);

        const mediaLabels = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'tahoe-cc-media-labels',
        });
        const mediaTitle = new St.Label({
            text: '',
            style_class: 'tahoe-cc-media-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        mediaTitle.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        const mediaArtist = new St.Label({
            text: '',
            style_class: 'tahoe-cc-media-artist',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        mediaArtist.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        mediaLabels.add_child(mediaTitle);
        mediaLabels.add_child(mediaArtist);
        mediaCard.add_child(mediaLabels);

        const mediaControls = new St.BoxLayout({
            style_class: 'tahoe-cc-media-controls',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const previousButton = new CircleButton({
            iconName: 'media-skip-backward-symbolic',
            iconSize: 12,
            accessibleName: 'Anterior',
            styleClass: 'tahoe-cc-media-button',
        });
        previousButton.connect('clicked', () => this._media?.previous());

        const playButton = new CircleButton({
            iconName: 'media-playback-start-symbolic',
            iconSize: 13,
            accessibleName: 'Reproducir o pausar',
            styleClass: 'tahoe-cc-media-button',
        });
        playButton.connect('clicked', () => this._media?.playPause());

        const nextButton = new CircleButton({
            iconName: 'media-skip-forward-symbolic',
            iconSize: 12,
            accessibleName: 'Siguiente',
            styleClass: 'tahoe-cc-media-button',
        });
        nextButton.connect('clicked', () => this._media?.next());

        mediaControls.add_child(previousButton);
        mediaControls.add_child(playButton);
        mediaControls.add_child(nextButton);
        mediaCard.add_child(mediaControls);

        root.add_child(mediaCard);

        this._mainRefs.mediaCard = mediaCard;
        this._mainRefs.mediaArt = art;
        this._mainRefs.mediaArtIcon = artIcon;
        this._mainRefs.mediaTitle = mediaTitle;
        this._mainRefs.mediaArtist = mediaArtist;
        this._mainRefs.mediaPrevious = previousButton;
        this._mainRefs.mediaPlay = playButton;
        this._mainRefs.mediaNext = nextButton;
        this._mainRefs._mediaArtUrl = null;

        // --- Acciones rápidas -----------------------------------------
        const actions = new St.BoxLayout({
            style_class: 'tahoe-cc-card tahoe-cc-actions',
            x_expand: true,
        });

        const powerAction = createQuickAction({
            iconName: 'power-profile-balanced-symbolic',
            label: 'Perfil de energía',
            onClick: () => this._powerProfiles?.cycleProfile(),
        });
        const screenshotAction = createQuickAction({
            iconName: 'screenshooter-symbolic',
            label: 'Captura',
            onClick: () => this._takeScreenshot(),
        });
        const lockAction = createQuickAction({
            iconName: 'system-lock-screen-symbolic',
            label: 'Bloquear',
            onClick: () => this._lockScreen(),
        });
        const settingsAction = createQuickAction({
            iconName: 'preferences-system-symbolic',
            label: 'Ajustes',
            onClick: () => this._openSettings(),
        });

        actions.add_child(powerAction.box);
        actions.add_child(screenshotAction.box);
        actions.add_child(lockAction.box);
        actions.add_child(settingsAction.box);
        root.add_child(actions);
        this._mainRefs.powerAction = powerAction;

        // --- Pie -------------------------------------------------------
        const footer = createFooterLink('Más ajustes de GNOME…',
            () => this._showGnomeQuickSettings());
        root.add_child(footer);
        this._mainRefs.footer = footer;

        this._syncMainView();
    }

    _syncMainView() {
        const refs = this._mainRefs;
        if (!refs || this._destroyed)
            return;

        const network = this._network;

        // Wi-Fi
        if (refs.wifi) {
            let subtitle = 'No disponible';
            let sensitive = false;
            let on = false;
            let icon = 'network-wireless-signal-none-symbolic';

            if (network && !network.failed) {
                sensitive = true;
                icon = network.wifiIconName;
                if (!network.hasWifi) {
                    subtitle = network.ethernetConnected ? 'Ethernet' : 'No disponible';
                    on = network.ethernetConnected;
                    sensitive = false;
                } else if (!network.wifiEnabled) {
                    subtitle = 'Desactivado';
                    on = false;
                } else {
                    on = true;
                    subtitle = network.wifiSsid || 'No conectado';
                }
            }

            refs.wifi.setSubtitle(subtitle);
            refs.wifi.setOn(on);
            refs.wifi.setIcon(icon);
            refs.wifi.setSensitive(sensitive);
        }

        // Bluetooth
        if (refs.bluetooth) {
            const bluetooth = this._bluetooth;
            const available = Boolean(bluetooth?.available);
            refs.bluetooth.setSubtitle(bluetooth?.subtitle ?? 'No disponible');
            refs.bluetooth.setOn(Boolean(bluetooth?.enabled));
            refs.bluetooth.setIcon(bluetooth?.iconName ?? 'bluetooth-disabled-symbolic');
            refs.bluetooth.setSensitive(available);
        }

        // Modo avión
        if (refs.airplane) {
            const show = Boolean(this._rfkill?.show_airplane_mode);
            refs.airplane.row.visible = show;

            if (show) {
                const on = Boolean(this._rfkill?.airplane_mode);
                refs.airplane.setOn(on);
                refs.airplane.setSubtitle(on ? 'Activado' : 'Desactivado');
                refs.airplane.setSensitive(!this._rfkill?.hw_airplane_mode);
            }
        }

        // Concentración
        if (refs.focus) {
            const dnd = !this._getShowBanners();
            refs.focus.setOn(dnd);
            refs.focus.setSubtitle(dnd ? 'No molestar' : 'Desactivado');
        }

        // Modo oscuro
        if (refs.dark) {
            let dark = false;
            try {
                dark = this._interfaceSettings?.get_string('color-scheme') === 'prefer-dark';
            } catch (_e) {
                dark = false;
            }
            refs.dark.setOn(dark);
        }

        // Luz nocturna
        if (refs.night) {
            let enabled = false;
            let supported = true;
            try {
                enabled = this._colorSettings?.get_boolean('night-light-enabled') ?? false;
            } catch (_e) {
                enabled = false;
            }
            try {
                supported = global.backend.get_monitor_manager().night_light_supported !== false;
            } catch (_e) {
                supported = true;
            }
            refs.night.setOn(enabled);
            refs.night.setSensitive(supported);
        }

        // Brillo
        if (refs.brightnessCard) {
            const scale = Main.brightnessManager?.globalScale ?? null;
            refs.brightnessCard.visible = Boolean(scale);

            if (scale) {
                this._updatingBrightnessSlider = true;
                refs.brightness.slider.value = scale.value;
                this._updatingBrightnessSlider = false;
            }
        }

        // Sonido
        if (refs.soundCard) {
            const sink = this._sink;
            refs.soundCard.visible = Boolean(sink);

            if (sink) {
                let volume = 0;
                let muted = true;

                try {
                    muted = Boolean(sink.is_muted);
                    const max = this._mixer?.get_vol_max_norm() || 1;
                    volume = muted ? 0 : Math.clamp(sink.volume / max, 0, 1);
                } catch (_e) {
                    volume = 0;
                    muted = true;
                }

                this._updatingVolumeSlider = true;
                refs.volume.slider.value = volume;
                this._updatingVolumeSlider = false;

                let icon = 'audio-volume-high-symbolic';
                if (muted)
                    icon = 'audio-volume-muted-symbolic';
                else if (volume < 0.33)
                    icon = 'audio-volume-low-symbolic';
                else if (volume < 0.66)
                    icon = 'audio-volume-medium-symbolic';

                refs.volume.setIcon(icon);
            }
        }

        // Reproduciendo
        if (refs.mediaCard) {
            const showNowPlaying = this._getBoolean('control-center-show-now-playing', true);
            const media = this._media;
            const visible = Boolean(showNowPlaying && media?.hasPlayer && media.title);
            refs.mediaCard.visible = visible;

            if (visible) {
                refs.mediaTitle.text = media.title || 'Reproduciendo';
                refs.mediaArtist.text = media.artist || '';
                refs.mediaArtist.visible = Boolean(media.artist);
                refs.mediaPlay.setIcon(media.playing
                    ? 'media-playback-pause-symbolic'
                    : 'media-playback-start-symbolic');
                refs.mediaPrevious.opacity = media.canGoPrevious ? 255 : 120;
                refs.mediaPrevious.reactive = media.canGoPrevious;
                refs.mediaNext.opacity = media.canGoNext ? 255 : 120;
                refs.mediaNext.reactive = media.canGoNext;

                this._updateArtwork(refs, media.artUrl);
            }
        }

        // Perfil de energía
        if (refs.powerAction) {
            const available = Boolean(this._powerProfiles?.available);
            refs.powerAction.setVisible(available);
            if (available) {
                const info = this._powerProfiles.activeInfo;
                refs.powerAction.setIcon(info.iconName);
                refs.powerAction.label.text = 'Perfil de energía';
                refs.powerAction.circle.accessible_name =
                    `Perfil de energía: ${info.name}`;
            }
        }
    }

    _updateArtwork(refs, artUrl) {
        if (refs._mediaArtUrl === artUrl)
            return;

        refs._mediaArtUrl = artUrl;

        const url = parseArtwork(artUrl);
        if (!url) {
            refs.mediaArt.set_style(null);
            refs.mediaArt.remove_style_class_name('tahoe-cc-media-art-image');
            refs.mediaArtIcon.visible = true;
            return;
        }

        try {
            refs.mediaArt.set_style(
                `background-image: url("${escapeCssUrl(url)}");`);
            refs.mediaArt.add_style_class_name('tahoe-cc-media-art-image');
            refs.mediaArtIcon.visible = false;
        } catch (e) {
            console.error(`${LOG} No se pudo mostrar la carátula:`, e);
            refs.mediaArtIcon.visible = true;
        }
    }

    // ------------------------------------------------------------------
    // Detalle: Wi-Fi / Bluetooth / sonido
    // ------------------------------------------------------------------

    _showDetail(view) {
        if (!this._ccRoot)
            return;

        this._view = view;
        this._renderDetail();

        // Una única actualización diferida para dar tiempo a que el escaneo
        // Wi-Fi o la enumeración Bluetooth terminen.
        if (view === 'wifi' || view === 'bluetooth') {
            this._addTimeout(1000, () => {
                if (this._view === view && this._ccButton?.menu.isOpen)
                    this._renderDetail();
            });
        }
    }

    _goBack() {
        this._view = 'main';
        this._renderMain();
    }

    _renderDetail() {
        if (!this._ccRoot)
            return;

        this._clearChildren(this._ccRoot);
        this._mainRefs = null;
        this._detailRefs = {};

        switch (this._view) {
        case 'wifi':
            this._renderWifiDetail();
            break;
        case 'bluetooth':
            this._renderBluetoothDetail();
            break;
        case 'sound':
            this._renderSoundDetail();
            break;
        default:
            this._renderMain();
            break;
        }
    }

    _createDetailCard() {
        return new St.BoxLayout({
            style_class: 'tahoe-cc-card tahoe-cc-detail-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
    }

    _createScrollList(rows) {
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

        const rowHeight = px(42);
        const height = Math.min(Math.max(rows.length, 1) * rowHeight, px(286));

        const holder = new St.Bin({
            style_class: 'tahoe-cc-scroll-holder',
            x_expand: true,
            height,
        });
        holder.set_child(scroll);

        return holder;
    }

    _renderWifiDetail() {
        const refs = this._detailRefs;
        const header = createDetailHeader('Wi‑Fi', () => this._goBack());
        this._ccRoot.add_child(header.header);
        refs.header = header;

        const card = this._createDetailCard();
        this._ccRoot.add_child(card);

        const toggleRow = createModuleRow({
            iconName: 'network-wireless-symbolic',
            title: 'Wi‑Fi',
            onToggle: () => {
                this._network?.toggleWifi();
                this._addTimeout(700, () => {
                    if (this._view === 'wifi' && this._ccButton?.menu.isOpen)
                        this._renderDetail();
                });
            },
        });
        card.add_child(toggleRow.row);
        refs.wifiToggle = toggleRow;

        const network = this._network;
        if (!network || network.failed) {
            card.add_child(createSectionLabel('NetworkManager no está disponible'));
        } else if (!network.hasWifi) {
            card.add_child(createSectionLabel('No hay adaptador Wi‑Fi en este equipo'));
        } else if (!network.wifiEnabled) {
            card.add_child(createSectionLabel('Wi‑Fi desactivado'));
        } else {
            const current = network.accessPoints.filter(ap => ap.active);
            if (current.length > 0) {
                const activeRow = createListRow({
                    iconName: `network-wireless-signal-${this._signalName(current[0].strength)}-symbolic`,
                    title: current[0].ssid,
                    subtitle: 'Red actual',
                    check: true,
                });
                card.add_child(activeRow.button);
                refs.activeRow = activeRow;
            }

            const rows = [];
            for (const ap of network.accessPoints) {
                if (ap.active)
                    continue;

                const row = createListRow({
                    iconName: `network-wireless-signal-${this._signalName(ap.strength)}-symbolic`,
                    title: ap.ssid,
                    subtitle: ap.secure ? 'Protegida' : 'Abierta',
                    check: false,
                    suffixIconName: ap.secure ? 'network-wireless-encrypted-symbolic' : null,
                    onClick: () => {
                        if (!ap.saved) {
                            network.openWifiSettings();
                            this._ccButton?.menu.close();
                            return;
                        }

                        if (network.connectSaved(ap.ssid))
                            this._ccButton?.menu.close();
                    },
                });
                rows.push(row.button);
            }

            if (rows.length === 0) {
                card.add_child(createSectionLabel('No se encontraron redes'));
            } else {
                card.add_child(createSectionLabel('Redes disponibles'));
                card.add_child(this._createScrollList(rows));
            }
        }

        card.add_child(createSeparator());
        card.add_child(createFooterLink('Ajustes de Wi‑Fi…',
            () => {
                this._ccButton?.menu.close();
                openSettingsPanel('wifi');
            }));

        this._syncDetailWifi();
    }

    _syncDetailWifi() {
        const refs = this._detailRefs;
        if (!refs?.wifiToggle)
            return;

        const network = this._network;
        let subtitle = 'No disponible';
        let on = false;

        if (network && !network.failed) {
            if (!network.hasWifi)
                subtitle = network.ethernetConnected ? 'Ethernet' : 'No disponible';
            else if (!network.wifiEnabled)
                subtitle = 'Desactivado';
            else
                subtitle = network.wifiSsid || 'No conectado';

            on = Boolean(network.hasWifi && network.wifiEnabled);
        }

        refs.wifiToggle.setSubtitle(subtitle);
        refs.wifiToggle.setOn(on);
        refs.wifiToggle.setIcon(network?.wifiIconName ??
            'network-wireless-signal-none-symbolic');
    }

    _renderBluetoothDetail() {
        const header = createDetailHeader('Bluetooth', () => this._goBack());
        this._ccRoot.add_child(header.header);
        this._detailRefs.header = header;

        const card = this._createDetailCard();
        this._ccRoot.add_child(card);

        const toggleRow = createModuleRow({
            iconName: 'bluetooth-active-symbolic',
            title: 'Bluetooth',
            onToggle: () => {
                this._bluetooth?.toggle();
                this._addTimeout(900, () => {
                    if (this._view === 'bluetooth' && this._ccButton?.menu.isOpen)
                        this._renderDetail();
                });
            },
        });
        card.add_child(toggleRow.row);

        const bluetooth = this._bluetooth;
        if (!bluetooth || !bluetooth.available) {
            card.add_child(createSectionLabel('No hay adaptador Bluetooth'));
        } else if (!bluetooth.enabled) {
            card.add_child(createSectionLabel('Bluetooth desactivado'));
        } else {
            const devices = bluetooth.devices;
            if (devices.length === 0) {
                card.add_child(createSectionLabel('No hay dispositivos emparejados'));
            } else {
                card.add_child(createSectionLabel('Dispositivos'));
                const rows = devices.map(item => createListRow({
                    iconName: item.icon,
                    title: item.name,
                    subtitle: item.connected ? 'Conectado' : 'Desconectado',
                    check: item.connected,
                    onClick: () => bluetooth.toggleDevice(item),
                }).button);
                card.add_child(this._createScrollList(rows));
            }
        }

        card.add_child(createSeparator());
        card.add_child(createFooterLink('Ajustes de Bluetooth…',
            () => {
                this._ccButton?.menu.close();
                openSettingsPanel('bluetooth');
            }));

        let subtitle = 'No disponible';
        let on = false;
        if (bluetooth?.available) {
            subtitle = bluetooth.enabled
                ? (bluetooth.connectedDevices[0]?.name ?? 'Activado')
                : 'Desactivado';
            on = bluetooth.enabled;
        }

        toggleRow.setSubtitle(subtitle);
        toggleRow.setOn(on);
        toggleRow.setIcon(bluetooth?.iconName ?? 'bluetooth-disabled-symbolic');
    }

    _renderSoundDetail() {
        const header = createDetailHeader('Salida de sonido', () => this._goBack());
        this._ccRoot.add_child(header.header);
        this._detailRefs.header = header;

        const card = this._createDetailCard();
        this._ccRoot.add_child(card);

        let sinks = [];
        try {
            sinks = this._mixer?.get_sinks() ?? [];
        } catch (_e) {
            sinks = [];
        }

        if (sinks.length === 0) {
            card.add_child(createSectionLabel('No hay salidas de audio'));
        } else {
            card.add_child(createSectionLabel('Dispositivos'));
            let active = null;
            try {
                active = this._mixer?.get_default_sink() ?? null;
            } catch (_e) {
                active = null;
            }

            const rows = sinks.map(sink => {
                const name = sink.description || sink.name || 'Salida de audio';
                const row = createListRow({
                    iconName: 'audio-speakers-symbolic',
                    title: name,
                    subtitle: sink.origin || '',
                    check: sink === active,
                    onClick: () => {
                        try {
                            this._mixer.change_output(sink);
                        } catch (e) {
                            console.error(`${LOG} No se pudo cambiar la salida:`, e);
                        }
                    },
                });
                return row.button;
            });

            card.add_child(this._createScrollList(rows));
        }

        card.add_child(createSeparator());
        card.add_child(createFooterLink('Ajustes de sonido…',
            () => {
                this._ccButton?.menu.close();
                openSettingsPanel('sound');
            }));
    }

    _signalName(strength) {
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

    // ------------------------------------------------------------------
    // Menú de batería
    // ------------------------------------------------------------------

    _buildBatteryPopover() {
        const box = this._batteryPopoverBox;
        if (!box)
            return;

        this._clearChildren(box);

        const battery = this._battery;
        if (!battery?.present) {
            box.add_child(createSectionLabel('No hay batería'));
            return;
        }

        const header = new St.BoxLayout({
            style_class: 'tahoe-cc-popover-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        header.add_child(new St.Icon({
            icon_name: battery.iconName,
            icon_size: 22,
            style_class: 'tahoe-cc-popover-header-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const headerLabels = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            style_class: 'tahoe-cc-popover-header-labels',
        });
        headerLabels.add_child(new St.Label({
            text: 'Batería',
            style_class: 'tahoe-cc-popover-title',
            x_align: Clutter.ActorAlign.START,
        }));
        headerLabels.add_child(new St.Label({
            text: battery.powerSource,
            style_class: 'tahoe-cc-subtitle',
            x_align: Clutter.ActorAlign.START,
        }));
        header.add_child(headerLabels);

        header.add_child(new St.Label({
            text: `${battery.percentage}%`,
            style_class: 'tahoe-cc-battery-percentage',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        box.add_child(header);
        box.add_child(createSeparator());

        const sourceRow = this._createPopoverInfoRow('Fuente de alimentación',
            battery.powerSource || '—');
        box.add_child(sourceRow);

        let timeLabel;
        if (battery.fullyCharged) {
            timeLabel = this._createPopoverInfoRow('Estado', 'Batería llena');
        } else if (battery.charging) {
            const value = formatDuration(battery.timeRemaining);
            timeLabel = this._createPopoverInfoRow('Tiempo para cargar',
                value || 'Cargando…');
        } else {
            const value = formatDuration(battery.timeRemaining);
            timeLabel = this._createPopoverInfoRow('Tiempo restante',
                value || 'Calculando…');
        }
        box.add_child(timeLabel);

        const profiles = this._powerProfiles;
        if (profiles?.available && profiles.profiles.length > 0) {
            box.add_child(createSeparator());
            box.add_child(createSectionLabel('Perfil de energía'));

            for (const profile of profiles.profiles) {
                const info = PROFILE_INFO[profile];
                if (!info)
                    continue;

                const row = createListRow({
                    iconName: info.iconName,
                    title: info.name,
                    check: profile === profiles.activeProfile,
                    onClick: () => profiles.setProfile(profile),
                });
                box.add_child(row.button);
            }
        }

        box.add_child(createSeparator());

        const settingsLink = createFooterLink('Ajustes de batería…', () => {
            this._batteryButton?.menu.close();
            openSettingsPanel('power');
        });
        box.add_child(settingsLink);
    }

    _createPopoverInfoRow(title, value) {
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

    // ------------------------------------------------------------------
    // Menú Wi-Fi de la barra
    // ------------------------------------------------------------------

    _buildWifiPopover() {
        const box = this._wifiPopoverBox;
        if (!box)
            return;

        this._clearChildren(box);

        const network = this._network;

        const header = createModuleRow({
            iconName: network?.wifiIconName ?? 'network-wireless-signal-none-symbolic',
            title: 'Wi‑Fi',
            onToggle: () => {
                network?.toggleWifi();
                this._addTimeout(900, () => {
                    if (this._wifiButton?.menu.isOpen)
                        this._buildWifiPopover();
                });
            },
        });
        box.add_child(header.row);

        if (network && !network.failed && network.hasWifi && network.wifiEnabled) {
            const active = network.accessPoints.find(ap => ap.active);
            if (active) {
                box.add_child(createListRow({
                    iconName: `network-wireless-signal-${this._signalName(active.strength)}-symbolic`,
                    title: active.ssid,
                    subtitle: 'Red actual',
                    check: true,
                }).button);
            }
        }

        if (!network || network.failed) {
            box.add_child(createSectionLabel('NetworkManager no está disponible'));
        } else if (!network.hasWifi) {
            box.add_child(createSectionLabel(
                network.ethernetConnected
                    ? 'Conectado por Ethernet'
                    : 'No hay adaptador Wi‑Fi'));
        } else if (!network.wifiEnabled) {
            box.add_child(createSectionLabel('Wi‑Fi desactivado'));
        } else {
            const aps = network.accessPoints
                .filter(ap => !ap.active)
                .slice(0, 8);
            if (aps.length === 0) {
                box.add_child(createSectionLabel('Buscando redes…'));
            } else {
                box.add_child(createSectionLabel('Redes'));
                for (const ap of aps) {
                    const row = createListRow({
                        iconName: `network-wireless-signal-${this._signalName(ap.strength)}-symbolic`,
                        title: ap.ssid,
                        subtitle: ap.secure ? 'Protegida' : 'Abierta',
                        check: false,
                        suffixIconName: ap.secure ? 'network-wireless-encrypted-symbolic' : null,
                        onClick: () => {
                            if (!ap.saved) {
                                network.openWifiSettings();
                                this._wifiButton?.menu.close();
                                return;
                            }
                            if (network.connectSaved(ap.ssid))
                                this._wifiButton?.menu.close();
                        },
                    });
                    box.add_child(row.button);
                }
            }
        }

        box.add_child(createSeparator());
        box.add_child(createFooterLink('Ajustes de Wi‑Fi…', () => {
            this._wifiButton?.menu.close();
            openSettingsPanel('wifi');
        }));

        // Subtítulo del conmutador: red actual / desactivado.
        let subtitle = 'No disponible';
        let on = false;
        if (network && !network.failed) {
            on = Boolean(network.hasWifi && network.wifiEnabled);
            if (!network.hasWifi)
                subtitle = network.ethernetConnected ? 'Ethernet' : 'No disponible';
            else if (!network.wifiEnabled)
                subtitle = 'Desactivado';
            else
                subtitle = network.wifiSsid || 'No conectado';
        }
        header.setSubtitle(subtitle);
        header.setOn(on);
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
        } catch (e) {
            console.error(`${LOG} No se pudo cambiar el volumen:`, e);
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
    // Sincronización general
    // ------------------------------------------------------------------

    _syncAll() {
        if (this._destroyed)
            return;

        this._updatePanelButtons();

        if (this._view === 'main' && this._mainRefs)
            this._syncMainView();
        else if (this._view === 'wifi')
            this._syncDetailWifi();
    }

    _updatePanelButtons() {
        // Batería
        if (this._batteryButton) {
            const battery = this._battery;
            const present = Boolean(battery?.present);

            try {
                this._batteryButton.container.visible = present;
            } catch (_e) {
                // Ignorar.
            }

            if (present) {
                const showPercent = this._getBoolean(
                    'control-center-show-battery-percent', true);

                this._batteryLabel.text = `${battery.percentage}%`;
                this._batteryLabel.visible = showPercent;
                this._batteryIcon.icon_name = battery.iconName;
            }
        }

        // Wi-Fi
        if (this._wifiButton) {
            const network = this._network;
            const visible = Boolean(network && !network.failed);

            try {
                this._wifiButton.container.visible = visible;
            } catch (_e) {
                // Ignorar.
            }

            if (visible)
                this._wifiPanelIcon.icon_name = network.wifiIconName;

        }

        // El botón del Centro de control siempre está visible.
        if (this._ccButton) {
            try {
                this._ccButton.container.visible = true;
            } catch (_e) {
                // Ignorar.
            }
        }

        if (this._batteryButton?.menu.isOpen)
            this._buildBatteryPopover();
    }

    // ------------------------------------------------------------------
    // Destrucción
    // ------------------------------------------------------------------

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        this._restoreQuickSettingsShortcut();

        // Cerrar los menús antes de destruir sus botones.
        for (const button of [this._ccButton, this._batteryButton, this._wifiButton]) {
            try {
                button?.menu?.close();
            } catch (_e) {
                // Ignorar.
            }
        }

        this._removePanelButton(ROLES.controlCenter, this._ccButton);
        this._removePanelButton(ROLES.battery, this._batteryButton);
        this._removePanelButton(ROLES.wifi, this._wifiButton);

        this._ccButton = null;
        this._batteryButton = null;
        this._wifiButton = null;
        this._ccRoot = null;
        this._batteryPopoverBox = null;
        this._wifiPopoverBox = null;
        this._mainRefs = null;
        this._detailRefs = null;
        this._batteryLabel = null;
        this._batteryIcon = null;
        this._wifiPanelIcon = null;

        this._restoreQuickSettingsIndicators();

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
                controller?.destroy();
            } catch (e) {
                console.error(`${LOG} No se pudo destruir un controlador:`, e);
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

        this._unloadStylesheet();
    }
}
