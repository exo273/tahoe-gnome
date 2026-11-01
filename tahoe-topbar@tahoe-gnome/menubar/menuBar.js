// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Tahoe Top Bar — barra de menús dinámica al estilo macOS.
//
// Estructura:
//
//     [Finder / Nombre de app]  [Archivo] [Edición] [Visualización] …
//
// Cada título es un PanelMenu.Button registrado en el PopupMenuManager del
// panel, de modo que al abrir un menú y pasar el ratón por otro título el
// menú cambia (igual que en macOS).
//
// Fuentes de los menús, por orden de preferencia:
//
//   1. org.gtk.Menus: barra de menús real exportada por apps GTK.
//   2. org.gtk.Actions: acciones conocidas (new-window, undo, copy…).
//   3. Perfiles por aplicación (menubar/profiles.js).
//   4. Menús genéricos para cualquier otra aplicación.
//
// El módulo es autónomo: lee sus propios ajustes, reacciona en vivo y limpia
// absolutamente todo en destroy().

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    ActionGroupCache,
    KeySender,
    accelToGlyph,
    activateGtkAction,
    activateWindow,
    appWindows,
    bringEverythingToFront,
    describeAll,
    hideApp,
    hideOtherApps,
    launchUri,
    logError,
    logWarn,
    minimizeWindow,
    moveWindowToHalf,
    showAllWindows,
    spawn,
    toggleAbove,
    toggleFullscreen,
    toggleMaximize,
    truncate,
} from './actions.js';

import {
    buildFinderAppMenuItems,
    buildFinderMenus,
    buildGenericMenus,
    getProfile,
} from './profiles.js';

import {
    gtkAccelToGlyph,
    mergeKnownActions,
    readMenubar,
} from './gtkMenus.js';

import {glassLook} from '../liquidGlass.js';

const SEPARATOR = {sep: true};

const DESKTOP_APP_IDS = [
    'com.desktop.ding',
    'com.desktop.ding.desktop',
    'gtk4-ding',
    'gtk4-ding.desktop',
    'nemo-desktop',
];

const APP_MENU_KEY = 'app';

function deepClone(value) {
    if (Array.isArray(value))
        return value.map(entry => deepClone(entry));

    if (value && typeof value === 'object') {
        const copy = {};
        for (const [key, entry] of Object.entries(value)) {
            // Los GLib.Variant y funciones se conservan por referencia.
            if (entry instanceof GLib.Variant || typeof entry === 'function') {
                copy[key] = entry;
                continue;
            }
            copy[key] = deepClone(entry);
        }
        return copy;
    }

    return value;
}

function isDesktopWindowType(win) {
    try {
        const type = win.get_window_type();
        return type === Meta.WindowType.DESKTOP;
    } catch {
        return false;
    }
}

function looksLikeDesktopWindow(win, app) {
    let wmClass = '';
    try {
        wmClass = `${win.get_wm_class() ?? ''}`.toLowerCase();
    } catch {
        wmClass = '';
    }

    let appId = '';
    try {
        appId = `${app?.get_id() ?? ''}`.toLowerCase();
    } catch {
        appId = '';
    }

    const haystack = `${wmClass} ${appId}`;
    if (DESKTOP_APP_IDS.some(id => haystack.includes(id.toLowerCase())))
        return true;

    return wmClass.includes('ding') || wmClass.includes('nemo-desktop');
}

export class TahoeMenuBar {
    /**
     * @param {object} extension instancia de Extension (getSettings(), path)
     */
    constructor(extension) {
        this._extension = extension;
        this._settings = null;
        this._settingsId = 0;
        this._signals = [];

        this._destroyed = false;
        this._rebuildId = 0;
        this._rebuildToken = 0;
        this._cancellable = null;

        this._titleButtons = [];
        this._ctxInfo = null;

        this._groups = new ActionGroupCache();
        this._keySender = new KeySender();
        this._menuModels = new Map();

        this._theme = this._extension?._theme ?? null;
        this._cssFile = null;
        this._glassEngine = null;
        this._glassUnsubscribe = null;

        this.actor = new St.BoxLayout({
            style_class: 'tahoe-menubar',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            reactive: false,
        });

        this._actorDestroyId = this.actor.connect('destroy', () => {
            // El panel puede destruir el actor antes que la extensión.
            if (!this._destroyed) {
                this._destroyed = true;
                this._teardown(false);
            }
        });

        this._loadStylesheet();
        this._bindSettings();
        this._connectSignals();

        this._glassUnsubscribe = this._extension?.onGlassEngineChanged?.(
            engine => this._setGlassEngine(engine)) ?? null;

        this._applyVisibility();
        this._scheduleRebuild();
    }

    /* -------------------------------------------------------------- */
    /* Estilos                                                         */
    /* -------------------------------------------------------------- */

    _extensionPath() {
        try {
            if (typeof this._extension?.path === 'string' && this._extension.path)
                return this._extension.path;
            if (typeof this._extension?.dir?.get_path === 'function')
                return this._extension.dir.get_path();
            if (this._extension?.dir)
                return `${this._extension.dir}`;
        } catch {
            // Sin ruta disponible.
        }
        return '';
    }

