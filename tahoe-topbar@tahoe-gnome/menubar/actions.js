// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Tahoe menu bar — utilidades compartidas.
//
// Aquí viven:
//   · el parser de aceleradores GTK y la síntesis de teclas con un
//     dispositivo virtual de Clutter,
//   · la activación de acciones GTK exportadas por D-Bus (org.gtk.Actions),
//   · operaciones de ventana basadas en Meta,
//   · lanzadores (URI, terminal, aplicaciones).

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

export const LOG_TAG = '[tahoe-topbar/menubar]';

export function logError(context, error) {
    const message = error?.message ?? `${error}`;
    console.error(`${LOG_TAG} ${context}: ${message}`);
}

export function logWarn(context, message) {
    console.warn(`${LOG_TAG} ${context}: ${message}`);
}

/* ------------------------------------------------------------------ */
/* Texto                                                               */
/* ------------------------------------------------------------------ */

/** Quita los mnemónicos de GTK («_Archivo» → «Archivo»). */
export function cleanLabel(text) {
    if (!text)
        return '';

    return `${text}`
        .replace(/__/g, '\u0000')
        .replace(/_([^\s_])/g, '$1')
        .replace(/\u0000/g, '_')
        .trim();
}

export function truncate(text, max = 52) {
    const value = `${text ?? ''}`.trim();
    if (value.length <= max)
        return value;
    return `${value.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ */
/* Aceleradores                                                        */
/* ------------------------------------------------------------------ */

const MODIFIER_ALIASES = {
    'ctrl': 'ctrl',
    'control': 'ctrl',
    'primary': 'ctrl',
    'shift': 'shift',
    'alt': 'alt',
    'meta': 'alt',
    'mod1': 'alt',
    'option': 'alt',
    'super': 'super',
    'mod4': 'super',
    'command': 'super',
    'cmd': 'super',
    'win': 'super',
};

const MODIFIER_GLYPHS = {
    shift: '⇧',
    ctrl: '⌃',
    alt: '⌥',
    super: '⌘',
};

// Orden de presentación usado por macOS (⇧⌃⌥⌘): encaja con los ejemplos
// del proyecto («⇧⌃Z», «⌃N», «⇧⌘Q»).
const MODIFIER_ORDER = ['shift', 'ctrl', 'alt', 'super'];

const MODIFIER_KEYVALS = {
    ctrl: Clutter.KEY_Control_L,
    shift: Clutter.KEY_Shift_L,
    alt: Clutter.KEY_Alt_L,
    super: Clutter.KEY_Super_L,
};

const KEY_ALIASES = {
    return: 'Return',
    enter: 'Return',
    escape: 'Escape',
    esc: 'Escape',
    backspace: 'BackSpace',
    back_space: 'BackSpace',
    delete: 'Delete',
    del: 'Delete',
    insert: 'Insert',
    home: 'Home',
    end: 'End',
    pageup: 'Page_Up',
    page_up: 'Page_Up',
    pagedown: 'Page_Down',
    page_down: 'Page_Down',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    tab: 'Tab',
    space: 'space',
    plus: 'plus',
    minus: 'minus',
    comma: 'comma',
    period: 'period',
    dot: 'period',
    slash: 'slash',
    backslash: 'backslash',
    semicolon: 'semicolon',
    apostrophe: 'apostrophe',
    grave: 'grave',
    bracketleft: 'bracketleft',
    bracketright: 'bracketright',
    equal: 'equal',
    print: 'Print',
    menu: 'Menu',
    help: 'Help',
    pause: 'Pause',
    scroll_lock: 'Scroll_Lock',
    question: 'question',
    exclam: 'exclam',
    at: 'at',
    numbersign: 'numbersign',
    dollar: 'dollar',
    percent: 'percent',
    asciicircum: 'asciicircum',
    ampersand: 'ampersand',
    asterisk: 'asterisk',
    parenleft: 'parenleft',
    parenright: 'parenright',
    underscore: 'underscore',
    colon: 'colon',
    quotedbl: 'quotedbl',
    less: 'less',
    greater: 'greater',
    bar: 'bar',
    KP_Add: 'KP_Add',
    KP_Subtract: 'KP_Subtract',
    KP_Multiply: 'KP_Multiply',
    KP_Divide: 'KP_Divide',
    KP_Enter: 'KP_Enter',
    KP_Decimal: 'KP_Decimal',
};

const KEY_GLYPHS = {
    Return: '↩',
    Escape: '⎋',
    BackSpace: '⌫',
    Delete: '⌦',
    Tab: '⇥',
    space: 'Espacio',
    Up: '↑',
    Down: '↓',
    Left: '←',
    Right: '→',
    Page_Up: 'Re Pág',
    Page_Down: 'Av Pág',
    Home: 'Inicio',
    End: 'Fin',
    Insert: 'Insert',
    plus: '+',
    minus: '-',
    comma: ',',
    period: '.',
    slash: '/',
    backslash: '\\',
    semicolon: ';',
    apostrophe: '\'',
    grave: '`',
    bracketleft: '[',
    bracketright: ']',
    equal: '=',
    question: '?',
    exclam: '!',
    at: '@',
    numbersign: '#',
    dollar: '$',
    percent: '%',
    asciicircum: '^',
    ampersand: '&',
    asterisk: '*',
    parenleft: '(',
    parenright: ')',
    underscore: '_',
    colon: ':',
    quotedbl: '"',
    less: '<',
    greater: '>',
    bar: '|',
    KP_Add: '+',
    KP_Subtract: '-',
    KP_Multiply: '*',
    KP_Divide: '/',
    KP_Enter: '⏎',
    KP_Decimal: '.',
};

