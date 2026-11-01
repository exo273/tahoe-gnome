import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {TahoeMenuBar} from './menubar/menuBar.js';
import {attachUpdatesBadge} from './menubar/updates.js';
import {TahoeControlCenter} from './controlCenter/controlCenter.js';
import {LiquidGlassEngine} from './liquidGlass.js';
import {TahoeTheme} from './theme.js';

const APPLE_ROLE = 'tahoeAppleMenu';
const BACKGROUND_SCHEMA = 'org.gnome.desktop.background';

// Ancho al que se reduce el fondo de pantalla para calcular la luminancia.
const WALLPAPER_SAMPLE_WIDTH = 64;
const WALLPAPER_TOP_BAND = 0.08;
const DARK_TEXT_LUMINANCE = 0.6;

const PANEL_CLASSES = [
    'tahoe-panel',
    'tahoe-transparent',
    'tahoe-translucent',
    'tahoe-solid',
    'tahoe-solid-forced',
    'tahoe-text-light',
    'tahoe-text-dark',
];

const LOGO_FILES = {
    'apple': 'apple-logo-symbolic.svg',
    'apple-outline': 'apple-outline-symbolic.svg',
    'fedora': 'fedora-logo-symbolic.svg',
    'gnome': 'gnome-logo-symbolic.svg',
};

const RECENT_LIMIT = 10;

function decodeXmlEntities(value) {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
            try {
                return String.fromCodePoint(parseInt(hex, 16));
            } catch {
                return '';
            }
        })
        .replace(/&#([0-9]+);/g, (_m, dec) => {
            try {
                return String.fromCodePoint(parseInt(dec, 10));
            } catch {
                return '';
            }
        })
        .replace(/&amp;/g, '&');
}

function getXmlAttribute(attributes, name) {
    const match = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
    return match ? decodeXmlEntities(match[1]) : null;
}

