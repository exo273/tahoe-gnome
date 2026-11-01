// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Perfiles de menús por aplicación.
//
// Cada perfil describe los menús con nombres «reales» al estilo macOS. Los
// ítems son prototipos que menuBar.js resuelve contra las acciones D-Bus
// disponibles en cada momento:
//
//   {label, keys:'<Control>n'}        → teclas sintetizadas (si no hay acción)
//   {label, gaction:'app.preferences'} → acción GTK por D-Bus
//   {label, window:'minimize'|'zoom'|'left'|'right'|'fullscreen'|'above'}
//   {label, app:'quit'|'new-window'|'hide'|'hide-others'|'show-all'}
//   {label, uri:'trash:///'}
//   {label, spawn:['nautilus','--new-window']}
//   {label, run: () => { ... }}
//   {sep: true}
//   {label, submenu: [ ... ]}
//
// Los perfiles NO incluyen el menú de la aplicación (el nombre en negrita):
// lo construye menuBar.js para que Acerca de / Ajustes / Ocultar / Salir
// funcionen igual en todas las aplicaciones.

'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    launchPath,
    openTerminal,
    showOverviewSearch,
    spawn,
} from './actions.js';

const SEP = {sep: true};

function item(label, extra = {}) {
    return {label, ...extra};
}

/** Menú «Ventana» mínimo que menuBar.js completa con estado real de Meta. */
function windowMenu(extra = []) {
    return {
        key: 'window',
        title: 'Ventana',
        items: [
            item('Minimizar', {window: 'minimize', keys: '<Super>m'}),
            item('Zoom', {window: 'zoom'}),
            SEP,
            ...extra,
        ],
    };
}

const HELP_FIREFOX = {
    key: 'help',
    title: 'Ayuda',
    items: [
        item('Ayuda de Firefox', {
            keys: 'F1',
            uri: 'https://support.mozilla.org/es/products/firefox',
        }),
        item('Atajos de teclado', {
            uri: 'https://support.mozilla.org/es/kb/atajos-de-teclado-firefox',
        }),
    ],
};