const PUNCTUATION_KEYS = {
    '+': 'plus',
    '-': 'minus',
    ',': 'comma',
    '.': 'period',
    '/': 'slash',
    '\\': 'backslash',
    ';': 'semicolon',
    '\'': 'apostrophe',
    '`': 'grave',
    '[': 'bracketleft',
    ']': 'bracketright',
    '=': 'equal',
    '?': 'question',
    '!': 'exclam',
    '@': 'at',
    '#': 'numbersign',
    '$': 'dollar',
    '%': 'percent',
    '^': 'asciicircum',
    '&': 'ampersand',
    '*': 'asterisk',
    '(': 'parenleft',
    ')': 'parenright',
    '_': 'underscore',
    ':': 'colon',
    '"': 'quotedbl',
    '<': 'less',
    '>': 'greater',
    '|': 'bar',
};

function normalizeKeyName(raw) {
    if (!raw)
        return null;

    if (raw.length === 1) {
        const char = raw;
        if (/[a-zA-Z]/.test(char))
            return char.toLowerCase();
        if (/[0-9]/.test(char))
            return char;
        if (PUNCTUATION_KEYS[char])
            return PUNCTUATION_KEYS[char];
        return null;
    }

    const lowered = raw.toLowerCase();
    if (KEY_ALIASES[raw])
        return KEY_ALIASES[raw];
    if (KEY_ALIASES[lowered])
        return KEY_ALIASES[lowered];
    if (/^f([1-9]|1[0-2])$/.test(lowered))
        return `F${lowered.slice(1)}`;
    if (/^kp_[0-9]$/.test(lowered))
        return `KP_${lowered.slice(3)}`;

    return raw;
}

function keyvalForName(name) {
    if (!name)
        return 0;

    try {
        const value = Clutter[`KEY_${name}`];
        if (typeof value === 'number' && value > 0)
            return value;
    } catch {
        // Se intenta con el nombre alternativo.
    }

    if (name.length === 1)
        return name.charCodeAt(0);

    return 0;
}

function glyphForKey(name, raw) {
    if (!name)
        return raw ?? '';

    if (KEY_GLYPHS[name])
        return KEY_GLYPHS[name];

    if (/^F[0-9]{1,2}$/.test(name))
        return name;

    if (name.length === 1)
        return name.toUpperCase();

    return name;
}

/**
 * Convierte un acelerador GTK («<Control><Shift>z», «F11», «plus») en
 * modificadores, keyval de Clutter y texto con glifos de macOS.
 *
 * @returns {{ctrl: boolean, shift: boolean, alt: boolean, super: boolean,
 *            keyval: number, keyName: string, glyph: string}|null}
 */