export default class TahoeTopBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._signals = [];
        this._solidIdleId = 0;
        this._solidForced = false;
        this._clockSignalId = 0;
        this._clockOrigText = null;
        this._dateMenu = null;
        this._dateMenuOrigParent = null;
        this._dateMenuOrigIndex = -1;
        this._activitiesHidden = false;
        this._activitiesWasVisible = true;
        this._appMenuHidden = false;
        this._appMenuContainer = null;
        this._appMenuWasVisible = true;
        this._about = null;
        this._appleButton = null;
        this._icon = null;
        this._recentMenuItem = null;
        this._windowTracker = null;
        this._backgroundSettings = null;
        this._menuBar = null;
        this._controlCenter = null;
        this._liquidGlass = null;

        this._wallpaperCache = new Map();
        this._wallpaperKey = '';
        this._wallpaperDarkText = null;
        this._wallpaperToken = 0;
        this._wallpaperCancellable = null;

        this._panelOrigStyle = Main.panel.style ?? '';

        // Un único dueño del modo claro/oscuro para toda la extensión. Los
        // módulos leen extension._theme y las clases viven en uiGroup.
        this._theme = new TahoeTheme(this);
        this._themeId = this._theme.connect(() => this._onThemeChanged());

        try {
            this._backgroundSettings = new Gio.Settings({
                schema_id: BACKGROUND_SCHEMA,
            });
        } catch (error) {
            console.error('[tahoe-topbar] No se pudo leer el esquema de fondo:', error);
            this._backgroundSettings = null;
        }

        this._buildAppleButton();
        this._buildMenuBar();
        this._applyPanelAppearance();
        this._applyActivitiesVisibility();
        this._hideOriginalAppMenu();

        this._windowTracker = Shell.WindowTracker.get_default();
        this._connectGlobalSignals();
        this._applyClockSettings();
        this._applyControlCenter();
        this._updateLogo();
        this._updateSolidState();

        this._liquidGlass = new LiquidGlassEngine(this);

        this._connect(this._settings, 'changed', (_settings, key) => this._onSettingsChanged(key));
    }

    disable() {
        if (this._liquidGlass) {
            this._liquidGlass.destroy();
            this._liquidGlass = null;
        }

        if (this._solidIdleId) {
            GLib.source_remove(this._solidIdleId);
            this._solidIdleId = 0;
        }

        this._wallpaperToken++;
        if (this._wallpaperCancellable) {
            try {
                this._wallpaperCancellable.cancel();
            } catch (_e) {
                // Ya estaba cancelado.
            }
            this._wallpaperCancellable = null;
        }
        this._wallpaperCache.clear();
        this._wallpaperKey = '';
        this._wallpaperDarkText = null;

        if (this._about) {
            try {
                this._about.destroy();
            } catch (error) {
                console.error('[tahoe-topbar] Error al destruir Acerca de:', error);
            }
            this._about = null;
        }

        this._disconnectClock();
        this._restoreClockText();
        this._restoreClockPosition();

        this._restoreActivities();
        this._restoreOriginalAppMenu();
        this._disconnectSignals();

        this._destroyControlCenter();
        this._destroyMenuBar();

        if (this._appleButton) {
            delete Main.panel.statusArea[APPLE_ROLE];
            this._appleButton.destroy();
            this._appleButton = null;
            this._icon = null;
            this._recentMenuItem = null;
        }

        this._clearPanelStyle();

        if (this._theme && this._themeId)
            this._theme.disconnect(this._themeId);
        this._themeId = 0;

        if (this._theme) {
            try {
                this._theme.destroy();
            } catch (error) {
                console.error('[tahoe-topbar] Error al destruir el tema:', error);
            }
            this._theme = null;
        }

        this._settings = null;
        this._backgroundSettings = null;
        this._windowTracker = null;
        this._dateMenu = null;
        this._dateMenuOrigParent = null;
        this._dateMenuOrigIndex = -1;
        this._signals = [];
    }

    // ------------------------------------------------------------------
    // Panel / logo
    // ------------------------------------------------------------------

    _buildAppleButton() {
        const existing = Main.panel.statusArea?.[APPLE_ROLE];
        if (existing) {
            delete Main.panel.statusArea[APPLE_ROLE];
            try {
                existing.destroy();
            } catch {
                // Indicador residual de una carga anterior.
            }
        }

        this._icon = new St.Icon({
            style_class: 'tahoe-logo',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._appleButton = new PanelMenu.Button(0.0, _('Menú de Apple'), false);
        this._appleButton.add_style_class_name('tahoe-apple-button');
        this._appleButton.add_child(this._icon);

        Main.panel.addToStatusArea(APPLE_ROLE, this._appleButton, 0, 'left');

        this._appleButton.menu.actor.add_style_class_name('tahoe-apple-menu');
        this._buildMenu();

        this._appleButton.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._rebuildRecent();
        });
    }

    _buildMenuBar() {
        if (this._menuBar)
            return;

        try {
            this._menuBar = new TahoeMenuBar(this);
            const leftBox = Main.panel._leftBox;
            const appleContainer = this._appleButton?.container;
            const index = appleContainer
                ? leftBox.get_children().indexOf(appleContainer) + 1
                : 1;
            leftBox.insert_child_at_index(this._menuBar.actor, Math.max(index, 0));
        } catch (error) {
            console.error('[tahoe-topbar] No se pudo crear la barra de menús:', error);
            this._destroyMenuBar();
        }
    }

    _destroyMenuBar() {
        if (!this._menuBar)
            return;
        try {
            this._menuBar.destroy();
        } catch (error) {
            console.error('[tahoe-topbar] Error al destruir la barra de menús:', error);
        }
        this._menuBar = null;
    }

    _applyControlCenter() {
        const wanted = this._settings?.get_boolean('control-center-enabled') &&
            Main.sessionMode.currentMode === 'user';

        if (wanted && !this._controlCenter) {
            try {
                this._controlCenter = new TahoeControlCenter(this);
            } catch (error) {
                console.error('[tahoe-topbar] No se pudo crear el Centro de control:', error);
                this._destroyControlCenter();
            }
        } else if (!wanted) {
            this._destroyControlCenter();
        }
    }

    _destroyControlCenter() {
        if (!this._controlCenter)
            return;
        try {
            this._controlCenter.destroy();
        } catch (error) {
            console.error('[tahoe-topbar] Error al destruir el Centro de control:', error);
        }
        this._controlCenter = null;
    }

    _updateLogo() {
        if (!this._icon)
            return;

        const path = this._resolveLogoPath();
        const size = this._settings.get_int('logo-size');
        const symbolic = this._settings.get_boolean('logo-symbolic');

        try {
            this._icon.gicon = new Gio.FileIcon({
                file: Gio.File.new_for_path(path),
            });
        } catch (error) {
            console.error('[tahoe-topbar] No se pudo cargar el logo:', error);
            return;
        }

        this._icon.icon_size = size;

        if (symbolic) {
            this._icon.remove_style_class_name('tahoe-logo-fixed');
            this._icon.add_style_class_name('tahoe-logo-symbolic');
        } else {
            this._icon.remove_style_class_name('tahoe-logo-symbolic');
            this._icon.add_style_class_name('tahoe-logo-fixed');
        }
    }

    _resolveLogoPath() {
        const type = this._settings.get_string('logo-type');
        const applePath = GLib.build_filenamev([this.path, 'assets', LOGO_FILES.apple]);

        if (type === 'custom') {
            let custom = this._settings.get_string('custom-logo-path').trim();

            if (custom.startsWith('file://')) {
                try {
                    [custom] = GLib.filename_from_uri(custom);
                } catch {
                    custom = '';
                }
            } else if (custom.startsWith('~/')) {
                custom = GLib.build_filenamev([GLib.get_home_dir(), custom.slice(2)]);
            }

            if (custom && !GLib.path_is_absolute(custom))
                custom = GLib.build_filenamev([GLib.get_home_dir(), custom]);

            if (custom && GLib.file_test(custom, GLib.FileTest.IS_REGULAR))
                return custom;

            return applePath;
        }

        const file = LOGO_FILES[type];
        if (!file)
            return applePath;

        return GLib.build_filenamev([this.path, 'assets', file]);
    }

    // ------------------------------------------------------------------
    // Apple menu
    // ------------------------------------------------------------------

    _buildMenu() {
        const menu = this._appleButton.menu;
        menu.removeAll();

        this._addMenuItem(_('Acerca de este Mac'), null,
            () => this._openAbout(), 'computer-symbolic');
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addMenuItem(_('Ajustes del Sistema…'), null,
            () => this._openSettings(), 'emblem-system-symbolic');
        this._addMenuItem(_('App Store…'), null,
            () => this._openAppStore(), 'system-software-install-symbolic',
            {updatesBadge: true});
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._recentMenuItem = new PopupMenu.PopupSubMenuMenuItem(_('Ítems recientes'));
        this._recentMenuItem.add_style_class_name('tahoe-apple-menu-item');
        this._recentMenuItem.insert_child_at_index(new St.Icon({
            style_class: 'tahoe-apple-menu-icon',
            icon_name: 'document-open-recent-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        }), 1);
        menu.addMenuItem(this._recentMenuItem);
        this._rebuildRecent();
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addMenuItem(_('Forzar salida…'), '⌥⌘⎋',
            () => this._openForceQuit(), 'process-stop-symbolic');
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addMenuItem(_('Reposo'), null,
            () => this._suspend(), 'weather-clear-night-symbolic');
        this._addMenuItem(_('Reiniciar…'), null,
            () => this._reboot(), 'system-reboot-symbolic');
        this._addMenuItem(_('Apagar…'), null,
            () => this._shutdown(), 'system-shutdown-symbolic');
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addMenuItem(_('Bloquear pantalla'), '⌃⌘Q',
            () => this._lockScreen(), 'system-lock-screen-symbolic');
        const logoutLabel = _('Cerrar sesión de “%s”…')
            .replace('%s', this._getRealName());
        this._addMenuItem(logoutLabel, '⇧⌘Q',
            () => this._logout(), 'avatar-default-symbolic');
    }

    _addMenuItem(text, shortcut, callback, iconName = null, options = {}) {
        const item = new PopupMenu.PopupMenuItem(text, {
            reactive: typeof callback === 'function',
        });

        item.add_style_class_name('tahoe-apple-menu-item');
        item.label.x_expand = true;

        if (iconName) {
            item.insert_child_at_index(new St.Icon({
                style_class: 'tahoe-apple-menu-icon',
                icon_name: iconName,
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            }), 1);
        }

        if (shortcut) {
            const shortcutLabel = new St.Label({
                text: shortcut,
                style_class: 'tahoe-menu-shortcut',
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.add_child(shortcutLabel);
        }

        if (options.updatesBadge)
            attachUpdatesBadge(this._appleButton.menu, item);

        if (typeof callback === 'function') {
            item.connect('activate', () => {
                try {
                    callback();
                } catch (error) {
                    console.error('[tahoe-topbar] Error en el menú de Apple:', error);
                }
            });
        }

        this._appleButton.menu.addMenuItem(item);
        return item;
    }

    _rebuildRecent() {
        if (!this._recentMenuItem)
            return;

        const submenu = this._recentMenuItem.menu;
        submenu.removeAll();

        const items = this._readRecentItems(RECENT_LIMIT);
        if (items.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('No hay elementos recientes'), {
                reactive: false,
            });
            submenu.addMenuItem(empty);
            return;
        }

        for (const item of items) {
            const menuItem = new PopupMenu.PopupMenuItem(item.label);
            menuItem.accessible_name = item.uri;
            menuItem.connect('activate', () => this._openRecent(item.uri));
            submenu.addMenuItem(menuItem);
        }
    }

    _readRecentItems(limit) {
        const xbelPath = GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'share', 'recently-used.xbel',
        ]);

        if (!GLib.file_test(xbelPath, GLib.FileTest.IS_REGULAR))
            return [];

        let contents;
        try {
            const [ok, data] = GLib.file_get_contents(xbelPath);
            if (!ok)
                return [];
            contents = new TextDecoder('utf-8').decode(data);
        } catch (error) {
            console.error('[tahoe-topbar] No se pudo leer recently-used.xbel:', error);
            return [];
        }

        const items = [];
        const seen = new Set();
        const bookmarkRegex = /<bookmark\b([^>]*)>/g;
        let match;

        while ((match = bookmarkRegex.exec(contents)) !== null) {
            const attributes = match[1];
            const href = getXmlAttribute(attributes, 'href');

            if (!href || !href.startsWith('file://') || seen.has(href))
                continue;

            let filename;
            try {
                [filename] = GLib.filename_from_uri(href);
            } catch {
                continue;
            }

            if (!filename || !GLib.file_test(filename, GLib.FileTest.EXISTS))
                continue;

            const label = GLib.path_get_basename(filename);
            if (!label)
                continue;

            seen.add(href);
            items.push({
                uri: href,
                label,
                visited: getXmlAttribute(attributes, 'visited')
                    ?? getXmlAttribute(attributes, 'modified')
                    ?? '',
            });
        }

        items.sort((a, b) => b.visited.localeCompare(a.visited));
        return items.slice(0, limit);
    }

    _openRecent(uri) {
        try {
            if (Main.overview.visible)
                Main.overview.hide();
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (error) {
            console.error('[tahoe-topbar] No se pudo abrir el elemento reciente:', error);
        }
    }

    async _openAbout() {
        try {
            if (!this._about) {
                const {AboutDialog} = await import('./about/aboutWindow.js');
                this._about = new AboutDialog(this);
            }
            this._about.open();
        } catch (error) {
            console.error('[tahoe-topbar] No se pudo abrir «Acerca de este Mac»:', error);
        }
    }

    // ------------------------------------------------------------------
    // Acciones del sistema
    // ------------------------------------------------------------------

    _openSettings() {
        this._launchApp(['org.gnome.Settings.desktop'], ['gnome-control-center']);
    }

    _openAppStore() {
        this._launchApp(['org.gnome.Software.desktop'], ['gnome-software']);
    }

    _openForceQuit() {
        this._launchApp(
            ['net.nokyan.Resources.desktop', 'gnome-system-monitor.desktop'],
            ['gnome-system-monitor']);
    }

    _launchApp(desktopIds, fallbackCommand) {
        const appSystem = Shell.AppSystem.get_default();

        for (const desktopId of desktopIds) {
            const app = appSystem.lookup_app(desktopId);
            if (!app)
                continue;

            try {
                if (Main.overview.visible)
                    Main.overview.hide();
                app.activate();
                return;
            } catch (error) {
                console.error(`[tahoe-topbar] No se pudo activar ${desktopId}:`, error);
            }
        }

        if (fallbackCommand) {
            try {
                Util.spawn(fallbackCommand);
            } catch (error) {
                console.error('[tahoe-topbar] No se pudo lanzar la aplicación:', error);
            }
        }
    }

    _suspend() {
        try {
            Gio.DBus.system.call(
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                'Suspend',
                new GLib.Variant('(b)', [false]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, result) => {
                    try {
                        connection.call_finish(result);
                    } catch (error) {
                        console.error('[tahoe-topbar] logind Suspend falló, usando systemctl:', error);
                        try {
                            Util.spawn(['systemctl', 'suspend']);
                        } catch (spawnError) {
                            console.error('[tahoe-topbar] No se pudo suspender:', spawnError);
                        }
                    }
                });
        } catch (error) {
            console.error('[tahoe-topbar] No se pudo contactar con logind:', error);
            try {
                Util.spawn(['systemctl', 'suspend']);
            } catch (spawnError) {
                console.error('[tahoe-topbar] No se pudo suspender:', spawnError);
            }
        }
    }

    _reboot() {
        this._callSessionManager('Reboot', null);
    }

    _shutdown() {
        this._callSessionManager('Shutdown', null);
    }

    _logout() {
        this._callSessionManager('Logout', new GLib.Variant('(u)', [0]));
    }

    _callSessionManager(method, parameters) {
        try {
            Gio.DBus.session.call(
                'org.gnome.SessionManager',
                '/org/gnome/SessionManager',
                'org.gnome.SessionManager',
                method,
                parameters,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, result) => {
                    try {
                        connection.call_finish(result);
                    } catch (error) {
                        console.error(`[tahoe-topbar] ${method} falló:`, error);
                    }
                });
        } catch (error) {
            console.error(`[tahoe-topbar] No se pudo llamar a ${method}:`, error);
        }
    }

    _lockScreen() {
        try {
            Main.screenShield.lock(true);
        } catch (error) {
            console.error('[tahoe-topbar] No se pudo bloquear la pantalla:', error);
        }
    }

    _getRealName() {
        let name = null;

        try {
            name = GLib.get_real_name();
        } catch {
            name = null;
        }

        if (!name || !name.trim()) {
            try {
                name = GLib.get_user_name();
            } catch {
                name = null;
            }
        }

        return (name ?? '').trim() || _('Usuario');
    }

    // ------------------------------------------------------------------
    // Nombre de la aplicación
    // ------------------------------------------------------------------

    _hideOriginalAppMenu() {
        if (this._appMenuHidden)
            return;

        const indicator = Main.panel.statusArea?.appMenu;
        if (!indicator?.container)
            return;

        this._appMenuContainer = indicator.container;
        this._appMenuWasVisible = indicator.container.visible;
        this._appMenuHidden = true;
        indicator.container.hide();
    }

    _restoreOriginalAppMenu() {
        if (!this._appMenuHidden || !this._appMenuContainer)
            return;

        try {
            this._appMenuContainer.visible = this._appMenuWasVisible;
        } catch {
            // El indicador ya no existe.
        }

        this._appMenuHidden = false;
        this._appMenuContainer = null;
    }

    // ------------------------------------------------------------------
    // Actividades
    // ------------------------------------------------------------------

    _applyActivitiesVisibility() {
        if (!this._settings)
            return;

        const activities = Main.panel.statusArea?.activities;
        if (!activities?.container)
            return;

        if (this._settings.get_boolean('hide-activities')) {
            if (!this._activitiesHidden) {
                this._activitiesWasVisible = activities.container.visible;
                this._activitiesHidden = true;
            }
            activities.container.hide();
        } else if (this._activitiesHidden) {
            activities.container.visible = this._activitiesWasVisible;
            this._activitiesHidden = false;
        }
    }

    _restoreActivities() {
        if (!this._activitiesHidden)
            return;

        try {
            const activities = Main.panel.statusArea?.activities;
            if (activities?.container)
                activities.container.visible = this._activitiesWasVisible;
        } catch {
            // El indicador ya no existe.
        }

        this._activitiesHidden = false;
    }

    // ------------------------------------------------------------------
    // Reloj
    // ------------------------------------------------------------------

    _applyClockSettings() {
        if (!this._settings)
            return;

        const dateMenu = Main.panel.statusArea?.dateMenu;
        if (!dateMenu?._clockDisplay)
            return;

        if (this._dateMenu !== dateMenu) {
            this._disconnectClock();
            this._dateMenu = dateMenu;
            const container = dateMenu.container;
            this._dateMenuOrigParent = container?.get_parent() ?? null;
            this._dateMenuOrigIndex = this._dateMenuOrigParent
                ? this._dateMenuOrigParent.get_children().indexOf(container)
                : -1;
            this._clockOrigText = dateMenu._clockDisplay.text;
        }

        if (this._settings.get_boolean('move-clock-right'))
            this._moveClockRight();
        else
            this._restoreClockPosition();

        const format = this._settings.get_string('clock-format').trim();
        if (format) {
            if (!this._clockSignalId && this._dateMenu._clock) {
                this._clockSignalId = this._dateMenu._clock.connect(
                    'notify::clock', () => this._applyClockText());
            }
            this._applyClockText();
        } else {
            this._disconnectClock();
            this._restoreClockText();
        }
    }

    _applyClockText() {
        if (!this._settings || !this._dateMenu?._clockDisplay)
            return;

        const format = this._settings.get_string('clock-format').trim();
        if (!format)
            return;

        try {
            this._dateMenu._clockDisplay.text =
                GLib.DateTime.new_now_local().format(format);
        } catch (error) {
            console.error('[tahoe-topbar] Formato de reloj inválido:', error);
        }
    }

    _disconnectClock() {
        if (this._clockSignalId && this._dateMenu?._clock) {
            try {
                this._dateMenu._clock.disconnect(this._clockSignalId);
            } catch {
                // La señal ya no existía.
            }
        }
        this._clockSignalId = 0;
    }

    _restoreClockText() {
        if (!this._dateMenu?._clockDisplay)
            return;

        let text = this._clockOrigText ?? '';
        try {
            const clockText = this._dateMenu._clock?.clock;
            if (clockText)
                text = clockText;
        } catch {
            // Se mantiene el texto original.
        }

        this._dateMenu._clockDisplay.text = text;
    }

    _moveClockRight() {
        if (!this._dateMenu?.container)
            return;

        const rightBox = Main.panel._rightBox;
        const container = this._dateMenu.container;
        if (!rightBox || container.get_parent() === rightBox)
            return;

        const parent = container.get_parent();
        if (parent)
            parent.remove_child(container);

        rightBox.add_child(container);
    }

    _restoreClockPosition() {
        if (!this._dateMenu?.container || !this._dateMenuOrigParent)
            return;

        const container = this._dateMenu.container;
        const parent = container.get_parent();

        if (parent !== this._dateMenuOrigParent) {
            if (parent)
                parent.remove_child(container);

            const count = this._dateMenuOrigParent.get_n_children();
            const index = Math.min(
                Math.max(this._dateMenuOrigIndex, 0), count);
            this._dateMenuOrigParent.insert_child_at_index(container, index);
        }
    }

    // ------------------------------------------------------------------
    // Estilo del panel
    // ------------------------------------------------------------------

    _onThemeChanged() {
        if (!this._settings)
            return;

        // El CSS se actualiza solo con las clases de uiGroup; el panel tiene
        // color inline y el contraste del fondo se recalcula aquí.
        this._applyPanelAppearance();
    }

    _computePanelDarkText() {
        if (!this._settings)
            return false;

        const preference = this._settings.get_string('text-color');
        if (preference === 'light')
            return false;
        if (preference === 'dark')
            return true;

        const darkMode = this._theme?.isDark ?? false;
        const style = this._settings.get_string('panel-style');

        // Con fondo propio el texto sigue al modo del sistema (Tahoe).
        if (this._solidForced || style === 'solid' || style === 'translucent')
            return !darkMode;

        // Transparente: el color depende del fondo de pantalla, no del modo.
        if (this._wallpaperDarkText !== null)
            return this._wallpaperDarkText;

        // Mientras se analiza la imagen (o si falla): texto oscuro en claro.
        return !darkMode;
    }

    _backgroundHasKey(key) {
        try {
            return Boolean(this._backgroundSettings?.settings_schema?.has_key(key));
        } catch (_e) {
            return false;
        }
    }

    _currentWallpaperUri() {
        if (!this._backgroundSettings)
            return '';

        const darkMode = this._theme?.isDark ?? false;
        const primary = darkMode && this._backgroundHasKey('picture-uri-dark')
            ? 'picture-uri-dark'
            : 'picture-uri';
        const secondary = primary === 'picture-uri'
            ? 'picture-uri-dark'
            : 'picture-uri';

        try {
            let uri = this._backgroundSettings.get_string(primary);
            if (!uri && this._backgroundHasKey(secondary))
                uri = this._backgroundSettings.get_string(secondary);
            return uri ?? '';
        } catch (_e) {
            return '';
        }
    }

    _uriToPath(uri) {
        if (!uri)
            return '';

        if (uri.startsWith('file://')) {
            try {
                const [path] = GLib.filename_from_uri(uri);
                return path ?? '';
            } catch (_e) {
                return '';
            }
        }

        if (GLib.path_is_absolute(uri))
            return uri;

        return '';
    }

    _resolveWallpaperPath(uri) {
        const path = this._uriToPath(uri);
        if (!path)
            return '';

        if (!path.toLowerCase().endsWith('.xml'))
            return path;

        // Fondos dinámicos de GNOME: usar la primera imagen <file>.
        try {
            const [ok, data] = GLib.file_get_contents(path);
            if (!ok)
                return '';

            const text = new TextDecoder('utf-8').decode(data);
            const match = /<file>\s*([^<]+?)\s*<\/file>/i.exec(text);
            if (!match)
                return '';

            let value = decodeXmlEntities(match[1].trim());
            if (value.startsWith('file://')) {
                const [resolved] = GLib.filename_from_uri(value);
                return resolved ?? '';
            }

            if (!GLib.path_is_absolute(value)) {
                value = GLib.build_filenamev([
                    GLib.path_get_dirname(path), value,
                ]);
            }

            return value;
        } catch (e) {
            console.error('[tahoe-topbar] No se pudo leer el fondo dinámico:', e);
            return '';
        }
    }

    _ensureWallpaperContrast() {
        if (!this._settings || !this._theme)
            return;

        const style = this._settings.get_string('panel-style');
        if (this._solidForced || style !== 'transparent')
            return;

        const uri = this._currentWallpaperUri();
        if (!uri) {
            this._wallpaperKey = '';
            this._wallpaperDarkText = null;
            return;
        }

        let mtime = 0;
        const path = this._uriToPath(uri);
        if (path) {
            try {
                const info = Gio.File.new_for_path(path).query_info(
                    'time::modified', Gio.FileQueryInfoFlags.NONE, null);
                mtime = info.get_attribute_uint64('time::modified');
            } catch (_e) {
                mtime = 0;
            }
        }

        const key = `${uri}|${mtime}`;
        if (key === this._wallpaperKey)
            return;

        this._wallpaperKey = key;
        this._wallpaperDarkText = null;

        if (this._wallpaperCache.has(key)) {
            this._wallpaperDarkText = this._wallpaperCache.get(key);
            return;
        }

        this._startWallpaperLoad(uri, key);
    }

    _startWallpaperLoad(uri, key) {
        const path = this._resolveWallpaperPath(uri);
        if (!path || !GLib.file_test(path, GLib.FileTest.IS_REGULAR)) {
            this._wallpaperCache.set(key, null);
            return;
        }

        if (this._wallpaperCancellable) {
            try {
                this._wallpaperCancellable.cancel();
            } catch (_e) {
                // Ya cancelado.
            }
        }

        const token = ++this._wallpaperToken;
        const cancellable = new Gio.Cancellable();
        this._wallpaperCancellable = cancellable;

        let stream;
        try {
            stream = Gio.File.new_for_path(path).read(cancellable);
        } catch (e) {
            console.warn('[tahoe-topbar] No se pudo abrir el fondo de pantalla:', e);
            this._wallpaperCache.set(key, null);
            return;
        }

        try {
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream, WALLPAPER_SAMPLE_WIDTH, -1, true, cancellable,
                (_source, result) => {
                    if (!this._settings || token !== this._wallpaperToken)
                        return;

                    let pixbuf;
                    try {
                        pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(result);
                    } catch (e) {
                        if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            console.warn('[tahoe-topbar] No se pudo analizar el fondo:', e);
                        this._finishWallpaper(key, null);
                        return;
                    }

                    this._finishWallpaper(key, this._wallpaperNeedsDarkText(pixbuf));
                });
        } catch (e) {
            console.warn('[tahoe-topbar] No se pudo lanzar el análisis del fondo:', e);
            this._wallpaperCache.set(key, null);
        }
    }

    _wallpaperNeedsDarkText(pixbuf) {
        try {
            const width = pixbuf.get_width();
            const height = pixbuf.get_height();
            const channels = pixbuf.get_n_channels();
            const rowstride = pixbuf.get_rowstride();
            const pixels = pixbuf.get_pixels();
            const bandHeight = Math.max(1,
                Math.round(height * WALLPAPER_TOP_BAND));

            let total = 0;
            let count = 0;

            for (let y = 0; y < bandHeight; y++) {
                for (let x = 0; x < width; x++) {
                    const offset = y * rowstride + x * channels;
                    const red = pixels[offset] / 255;
                    const green = pixels[offset + 1] / 255;
                    const blue = pixels[offset + 2] / 255;
                    total += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
                    count++;
                }
            }

            if (count === 0)
                return false;

            // Luminancia alta => fondo claro => texto oscuro.
            return (total / count) > DARK_TEXT_LUMINANCE;
        } catch (e) {
            console.error('[tahoe-topbar] No se pudo calcular la luminancia:', e);
            return false;
        }
    }

    _finishWallpaper(key, isDark) {
        if (this._wallpaperKey !== key)
            return;

        const darkText = typeof isDark === 'boolean' ? isDark : null;

        this._wallpaperCache.set(key, darkText);
        if (this._wallpaperCache.size > 24) {
            const oldest = this._wallpaperCache.keys().next().value;
            this._wallpaperCache.delete(oldest);
        }

        if (this._wallpaperDarkText === darkText)
            return;

        this._wallpaperDarkText = darkText;
        this._applyPanelAppearance();
    }

    _applyPanelAppearance() {
        if (!this._settings)
            return;

        // No tocar la barra de bloqueo: se reaplica al volver a la sesión.
        if (Main.sessionMode.currentMode !== 'user')
            return;

        this._ensureWallpaperContrast();

        const style = this._settings.get_string('panel-style');
        const darkText = this._computePanelDarkText();
        const darkMode = this._theme?.isDark ?? false;

        for (const name of PANEL_CLASSES)
            Main.panel.remove_style_class_name(name);

        Main.panel.add_style_class_name('tahoe-panel');
        Main.panel.add_style_class_name(`tahoe-${style}`);
        Main.panel.add_style_class_name(darkText ? 'tahoe-text-dark' : 'tahoe-text-light');
        if (this._solidForced)
            Main.panel.add_style_class_name('tahoe-solid-forced');

        const height = this._settings.get_int('panel-height');
        const fontSize = this._settings.get_int('font-size');
        let family = this._settings.get_string('font-family').trim();
        family = family
            ? `${family}, "SF Pro Text", "SF Pro Display", Inter, Cantarell, sans-serif`
            : '"SF Pro Text", "SF Pro Display", Inter, Cantarell, sans-serif';

        let background;
        if (this._solidForced || style === 'solid') {
            background = darkMode
                ? 'rgba(30, 30, 30, 0.85)'
                : 'rgba(246, 246, 246, 0.85)';
        } else if (style === 'translucent') {
            let opacity = this._settings.get_double('panel-opacity');
            opacity = Math.min(Math.max(opacity, 0.0), 1.0);
            background = darkMode
                ? `rgba(30, 30, 30, ${opacity.toFixed(3)})`
                : `rgba(246, 246, 246, ${opacity.toFixed(3)})`;
        } else {
            background = 'rgba(0, 0, 0, 0)';
        }

        const color = darkText ? '#1d1d1f' : '#ffffff';
        Main.panel.style = [
            `height: ${height}px`,
            `font-family: ${family}`,
            `font-size: ${fontSize}px`,
            `background-color: ${background}`,
            `color: ${color}`,
            'box-shadow: none',
            'border: none',
        ].join('; ') + ';';
    }

    _clearPanelStyle() {
        if (!Main.panel)
            return;

        for (const name of PANEL_CLASSES)
            Main.panel.remove_style_class_name(name);

        Main.panel.style = this._panelOrigStyle ?? '';
    }

    // ------------------------------------------------------------------
    // Panel sólido con ventanas maximizadas
    // ------------------------------------------------------------------

    _isSolidNeeded() {
        if (!this._settings)
            return false;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;

        const workspace = global.workspace_manager.get_active_workspace();
        if (!workspace)
            return false;

        const panelHeight = this._settings.get_int('panel-height');
        let windows;

        try {
            windows = workspace.list_windows();
        } catch {
            return false;
        }

        for (const window of windows) {
            try {
                if (!window.showing_on_its_workspace())
                    continue;

                let onPrimary = false;
                try {
                    onPrimary = window.is_on_primary_monitor();
                } catch {
                    onPrimary = window.get_monitor() === Main.layoutManager.primaryIndex;
                }

                if (!onPrimary)
                    continue;

                const type = window.get_window_type();
                if (type === Meta.WindowType.DESKTOP ||
                    type === Meta.WindowType.DOCK ||
                    type === Meta.WindowType.SPLASHSCREEN)
                    continue;

                const rect = window.get_frame_rect();
                if (rect.width <= 0 || rect.height <= 0)
                    continue;

                if (window.maximized_vertically)
                    return true;

                if (rect.y <= monitor.y + panelHeight + 5)
                    return true;
            } catch {
                // Ventana destruida durante la comprobación.
            }
        }

        return false;
    }

    _updateSolidState() {
        if (!this._settings)
            return;

        const enabled = this._settings.get_boolean('solid-when-maximized');
        const forced = enabled ? this._isSolidNeeded() : false;

        if (forced === this._solidForced)
            return;

        this._solidForced = forced;
        this._applyPanelAppearance();
    }

    _queueSolidUpdate() {
        if (this._solidIdleId)
            return;

        this._solidIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._solidIdleId = 0;
            this._updateSolidState();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------------
    // Señales
    // ------------------------------------------------------------------

    _connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._signals.push([object, id]);
        return id;
    }

    _connectGlobalSignals() {
        const display = global.display;
        this._connect(display, 'notify::focus-window', () => this._queueSolidUpdate());
        this._connect(display, 'window-created', () => this._queueSolidUpdate());
        this._connect(display, 'window-entered-monitor', () => this._queueSolidUpdate());
        this._connect(display, 'window-left-monitor', () => this._queueSolidUpdate());
        this._connect(display, 'restacked', () => this._queueSolidUpdate());

        this._connect(global.window_manager, 'size-change', () => this._queueSolidUpdate());
        this._connect(global.window_manager, 'size-changed', () => this._queueSolidUpdate());
        this._connect(global.workspace_manager, 'active-workspace-changed',
            () => this._queueSolidUpdate());
        this._connect(global.workspace_manager, 'notify::n-workspaces',
            () => this._queueSolidUpdate());

        if (this._backgroundSettings) {
            for (const key of ['picture-uri', 'picture-uri-dark']) {
                if (!this._backgroundHasKey(key))
                    continue;
                this._connect(this._backgroundSettings, `changed::${key}`,
                    () => this._applyPanelAppearance());
            }
        }

        this._connect(Main.sessionMode, 'updated', () => this._onSessionUpdated());
    }

    _disconnectSignals() {
        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch {
                // El objeto ya no existe.
            }
        }
        this._signals = [];
    }

    _onSessionUpdated() {
        const isUser = Main.sessionMode.currentMode === 'user';

        if (this._appleButton?.container)
            this._appleButton.container.visible = isUser;
        if (this._menuBar?.actor)
            this._menuBar.actor.visible = isUser;

        if (!isUser) {
            this._destroyControlCenter();
            this._clearPanelStyle();
            return;
        }

        this._applyPanelAppearance();
        this._applyActivitiesVisibility();
        this._hideOriginalAppMenu();
        this._applyClockSettings();
        this._applyControlCenter();
        this._updateSolidState();
    }

    // ------------------------------------------------------------------
    // Ajustes en vivo
    // ------------------------------------------------------------------

    _onSettingsChanged(key) {
        switch (key) {
        case 'logo-type':
        case 'custom-logo-path':
        case 'logo-size':
        case 'logo-symbolic':
            this._updateLogo();
            break;
        case 'panel-height':
        case 'panel-style':
        case 'panel-opacity':
        case 'text-color':
        case 'font-family':
        case 'font-size':
            this._applyPanelAppearance();
            this._queueSolidUpdate();
            break;
        case 'solid-when-maximized':
            this._updateSolidState();
            break;
        case 'hide-activities':
            this._applyActivitiesVisibility();
            break;
        case 'control-center-enabled':
            this._applyControlCenter();
            break;
        case 'move-clock-right':
        case 'clock-format':
            this._applyClockSettings();
            break;
        default:
            break;
        }
    }
}