const APP_PROFILES = {
    'org.mozilla.firefox.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Nueva ventana', {keys: '<Control>n'}),
                    item('Nueva ventana privada', {keys: '<Control><Shift>p'}),
                    item('Nueva pestaña', {keys: '<Control>t'}),
                    SEP,
                    item('Abrir ubicación…', {keys: '<Control>l'}),
                    item('Guardar página como…', {keys: '<Control>s'}),
                    item('Imprimir…', {keys: '<Control>p'}),
                    SEP,
                    item('Cerrar pestaña', {keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Deshacer', {keys: '<Control>z'}),
                    item('Rehacer', {keys: '<Control><Shift>z'}),
                    SEP,
                    item('Cortar', {keys: '<Control>x'}),
                    item('Copiar', {keys: '<Control>c'}),
                    item('Pegar', {keys: '<Control>v'}),
                    item('Seleccionar todo', {keys: '<Control>a'}),
                    SEP,
                    item('Buscar en esta página…', {keys: '<Control>f'}),
                    item('Buscar de nuevo', {keys: '<Control>g'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Recargar', {keys: '<Control>r'}),
                    item('Forzar recarga', {keys: '<Control><Shift>r'}),
                    SEP,
                    item('Ampliar', {keys: '<Control>plus'}),
                    item('Reducir', {keys: '<Control>minus'}),
                    item('Tamaño normal', {keys: '<Control>0'}),
                    SEP,
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            {
                key: 'history',
                title: 'Historial',
                items: [
                    item('Atrás', {keys: '<Alt>Left'}),
                    item('Adelante', {keys: '<Alt>Right'}),
                    item('Inicio', {keys: '<Alt>Home'}),
                    SEP,
                    item('Mostrar historial', {keys: '<Control>h'}),
                    item('Borrar historial reciente…',
                        {keys: '<Control><Shift>Delete'}),
                ],
            },
            {
                key: 'bookmarks',
                title: 'Marcadores',
                items: [
                    item('Añadir a marcadores', {keys: '<Control>d'}),
                    item('Mostrar todos los marcadores',
                        {keys: '<Control><Shift>o'}),
                    item('Mostrar barra de marcadores',
                        {keys: '<Control><Shift>b'}),
                ],
            },
            {
                key: 'tools',
                title: 'Herramientas',
                items: [
                    item('Descargas', {keys: '<Control>j'}),
                    item('Complementos y temas',
                        {keys: '<Control><Shift>a'}),
                    SEP,
                    item('Preferencias', {
                        gaction: 'app.preferences',
                        keys: '<Control>comma',
                    }),
                    item('Información de solución de problemas',
                        {uri: 'about:support'}),
                ],
            },
            windowMenu(),
            HELP_FIREFOX,
        ],
    },

    'org.gnome.Ptyxis.desktop': {
        menus: [
            {
                key: 'shell',
                title: 'Shell',
                items: [
                    item('Nueva ventana', {keys: '<Control><Shift>n'}),
                    item('Nueva pestaña', {keys: '<Control><Shift>t'}),
                    SEP,
                    item('Copiar', {keys: '<Control><Shift>c'}),
                    item('Pegar', {keys: '<Control><Shift>v'}),
                    item('Seleccionar todo', {keys: '<Control><Shift>a'}),
                    SEP,
                    item('Buscar…', {keys: '<Control><Shift>f'}),
                    item('Preferencias', {
                        gaction: 'app.preferences',
                        keys: '<Control>comma',
                    }),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Deshacer', {keys: '<Control>z'}),
                    item('Rehacer', {keys: '<Control><Shift>z'}),
                    SEP,
                    item('Copiar', {keys: '<Control><Shift>c'}),
                    item('Pegar', {keys: '<Control><Shift>v'}),
                    item('Seleccionar todo', {keys: '<Control><Shift>a'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Ampliar', {keys: '<Control>plus'}),
                    item('Reducir', {keys: '<Control>minus'}),
                    item('Tamaño normal', {keys: '<Control>0'}),
                    SEP,
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda de Ptyxis', {
                        uri: 'https://help.gnome.org/users/ptyxis/stable/',
                    }),
                    item('Atajos de teclado', {
                        uri: 'https://help.gnome.org/users/ptyxis/stable/shortcuts.html',
                    }),
                ],
            },
        ],
    },

    'org.gnome.Nautilus.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Nueva ventana', {keys: '<Control>n'}),
                    item('Nueva pestaña', {keys: '<Control>t'}),
                    SEP,
                    item('Nueva carpeta', {keys: '<Control><Shift>n'}),
                    SEP,
                    item('Cerrar', {keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Deshacer', {keys: '<Control>z'}),
                    item('Rehacer', {keys: '<Control><Shift>z'}),
                    SEP,
                    item('Cortar', {keys: '<Control>x'}),
                    item('Copiar', {keys: '<Control>c'}),
                    item('Pegar', {keys: '<Control>v'}),
                    item('Seleccionar todo', {keys: '<Control>a'}),
                    item('Renombrar', {keys: 'F2'}),
                    SEP,
                    item('Preferencias', {gaction: 'app.preferences'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Recargar', {keys: '<Control>r'}),
                    SEP,
                    item('Mostrar barra lateral', {keys: 'F9'}),
                    item('Ampliar', {keys: '<Control>plus'}),
                    item('Reducir', {keys: '<Control>minus'}),
                    item('Tamaño normal', {keys: '<Control>0'}),
                    SEP,
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            {
                key: 'go',
                title: 'Ir',
                items: [
                    item('Atrás', {keys: '<Alt>Left'}),
                    item('Adelante', {keys: '<Alt>Right'}),
                    SEP,
                    item('Inicio', {keys: '<Alt>Home'}),
                    item('Papelera', {uri: 'trash:///'}),
                    item('Red', {uri: 'network:///'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda de Archivos', {
                        uri: 'https://help.gnome.org/users/nautilus/stable/',
                    }),
                    item('Atajos de teclado', {
                        uri: 'https://help.gnome.org/users/nautilus/stable/shortcuts.html',
                    }),
                ],
            },
        ],
    },

    'org.gnome.TextEditor.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Nueva ventana', {gaction: 'app.new-window', keys: '<Control>n'}),
                    item('Nueva pestaña', {keys: '<Control>t'}),
                    SEP,
                    item('Abrir…', {gaction: 'app.open', keys: '<Control>o'}),
                    item('Guardar', {gaction: 'win.save', keys: '<Control>s'}),
                    item('Guardar como…', {gaction: 'win.save-as', keys: '<Control><Shift>s'}),
                    SEP,
                    item('Cerrar', {gaction: 'win.close', keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Deshacer', {gaction: 'win.undo', keys: '<Control>z'}),
                    item('Rehacer', {gaction: 'win.redo', keys: '<Control><Shift>z'}),
                    SEP,
                    item('Cortar', {gaction: 'win.cut', keys: '<Control>x'}),
                    item('Copiar', {gaction: 'win.copy', keys: '<Control>c'}),
                    item('Pegar', {gaction: 'win.paste', keys: '<Control>v'}),
                    item('Seleccionar todo', {gaction: 'win.select-all', keys: '<Control>a'}),
                    SEP,
                    item('Buscar…', {gaction: 'win.find', keys: '<Control>f'}),
                    item('Reemplazar…', {gaction: 'win.replace', keys: '<Control>h'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Barra lateral', {gaction: 'win.show-sidebar', keys: 'F9'}),
                    SEP,
                    item('Ampliar', {keys: '<Control>plus'}),
                    item('Reducir', {keys: '<Control>minus'}),
                    item('Tamaño normal', {keys: '<Control>0'}),
                    SEP,
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda del Editor de textos', {
                        uri: 'https://help.gnome.org/users/gnome-text-editor/stable/',
                    }),
                    item('Atajos de teclado', {gaction: 'app.shortcuts'}),
                ],
            },
        ],
    },

    'org.gnome.Loupe.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Abrir…', {gaction: 'app.open', keys: '<Control>o'}),
                    SEP,
                    item('Cerrar', {gaction: 'win.close', keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Copiar', {gaction: 'win.copy', keys: '<Control>c'}),
                    item('Seleccionar todo', {gaction: 'win.select-all', keys: '<Control>a'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Ampliar', {keys: '<Control>plus'}),
                    item('Reducir', {keys: '<Control>minus'}),
                    item('Tamaño normal', {keys: '<Control>0'}),
                    SEP,
                    item('Girar a la izquierda', {keys: '<Control><Shift>r'}),
                    item('Girar a la derecha', {keys: '<Control>r'}),
                    SEP,
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda del Visor de imágenes', {
                        uri: 'https://help.gnome.org/users/loupe/stable/',
                    }),
                ],
            },
        ],
    },

    'org.gnome.Papers.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Abrir…', {gaction: 'app.open', keys: '<Control>o'}),
                    item('Guardar una copia…', {gaction: 'win.save-a-copy'}),
                    item('Imprimir…', {gaction: 'win.print', keys: '<Control>p'}),
                    SEP,
                    item('Cerrar', {gaction: 'win.close', keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Copiar', {gaction: 'win.copy', keys: '<Control>c'}),
                    item('Seleccionar todo', {gaction: 'win.select-all', keys: '<Control>a'}),
                    SEP,
                    item('Buscar…', {keys: '<Control>f'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Ampliar', {keys: '<Control>plus'}),
                    item('Reducir', {keys: '<Control>minus'}),
                    item('Tamaño normal', {keys: '<Control>0'}),
                    SEP,
                    item('Página siguiente', {keys: 'Page_Down'}),
                    item('Página anterior', {keys: 'Page_Up'}),
                    SEP,
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda del Visor de documentos', {
                        uri: 'https://help.gnome.org/users/papers/stable/',
                    }),
                ],
            },
        ],
    },

    'org.gnome.Calculator.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Cerrar', {gaction: 'win.close', keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Deshacer', {keys: '<Control>z'}),
                    item('Rehacer', {keys: '<Control><Shift>z'}),
                    SEP,
                    item('Cortar', {keys: '<Control>x'}),
                    item('Copiar', {keys: '<Control>c'}),
                    item('Pegar', {keys: '<Control>v'}),
                    item('Seleccionar todo', {keys: '<Control>a'}),
                    SEP,
                    item('Borrar', {keys: '<Control>BackSpace'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Modo básico', {gaction: 'app.mode-basic'}),
                    item('Modo avanzado', {gaction: 'app.mode-advanced'}),
                    item('Modo financiero', {gaction: 'app.mode-financial'}),
                    item('Modo programador', {gaction: 'app.mode-programmer'}),
                    SEP,
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda de Calculadora', {
                        uri: 'https://help.gnome.org/users/gnome-calculator/stable/',
                    }),
                    item('Atajos de teclado', {gaction: 'app.shortcuts'}),
                ],
            },
        ],
    },

    'org.gnome.Settings.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Cerrar', {gaction: 'win.close', keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Buscar…', {keys: '<Control>f'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda de Ajustes de GNOME', {
                        uri: 'https://help.gnome.org/users/gnome-help/stable/',
                    }),
                ],
            },
        ],
    },

    'org.gnome.Software.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Cerrar', {gaction: 'win.close', keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Buscar…', {keys: '<Control>f'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Instalado', {gaction: 'app.show-installed'}),
                    item('Actualizaciones', {gaction: 'app.show-updates'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda de Software', {
                        uri: 'https://help.gnome.org/users/gnome-software/stable/',
                    }),
                ],
            },
        ],
    },

    'io.missioncenter.MissionCenter.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Cerrar', {gaction: 'win.close', keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Copiar', {keys: '<Control>c'}),
                    item('Seleccionar todo', {keys: '<Control>a'}),
                    SEP,
                    item('Buscar…', {keys: '<Control>f'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda de Mission Center', {
                        uri: 'https://missioncenter.io/docs/',
                    }),
                ],
            },
        ],
    },

    'org.onlyoffice.desktopeditors.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Nuevo documento', {keys: '<Control>n'}),
                    item('Abrir…', {keys: '<Control>o'}),
                    item('Guardar', {keys: '<Control>s'}),
                    item('Guardar como…', {keys: '<Control><Shift>s'}),
                    SEP,
                    item('Imprimir…', {keys: '<Control>p'}),
                    SEP,
                    item('Cerrar', {keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Deshacer', {keys: '<Control>z'}),
                    item('Rehacer', {keys: '<Control><Shift>z'}),
                    SEP,
                    item('Cortar', {keys: '<Control>x'}),
                    item('Copiar', {keys: '<Control>c'}),
                    item('Pegar', {keys: '<Control>v'}),
                    item('Seleccionar todo', {keys: '<Control>a'}),
                    SEP,
                    item('Buscar…', {keys: '<Control>f'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Ampliar', {keys: '<Control>plus'}),
                    item('Reducir', {keys: '<Control>minus'}),
                    item('Tamaño normal', {keys: '<Control>0'}),
                    SEP,
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Ayuda de ONLYOFFICE', {
                        uri: 'https://helpcenter.onlyoffice.com/es/',
                    }),
                ],
            },
        ],
    },

    'ai.opencode.desktop.desktop': {
        menus: [
            {
                key: 'file',
                title: 'Archivo',
                items: [
                    item('Nueva ventana', {app: 'new-window', keys: '<Control><Shift>n'}),
                    item('Abrir carpeta…', {keys: '<Control>o'}),
                    SEP,
                    item('Cerrar ventana', {window: 'close', keys: '<Control>w'}),
                ],
            },
            {
                key: 'edit',
                title: 'Edición',
                items: [
                    item('Deshacer', {keys: '<Control>z'}),
                    item('Rehacer', {keys: '<Control><Shift>z'}),
                    SEP,
                    item('Cortar', {keys: '<Control>x'}),
                    item('Copiar', {keys: '<Control>c'}),
                    item('Pegar', {keys: '<Control>v'}),
                    item('Seleccionar todo', {keys: '<Control>a'}),
                    SEP,
                    item('Buscar…', {keys: '<Control>f'}),
                ],
            },
            {
                key: 'view',
                title: 'Visualización',
                items: [
                    item('Recargar', {keys: '<Control>r'}),
                    SEP,
                    item('Ampliar', {keys: '<Control>plus'}),
                    item('Reducir', {keys: '<Control>minus'}),
                    item('Tamaño normal', {keys: '<Control>0'}),
                    SEP,
                    item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
                ],
            },
            windowMenu(),
            {
                key: 'help',
                title: 'Ayuda',
                items: [
                    item('Documentación de OpenCode', {
                        uri: 'https://opencode.ai/docs/',
                    }),
                ],
            },
        ],
    },
};

