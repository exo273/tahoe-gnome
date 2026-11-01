// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Lectura de menús reales de aplicaciones GTK por D-Bus:
//   · org.gtk.Menus  → Gio.DBusMenuModel con la barra de menús exportada
//   · org.gtk.Actions → DescribeAll para saber qué acciones existen,
//                       si están habilitadas y su estado.
//
// También añade ítems conocidos (Nueva ventana, Deshacer, Buscar…) cuando la
// aplicación no exporta un menú real, para que los menús no queden vacíos.

'use strict';

import GLib from 'gi://GLib';

import {accelToGlyph, cleanLabel} from './actions.js';

/* ------------------------------------------------------------------ */
/* Utilidades de GMenuModel                                            */
/* ------------------------------------------------------------------ */

function getAttr(model, index, name) {
    try {
        return model.get_item_attribute_value(index, name, null);
    } catch {
        return null;
    }
}

function getAttrString(model, index, name) {
    const value = getAttr(model, index, name);
    if (!value)
        return null;

    try {
        return value.get_string()[0];
    } catch {
        return null;
    }
}

function getLink(model, index, name) {
    try {
        return model.get_item_link(index, name);
    } catch {
        return null;
    }
}

const SEPARATOR = {sep: true};

function trimSeparators(items) {
    const cleaned = [];
    for (const item of items) {
        if (item?.sep) {
            if (cleaned.length === 0 || cleaned[cleaned.length - 1]?.sep)
                continue;
            cleaned.push(item);
            continue;
        }
        cleaned.push(item);
    }

    while (cleaned.length && cleaned[cleaned.length - 1]?.sep)
        cleaned.pop();

    return cleaned;
}

/* ------------------------------------------------------------------ */
/* Acciones                                                            */
/* ------------------------------------------------------------------ */

function splitAction(actionPath) {
    const dot = actionPath.indexOf('.');
    if (dot < 0)
        return {prefix: 'app', name: actionPath};
    return {
        prefix: actionPath.slice(0, dot),
        name: actionPath.slice(dot + 1),
    };
}

function actionInfo(ctx, prefix, name) {
    const map = ctx?.actions?.[prefix];
    if (!map)
        return null;
    return map.get(name) ?? null;
}

function isActionEnabled(ctx, info) {
    // Sin información de D-Bus se asume habilitada para no romper menús.
    return info?.enabled ?? true;
}

function isStateChecked(info) {
    if (!info?.state)
        return false;

    try {
        if (info.state.is_of_type(new GLib.VariantType('b')))
            return info.state.get_boolean();
    } catch {
        // Estados no booleanos (radios, etc.) se ignoran.
    }

    return false;
}

/* ------------------------------------------------------------------ */
/* Lectura del modelo                                                  */
/* ------------------------------------------------------------------ */

function readItem(model, index, ctx, depth = 0) {
    if (depth > 6)
        return null;

    const label = getAttrString(model, index, 'label');
    const hiddenWhen = getAttrString(model, index, 'hidden-when') ?? '';
    const submenu = getLink(model, index, 'submenu');
    const section = getLink(model, index, 'section');
    const actionPath = getAttrString(model, index, 'action');
    const accel = getAttrString(model, index, 'accel');

    // Sección sin etiqueta: se aplana en el menú padre.
    if (!label && !submenu && section)
        return {sectionModel: section};

    if (submenu) {
        if (!label)
            return null;

        return {
            label: cleanLabel(label),
            submenu: readModel(submenu, ctx, depth + 1),
        };
    }

    if (!label && !actionPath)
        return null;

    if (!actionPath) {
        // Ítem sin acción: puede ser un encabezado de sección.
        if (label)
            return {label: cleanLabel(label), enabled: false, header: true};
        return null;
    }

    const {prefix, name} = splitAction(actionPath);
    const info = actionInfo(ctx, prefix, name);
    const enabled = isActionEnabled(ctx, info);

    if (hiddenWhen.includes('action-disabled') && !enabled)
        return null;
    if (hiddenWhen.includes('action-missing') && !info)
        return null;

    const targetValue = getAttr(model, index, 'target');

    return {
        label: cleanLabel(label ?? name),
        gaction: `${prefix}.${name}`,
        target: targetValue,
        enabled,
        checked: isStateChecked(info),
        gtkAccel: accel,
    };
}

