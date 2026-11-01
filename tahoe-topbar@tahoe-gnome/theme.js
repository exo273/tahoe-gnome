// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Tema único de Tahoe Top Bar.
//
// TahoeTheme centraliza todo lo que depende del esquema de color del sistema:
//
//   * publica las clases globales .tahoe-theme-light / .tahoe-theme-dark y
//     .tahoe-accent-<nombre> en Main.uiGroup, de modo que todo el chrome
//     (panel, menús, boxpointers, Centro de control y ventana «Acerca de»)
//     se pueda estilizar con selectores descendientes desde el CSS;
//   * avisa a los módulos que necesitan repintar algo dibujado con Cairo;
//   * opcionalmente sincroniza el tema de GNOME Shell, el tema GTK y el
//     enlace ~/.config/gtk-4.0/gtk.css cuando cambia el modo.
//
// Es un singleton de facto: extension.js crea una instancia en enable() y la
// destruye en disable(). Los demás módulos la reciben como extension._theme.

'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LOG = '[tahoe-topbar/theme]';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';
const USER_THEME_SCHEMA = 'org.gnome.shell.extensions.user-theme';

const THEME_CLASSES = ['tahoe-theme-light', 'tahoe-theme-dark'];
const ACCENT_CLASSES = [
    'tahoe-accent-blue',
    'tahoe-accent-teal',
    'tahoe-accent-green',
    'tahoe-accent-yellow',
    'tahoe-accent-orange',
    'tahoe-accent-red',
    'tahoe-accent-pink',
    'tahoe-accent-purple',
    'tahoe-accent-slate',
];

// Colores de acento al estilo Apple: [claro, oscuro].
const ACCENT_COLORS = {
    blue: ['#0a84ff', '#0a84ff'],
    teal: ['#30b0c7', '#40c8e0'],
    green: ['#34c759', '#30d158'],
    yellow: ['#ffcc00', '#ffd60a'],
    orange: ['#ff9500', '#ff9f0a'],
    red: ['#ff3b30', '#ff453a'],
    pink: ['#ff2d55', '#ff375f'],
    purple: ['#af52de', '#bf5af2'],
    slate: ['#8e8e93', '#8e8e93'],
};

const ACCENT_NAMES = Object.keys(ACCENT_COLORS);

function lookupSchema(id) {
    if (!id)
        return null;

    try {
        const source = Gio.SettingsSchemaSource.get_default();
        return source?.lookup(id, true) ?? null;
    } catch (e) {
        console.error(`${LOG} No se pudo buscar el esquema ${id}:`, e);
        return null;
    }
}

function newSettings(id) {
    const schema = lookupSchema(id);
    if (!schema)
        return null;

    try {
        return new Gio.Settings({settings_schema: schema});
    } catch (e) {
        console.error(`${LOG} No se pudo crear Gio.Settings para ${id}:`, e);
        return null;
    }
}

function hasKey(settings, key) {
    try {
        return Boolean(settings?.settings_schema?.has_key(key));
    } catch (_e) {
        return false;
    }
}

function themeExists(name) {
    if (!name)
        return false;

    const candidates = [
        GLib.build_filenamev([GLib.get_home_dir(), '.themes', name]),
        GLib.build_filenamev(['/usr/share/themes', name]),
    ];

    return candidates.some(path =>
        GLib.file_test(path, GLib.FileTest.IS_DIR));
}

/**
 * Devuelve el nombre MacTahoe correspondiente al modo conservando los
 * sufijos de variante del nombre actual (-solid, -hdpi, -solid-hdpi…).
 *
 * @param {string} name
 * @param {'Light'|'Dark'} mode
 */
function macTahoeName(name, mode) {
    let suffix = '';
    const match = /^(.*?)((?:-(?:solid|hdpi|xhdpi|xxhdpi))+)$/.exec(name ?? '');
    if (match)
        suffix = match[2];

    return `MacTahoe-${mode}${suffix}`;
}