export function getProfile(appId) {
    if (!appId)
        return null;
    return APP_PROFILES[appId] ?? null;
}

export function hasProfile(appId) {
    return Boolean(appId && APP_PROFILES[appId]);
}

/* ------------------------------------------------------------------ */
/* Menús genéricos (cualquier app, incluidas Electron/Qt/XWayland)     */
/* ------------------------------------------------------------------ */

export function buildGenericMenus(ctx) {
    const appName = ctx?.appName ?? 'la aplicación';
    const hasWindow = Boolean(ctx?.win);

    const fileItems = [];

    if (ctx?.app?.can_open_new_window?.()) {
        fileItems.push(item('Nueva ventana', {app: 'new-window', keys: '<Control>n'}));
        fileItems.push(item('Nueva pestaña', {keys: '<Control>t'}));
    }

    if (hasWindow) {
        if (fileItems.length)
            fileItems.push(SEP);
        fileItems.push(item('Cerrar ventana', {window: 'close', keys: '<Control>w'}));
    }

    return [
        {
            key: 'file',
            title: 'Archivo',
            items: fileItems,
        },
        {
            key: 'edit',
            title: 'Edición',
            items: [
                item('Deshacer', {keys: '<Control>z'}),
                item('Rehacer', {keys: '<Control><Shift>z'}),
                SEP,
                item('Cortar', {keys: '<Control>x'}),
                item('Copiar', {keys: '<Control>c'}),
                item('Pegar', {keys: '<Control>v'}),
                item('Seleccionar todo', {keys: '<Control>a'}),
                SEP,
                item('Buscar…', {keys: '<Control>f'}),
            ],
        },
        {
            key: 'view',
            title: 'Visualización',
            items: [
                item('Recargar', {keys: '<Control>r'}),
                SEP,
                item('Ampliar', {keys: '<Control>plus'}),
                item('Reducir', {keys: '<Control>minus'}),
                item('Tamaño normal', {keys: '<Control>0'}),
                SEP,
                item('Pantalla completa', {window: 'fullscreen', keys: 'F11'}),
            ],
        },
        windowMenu(),
        {
            key: 'help',
            title: 'Ayuda',
            items: [
                item(`Ayuda de ${appName}`, {gaction: 'app.help', keys: 'F1'}),
            ],
        },
    ];
}