    _loadStylesheet() {
        try {
            const base = this._extensionPath();
            if (!base)
                throw new Error('ruta de la extensión desconocida');

            this._cssFile = Gio.File.new_for_path(
                GLib.build_filenamev([base, 'menubar', 'menubar.css']));
            this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            this._theme.load_stylesheet(this._cssFile);
        } catch (error) {
            logError('No se pudo cargar menubar/menubar.css', error);
            this._theme = null;
            this._cssFile = null;
        }
    }

    _unloadStylesheet() {
        if (!this._theme || !this._cssFile)
            return;

        try {
            this._theme.unload_stylesheet(this._cssFile);
        } catch (error) {
            logError('No se pudo descargar menubar/menubar.css', error);
        }

        this._theme = null;
        this._cssFile = null;
    }

    /* -------------------------------------------------------------- */
    /* Ajustes y señales                                               */
    /* -------------------------------------------------------------- */

    _bindSettings() {
        try {
            this._settings = this._extension.getSettings();
        } catch (error) {
            logError('No se pudieron leer los ajustes', error);
            this._settings = null;
            return;
        }

        this._settingsId = this._settings.connect('changed',
            (_settings, key) => this._onSettingsChanged(key));
    }

    _connectSignals() {
        const tracker = Shell.WindowTracker.get_default();
        this._connect(tracker, 'notify::focus-app', () => this._scheduleRebuild());

        const display = global.display;
        this._connect(display, 'notify::focus-window', () => this._scheduleRebuild());
        this._connect(display, 'window-created', () => this._scheduleRebuild());

        // Meta.Display no emite window-destroyed; ShellWM sí avisa de los
        // actores destruidos, lo que cubre cerrar ventanas.
        try {
            this._connect(global.window_manager, 'destroy', () => this._scheduleRebuild());
        } catch (error) {
            logWarn('Señales', `ShellWM.destroy no disponible: ${error.message}`);
        }

        try {
            this._connect(Main.overview, 'showing', () => this._scheduleRebuild());
            this._connect(Main.overview, 'hidden', () => this._scheduleRebuild());
        } catch (error) {
            logWarn('Señales', `Overview: ${error.message}`);
        }

        try {
            this._connect(Main.sessionMode, 'updated', () => {
                this._applyVisibility();
                this._scheduleRebuild();
            });
        } catch (error) {
            logWarn('Señales', `SessionMode: ${error.message}`);
        }
    }

