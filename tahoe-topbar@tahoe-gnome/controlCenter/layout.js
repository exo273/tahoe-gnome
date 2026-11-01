// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Distribución del Centro de control: formato JSON persistente y motor de
// rejilla. La rejilla de Tahoe tiene 4 columnas de 62 px con 12 px de hueco
// (284 px en total) y coloca los controles con "first fit": cada módulo ocupa
// el primer hueco libre recorriendo de arriba-izquierda a abajo-derecha.
//
// El formato persistido (clave `control-center-layout`) es una lista ordenada:
//
//   [
//     {"id": "wifi", "size": "medium"},
//     {"id": "now-playing", "size": "large"}
//   ]
//
// Tamaños: "small" 1x1, "medium" 2x1, "large" 2x2 y "wide" 4x1.

'use strict';

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const GRID_COLUMNS = 4;
export const CELL_SIZE = 62;
export const GRID_GAP = 12;
export const GRID_WIDTH = GRID_COLUMNS * CELL_SIZE + (GRID_COLUMNS - 1) * GRID_GAP;
export const MAX_LAYOUT_ENTRIES = 64;

export const CONTROL_SIZES = {
    small: {columns: 1, rows: 1, radius: 31},
    medium: {columns: 2, rows: 1, radius: 31},
    large: {columns: 2, rows: 2, radius: 24},
    wide: {columns: 4, rows: 1, radius: 24},
};

// Distribución de referencia de macOS Tahoe.
export const DEFAULT_LAYOUT = [
    {id: 'wifi', size: 'medium'},
    {id: 'now-playing', size: 'large'},
    {id: 'bluetooth', size: 'small'},
    {id: 'airplane', size: 'small'},
    {id: 'focus', size: 'medium'},
    {id: 'dark-mode', size: 'small'},
    {id: 'night-light', size: 'small'},
    {id: 'display', size: 'wide'},
    {id: 'sound', size: 'wide'},
    {id: 'power-profile', size: 'small'},
    {id: 'screenshot', size: 'small'},
    {id: 'lock', size: 'small'},
    {id: 'settings', size: 'small'},
];

const VALID_ID = /^[A-Za-z0-9_.:@-]+$/;

export function sizeSpan(size) {
    return CONTROL_SIZES[size] ?? CONTROL_SIZES.small;
}

export function sizeRadius(size) {
    return sizeSpan(size).radius;
}

export function isValidSize(size) {
    return Object.prototype.hasOwnProperty.call(CONTROL_SIZES, size);
}