export class TahoeTheme {
    /**
     * @param {object} extension instancia de Extension (getSettings(), path)
     */
    constructor(extension) {
        this._extension = extension ?? null;
        this._destroyed = false;

        this._callbacks = new Map();
        this._nextCallbackId = 1;
        this._signalIds = [];

        this._interfaceSettings = newSettings(INTERFACE_SCHEMA);
        this._extensionSettings = null;
        this._userThemeSettings = null;

        try {
            this._extensionSettings = this._extension?.getSettings?.() ?? null;
        } catch (e) {
            console.error(`${LOG} No se pudieron leer los ajustes de la extensión:`, e);
            this._extensionSettings = null;
        }

        this.scheme = this._readScheme();
        this.isDark = this.scheme === 'prefer-dark';
        this.accentName = this._readAccentName();
        this.accentColor = this._accentColor();

        this._applyClasses();
        this._connectSettings();
    }

    /* ------------------------------------------------------------------ */
    /* Eventos                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Registra un callback invocado tras cada cambio de modo o acento.
     * @param {(theme: TahoeTheme) => void} callback
     * @returns {number} identificador para disconnect()
     */
    connect(callback) {
        if (typeof callback !== 'function')
            return 0;

        const id = this._nextCallbackId++;
        this._callbacks.set(id, callback);
        return id;
    }

    disconnect(id) {
        this._callbacks.delete(id);
    }