export function parseAccel(accel) {
    if (!accel)
        return null;

    let source = `${accel}`.trim();
    if (!source)
        return null;

    const mods = {ctrl: false, shift: false, alt: false, super: false};
    const regex = /<([^>]+)>/g;
    let match;

    while ((match = regex.exec(source)) !== null) {
        const modifier = MODIFIER_ALIASES[match[1].toLowerCase()];
        if (modifier)
            mods[modifier] = true;
    }

    source = source.replace(/<[^>]+>/g, '').trim();
    if (!source)
        return null;

    // Una tecla en mayúsculas en un acelerador GTK implica Shift.
    if (source.length === 1 && /[A-Z]/.test(source))
        mods.shift = true;

    const keyName = normalizeKeyName(source);
    const keyval = keyvalForName(keyName);
    if (!keyval)
        return null;

    let glyph = '';
    for (const modifier of MODIFIER_ORDER) {
        if (mods[modifier])
            glyph += MODIFIER_GLYPHS[modifier];
    }
    glyph += glyphForKey(keyName, source);

    return {...mods, keyval, keyName, glyph};
}

/** Texto de atajo (⌃N, ⇧⌃Z…) para un acelerador GTK. */
export function accelToGlyph(accel) {
    return parseAccel(accel)?.glyph ?? '';
}

const TIMESTAMP = () => GLib.get_monotonic_time();

/**
 * Envía combinaciones de teclas a la ventana indicada mediante un
 * dispositivo virtual de Clutter. Cierra el menú antes (lo hace el propio
 * PopupMenu) y espera ~120 ms para que el foco llegue a la aplicación.
 */
export class KeySender {
    constructor() {
        this._device = null;
        this._timeoutId = 0;
        this._destroyed = false;
    }

    _getDevice() {
        if (this._device)
            return this._device;

        try {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._device = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE);
        } catch (error) {
            logError('No se pudo crear el teclado virtual', error);
            this._device = null;
        }