function readModel(model, ctx, depth = 0) {
    if (!model || depth > 8)
        return [];

    const items = [];
    const count = model.get_n_items();

    for (let i = 0; i < count; i++) {
        const parsed = readItem(model, i, ctx, depth);

        if (!parsed)
            continue;

        if (parsed.sectionModel) {
            const sectionItems = readModel(parsed.sectionModel, ctx, depth + 1);
            if (sectionItems.length === 0)
                continue;
            if (items.length > 0)
                items.push(SEPARATOR);
            items.push(...sectionItems);
            continue;
        }

        if (parsed.submenu) {
            if (parsed.submenu.length === 0)
                continue;
            items.push(parsed);
            continue;
        }

        items.push(parsed);
    }

    return trimSeparators(items);
}

const TITLE_KEYS = {
    archivo: 'file',
    file: 'file',
    edicion: 'edit',
    editar: 'edit',
    edit: 'edit',
    visualizacion: 'view',
    ver: 'view',
    view: 'view',
    insertar: 'insert',
    insert: 'insert',
    formato: 'format',
    format: 'format',
    ir: 'go',
    go: 'go',
    historial: 'history',
    history: 'history',
    marcadores: 'bookmarks',
    bookmarks: 'bookmarks',
    herramientas: 'tools',
    tools: 'tools',
    ventana: 'window',
    window: 'window',
    ayuda: 'help',
    help: 'help',
};

export function menuKeyForTitle(title) {
    const normalized = `${title ?? ''}`
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

    return TITLE_KEYS[normalized] ??
        normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ??
        'menu';
}

/**
 * Convierte el modelo de barra de menús de una app GTK en la lista interna
 * de menús. Devuelve null si el modelo está vacío (aún no cargado o la app
 * no exporta nada útil).
 */
export function readMenubar(model, ctx) {
    if (!model || model.get_n_items() === 0)
        return null;

    const menus = [];

    const appendTopLevel = (source, depth = 0) => {
        if (!source || depth > 2)
            return;

        const count = source.get_n_items();
        for (let i = 0; i < count; i++) {
            const label = getAttrString(source, i, 'label');
            const submenu = getLink(source, i, 'submenu');
            const section = getLink(source, i, 'section');

            if (submenu && label) {
                const items = readModel(submenu, ctx);
                if (items.length === 0)
                    continue;

                menus.push({
                    key: menuKeyForTitle(label),
                    title: cleanLabel(label),
                    items,
                });
                continue;
            }

            // Algunos modelos envuelven la barra en una sección sin título.
            if (!label && section)
                appendTopLevel(section, depth + 1);
        }
    };

    appendTopLevel(model);

    return menus.length > 0 ? menus : null;
}

/* ------------------------------------------------------------------ */
/* Acciones conocidas                                                  */
/* ------------------------------------------------------------------ */