function scaleFactor() {
    try {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (_e) {
        return 1;
    }
}

/**
 * Acepta el JSON guardado (o ya deserializado) y devuelve una lista limpia.
 * Las entradas inválidas se descartan y los ids duplicados se ignoran.
 * Con una cadena vacía o rota se usa `fallback`.
 */
export function parseLayout(raw, fallback = DEFAULT_LAYOUT) {
    let value = raw;

    if (typeof value === 'string') {
        if (!value.trim())
            return fallback.map(entry => ({...entry}));

        try {
            value = JSON.parse(value);
        } catch (_e) {
            return fallback.map(entry => ({...entry}));
        }
    }

    if (!Array.isArray(value))
        return fallback.map(entry => ({...entry}));

    const result = [];
    const seen = new Set();

    for (const rawEntry of value.slice(0, MAX_LAYOUT_ENTRIES)) {
        if (!rawEntry || typeof rawEntry !== 'object')
            continue;

        const id = typeof rawEntry.id === 'string' ? rawEntry.id.trim() : '';
        if (!id || id.length > 120 || !VALID_ID.test(id) || seen.has(id))
            continue;

        let size = typeof rawEntry.size === 'string'
            ? rawEntry.size.trim().toLowerCase()
            : '';

        if (!isValidSize(size))
            size = 'small';

        seen.add(id);
        result.push({id, size});
    }

    return result;
}

export function layoutToJSON(layout) {
    return JSON.stringify(parseLayout(layout, []));
}

export function cloneLayout(layout) {
    return layout.map(entry => ({id: entry.id, size: entry.size}));
}

function px(value) {
    return Math.max(1, Math.round(value * scaleFactor()));
}

const TahoeGridMeta = GObject.registerClass({
    Properties: {
        'column-span': GObject.ParamSpec.int(
            'column-span', null, null,
            GObject.ParamFlags.READWRITE,
            1, GRID_COLUMNS, 1),
        'row-span': GObject.ParamSpec.int(
            'row-span', null, null,
            GObject.ParamFlags.READWRITE,
            1, 2, 1),
    },
}, class TahoeGridMeta extends Clutter.LayoutMeta {});

/**
 * LayoutManager de 4 columnas fijas. Coloca los hijos con first fit según su
 * `column-span`/`row-span`, de modo que un layout nuevo (o un control que
 * aparece/desaparece) no cambia el tamaño de las columnas.
 */
export const TahoeGridLayout = GObject.registerClass(
class TahoeGridLayout extends Clutter.LayoutManager {
    _init(params = {}) {
        super._init(params);
        this._columns = GRID_COLUMNS;
        this._cell = CELL_SIZE;
        this._gap = GRID_GAP;
    }

    setSpan(container, child, columns, rows) {
        this.child_set_property(container, child, 'column-span',
            Math.clamp(Math.round(columns), 1, GRID_COLUMNS));
        this.child_set_property(container, child, 'row-span',
            Math.clamp(Math.round(rows), 1, 2));
        container.queue_relayout();
    }

    vfunc_get_child_meta_type() {
        return TahoeGridMeta.$gtype;
    }

    _spanFor(container, child) {
        let meta;
        try {
            meta = this.get_child_meta(container, child);
        } catch (_e) {
            meta = null;
        }

        return [
            Math.clamp(meta?.columnSpan ?? 1, 1, GRID_COLUMNS),
            Math.clamp(meta?.rowSpan ?? 1, 1, 2),
        ];
    }

    _isFree(occupied, columns, x, y, w, h) {
        for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) {
                if (occupied.has((y + dy) * columns + x + dx))
                    return false;
            }
        }
        return true;
    }

    _occupy(occupied, columns, x, y, w, h) {
        for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++)
                occupied.add((y + dy) * columns + x + dx);
        }
    }

    /**
     * Posiciones resultantes: [{child, column, row, columns, rows}].
     * Sólo se tienen en cuenta los hijos visibles.
     */
    pack(container) {
        const columns = this._columns;
        const occupied = new Set();
        const items = [];
        let rowCount = 0;

        for (const child of container.get_children()) {
            if (!child.visible)
                continue;

            const [w, h] = this._spanFor(container, child);
            let found = false;

            // Como mucho hay un número pequeño de módulos; el tope evita
            // bucles infinitos si algo corrompe los spans.
            for (let y = 0; y < MAX_LAYOUT_ENTRIES && !found; y++) {
                for (let x = 0; x <= columns - w; x++) {
                    if (!this._isFree(occupied, columns, x, y, w, h))
                        continue;

                    this._occupy(occupied, columns, x, y, w, h);
                    items.push({child, column: x, row: y, columns: w, rows: h});
                    rowCount = Math.max(rowCount, y + h);
                    found = true;
                    break;
                }
            }
        }

        return {items, rows: rowCount};
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        const width = px(GRID_WIDTH);
        return [width, width];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        const {rows} = this.pack(container);
        if (rows === 0)
            return [0, 0];

        const height = rows * px(CELL_SIZE) + (rows - 1) * px(GRID_GAP);
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const {items} = this.pack(container);
        const gap = px(GRID_GAP);
        const available = box.get_width();
        const cell = Math.max(1, Math.floor(
            (available - (this._columns - 1) * gap) / this._columns));
        const childBox = new Clutter.ActorBox();

        for (const item of items) {
            const width = cell * item.columns + gap * (item.columns - 1);
            const height = cell * item.rows + gap * (item.rows - 1);
            const x = box.x1 + item.column * (cell + gap);
            const y = box.y1 + item.row * (cell + gap);

            childBox.set_origin(Math.round(x), Math.round(y));
            childBox.set_size(width, height);
            item.child.allocate(childBox);
        }
    }
});