        return this._device;
    }

    _cancelPending() {
        if (this._timeoutId) {
            try {
                GLib.source_remove(this._timeoutId);
            } catch {
                // La fuente ya no existía.
            }
            this._timeoutId = 0;
        }
    }

    send(win, accel) {
        if (this._destroyed)
            return false;

        const parsed = parseAccel(accel);
        if (!parsed) {
            logWarn('send', `Acelerador no válido: ${accel}`);
            return false;
        }

        let needsActivation = false;
        if (win) {
            try {
                needsActivation = global.display.focus_window !== win;
                if (needsActivation)
                    Main.activateWindow(win);
            } catch (error) {
                logError('No se pudo activar la ventana destino', error);
            }
        }

        this._cancelPending();

        const delay = needsActivation ? 220 : 120;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeoutId = 0;
            this._emit(parsed);
            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    _emit(parsed) {
        if (this._destroyed)
            return;

        const device = this._getDevice();
        if (!device)
            return;

        const pressed = [];
        const timestamp = TIMESTAMP();

        const press = (keyval, mod) => {
            try {
                device.notify_keyval(timestamp, keyval,
                    Clutter.KeyState.PRESSED);
                pressed.push({keyval, mod});
            } catch (error) {
                logError('notify_keyval (pulsar)', error);
            }
        };

        try {
            for (const modifier of ['ctrl', 'alt', 'shift', 'super']) {
                if (parsed[modifier])
                    press(MODIFIER_KEYVALS[modifier], modifier);
            }

            press(parsed.keyval, null);

            try {
                device.notify_keyval(timestamp, parsed.keyval,
                    Clutter.KeyState.RELEASED);
            } catch (error) {
                logError('notify_keyval (soltar tecla)', error);
            }

            for (let i = pressed.length - 1; i >= 0; i--) {
                const {keyval, mod} = pressed[i];
                if (mod === null)
                    continue;
                try {
                    device.notify_keyval(timestamp, keyval,
                        Clutter.KeyState.RELEASED);
                } catch (error) {
                    logError('notify_keyval (soltar modificador)', error);
                }
            }
        } catch (error) {
            logError('No se pudieron sintetizar las teclas', error);
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancelPending();
        this._device = null;
    }
}

/* ------------------------------------------------------------------ */
/* Acciones GTK por D-Bus                                              */
/* ------------------------------------------------------------------ */

/** Caché de Gio.DBusActionGroup por (bus, ruta). */
export class ActionGroupCache {
    constructor() {
        this._groups = new Map();
    }

    get(busName, path) {
        if (!busName || !path)
            return null;

        const key = `${busName}|${path}`;
        let group = this._groups.get(key);
        if (group)
            return group;

        try {
            group = Gio.DBusActionGroup.get(Gio.DBus.session, busName, path);
            this._groups.set(key, group);
        } catch (error) {
            logError(`No se pudo crear el grupo de acciones ${key}`, error);
            return null;
        }

        return group;
    }

    clear() {
        this._groups.clear();
    }
}

/**
 * Parsea la respuesta de org.gtk.Actions.DescribeAll sin depender de la
 * firma exacta (las versiones de GTK han usado a{s(bsav)} y variantes).
 *
 * @returns {Map<string, {enabled: boolean, paramType: string,
 *                        state: GLib.Variant|null}>}
 */
function parseDescribeAll(variant) {
    const actions = new Map();

    const parseInfo = info => {
        try {
            const enabled = info.get_child_value(0).get_boolean();
            const typeValue = info.get_child_value(1);
            const paramType = typeValue.get_string()[0] ?? '';
            const rawState = info.get_child_value(2);
            let state = null;

            if (rawState.get_type_string() === 'av') {
                if (rawState.n_children() > 0)
                    state = rawState.get_child_value(0);
            } else if (rawState.get_type_string() === 'v') {
                state = rawState.get_variant();
            } else {
                state = rawState;
            }

            return {enabled, paramType, state};
        } catch (error) {
            logError('DescribeAll (entrada)', error);
            return null;
        }
    };

    try {
        const array = variant.get_child_value(0);
        const count = array.n_children();

        for (let i = 0; i < count; i++) {
            const entry = array.get_child_value(i);
            const type = entry.get_type_string();

            if (type.startsWith('{')) {
                const name = entry.get_child_value(0).get_string()[0];
                const info = parseInfo(entry.get_child_value(1));
                if (name && info)
                    actions.set(name, info);
            }
            // El formato sin nombres no es utilizable: se ignora.
        }
    } catch (error) {
        logError('DescribeAll (respuesta)', error);
    }

    return actions;
}

/**
 * Llama a org.gtk.Actions.DescribeAll de forma asíncrona.
 *
 * @returns {Promise<Map|null>}
 */
export function describeAll(busName, path, cancellable) {
    if (!busName || !path)
        return Promise.resolve(null);

    return new Promise(resolve => {
        let settled = false;

        const finish = value => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };

        try {
            Gio.DBus.session.call(
                busName,
                path,
                'org.gtk.Actions',
                'DescribeAll',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                1500,
                cancellable,
                (connection, result) => {
                    try {
                        const reply = connection.call_finish(result);
                        finish(parseDescribeAll(reply));
                    } catch (error) {
                        if (!error.matches?.(Gio.IOErrorEnum,
                            Gio.IOErrorEnum.CANCELLED)) {
                            logWarn('DescribeAll',
                                `${busName}${path}: ${error.message}`);
                        }
                        finish(null);
                    }
                });
        } catch (error) {
            logError('DescribeAll (llamada)', error);
            finish(null);
        }
    });
}

/** Activa una acción GTK de un grupo exportado por D-Bus. */
export function activateGtkAction(cache, prefix, group, name, target) {
    if (!group || !name) {
        logWarn('activateGtkAction', `Acción inválida ${prefix ?? ''}.${name}`);
        return false;
    }

    try {
        group.activate_action(name, target ?? null);
        return true;
    } catch (error) {
        logError(`No se pudo activar ${prefix ?? ''}.${name}`, error);
        return false;
    }
}