const KNOWN_ACTIONS = [
    {bucket: 'file', name: 'new-window', label: 'Nueva ventana', keys: '<Control>n', prefer: 'app'},
    {bucket: 'file', name: 'new-tab', label: 'Nueva pestaña', keys: '<Control>t', prefer: 'win'},
    {bucket: 'file', name: 'new', label: 'Nuevo', keys: '<Control>n', prefer: 'win'},
    {bucket: 'file', name: 'open', label: 'Abrir…', keys: '<Control>o', prefer: 'app'},
    {bucket: 'file', name: 'save', label: 'Guardar', keys: '<Control>s', prefer: 'win'},
    {bucket: 'file', name: 'save-as', label: 'Guardar como…', keys: '<Control><Shift>s', prefer: 'win'},
    {bucket: 'file', name: 'save-a-copy', label: 'Guardar una copia…', prefer: 'win'},
    {bucket: 'file', name: 'print', label: 'Imprimir…', keys: '<Control>p', prefer: 'win'},
    {bucket: 'file', name: 'close', label: 'Cerrar', keys: '<Control>w', prefer: 'win'},
    {bucket: 'file', name: 'close-all', label: 'Cerrar todo', keys: '<Control><Shift>w', prefer: 'win'},
    {bucket: 'file', name: 'close-tab', label: 'Cerrar pestaña', keys: '<Control>w', prefer: 'win'},

    {bucket: 'edit', name: 'undo', label: 'Deshacer', keys: '<Control>z', prefer: 'win'},
    {bucket: 'edit', name: 'redo', label: 'Rehacer', keys: '<Control><Shift>z', prefer: 'win'},
    {bucket: 'edit', name: 'cut', label: 'Cortar', keys: '<Control>x', prefer: 'win'},
    {bucket: 'edit', name: 'copy', label: 'Copiar', keys: '<Control>c', prefer: 'win'},
    {bucket: 'edit', name: 'paste', label: 'Pegar', keys: '<Control>v', prefer: 'win'},
    {bucket: 'edit', name: 'select-all', label: 'Seleccionar todo', keys: '<Control>a', prefer: 'win'},
    {bucket: 'edit', name: 'find', label: 'Buscar…', keys: '<Control>f', prefer: 'win'},
    {bucket: 'edit', name: 'search', label: 'Buscar…', keys: '<Control>f', prefer: 'win'},
    {bucket: 'edit', name: 'find-next', label: 'Buscar siguiente', keys: '<Control>g', prefer: 'win'},
    {bucket: 'edit', name: 'replace', label: 'Buscar y reemplazar…', keys: '<Control>h', prefer: 'win'},

    {bucket: 'view', name: 'reload', label: 'Recargar', keys: '<Control>r', prefer: 'win'},
    {bucket: 'view', name: 'zoom-in', label: 'Ampliar', keys: '<Control>plus', prefer: 'win'},
    {bucket: 'view', name: 'zoom-out', label: 'Reducir', keys: '<Control>minus', prefer: 'win'},
    {bucket: 'view', name: 'zoom-reset', label: 'Tamaño real', keys: '<Control>0', prefer: 'win'},
    {bucket: 'view', name: 'fullscreen', label: 'Pantalla completa', keys: 'F11', prefer: 'win', toggle: 'fullscreen'},
    {bucket: 'view', name: 'toggle-fullscreen', label: 'Pantalla completa', keys: 'F11', prefer: 'win', toggle: 'fullscreen'},
    {bucket: 'view', name: 'show-sidebar', label: 'Mostrar barra lateral', keys: 'F9', prefer: 'win'},
    {bucket: 'view', name: 'toggle-sidebar', label: 'Mostrar barra lateral', keys: 'F9', prefer: 'win'},
    {bucket: 'view', name: 'show-help-overlay', label: 'Atajos de teclado', prefer: 'win'},

    {bucket: 'help', name: 'shortcuts', label: 'Atajos de teclado', prefer: 'win'},
    {bucket: 'help', name: 'help', label: 'Ayuda', keys: 'F1', prefer: 'app'},
    {bucket: 'help', name: 'help-overlay', label: 'Atajos de teclado', prefer: 'win'},
];

const MENU_ORDER = ['file', 'edit', 'view', 'insert', 'format', 'go',
    'history', 'bookmarks', 'tools', 'window', 'help'];

const MENU_TITLES = {
    file: 'Archivo',
    edit: 'Edición',
    view: 'Visualización',
    insert: 'Insertar',
    format: 'Formato',
    go: 'Ir',
    history: 'Historial',
    bookmarks: 'Marcadores',
    tools: 'Herramientas',
    window: 'Ventana',
    help: 'Ayuda',
};

function menuIndex(key) {
    const index = MENU_ORDER.indexOf(key);
    return index < 0 ? MENU_ORDER.length : index;
}

function ensureMenu(menus, key) {
    let menu = menus.find(m => m.key === key);
    if (menu)
        return menu;

    menu = {
        key,
        title: MENU_TITLES[key] ?? key,
        items: [],
    };

    const newIndex = menuIndex(key);
    const position = menus.findIndex(m => menuIndex(m.key) > newIndex);
    if (position < 0)
        menus.push(menu);
    else
        menus.splice(position, 0, menu);

    // Ventana y Ayuda deben quedar al final.
    if (key !== 'window' && key !== 'help') {
        const helpPosition = menus.findIndex(m => m.key === 'help');
        const windowPosition = menus.findIndex(m => m.key === 'window');
        const lastSpecial = Math.max(helpPosition, windowPosition);
        if (lastSpecial >= 0) {
            const current = menus.indexOf(menu);
            if (current > lastSpecial) {
                menus.splice(current, 1);
                menus.splice(lastSpecial, 0, menu);
            }
        }
    }

    return menu;
}

