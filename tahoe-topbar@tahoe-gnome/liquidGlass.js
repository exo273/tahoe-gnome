// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Capa de adaptación sobre el motor de Liquid Glass (MIT, ryohsuke1231) que
// vive en vendor/liquid-glass. Dibuja un cristal que lee el framebuffer del
// stage detrás de un actor del chrome y sigue su rectángulo en pantalla.
//
// El motor copia el fondo durante el paint del stage, así que el cristal no
// aparece en capturas hechas con Shell.Screenshot (son paints fuera del
// stage): allí se dibuja la última copia on-screen. Para verlo en una captura
// hace falta una "cámara" como la de tools/backdrop-spike (ver README).

'use strict';

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    BackdropGlass,
    trackViewPaints,
    untrackViewPaints,
} from './vendor/liquid-glass/rendering/backdropGlass.js';
import {
    GLASS_SHADOW_MAX_RADIUS,
    ensureGlassAllocated,
    getAllocatedSize,
    getTransformedRect,
    isActorValid,
    placeScreenGlass,
    setActorVisible,
} from './vendor/liquid-glass/actors.js';
import {hexToColorArray, startSyncLoop, stopStageLoop} from './vendor/liquid-glass/animation.js';
import {Logger} from './vendor/liquid-glass/logger.js';

// Margen que el shader recorta alrededor del cuerpo del cristal. El rect que
// se le pasa incluye este margen; el cuerpo visible queda donde el actor.
const SHADER_PADDING = 20;
// Radio máximo que el shader dibuja de sombra, y el que usa upstream para los
// menús y el panel.
const SHADOW_MAX_RADIUS = GLASS_SHADOW_MAX_RADIUS;
// El motor necesita el stage para copiar el fondo, y un actor de 0x0 con un
// shader hace crash en Cogl, así que se empieza con tamaño 1x1.
const MIN_GLASS_SIZE = 1;

const DEFAULT_OPTIONS = {
    cornerRadius: 24,
    tint: '#ffffff',
    tintStrength: 0.12,
    blurRadius: 8,
    brightness: 1.0,
    contrast: 1.0,
    saturation: 1.2,
    outline: null,
    shadow: true,
    shadowIntensity: null,
    owner: 'tahoe-topbar',
    padding: SHADER_PADDING,
};