/** Activa una acción suelta sin conocer su grupo (org.gtk.Actions.Activate). */
export function activateRemoteAction(busName, path, name) {
    if (!busName || !path || !name)
        return;

    try {
        Gio.DBus.session.call(
            busName,
            path,
            'org.gtk.Actions',
            'Activate',
            new GLib.Variant('(sava{sv})', [
                name,
                [],
                {},
            ]),
            null,
            Gio.DBusCallFlags.NONE,
            1500,
            null,
            (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (error) {
                    logWarn('Activate', `${busName}${path} ${name}: ${error.message}`);
                }
            });
    } catch (error) {
        logError('Activate (llamada)', error);
    }
}

/* ------------------------------------------------------------------ */
/* Lanzadores                                                          */
/* ------------------------------------------------------------------ */

export function spawn(argv) {
    if (!Array.isArray(argv) || argv.length === 0)
        return false;

    try {
        Util.spawn(argv);
        return true;
    } catch (error) {
        logError(`No se pudo lanzar ${argv[0]}`, error);
        return false;
    }
}

export function spawnCommandLine(commandLine) {
    try {
        Util.spawnCommandLine(commandLine);
        return true;
    } catch (error) {
        logError('No se pudo lanzar el comando', error);
        return false;
    }
}

export function launchUri(uri) {
    if (!uri)
        return false;

    try {
        if (Main.overview.visible)
            Main.overview.hide();
        Gio.AppInfo.launch_default_for_uri(uri, null);
        return true;
    } catch (error) {
        logError(`No se pudo abrir ${uri}`, error);
        return false;
    }
}

export function launchPath(path) {
    if (!path)
        return false;

    try {
        return launchUri(Gio.File.new_for_path(path).get_uri());
    } catch (error) {
        logError(`No se pudo abrir ${path}`, error);
        return false;
    }
}

export function findProgram(name) {
    try {
        return GLib.find_program_in_path(name) !== null;
    } catch {
        return false;
    }
}

export function activateApp(desktopIds) {
    const appSystem = Shell.AppSystem.get_default();

    for (const id of desktopIds) {
        const app = appSystem.lookup_app(id);
        if (!app)
            continue;

        try {
            if (Main.overview.visible)
                Main.overview.hide();
            app.activate();
            return app;
        } catch (error) {
            logError(`No se pudo activar ${id}`, error);
        }
    }

    return null;
}

export function showOverviewSearch() {
    try {
        Main.overview.show();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            try {
                Main.overview.searchEntry?.grab_key_focus();
            } catch (error) {
                logError('No se pudo enfocar la búsqueda', error);
            }
            return GLib.SOURCE_REMOVE;
        });
        return true;
    } catch (error) {
        logError('No se pudo abrir la vista general', error);
        return false;
    }
}

export function openTerminal(workingDirectory = null) {
    if (workingDirectory && findProgram('ptyxis'))
        return spawn(['ptyxis', '--new-window', '-d', workingDirectory]);

    const app = activateApp([
        'org.gnome.Ptyxis.desktop',
        'org.gnome.Console.desktop',
        'org.gnome.Terminal.desktop',
    ]);

    if (app)
        return true;

    if (findProgram('ptyxis')) {
        const argv = ['ptyxis', '--new-window'];
        if (workingDirectory)
            argv.push('-d', workingDirectory);
        return spawn(argv);
    }

    if (findProgram('kgx'))
        return spawn(['kgx']);

    if (findProgram('gnome-terminal')) {
        if (workingDirectory)
            return spawn(['gnome-terminal', `--working-directory=${workingDirectory}`]);
        return spawn(['gnome-terminal']);
    }

    if (findProgram('xterm'))
        return spawn(['xterm']);

    return false;
}

export function getUserSpecialDir(kind) {
    try {
        return GLib.get_user_special_dir(kind);
    } catch {
        return null;
    }
}

export function openUserDir(kind) {
    const path = getUserSpecialDir(kind);
    if (!path)
        return false;
    return launchPath(path);
}

export function openHome() {
    return launchPath(GLib.get_home_dir());
}

/* ------------------------------------------------------------------ */
/* Ventanas                                                           */
/* ------------------------------------------------------------------ */