    _emit() {
        for (const callback of [...this._callbacks.values()]) {
            try {
                callback(this);
            } catch (e) {
                console.error(`${LOG} Error en un callback de tema:`, e);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Lectura de ajustes                                                  */
    /* ------------------------------------------------------------------ */

    _readScheme() {
        try {
            return this._interfaceSettings?.get_string('color-scheme') ?? 'default';
        } catch (_e) {
            return 'default';
        }
    }

    _readAccentName() {
        if (!hasKey(this._interfaceSettings, 'accent-color'))
            return 'blue';

        try {
            const value = this._interfaceSettings.get_string('accent-color');
            return ACCENT_NAMES.includes(value) ? value : 'blue';
        } catch (_e) {
            return 'blue';
        }
    }

    _accentColor() {
        const pair = ACCENT_COLORS[this.accentName] ?? ACCENT_COLORS.blue;
        return this.isDark ? pair[1] : pair[0];
    }

    _connectSettings() {
        if (!this._interfaceSettings)
            return;

        for (const key of ['color-scheme', 'accent-color']) {
            if (!hasKey(this._interfaceSettings, key))
                continue;

            try {
                const id = this._interfaceSettings.connect(
                    `changed::${key}`, () => this._onInterfaceChanged(key));
                this._signalIds.push([this._interfaceSettings, id]);
            } catch (e) {
                console.error(`${LOG} No se pudo seguir ${key}:`, e);
            }
        }
    }

    _onInterfaceChanged(key) {
        if (this._destroyed)
            return;

        if (key === 'color-scheme') {
            const scheme = this._readScheme();
            if (scheme === this.scheme)
                return;

            this.scheme = scheme;
            this.isDark = scheme === 'prefer-dark';
            this.accentColor = this._accentColor();
            this._applyClasses();
            this._syncExternalThemes();
        } else if (key === 'accent-color') {
            const accent = this._readAccentName();
            if (accent === this.accentName)
                return;

            this.accentName = accent;
            this.accentColor = this._accentColor();
            this._applyClasses();
        }

        this._emit();
    }

    /* ------------------------------------------------------------------ */
    /* Clases globales                                                     */
    /* ------------------------------------------------------------------ */

    _applyClasses() {
        if (this._destroyed)
            return;

        const group = Main.uiGroup;
        if (!group)
            return;

        try {
            for (const name of THEME_CLASSES)
                group.remove_style_class_name(name);
            for (const name of ACCENT_CLASSES)
                group.remove_style_class_name(name);

            group.add_style_class_name(this.isDark
                ? 'tahoe-theme-dark'
                : 'tahoe-theme-light');
            group.add_style_class_name(`tahoe-accent-${this.accentName}`);
        } catch (e) {
            console.error(`${LOG} No se pudieron aplicar las clases de tema:`, e);
        }
    }

    _removeClasses() {
        const group = Main.uiGroup;
        if (!group)
            return;

        try {
            for (const name of [...THEME_CLASSES, ...ACCENT_CLASSES])
                group.remove_style_class_name(name);
        } catch (e) {
            console.error(`${LOG} No se pudieron quitar las clases de tema:`, e);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Sincronización opcional con el tema de Shell y GTK                  */
    /* ------------------------------------------------------------------ */

    _syncEnabled() {
        if (!hasKey(this._extensionSettings, 'sync-shell-theme'))
            return false;

        try {
            return this._extensionSettings.get_boolean('sync-shell-theme');
        } catch (_e) {
            return false;
        }
    }

    _syncExternalThemes() {
        if (!this._syncEnabled())
            return;

        const mode = this.isDark ? 'Dark' : 'Light';
        this._syncUserTheme(mode);
        this._syncGtkTheme(mode);
        this._syncGtk4Css(mode);
    }

    _syncUserTheme(mode) {
        if (!hasKey(this._userThemeSettings, 'name'))
            this._userThemeSettings = newSettings(USER_THEME_SCHEMA);

        if (!hasKey(this._userThemeSettings, 'name'))
            return;

        try {
            const current = this._userThemeSettings.get_string('name');
            const target = macTahoeName(current, mode);

            if (current === target || !themeExists(target))
                return;

            this._userThemeSettings.set_string('name', target);
        } catch (e) {
            console.error(`${LOG} No se pudo sincronizar el tema de GNOME Shell:`, e);
        }
    }

    _syncGtkTheme(mode) {
        if (!hasKey(this._interfaceSettings, 'gtk-theme'))
            return;

        try {
            const current = this._interfaceSettings.get_string('gtk-theme');
            const target = macTahoeName(current, mode);

            if (current === target || !themeExists(target))
                return;

            this._interfaceSettings.set_string('gtk-theme', target);
        } catch (e) {
            console.error(`${LOG} No se pudo sincronizar el tema GTK:`, e);
        }
    }

    _syncGtk4Css(mode) {
        const dir = GLib.build_filenamev([
            GLib.get_home_dir(), '.config', 'gtk-4.0',
        ]);
        const linkPath = GLib.build_filenamev([dir, 'gtk.css']);
        const link = Gio.File.new_for_path(linkPath);

        let info;
        try {
            info = link.query_info(
                'standard::is-symlink,standard::symlink-target',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch (_e) {
            // No existe o no es un enlace: no se toca nada.
            return;
        }

        if (!info.get_is_symlink())
            return;

        const target = info.get_symlink_target();
        const base = GLib.path_get_basename(target);

        if (base !== 'gtk-Light.css' && base !== 'gtk-Dark.css')
            return;

        const targetPath = GLib.path_is_absolute(target)
            ? target
            : GLib.build_filenamev([dir, target]);

        // Sólo si el enlace apunta a un archivo del mismo directorio.
        if (GLib.path_get_dirname(targetPath) !== dir)
            return;

        const desiredName = `gtk-${mode}.css`;
        if (base === desiredName)
            return;

        const desiredPath = GLib.build_filenamev([dir, desiredName]);
        if (!GLib.file_test(desiredPath, GLib.FileTest.IS_REGULAR))
            return;

        try {
            link.delete(null);
            Gio.File.new_for_path(linkPath).make_symbolic_link(
                desiredName, null);
        } catch (e) {
            console.error(`${LOG} No se pudo actualizar gtk-4.0/gtk.css:`, e);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Destrucción                                                         */
    /* ------------------------------------------------------------------ */

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        for (const [object, id] of this._signalIds) {
            try {
                object.disconnect(id);
            } catch (_e) {
                // El objeto ya no existe.
            }
        }
        this._signalIds = [];

        this._callbacks.clear();
        this._removeClasses();

        this._interfaceSettings = null;
        this._extensionSettings = null;
        this._userThemeSettings = null;
        this._extension = null;
    }
}