    _connect(object, signal, callback) {
        try {
            const id = object.connect(signal, callback);
            this._signals.push([object, id]);
            return id;
        } catch (error) {
            logError(`No se pudo conectar «${signal}»`, error);
            return 0;
        }
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

    _onSettingsChanged(key) {
        if (this._destroyed || !this._settings)
            return;

        switch (key) {
        case 'show-app-name':
        case 'show-fake-menus':
            this._applyVisibility();
            break;
        case 'desktop-app-name':
        case 'menu-use-app-actions':
            this._scheduleRebuild();
            break;
        default:
            break;
        }
    }

    /* -------------------------------------------------------------- */
    /* Cristal Liquid Glass                                            */
    /* -------------------------------------------------------------- */

    _setGlassEngine(engine) {
        this._detachAllMenuGlass();
        this._glassEngine = engine;
        if (!engine || this._destroyed)
            return;
        for (const entry of this._titleButtons) {
            if (entry.menu?.isOpen)
                this._attachMenuGlass(entry);
        }
    }

    updateGlass() {
        if (!this._glassEngine)
            return;
        const look = glassLook(this._extension?._theme);
        for (const entry of this._titleButtons) {
            if (!entry.menu?.isOpen)
                continue;
            if (entry.glassHandle)
                entry.glassHandle.update(look);
            else
                this._attachMenuGlass(entry);
        }
    }

    _attachMenuGlass(entry) {
        if (!this._glassEngine || !entry.menu?.box || entry.glassHandle)
            return;

        entry.glassHandle = this._glassEngine.attach(entry.menu.box,
            glassLook(this._extension?._theme, {
                cornerRadius: 14,
                blurRadius: 12,
                owner: 'menubar-menu',
            }));
    }

    _detachMenuGlass(entry) {
        entry.glassHandle?.destroy();
        entry.glassHandle = null;
    }

    _detachAllMenuGlass() {
        for (const entry of this._titleButtons)
            this._detachMenuGlass(entry);
    }

    _applyVisibility() {
        if (this._destroyed)
            return;

        const showName = this._settings?.get_boolean('show-app-name') ?? true;
        const showMenus = this._settings?.get_boolean('show-fake-menus') ?? true;
        const userMode = Main.sessionMode?.currentMode === 'user';

        this.actor.visible = userMode && (showName || showMenus);

        for (const entry of this._titleButtons) {
            const visible = entry.isApp ? showName : showMenus;
            try {
                entry.button.container.visible = visible;
                if (!visible && entry.menu?.isOpen)
                    entry.menu.close();
            } catch {
                // Botón destruido.
            }
        }
    }

    /* -------------------------------------------------------------- */
    /* Contexto (app activa / escritorio)                              */
    /* -------------------------------------------------------------- */

    _buildContext() {
        const tracker = Shell.WindowTracker.get_default();
        const win = global.display.focus_window ?? null;
        let app = tracker.focus_app ?? null;
        const overview = Boolean(Main.overview?.visible);

        if (!app && win) {
            try {
                app = tracker.get_window_app(win);
            } catch {
                app = null;
            }
        }

        let desktop = overview || !win || !app;

        if (!desktop && win) {
            if (isDesktopWindowType(win) || looksLikeDesktopWindow(win, app))
                desktop = true;
        }

        const ctx = {
            mode: desktop ? 'desktop' : 'app',
            app: desktop ? null : app,
            win: desktop ? null : win,
            appId: desktop ? '' : (app?.get_id() ?? ''),
            appName: '',
            windows: [],
            actions: {app: null, win: null, nautilus: null},
            bus: null,
            appPath: null,
            winPath: null,
            menubarPath: null,
            nautilusBus: 'org.gnome.Nautilus',
            nautilusPath: '/org/gnome/Nautilus',
        };

        if (desktop) {
            const name = this._settings?.get_string('desktop-app-name')?.trim();
            ctx.appName = name || 'Archivos';
            return ctx;
        }

        ctx.appName = app.get_name?.() || ctx.appId.replace(/\.desktop$/, '') || 'Aplicación';

        try {
            ctx.windows = appWindows(app);
        } catch {
            ctx.windows = [];
        }

        try {
            ctx.bus = win.get_gtk_unique_bus_name?.() ?? null;
            ctx.appPath = win.get_gtk_application_object_path?.() ?? null;
            ctx.winPath = win.get_gtk_window_object_path?.() ?? null;
            ctx.menubarPath = win.get_gtk_menubar_object_path?.() ?? null;
        } catch (error) {
            logError('No se pudieron leer las rutas D-Bus de la ventana', error);
        }

        return ctx;
    }

    _nautilusRunning() {
        try {
            const app = Shell.AppSystem.get_default()
                .lookup_app('org.gnome.Nautilus.desktop');
            return app?.get_state?.() === Shell.AppState.RUNNING;
        } catch {
            return false;
        }
    }

    _scheduleRebuild() {
        if (this._destroyed)
            return;

        if (this._rebuildId)
            return;

        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._rebuildId = 0;
            this._rebuildMenus().catch(error =>
                logError('No se pudo reconstruir la barra de menús', error));
            return GLib.SOURCE_REMOVE;
        });
    }

    /* -------------------------------------------------------------- */
    /* Construcción de menús                                           */
    /* -------------------------------------------------------------- */

    async _rebuildMenus() {
        if (this._destroyed)
            return;

        const token = ++this._rebuildToken;

        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        const ctx = this._buildContext();
        if (!ctx)
            return;

        const useActions = this._settings?.get_boolean('menu-use-app-actions') ?? true;
        let menus = null;
        let source = 'generic';
        let model = null;

        try {
            if (ctx.mode === 'desktop') {
                if (useActions && this._nautilusRunning()) {
                    const actions = await describeAll(
                        ctx.nautilusBus, ctx.nautilusPath, cancellable);

                    if (token !== this._rebuildToken || this._destroyed)
                        return;

                    if (actions)
                        ctx.actions.nautilus = actions;
                }

                menus = buildFinderMenus();
                source = 'finder';

                const finderItems = buildFinderAppMenuItems(ctx);
                menus.unshift({
                    key: APP_MENU_KEY,
                    title: ctx.appName,
                    isApp: true,
                    items: finderItems,
                });
            } else {
                if (useActions) {
                    const tasks = [];

                    if (ctx.appPath) {
                        tasks.push(describeAll(ctx.bus, ctx.appPath, cancellable)
                            .then(actions => {
                                ctx.actions.app = actions;
                            }));
                    }

                    if (ctx.winPath) {
                        tasks.push(describeAll(ctx.bus, ctx.winPath, cancellable)
                            .then(actions => {
                                ctx.actions.win = actions;
                            }));
                    }

                    if (tasks.length)
                        await Promise.all(tasks);

                    if (token !== this._rebuildToken || this._destroyed)
                        return;
                }

                if (useActions && ctx.menubarPath && ctx.bus) {
                    ctx.modelKey = `${ctx.bus}|${ctx.menubarPath}`;
                    model = this._getMenuModel(ctx.bus, ctx.menubarPath);
                    if (model) {
                        menus = readMenubar(model, ctx);
                        if (menus) {
                            source = 'menubar';
                            this._augmentFullMenus(menus, ctx);
                        }
                    }
                }

                if (!menus) {
                    const profile = getProfile(ctx.appId);
                    if (profile) {
                        menus = deepClone(profile.menus);
                        source = 'profile';
                    } else {
                        menus = buildGenericMenus(ctx);
                        source = 'generic';
                    }

                    if (useActions)
                        menus = mergeKnownActions(menus, ctx);

                    this._augmentWindowMenu(menus, ctx);
                }

                menus.unshift({
                    key: APP_MENU_KEY,
                    title: ctx.appName,
                    isApp: true,
                    items: this._buildAppMenuItems(ctx),
                });
            }
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError('Error construyendo los menús', error);
            return;
        }

        if (token !== this._rebuildToken || this._destroyed)
            return;

        const resolved = this._resolveMenus(menus, ctx);
        this._renderMenus(resolved, ctx);

        this._ctxInfo = {
            mode: ctx.mode,
            appId: ctx.appId,
            appName: ctx.appName,
            winTitle: this._windowTitle(ctx.win),
            source,
            actions: {
                app: ctx.actions.app ? [...ctx.actions.app.keys()] : [],
                win: ctx.actions.win ? [...ctx.actions.win.keys()] : [],
                nautilus: ctx.actions.nautilus ? [...ctx.actions.nautilus.keys()] : [],
            },
            menubarPath: ctx.menubarPath,
            modelKey: ctx.modelKey ?? '',
            menus: resolved.map(menu => ({
                title: menu.title,
                items: menu.items
                    .filter(item => !item.sep)
                    .map(item => item.label),
            })),
        };
    }

    _windowTitle(win) {
        try {
            return win?.get_title?.() ?? '';
        } catch {
            return '';
        }
    }

    /* ------------------------- menú de la app ---------------------- */

    _actionInfo(ctx, prefix, name) {
        const map = ctx?.actions?.[prefix];
        if (!map)
            return null;
        return map.get(name) ?? null;
    }

    _buildAppMenuItems(ctx) {
        const items = [];
        const name = ctx.appName;
        const about = this._actionInfo(ctx, 'app', 'about') ??
            this._actionInfo(ctx, 'win', 'about');
        const aboutPrefix = this._actionInfo(ctx, 'app', 'about') ? 'app' : 'win';
        let preferences = this._actionInfo(ctx, 'app', 'preferences');
        let preferencesPrefix = 'app';
        if (!preferences) {
            preferences = this._actionInfo(ctx, 'win', 'preferences');
            if (preferences)
                preferencesPrefix = 'win';
        }
        const quit = this._actionInfo(ctx, 'app', 'quit');

        if (about) {
            items.push({
                label: `Acerca de ${name}`,
                gaction: `${aboutPrefix}.about`,
                enabled: about.enabled,
            });
        } else {
            items.push({
                label: `Acerca de ${name}`,
                run: () => this._openAbout(ctx),
            });
        }

        if (preferences) {
            items.push(SEPARATOR);
            items.push({
                label: 'Ajustes…',
                gaction: `${preferencesPrefix}.preferences`,
                keys: '<Control>comma',
                enabled: preferences.enabled,
            });
        }

        items.push(SEPARATOR);
        items.push({
            label: `Ocultar ${name}`,
            run: () => hideApp(ctx.app),
        });
        items.push({
            label: 'Ocultar otras',
            run: () => hideOtherApps(ctx.app),
        });
        items.push({
            label: 'Mostrar todo',
            run: () => showAllWindows(),
        });

        items.push(SEPARATOR);
        if (quit) {
            items.push({
                label: `Salir de ${name}`,
                gaction: 'app.quit',
                keys: '<Control>q',
                enabled: quit.enabled,
            });
        } else {
            items.push({
                label: `Salir de ${name}`,
                keys: '<Control>q',
                run: () => {
                    try {
                        ctx.app?.request_quit?.();
                    } catch (error) {
                        logError('No se pudo cerrar la aplicación', error);
                    }
                },
            });
        }

        return items;
    }

    _openAbout(ctx) {
        const appId = ctx.appId;
        try {
            if (appId) {
                spawn(['gnome-software', `--details=${appId}`]);
                return;
            }
            ctx.app?.activate?.();
        } catch (error) {
            logError('No se pudo abrir «Acerca de»', error);
        }
    }

    /* ------------------------- menú Ventana ------------------------ */

    _generatedWindowItems(ctx) {
        if (!ctx.win)
            return [];

        const win = ctx.win;
        let maximized = false;
        let fullscreen = false;
        let above = false;
        let canMinimize = false;

        try {
            maximized = win.is_maximized();
            fullscreen = win.is_fullscreen();
            above = win.is_above();
            canMinimize = win.can_minimize();
        } catch {
            // Ventana destruida entre la captura y la construcción.
        }

        const items = [
            {
                label: 'Minimizar',
                window: 'minimize',
                keys: '<Super>m',
                enabled: canMinimize,
            },
            {
                // El resolver cambia la etiqueta a «Restaurar» si procede.
                label: maximized ? 'Restaurar' : 'Zoom',
                window: 'zoom',
            },
            SEPARATOR,
            {label: 'Mover a la mitad izquierda', window: 'left'},
            {label: 'Mover a la mitad derecha', window: 'right'},
            SEPARATOR,
            {
                label: 'Pantalla completa',
                window: 'fullscreen',
                keys: 'F11',
                checked: fullscreen,
            },
            {
                label: 'Siempre encima',
                window: 'above',
                checked: above,
            },
            SEPARATOR,
            {label: 'Traer todo al frente', app: 'bring-all-front'},
        ];

        const windows = this._sortedWindows(ctx);
        if (windows.length > 0) {
            items.push(SEPARATOR);
            for (const other of windows) {
                items.push({
                    label: truncate(this._windowTitle(other)),
                    checked: other === win,
                    run: () => activateWindow(other),
                });
            }
        }

        return items;
    }

    _sortedWindows(ctx) {
        const windows = [...(ctx.windows ?? [])];
        windows.sort((a, b) => {
            try {
                return b.get_user_time() - a.get_user_time();
            } catch {
                return 0;
            }
        });
        return windows;
    }

    _augmentWindowMenu(menus, ctx) {
        if (!ctx.win)
            return;

        let menu = menus.find(entry => entry.key === 'window');
        if (!menu) {
            menu = {key: 'window', title: 'Ventana', items: []};
            const helpIndex = menus.findIndex(entry => entry.key === 'help');
            if (helpIndex >= 0)
                menus.splice(helpIndex, 0, menu);
            else
                menus.push(menu);
        }

        const existing = new Set(
            menu.items.filter(item => item?.label).map(item => item.label));
        const existingKinds = new Set(
            menu.items.filter(item => item?.window).map(item => item.window));

        const generated = this._generatedWindowItems(ctx);
        const additions = generated.filter(item =>
            item.sep ||
            (!existing.has(item.label) &&
             (!item.window || !existingKinds.has(item.window))));

        if (additions.length > 0) {
            if (menu.items.length > 0 &&
                !menu.items[menu.items.length - 1]?.sep)
                menu.items.push(SEPARATOR);
            menu.items.push(...additions);
        }
    }

    _augmentFullMenus(menus, ctx) {
        // La barra real de GTK suele traer Archivo/Edición/…, pero el menú
        // Ventana generado desde Meta siempre está disponible.
        this._augmentWindowMenu(menus, ctx);

        // Aseguramos una entrada de ayuda cuando la app no la exporta.
        if (!menus.some(menu => menu.key === 'help')) {
            const helpItems = [];
            const shortcuts = this._actionInfo(ctx, 'win', 'shortcuts') ??
                this._actionInfo(ctx, 'win', 'show-help-overlay');

            if (shortcuts) {
                helpItems.push({
                    label: 'Atajos de teclado',
                    gaction: 'win.shortcuts',
                    enabled: shortcuts.enabled,
                });
            }

            if (helpItems.length > 0)
                menus.push({key: 'help', title: 'Ayuda', items: helpItems});
        }

        // Nada de menús vacíos.
        for (let i = menus.length - 1; i >= 0; i--) {
            const menu = menus[i];
            if (menu.key === APP_MENU_KEY)
                continue;
            if (!menu.items.some(item => !item.sep))
                menus.splice(i, 1);
        }
    }

    /* ------------------------- resolución -------------------------- */

    _groupFor(ctx, prefix) {
        if (prefix === 'nautilus')
            return this._groups.get(ctx.nautilusBus, ctx.nautilusPath);

        if (prefix === 'app') {
            if (!ctx.bus || !ctx.appPath)
                return null;
            return this._groups.get(ctx.bus, ctx.appPath);
        }

        if (prefix === 'win') {
            if (!ctx.bus || !ctx.winPath)
                return null;
            return this._groups.get(ctx.bus, ctx.winPath);
        }

        return null;
    }

    _splitGaction(gaction) {
        const dot = `${gaction}`.indexOf('.');
        if (dot < 0)
            return {prefix: 'app', name: `${gaction}`};
        return {
            prefix: `${gaction}`.slice(0, dot),
            name: `${gaction}`.slice(dot + 1),
        };
    }

    _resolveMenus(menus, ctx) {
        const resolved = [];

        for (const menu of menus) {
            if (!menu)
                continue;

            const items = this._resolveItems(menu.items, ctx);
            if (items.length === 0)
                continue;

            resolved.push({
                key: menu.key,
                title: menu.title,
                isApp: Boolean(menu.isApp) || menu.key === APP_MENU_KEY,
                items,
            });
        }

        return resolved;
    }

    _resolveItems(protoItems, ctx) {
        const result = [];

        for (const proto of protoItems ?? []) {
            if (!proto)
                continue;

            if (proto.sep) {
                if (result.length && !result[result.length - 1].sep)
                    result.push({sep: true});
                continue;
            }

            let item = null;
            try {
                item = this._resolveItem(proto, ctx);
            } catch (error) {
                logError(`No se pudo resolver «${proto.label ?? '?'}»`, error);
            }

            if (!item)
                continue;

            // Evita duplicados exactos de etiqueta dentro del mismo menú.
            const duplicate = result.find(existing =>
                !existing.sep && existing.label === item.label &&
                existing.enabled === item.enabled);
            if (duplicate)
                continue;

            result.push(item);
        }

        while (result.length && result[result.length - 1].sep)
            result.pop();

        return result;
    }

    _resolveItem(proto, ctx) {
        const desktop = ctx.mode === 'desktop';
        const win = ctx.win;

        const base = {
            label: proto.label ?? '',
            accel: proto.accel ?? '',
            enabled: proto.enabled ?? true,
            checked: Boolean(proto.checked),
            run: null,
        };

        if (proto.keys)
            base.accel = accelToGlyph(proto.keys) || base.accel;

        if (proto.gtkAccel) {
            const glyph = gtkAccelToGlyph(proto.gtkAccel);
            if (glyph)
                base.accel = glyph;
        }

        if (proto.desktopDisabled && desktop)
            base.enabled = false;

        // Encabezado de sección (no interactivo).
        if (proto.header) {
            base.header = true;
            base.enabled = false;
            return base;
        }

        // 1. Callback explícito.
        if (typeof proto.run === 'function') {
            base.run = proto.run;
            return base;
        }

        // 2. Submenú.
        if (Array.isArray(proto.submenu)) {
            const children = this._resolveItems(proto.submenu, ctx);
            if (children.length === 0)
                return null;
            return {
                label: proto.label,
                accel: base.accel,
                submenu: children,
                enabled: children.some(child => !child.sep && child.enabled),
            };
        }

        // 3. Acción GTK (org.gtk.Actions).
        if (proto.gaction) {
            const {prefix, name} = this._splitGaction(proto.gaction);
            const info = this._actionInfo(ctx, prefix, name);
            const group = this._groupFor(ctx, prefix);

            if (info) {
                if (info.paramType && !proto.target) {
                    // Acción con parámetro no trivial: se intenta con teclas.
                    if (proto.keys && (win || !desktop))
                        return this._keyItem(proto, ctx);
                    return null;
                }

                let target = proto.target ?? null;
                if (target) {
                    try {
                        if (target.get_type_string() === 'v')
                            target = target.get_variant();
                    } catch {
                        // Se usa tal cual.
                    }
                }

                base.enabled = proto.enabled ?? info.enabled ?? true;
                if (proto.checked === undefined)
                    base.checked = this._booleanState(info.state);

                base.run = () => {
                    activateGtkAction(this._groups, prefix, group, name, target);
                };
                return base;
            }

            // La acción no existe: para Ajustes/Acerca/Atajos es mejor no
            // mostrar un ítem muerto; para el resto se intenta con teclas.
            if (['preferences', 'about', 'shortcuts'].includes(name)) {
                if (proto.keys && proto.run)
                    return this._keyItem(proto, ctx);
                return null;
            }

            if (proto.keys && (win || !desktop))
                return this._keyItem(proto, ctx);

            base.enabled = false;
            return base;
        }

        // 4. Operación de ventana.
        if (proto.window)
            return this._windowItem(proto, ctx);

        // 5. Operación de aplicación.
        if (proto.app)
            return this._appItem(proto, ctx);

        // 6. URI / lanzamiento.
        if (proto.uri) {
            base.run = () => launchUri(proto.uri);
            return base;
        }

        if (proto.spawn) {
            base.run = () => spawn(proto.spawn);
            return base;
        }

        // 7. Teclas sintetizadas.
        if (proto.keys)
            return this._keyItem(proto, ctx);

        base.enabled = false;
        return base;
    }

    _booleanState(state) {
        try {
            if (state?.is_of_type(new GLib.VariantType('b')))
                return state.get_boolean();
        } catch {
            // Estado no booleano.
        }
        return false;
    }

    _keyItem(proto, ctx) {
        const desktop = ctx.mode === 'desktop';
        const win = ctx.win;

        const enabled = proto.enabled ?? (!desktop && Boolean(win));

        return {
            label: proto.label ?? '',
            accel: proto.accel ?? accelToGlyph(proto.keys),
            enabled,
            checked: Boolean(proto.checked),
            run: () => {
                this._keySender.send(win, proto.keys);
            },
        };
    }

    _windowItem(proto, ctx) {
        const win = ctx.win;
        const desktop = ctx.mode === 'desktop';

        const base = {
            label: proto.label,
            accel: proto.accel ?? (proto.keys ? accelToGlyph(proto.keys) : ''),
            enabled: false,
            checked: Boolean(proto.checked),
            run: null,
        };

        if (desktop || !win)
            return base;

        switch (proto.window) {
        case 'minimize':
            try {
                base.enabled = win.can_minimize();
            } catch {
                base.enabled = false;
            }
            base.run = () => minimizeWindow(win);
            break;

        case 'zoom':
            try {
                base.label = win.is_maximized() ? 'Restaurar' : 'Zoom';
            } catch {
                base.label = 'Zoom';
            }
            base.enabled = true;
            base.run = () => toggleMaximize(win);
            break;

        case 'close':
            base.enabled = true;
            base.run = () => {
                try {
                    win.delete(global.get_current_time());
                } catch (error) {
                    logError('No se pudo cerrar la ventana', error);
                }
            };
            break;

        case 'left':
        case 'right':
            base.enabled = true;
            base.run = () => moveWindowToHalf(win, proto.window);
            break;

        case 'fullscreen':
            try {
                base.checked = win.is_fullscreen();
            } catch {
                base.checked = false;
            }
            base.enabled = true;
            base.run = () => toggleFullscreen(win);
            break;

        case 'above':
            try {
                base.checked = win.is_above();
            } catch {
                base.checked = false;
            }
            base.enabled = true;
            base.run = () => toggleAbove(win);
            break;

        default:
            return base;
        }

        return base;
    }

    _appItem(proto, ctx) {
        const app = ctx.app;

        const base = {
            label: proto.label,
            accel: proto.accel ?? (proto.keys ? accelToGlyph(proto.keys) : ''),
            enabled: true,
            checked: Boolean(proto.checked),
            run: null,
        };

        switch (proto.app) {
        case 'quit': {
            const info = this._actionInfo(ctx, 'app', 'quit');
            if (info) {
                const {name} = this._splitGaction('app.quit');
                const group = this._groupFor(ctx, 'app');
                base.enabled = info.enabled;
                base.run = () => activateGtkAction(
                    this._groups, 'app', group, name, null);
                base.accel = base.accel || accelToGlyph('<Control>q');
            } else if (app) {
                base.run = () => {
                    try {
                        app.request_quit();
                    } catch (error) {
                        logError('No se pudo cerrar la aplicación', error);
                    }
                };
                base.accel = base.accel || accelToGlyph('<Control>q');
            } else {
                base.enabled = false;
            }
            break;
        }

        case 'new-window': {
            const info = this._actionInfo(ctx, 'app', 'new-window');
            if (info) {
                const group = this._groupFor(ctx, 'app');
                base.enabled = info.enabled;
                base.run = () => activateGtkAction(
                    this._groups, 'app', group, 'new-window', null);
            } else if (app?.can_open_new_window?.()) {
                base.run = () => {
                    try {
                        app.open_new_window(-1);
                    } catch (error) {
                        logError('No se pudo abrir una ventana nueva', error);
                    }
                };
            } else {
                base.enabled = false;
            }
            break;
        }

        case 'hide':
            base.enabled = Boolean(app);
            base.run = () => hideApp(app);
            break;

        case 'hide-others':
            base.run = () => hideOtherApps(app);
            break;

        case 'show-all':
            base.run = () => showAllWindows();
            break;

        case 'bring-all-front':
            base.run = () => bringEverythingToFront();
            break;

        case 'minimize-desktop':
            base.enabled = false;
            break;

        default:
            base.enabled = false;
            break;
        }

        return base;
    }

    /* -------------------------------------------------------------- */
    /* Render                                                          */
    /* -------------------------------------------------------------- */

    _clearTitles() {
        for (const entry of this._titleButtons) {
            const menu = entry.button?.menu ?? null;

            this._detachMenuGlass(entry);
            if (menu) {
                for (const id of [entry.openId, entry.closedId]) {
                    if (!id)
                        continue;
                    try {
                        menu.disconnect(id);
                    } catch {
                        // Menú ya destruido.
                    }
                }
                entry.openId = entry.closedId = 0;
            }

            try {
                if (menu?.isOpen)
                    menu.close(PopupMenu.PopupAnimation.NONE);
            } catch {
                // Menú ya cerrado.
            }

            try {
                if (menu)
                    Main.panel.menuManager?.removeMenu(menu);
            } catch (error) {
                logError('No se pudo desregistrar un menú', error);
            }

            try {
                entry.button?.destroy();
            } catch (error) {
                logError('No se pudo destruir un título', error);
            }
        }

        this._titleButtons = [];
    }

    _renderMenus(menus, ctx) {
        if (this._destroyed)
            return;

        this._clearTitles();

        for (const menuDef of menus) {
            if (!menuDef)
                continue;

            if (!menuDef.isApp && !menuDef.items.some(item => !item.sep))
                continue;

            try {
                this._renderMenu(menuDef, ctx);
            } catch (error) {
                logError(`No se pudo crear el menú «${menuDef.title}»`, error);
            }
        }

        this._applyVisibility();
    }

    _renderMenu(menuDef, ctx) {
        const button = new PanelMenu.Button(0.0, menuDef.title, false);
        button.add_style_class_name('tahoe-menubar-title');

        if (menuDef.isApp)
            button.add_style_class_name('tahoe-menubar-appname');

        const label = new St.Label({
            text: menuDef.title,
            style_class: 'tahoe-menubar-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const box = new St.Bin({
            style_class: 'tahoe-menubar-title-box',
            child: label,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        button.add_child(box);
        button.menu.actor.add_style_class_name('tahoe-menubar-menu');

        this._populateMenu(button.menu, menuDef.items);

        try {
            Main.panel.menuManager.addMenu(button.menu);
        } catch (error) {
            logError('No se pudo registrar el menú en el panel', error);
        }

        this.actor.add_child(button.container);

        const entry = {
            key: menuDef.key,
            title: menuDef.title,
            isApp: menuDef.isApp,
            button,
            menu: button.menu,
            glassHandle: null,
            openId: 0,
            closedId: 0,
        };
        entry.openId = button.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._attachMenuGlass(entry);
        });
        entry.closedId = button.menu.connect('menu-closed',
            () => this._detachMenuGlass(entry));
        this._titleButtons.push(entry);
    }

    _populateMenu(menu, items) {
        for (const item of items) {
            if (!item)
                continue;

            if (item.sep) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                continue;
            }

            if (item.header) {
                const header = new PopupMenu.PopupMenuItem(item.label, {
                    reactive: false,
                    can_focus: false,
                });
                header.add_style_class_name('tahoe-menubar-header');
                header.add_style_pseudo_class('insensitive');
                menu.addMenuItem(header);
                continue;
            }

            if (item.submenu) {
                const submenu = new PopupMenu.PopupSubMenuMenuItem(item.label);

                if (item.accel) {
                    submenu.label.x_expand = true;
                    submenu.add_child(new St.Label({
                        text: item.accel,
                        style_class: 'tahoe-menubar-accel',
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
                }

                this._populateMenu(submenu.menu, item.submenu);

                if (!item.enabled)
                    this._disableItem(submenu);

                menu.addMenuItem(submenu);
                continue;
            }

            const menuItem = new PopupMenu.PopupMenuItem(item.label);
            menuItem.label.x_expand = true;

            if (item.accel) {
                menuItem.add_child(new St.Label({
                    text: item.accel,
                    style_class: 'tahoe-menubar-accel',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            if (item.checked)
                menuItem.setOrnament(PopupMenu.Ornament.CHECK);

            if (!item.enabled || typeof item.run !== 'function') {
                this._disableItem(menuItem);
            } else {
                const run = item.run;
                menuItem.connect('activate', () => {
                    try {
                        run();
                    } catch (error) {
                        logError(`Error al activar «${item.label}»`, error);
                    }

                    // El estado (✓ de «Siempre encima», ventanas abiertas…)
                    // puede haber cambiado: se refresca al cerrar el menú.
                    this._scheduleRebuild();
                });
            }

            menu.addMenuItem(menuItem);
        }
    }

    _disableItem(menuItem) {
        try {
            menuItem.reactive = false;
            menuItem.can_focus = false;
            menuItem.add_style_pseudo_class('insensitive');
            menuItem.add_style_class_name('tahoe-menubar-disabled');
        } catch {
            // Ítem ya destruido.
        }
    }

    /* -------------------------------------------------------------- */
    /* Modelos de menú D-Bus                                           */
    /* -------------------------------------------------------------- */

    _getMenuModel(busName, path) {
        const key = `${busName}|${path}`;
        const cached = this._menuModels.get(key);
        if (cached)
            return cached.model;

        try {
            const model = Gio.DBusMenuModel.get(Gio.DBus.session, busName, path);
            const id = model.connect('items-changed', () => {
                if (this._destroyed)
                    return;
                if (this._ctxInfo?.modelKey === key)
                    this._scheduleRebuild();
            });

            this._menuModels.set(key, {model, id, key});
            return model;
        } catch (error) {
            logError(`No se pudo leer el menú D-Bus ${key}`, error);
            return null;
        }
    }

    _clearMenuModels() {
        for (const {model, id} of this._menuModels.values()) {
            try {
                model.disconnect(id);
            } catch {
                // El modelo ya no existe.
            }
        }
        this._menuModels.clear();
    }

    /* -------------------------------------------------------------- */
    /* API pública                                                     */
    /* -------------------------------------------------------------- */

    /** Información para depuración/pruebas. */
    getDebugInfo() {
        return this._ctxInfo ? deepCloneSafe(this._ctxInfo) : null;
    }

    /** Botones de título actuales: [{title, isApp, button}]. */
    getTitleButtons() {
        return this._titleButtons.map(entry => ({
            title: entry.title,
            key: entry.key,
            isApp: entry.isApp,
            button: entry.button,
            menu: entry.menu,
        }));
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this._teardown(true);
    }

    _teardown(destroyActor) {
        this._detachAllMenuGlass();
        if (this._glassUnsubscribe) {
            this._glassUnsubscribe();
            this._glassUnsubscribe = null;
        }
        this._glassEngine = null;

        if (this._rebuildId) {
            try {
                GLib.source_remove(this._rebuildId);
            } catch {
                // Fuente ya retirada.
            }
            this._rebuildId = 0;
        }

        this._rebuildToken++;

        if (this._cancellable) {
            try {
                this._cancellable.cancel();
            } catch {
                // Ya estaba cancelado.
            }
            this._cancellable = null;
        }

        if (this._settings && this._settingsId) {
            try {
                this._settings.disconnect(this._settingsId);
            } catch {
                // Ajustes ya destruidos.
            }
        }
        this._settingsId = 0;
        this._settings = null;

        this._disconnectSignals();
        this._clearTitles();
        this._clearMenuModels();
        this._groups.clear();

        if (this._keySender) {
            this._keySender.destroy();
            this._keySender = null;
        }

        this._unloadStylesheet();

        if (destroyActor && this.actor) {
            try {
                if (this._actorDestroyId) {
                    this.actor.disconnect(this._actorDestroyId);
                    this._actorDestroyId = 0;
                }
                this.actor.destroy();
            } catch (error) {
                logError('No se pudo destruir el actor de la barra de menús', error);
            }
        }

        this.actor = null;
        this._extension = null;
        this._ctxInfo = null;
    }
}

// deepClone no puede copiar GLib.Variant de forma segura en todas las
// versiones de GJS; para la información de depuración basta con JSON.
function deepCloneSafe(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}