function colorArray(tint) {
    if (Array.isArray(tint))
        return [tint[0] ?? 1, tint[1] ?? 1, tint[2] ?? 1];
    return hexToColorArray(tint);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// El ancestro del actor que cuelga directamente de uiGroup. El cristal se
// pone debajo de él: así lee el stage antes de que se pinte toda la rama del
// actor (los menús se pintan a través de un offscreen y no sirven de padre).
function stackRoot(actor) {
    let root = actor;
    while (root.get_parent() && root.get_parent() !== Main.layoutManager.uiGroup)
        root = root.get_parent();
    return root;
}

function insertBelowActor(glass, actor) {
    const uiGroup = Main.layoutManager.uiGroup;
    const root = stackRoot(actor);
    if (root.get_parent() === uiGroup)
        uiGroup.insert_child_below(glass, root);
    else
        uiGroup.add_child(glass);
}

// Escala acumulada del actor, para que el radio de las esquinas crezca con
// las animaciones que escalan un contenedor.
function actorScale(actor, rect) {
    const [width, height] = getAllocatedSize(actor);
    if (!(width > 0) || !(height > 0))
        return 1;
    return clamp(Math.min(rect[2] / width, rect[3] / height), 0.01, 100);
}

function applyMaterial(glass, opts, settings) {
    const [r, g, b] = colorArray(opts.tint);
    glass.setTintColor(r, g, b);
    glass.setTintStrength(opts.tintStrength);
    glass.setBlurRadius(opts.blurRadius);
    glass.setBrightness(opts.brightness);
    glass.setContrast(opts.contrast);
    glass.setSaturation(opts.saturation);
    // Un prefijo de outline haría que MaterialSettings pisara estos valores
    // desde GSettings en cada cambio; aquí el look lo decide la API.
    if (opts.outline && opts.outline.width > 0) {
        const [or, og, ob] = colorArray(opts.outline.color ?? '#000000');
        glass.setOutline(opts.outline.width, or, og, ob);
    } else {
        glass.setOutline(0, 1, 1, 1);
    }
    glass.setShadowMaxRadius(opts.shadow ? SHADOW_MAX_RADIUS : 0);
    const intensity = opts.shadow
        ? (opts.shadowIntensity ?? settings.get_double('shadow-intensity'))
        : 0;
    glass.setShadowIntensity(intensity);
}

/** Una superficie de cristal detrás de un actor o de un conjunto de regiones. */
class GlassHandle {
    _engine;
    _actor;
    _glass;
    _options;
    _regions = false;
    _getRects = null;
    _destroyId = 0;
    _lastKey = '';

    constructor(engine, actor, glass, options, getRects = null) {
        this._engine = engine;
        this._actor = actor;
        this._glass = glass;
        this._options = options;
        this._getRects = getRects;
        this._regions = getRects !== null;
        this._destroyId = actor.connect('destroy', () => this.destroy());
    }

    /** Reaplica el look. Los rectángulos se siguen leyendo cada frame. */
    update(options = {}) {
        if (!this._glass)
            return;
        this._options = {...this._options, ...options};
        applyMaterial(this._glass, this._options, this._engine._settings);
        this._lastKey = '';
        this._sync();
    }

    _sync() {
        const actor = this._actor;
        if (!isActorValid(actor)) {
            this.destroy();
            return;
        }
        if (!actor.mapped || !actor.visible) {
            setActorVisible(this._glass, false);
            this._lastKey = '';
            return;
        }
        const monitor = Main.layoutManager.findMonitorForActor(actor)
            ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        setActorVisible(this._glass, true);
        ensureGlassAllocated(this._glass);

        const opacity = actor.get_paint_opacity();
        const rect = getTransformedRect(actor);
        if (!(rect[2] >= 1) || !(rect[3] >= 1)) {
            setActorVisible(this._glass, false);
            this._lastKey = '';
            return;
        }

        if (this._regions)
            this._syncRegions(monitor, opacity);
        else
            this._syncSingle(monitor, rect, opacity);
        this._glass.syncSources();
    }

    _syncSingle(monitor, rect, opacity) {
        const pad = this._options.padding;
        const bx = Math.round(rect[0] - monitor.x);
        const by = Math.round(rect[1] - monitor.y);
        const bw = Math.round(rect[2]);
        const bh = Math.round(rect[3]);
        const radius = this._options.cornerRadius * actorScale(this._actor, rect);
        const key = `${monitor.x},${monitor.y},${monitor.width},${monitor.height},${bx},${by},${bw},${bh},${radius},${opacity}`;
        if (key === this._lastKey)
            return;
        this._lastKey = key;
        this._glass.opacity = opacity;
        placeScreenGlass(this._glass, monitor.x, monitor.y, monitor.width, monitor.height,
            {x: bx, y: by, w: bw, h: bh});
        this._glass.setResolution(monitor.width, monitor.height);
        this._glass.setPadding(pad);
        this._glass.setCornerRadius(radius);
        this._glass.setGlassGeometry(bx - pad, by - pad, bw + pad * 2, bh + pad * 2);
    }

    _syncRegions(monitor, opacity) {
        const options = this._options;
        const pad = options.padding;
        const entries = this._getRects() ?? [];
        const regions = [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const raw of entries) {
            const [x, y, w, h] = Array.isArray(raw)
                ? raw
                : [raw.x, raw.y, raw.w, raw.h];
            if (!(w >= 1) || !(h >= 1))
                continue;
            const rx = Math.round(x - monitor.x) - pad;
            const ry = Math.round(y - monitor.y) - pad;
            const rw = Math.round(w) + pad * 2;
            const rh = Math.round(h) + pad * 2;
            const [tr, tg, tb] = colorArray(raw.tint ?? options.tint);
            regions.push({
                x: rx, y: ry, w: rw, h: rh,
                tintR: tr, tintG: tg, tintB: tb,
                baseStrength: raw.baseStrength ?? options.tintStrength,
            });
            minX = Math.min(minX, rx + pad);
            minY = Math.min(minY, ry + pad);
            maxX = Math.max(maxX, rx + rw - pad);
            maxY = Math.max(maxY, ry + rh - pad);
        }
        if (regions.length === 0) {
            setActorVisible(this._glass, false);
            this._lastKey = '';
            return;
        }
        setActorVisible(this._glass, true);
        const key = `${monitor.x},${monitor.y},${monitor.width},${monitor.height},${opacity},`
            + regions.map(r => `${r.x},${r.y},${r.w},${r.h},${r.tintR},${r.tintG},${r.tintB},${r.baseStrength}`).join(';');
        if (key === this._lastKey)
            return;
        this._lastKey = key;
        this._glass.opacity = opacity;
        placeScreenGlass(this._glass, monitor.x, monitor.y, monitor.width, monitor.height,
            {x: minX, y: minY, w: maxX - minX, h: maxY - minY});
        this._glass.setResolution(monitor.width, monitor.height);
        this._glass.setPadding(pad);
        this._glass.setGlassRegions(regions);
    }

    destroy() {
        const glass = this._glass;
        if (!glass)
            return;
        this._glass = null;
        if (this._destroyId) {
            this._actor.disconnect(this._destroyId);
            this._destroyId = 0;
        }
        this._engine._forget(this);
        glass.cleanup();
        glass.destroy();
        this._actor = null;
        this._getRects = null;
    }
}

/**
 * El motor de cristal de la extensión. Se crea una vez en enable() y se
 * destruye en disable(); carga los shaders del vendor y comparte settings y
 * logger entre todas las superficies.
 */
export class LiquidGlassEngine {
    _settings;
    _logger;
    _shaderPath;
    _handles = new Set();
    _syncSignalId = 0;
    _syncLaterId = 0;

    constructor(extension) {
        this._settings = extension.getSettings();
        this._logger = new Logger(this._settings);
        this._shaderPath = GLib.build_filenamev([extension.dir.get_path(), 'vendor', 'liquid-glass']);
        // El copiador necesita saber qué view del stage se está pintando.
        trackViewPaints();
    }

    get _signalSlot() {
        return {
            get: () => this._syncSignalId,
            set: id => {
                this._syncSignalId = id;
            },
        };
    }

    get _laterSlot() {
        return {
            get: () => this._syncLaterId,
            set: id => {
                this._syncLaterId = id;
            },
        };
    }

    /**
     * Cristal detrás de `actor`.
     *
     * opts: {cornerRadius, tint, tintStrength, blurRadius, brightness,
     *        contrast, saturation, outline: {width, color}, shadow,
     *        shadowIntensity}
     * `tint` es '#rrggbb' o [r, g, b] normalizados (un cuarto valor de alfa se
     * ignora: la opacidad la decide el actor); `outline.color` igual.
     */
    attach(actor, options = {}) {
        return this._createHandle(actor, {...DEFAULT_OPTIONS, ...options}, null);
    }

    /**
     * Una sola superficie de cristal con varias regiones (hasta 16), para los
     * botones del Centro de control. `getRects()` devuelve rectángulos en
     * coordenadas del stage: [x, y, w, h] u {x, y, w, h, tint, baseStrength}.
     * Las regiones no deben solaparse y comparten el radio de las esquinas:
     * el shader no tiene radio por región.
     */
    attachRegions(container, getRects, options = {}) {
        if (typeof getRects !== 'function')
            throw new TypeError('attachRegions necesita una función getRects()');
        return this._createHandle(container, {...DEFAULT_OPTIONS, ...options}, getRects);
    }

    _createHandle(actor, options, getRects) {
        const glass = new BackdropGlass({
            extensionPath: this._shaderPath,
            settings: this._settings,
            logger: this._logger,
            owner: options.owner,
        });
        glass.set_size(MIN_GLASS_SIZE, MIN_GLASS_SIZE);
        glass.set_pivot_point(0.0, 0.0);
        // Antes del primer sync: el modo multi-región decide qué rect usa el
        // shader como cuerpo del cristal.
        if (getRects)
            glass.setMultiRegionMode(true);
        applyMaterial(glass, options, this._settings);
        insertBelowActor(glass, actor);
        const handle = new GlassHandle(this, actor, glass, options, getRects);
        this._handles.add(handle);
        this._sync();
        this._startLoop();
        return handle;
    }

    _forget(handle) {
        this._handles.delete(handle);
        if (this._handles.size === 0)
            this._stopLoop();
    }

    _startLoop() {
        if (this._syncSignalId !== 0)
            return;
        startSyncLoop(this._signalSlot, this._laterSlot, {
            alive: () => this._handles.size > 0,
            honourFreeze: true,
            errorTag: 'TahoeLiquidGlass',
            step: () => this._sync(),
        });
    }

    _stopLoop() {
        stopStageLoop(this._signalSlot, this._laterSlot);
    }

    _sync() {
        for (const handle of [...this._handles])
            handle._sync();
    }

    destroy() {
        if (!this._logger)
            return;
        for (const handle of [...this._handles])
            handle.destroy();
        this._handles.clear();
        this._stopLoop();
        this._logger.cleanup();
        untrackViewPaints();
        this._logger = null;
        this._settings = null;
    }
}