function itemKey(item) {
    return `${item?.label ?? ''}`.normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function findMatchingItem(items, entry) {
    for (const candidate of items) {
        if (!candidate || candidate.sep)
            continue;
        if (candidate.gaction) {
            const {name} = splitAction(candidate.gaction);
            if (name === entry.name)
                return candidate;
        }
        if (candidate.label && itemKey(candidate) === itemKey(entry))
            return candidate;
    }
    return null;
}

function findAction(ctx, entry) {
    const order = entry.prefer === 'app' ? ['app', 'win'] : ['win', 'app'];

    for (const prefix of order) {
        const map = ctx?.actions?.[prefix];
        if (!map)
            continue;

        const info = map.get(entry.name);
        if (info)
            return {prefix, name: entry.name, info};
    }

    return null;
}

/**
 * Fusiona las acciones D-Bus conocidas con los menús ya construidos.
 * Los ítems existentes que solo tenían teclas se actualizan para usar la
 * acción real cuando está disponible.
 */
export function mergeKnownActions(menus, ctx) {
    if (!ctx?.actions)
        return menus;

    for (const entry of KNOWN_ACTIONS) {
        const found = findAction(ctx, entry);
        if (!found)
            continue;

        const menu = ensureMenu(menus, entry.bucket);

        // Los perfiles ya definen su menú de Ayuda: no añadimos un «Ayuda»
        // genérico duplicado. Los atajos solo se añaden si faltan.
        if (entry.bucket === 'help') {
            const current = menu.items.filter(candidate =>
                candidate && !candidate.sep);
            if (entry.name === 'help' && current.length > 0)
                continue;
            if ((entry.name === 'shortcuts' || entry.name === 'help-overlay') &&
                current.some(candidate =>
                    itemKey(candidate) === itemKey({label: 'Atajos de teclado'})))
                continue;
        }

        let target = findMatchingItem(menu.items, entry);

        if (!target) {
            target = {
                label: entry.label,
                gaction: `${found.prefix}.${found.name}`,
                keys: entry.keys,
            };
            menu.items.push(target);
        } else {
            target.gaction = `${found.prefix}.${found.name}`;
            if (!target.keys)
                target.keys = entry.keys;
        }

        target.label = target.label || entry.label;
        target.enabled = found.info.enabled;

        if (entry.toggle)
            target.windowState = entry.toggle;

        if (entry.toggle && isStateChecked(found.info))
            target.checked = true;

        if (found.info.paramType && !target.target)
            target.enabled = false;
    }

    // Ítems que solo tenían teclas y cuya acción D-Bus existe: se
    // actualizan por etiqueta aunque no estuvieran en la tabla anterior.
    for (const menu of menus) {
        for (const item of menu.items) {
            if (!item || item.sep || !item.keys || item.gaction)
                continue;

            const labelKey = itemKey(item);
            const entry = KNOWN_ACTIONS.find(candidate =>
                itemKey(candidate) === labelKey && candidate.bucket === menu.key);
            if (!entry)
                continue;

            const found = findAction(ctx, entry);
            if (!found)
                continue;

            item.gaction = `${found.prefix}.${found.name}`;
            item.enabled = found.info.enabled;
            if (entry.toggle)
                item.windowState = entry.toggle;
        }
    }

    for (const menu of menus)
        menu.items = trimSeparators(menu.items);

    return menus;
}

/** Convierte el atributo accel de GMenu en glifos (con fallback). */
export function gtkAccelToGlyph(accel) {
    if (!accel)
        return '';

    const direct = accelToGlyph(accel);
    if (direct)
        return direct;

    // Algunas apps exportan «Ctrl+N» en lugar de «<Control>n».
    const parts = `${accel}`.split('+');
    if (parts.length > 1) {
        const key = parts.pop();
        const mods = parts.map(part => `<${part}>`).join('');
        return accelToGlyph(`${mods}${key}`);
    }

    return accel;
}