export function windowCanMinimize(win) {
    try {
        return win.can_minimize();
    } catch {
        return false;
    }
}

export function minimizeWindow(win) {
    try {
        win.minimize();
    } catch (error) {
        logError('No se pudo minimizar la ventana', error);
    }
}

export function toggleMaximize(win) {
    try {
        if (win.is_maximized())
            win.unmaximize(Meta.MaximizeFlags.BOTH);
        else
            win.maximize(Meta.MaximizeFlags.BOTH);
    } catch (error) {
        logError('No se pudo maximizar la ventana', error);
    }
}

export function toggleFullscreen(win) {
    try {
        if (win.is_fullscreen())
            win.unmake_fullscreen();
        else
            win.make_fullscreen();
    } catch (error) {
        logError('No se pudo cambiar la pantalla completa', error);
    }
}

export function toggleAbove(win) {
    try {
        if (win.is_above())
            win.unmake_above();
        else
            win.make_above();
    } catch (error) {
        logError('No se pudo cambiar «Siempre encima»', error);
    }
}

export function moveWindowToHalf(win, side) {
    try {
        const monitorIndex = win.get_monitor();
        const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        if (!area)
            return;

        const width = Math.floor(area.width / 2);
        const height = area.height;
        const x = side === 'right' ? area.x + area.width - width : area.x;

        if (win.is_maximized())
            win.unmaximize(Meta.MaximizeFlags.BOTH);

        win.move_resize_frame(true, x, area.y, width, height);
    } catch (error) {
        logError('No se pudo mover la ventana a la mitad', error);
    }
}

export function workspaceWindows(workspace = null) {
    try {
        const ws = workspace ??
            global.workspace_manager.get_active_workspace();
        return ws ? ws.list_windows() : [];
    } catch {
        return [];
    }
}

function isRealWindow(win) {
    try {
        if (!win || win.is_skip_taskbar())
            return false;
        const type = win.get_window_type();
        return type !== Meta.WindowType.DESKTOP &&
            type !== Meta.WindowType.DOCK &&
            type !== Meta.WindowType.SPLASHSCREEN;
    } catch {
        return false;
    }
}

export function appWindows(app) {
    if (!app)
        return [];

    try {
        return app.get_windows().filter(win => isRealWindow(win));
    } catch (error) {
        logError('No se pudieron listar las ventanas de la app', error);
        return [];
    }
}

export function hideApp(app) {
    for (const win of appWindows(app)) {
        try {
            if (windowCanMinimize(win))
                win.minimize();
        } catch (error) {
            logError('No se pudo ocultar una ventana', error);
        }
    }
}

export function showAllWindows() {
    for (const win of workspaceWindows()) {
        if (!isRealWindow(win))
            continue;
        try {
            if (win.minimized)
                win.unminimize();
        } catch {
            // Ventana destruida.
        }
    }
}

export function hideOtherApps(app) {
    for (const win of workspaceWindows()) {
        if (!isRealWindow(win))
            continue;
        try {
            if (app && app.get_windows().includes(win))
                continue;
            if (windowCanMinimize(win))
                win.minimize();
        } catch {
            // Ventana ajena a la aplicación o ya destruida.
        }
    }
}

export function bringAppToFront(app) {
    const windows = appWindows(app);
    windows.sort((a, b) => {
        try {
            return b.get_user_time() - a.get_user_time();
        } catch {
            return 0;
        }
    });

    for (const win of windows) {
        try {
            if (win.minimized)
                win.unminimize();
            Main.activateWindow(win);
        } catch (error) {
            logError('No se pudo activar una ventana', error);
        }
    }
}

export function bringEverythingToFront() {
    for (const win of workspaceWindows()) {
        if (!isRealWindow(win))
            continue;
        try {
            if (win.minimized)
                win.unminimize();
        } catch {
            // Ventana destruida.
        }
    }
}

export function activateWindow(win) {
    if (!win)
        return;
    try {
        if (win.minimized)
            win.unminimize();
        Main.activateWindow(win);
    } catch (error) {
        logError('No se pudo activar la ventana', error);
    }
}