/* ------------------------------------------------------------------ */
/* Escritorio (modo «Finder»)                                          */
/* ------------------------------------------------------------------ */

function desktopDirectory() {
    try {
        const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        if (dir)
            return dir;
    } catch {
        // Se usa ~/Escritorio.
    }
    return GLib.build_filenamev([GLib.get_home_dir(), 'Escritorio']);
}

function createUntitledFolder() {
    const base = desktopDirectory();
    const name = 'Carpeta sin título';

    for (let i = 1; i <= 99; i++) {
        const candidate = i === 1 ? name : `${name} ${i}`;
        const path = GLib.build_filenamev([base, candidate]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            continue;

        try {
            const file = Gio.File.new_for_path(path);
            if (file.make_directory(null)) {
                console.log(`[tahoe-topbar/menubar] Carpeta creada: ${path}`);
                return true;
            }
        } catch (error) {
            console.error(`[tahoe-topbar/menubar] No se pudo crear ${path}: ${error.message}`);
            return false;
        }
    }

    return false;
}

function specialDirectoryItem(label, kind) {
    const path = (() => {
        try {
            return GLib.get_user_special_dir(kind);
        } catch {
            return null;
        }
    })();

    // Si el directorio no existe (p. ej. Música desactivada) se omite.
    if (!path || !GLib.file_test(path, GLib.FileTest.IS_DIR))
        return null;

    return item(label, {
        run: () => launchPath(path),
    });
}

function optionalItems(list) {
    return list.filter(Boolean);
}

export function buildFinderMenus() {
    const home = GLib.get_home_dir();
    const desktop = desktopDirectory();

    return [
        {
            key: 'file',
            title: 'Archivo',
            items: [
                item('Nueva ventana de Archivos', {
                    spawn: ['nautilus', '--new-window'],
                    keys: '<Control>n',
                }),
                item('Nueva carpeta', {
                    run: createUntitledFolder,
                    keys: '<Control><Shift>n',
                }),
                SEP,
                item('Abrir terminal aquí', {
                    run: () => openTerminal(desktop),
                }),
                item('Buscar', {
                    run: showOverviewSearch,
                    keys: '<Control>f',
                }),
            ],
        },
        {
            key: 'edit',
            title: 'Edición',
            items: [
                item('Deshacer', {keys: '<Control>z', desktopDisabled: true}),
                item('Rehacer', {keys: '<Control><Shift>z', desktopDisabled: true}),
                SEP,
                item('Cortar', {keys: '<Control>x', desktopDisabled: true}),
                item('Copiar', {keys: '<Control>c', desktopDisabled: true}),
                item('Pegar', {keys: '<Control>v', desktopDisabled: true}),
                item('Seleccionar todo', {keys: '<Control>a', desktopDisabled: true}),
            ],
        },
        {
            key: 'view',
            title: 'Visualización',
            items: [
                item('Mostrar vista general de ventanas', {
                    run: () => {
                        if (Main.overview.visible)
                            Main.overview.hide();
                        else
                            Main.overview.show();
                    },
                }),
                item('Mostrar aplicaciones', {
                    run: () => Main.overview.showApps(),
                }),
                SEP,
                item('Cambiar fondo de escritorio…', {
                    spawn: ['gnome-control-center', 'background'],
                }),
            ],
        },
        {
            key: 'go',
            title: 'Ir',
            items: [
                item('Atrás', {keys: '<Alt>Left', desktopDisabled: true}),
                item('Adelante', {keys: '<Alt>Right', desktopDisabled: true}),
                SEP,
                item('Inicio', {run: () => launchPath(home), keys: '<Control><Shift>h'}),
                ...optionalItems([
                    specialDirectoryItem('Escritorio',
                        GLib.UserDirectory.DIRECTORY_DESKTOP),
                    specialDirectoryItem('Documentos',
                        GLib.UserDirectory.DIRECTORY_DOCUMENTS),
                    specialDirectoryItem('Descargas',
                        GLib.UserDirectory.DIRECTORY_DOWNLOAD),
                    specialDirectoryItem('Imágenes',
                        GLib.UserDirectory.DIRECTORY_PICTURES),
                    specialDirectoryItem('Música',
                        GLib.UserDirectory.DIRECTORY_MUSIC),
                    specialDirectoryItem('Vídeos',
                        GLib.UserDirectory.DIRECTORY_VIDEOS),
                ]),
                SEP,
                item('Papelera', {uri: 'trash:///'}),
                item('Red', {uri: 'network:///'}),
                item('Otras ubicaciones', {uri: 'other-locations:///'}),
                SEP,
                item('Ir a la carpeta…', {
                    run: () => spawn(['nautilus', home]),
                    keys: '<Control><Shift>g',
                }),
            ],
        },
        {
            key: 'window',
            title: 'Ventana',
            items: [
                item('Minimizar', {
                    app: 'minimize-desktop',
                    keys: '<Super>m',
                    desktopDisabled: true,
                }),
                SEP,
                item('Traer todo al frente', {
                    app: 'bring-all-front',
                }),
            ],
        },
        {
            key: 'help',
            title: 'Ayuda',
            items: [
                item('Ayuda de Fedora', {
                    uri: 'https://docs.fedoraproject.org/es/',
                }),
                item('Ayuda de GNOME', {
                    spawn: ['yelp'],
                }),
            ],
        },
    ];
}

/* Items dinámicos para el menú de la app en modo escritorio. */
export function buildFinderAppMenuItems(ctx) {
    const items = [];
    const nautilusActions = ctx?.nautilusActions;

    if (nautilusActions?.has('about')) {
        items.push(item('Acerca de Archivos', {gaction: 'nautilus.about'}));
    } else {
        items.push(item('Acerca de Archivos', {
            run: () => {
                // Sin acción «about»: basta con traer Archivos al frente.
                const app = ShellApp('org.gnome.Nautilus.desktop');
                if (app)
                    app.activate();
            },
        }));
    }

    if (nautilusActions?.has('preferences')) {
        items.push(item('Ajustes…', {
            gaction: 'nautilus.preferences',
            keys: '<Control>comma',
        }));
    } else {
        items.push(item('Ajustes…', {
            run: () => activateNautilusAction('preferences'),
            keys: '<Control>comma',
        }));
    }

    items.push(SEP);
    items.push(item('Vaciar papelera…', {uri: 'trash:///'}));
    items.push(SEP);
    items.push(item('Ocultar otras', {app: 'hide-others'}));
    items.push(item('Mostrar todo', {app: 'show-all'}));

    return items;
}

function ShellApp(id) {
    try {
        return Shell.AppSystem.get_default().lookup_app(id);
    } catch {
        return null;
    }
}

function activateNautilusAction(name) {
    try {
        const group = Gio.DBusActionGroup.get(
            Gio.DBus.session, 'org.gnome.Nautilus', '/org/gnome/Nautilus');
        group.activate_action(name, null);
        return true;
    } catch (error) {
        console.error(`[tahoe-topbar/menubar] Acción de Nautilus ${name}: ${error.message}`);
        return false;
    }
}
