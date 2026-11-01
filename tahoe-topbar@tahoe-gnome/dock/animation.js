// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Animación de minimizar/restaurar estilo macOS Tahoe (Aladdin / Genie).
//
// Estrategia (GNOME Shell 50, Mutter/Clutter 18):
//
//   1. Escuchamos las señales 'minimize' y 'unminimize' de
//      global.window_manager (ShellWM).  El WindowManager de GNOME ya está
//      conectado antes que nosotros, así que nuestro handler corre después.
//   2. Congelamos el contenido de la ventana con
//      Meta.WindowActor.paint_to_content(null).  Es un ClutterContent con la
//      textura real de la ventana en ese instante: no depende de la escala ni
//      de la posición que la animación nativa esté aplicando.
//   3. Cancelamos la animación nativa de forma segura: quitamos sus
//      transiciones y, usando el mismo guard (`Set.delete`) que usa
//      windowManager.js, llamamos completed_minimize/completed_unminimize una
//      sola vez.  Si la animación nativa ya había terminado (o GNOME no la
//      inició), el Set ya no contiene al actor y NO volvemos a completar.
//      Si no existe la API privada, dejamos que GNOME complete por su cuenta
//      (fallback documentado).
//   4. Dibujamos el contenido congelado en Main.uiGroup y le aplicamos un
//      Clutter.DeformEffect con malla densa (vfunc_deform_vertex).  La malla
//      interpola cada vértice entre el rectángulo de la ventana y el icono del
//      dock, con retardo por fila/columna y una onda transversal: es una
//      deformación real, no un simple scale/opacity.
//   5. Al terminar (o al deshabilitar/cambiar de workspace/morir el actor)
//      retiramos el overlay y restauramos la opacidad del actor si la
//      habíamos ocultado.  Los completed_* ya se llamaron al empezar, así que
//      nunca hay doble llamada ni ventana atascada.
//
// Los estilos 'none' y 'scale' no tocan nada: queda la animación nativa de
// GNOME.  Si el dock está oculto, no hay geometría de icono, la ventana es
// fullscreen/monitor-sized, la sesión está bloqueada o no hay textura,
// tampoco intervenimos.

'use strict';

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LOG = '[tahoe-anim]';

const DURATION_MINIMIZE = 420;
const DURATION_UNMINIMIZE = 480;
const STYLES = ['aladdin', 'genie'];
const MARGIN = 180;
const MAX_CACHED_CONTENTS = 8;
const MAX_TILES = 26;

const MINIMIZE_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.DIALOG,
];

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function easeOutCubic(t) {
    const inv = 1 - clamp(t, 0, 1);
    return 1 - inv * inv * inv;
}

function validRect(rect) {
    return rect &&
        Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
        Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
        rect.width > 0 && rect.height > 0;
}

function unionRect(a, b, pad) {
    const x = Math.min(a.x, b.x) - pad;
    const y = Math.min(a.y, b.y) - pad;
    const right = Math.max(a.x + a.width, b.x + b.width) + pad;
    const bottom = Math.max(a.y + a.height, b.y + b.height) + pad;
    return {x, y, width: right - x, height: bottom - y};
}

/*
 * Efecto de malla.  Clutter.DeformEffect es abstracto; la subclase implementa
 * vfunc_deform_vertex, que recibe cada vértice de la malla en coordenadas
 * locales del actor (el overlay).  Devolvemos la posición deformada en esas
 * mismas coordenadas locales.  La UV de cada vértice no cambia: la textura de
 * la ventana se estira/curva con la malla.
 */
const DeformEffectBase = Clutter.DeformEffect ?? null;

let TahoeDeformEffect = null;
if (DeformEffectBase) {
    try {
        TahoeDeformEffect = GObject.registerClass(
        class TahoeDeformEffect extends DeformEffectBase {
    _init() {
        super._init();
        this._geo = null;
        this._progress = 0;
        this._style = 'aladdin';
        this.set_n_tiles(MAX_TILES, MAX_TILES);
    }

    configure(geo) {
        this._geo = geo;
        this._style = geo.style;
        const tiles = Math.round(clamp(
            Math.max(geo.win.width, geo.win.height) / 28, 12, MAX_TILES));
        this.set_n_tiles(tiles, tiles);
        this.invalidate();
    }

    setProgress(progress) {
        this._progress = progress;
        this.invalidate();
    }

    /*
     * Geometría:
     *   win   rect de la ventana en coordenadas de stage.
     *   icon  rect del icono del dock en coordenadas de stage.
     *   union rect del overlay (win + icon + margen para la onda).
     *   side  'bottom' | 'left' | 'right' | 'top'.
     *
     * Para cada punto fuente (sx, sy):
     *   - u, v normalizados dentro de la ventana.
     *   - 'pinch' estrecha la sección transversal.  La parte superior de la
     *     ventana empieza a estrecharse antes que la inferior (lead = v), tal
     *     como pide el efecto genie; la onda y la curva S dan la doble
     *     curvatura.
     *   - la posición longitudinal se interpola con progreso global; así no
     *     hay cruce de filas ni contenido invertido.
     */
    vfunc_deform_vertex(_width, _height, vertex) {
        const geo = this._geo;
        if (!geo)
            return;

        const {win, icon, union, side} = geo;
        const t = clamp(this._progress, 0, 1);

        const sx = union.x + vertex.x;
        const sy = union.y + vertex.y;

        let u = (sx - win.x) / win.width;
        let v = (sy - win.y) / win.height;

        // Los vértices del margen transparente también se deforman; los
        // limitamos para que la interpolación sea estable.
        const uc = clamp(u, 0, 1);
        const vc = clamp(v, 0, 1);

        const aladdin = this._style === 'aladdin';

        // Estrechamiento transversal: la parte superior (v pequeño) va por
        // delante; la inferior conserva anchura hasta el final.
        const lag = aladdin ? 0.24 : 0.20;
        const pinchRaw = clamp((t - vc * lag) / (1 - lag), 0, 1);
        const pinch = pinchRaw;

        // Progreso longitudinal y centro del destino.
        const winCx = win.x + win.width / 2;
        const winCy = win.y + win.height / 2;
        const iconCx = icon.x + icon.width / 2;
        const iconCy = icon.y + icon.height / 2;

        let x;
        let y;

        if (side === 'bottom' || side === 'top') {
            const widthFactor =
                1 - (1 - icon.width / win.width) * (aladdin ? pinch : pinch);
            x = lerp(winCx, iconCx, t) + (sx - winCx) * widthFactor;

            const targetY = icon.y + vc * icon.height;
            y = lerp(sy, targetY, t);
        } else {
            const heightFactor =
                1 - (1 - icon.height / win.height) * pinch;
            y = lerp(winCy, iconCy, t) + (sy - winCy) * heightFactor;

            const targetX = icon.x + uc * icon.width;
            x = lerp(sx, targetX, t);
        }

        // Onda transversal + curva S.  Se anula en t=0 y t=1 para que el
        // primer y el último frame coincidan con la ventana y el icono.
        const envelope = t * (1 - t) * 4;
        const phase = t * Math.PI * 2;
        const cross = vc;
        let lateral;
        let along = 0;

        if (aladdin) {
            // Una sola S amplia, tipo lámpara de Aladino.
            lateral = Math.sin(cross * Math.PI * 1.05 + 0.22) *
                envelope * 85;
            const bend = Math.sin(vc * Math.PI * 1.5) *
                Math.sin(Math.PI * t) * 26;
            lateral += bend;
        } else {
            // Genie clásico: varias ondulaciones y un pequeño ripple axial.
            lateral = Math.sin(cross * Math.PI * 2.6 + phase * 0.55) *
                envelope * 45;
            along = Math.sin(cross * Math.PI * 3.1 + phase) *
                envelope * 11;
        }

        if (side === 'bottom' || side === 'top') {
            x += lateral;
            y += along;
        } else {
            y += lateral;
            x += along;
        }

        vertex.x = x - union.x;
        vertex.y = y - union.y;
    }
        });
    } catch (e) {
        console.error(`${LOG} no se pudo crear DeformEffect: ${e.message}`);
        TahoeDeformEffect = null;
    }
}

export class TahoeMinimizeAnimation {
    /**
     * @param {object} extension instancia de la extensión (getSettings()).
     * @param {object} dock instancia de TahoeDock (getIconGeometry()).
     */
    constructor(extension, dock) {
        this._extension = extension ?? null;
        this._dock = dock ?? null;
        this._destroyed = false;

        this._animated = new Map();   // Meta.WindowActor -> record
        this._contents = new Map();   // Meta.WindowActor -> {content, rect, destroyId}
        this._handlers = [];
        this._settings = null;
        this._settingsId = 0;

        this._connectSettings();
        this._connectShellWM();
    }

    /* ------------------------------------------------------------------ */
    /* Conexiones                                                         */
    /* ------------------------------------------------------------------ */

    _connectSettings() {
        try {
            this._settings = this._extension?.getSettings?.() ?? null;
        } catch (e) {
            this._settings = null;
        }

        if (!this._settings)
            return;

        try {
            this._settingsId = this._settings.connect('changed', (_settings, key) => {
                if (key !== 'dock-animation-style')
                    return;
                // Al pasar a none/scale, terminamos lo que haya en vuelo.
                if (!['aladdin', 'genie'].includes(this._readStyle())) {
                    for (const record of [...this._animated.values()])
                        this._finishRecord(record);
                }
            });
        } catch (_e) {
            this._settingsId = 0;
        }
    }

    _connectShellWM() {
        const shellwm = global.window_manager;
        if (!shellwm)
            return;

        this._handlers.push([
            shellwm,
            shellwm.connect('minimize', (_wm, actor) => this._onMinimize(actor)),
        ]);
        this._handlers.push([
            shellwm,
            shellwm.connect('unminimize', (_wm, actor) => this._onUnminimize(actor)),
        ]);
        this._handlers.push([
            shellwm,
            shellwm.connect('switch-workspace', () => this._finishAll()),
        ]);
        this._handlers.push([
            shellwm,
            shellwm.connect('kill-window-effects', (_wm, actor) => {
                const record = this._animated.get(actor);
                if (record)
                    this._finishRecord(record);
            }),
        ]);
    }

    /* ------------------------------------------------------------------ */
    /* Ajustes y elegibilidad                                             */
    /* ------------------------------------------------------------------ */

    _readStyle() {
        try {
            const settings = this._settings ?? this._extension?.getSettings?.();
            if (settings) {
                const schema = settings.settings_schema;
                if (!schema || typeof schema.has_key !== 'function' ||
                    schema.has_key('dock-animation-style')) {
                    const value = settings.get_string('dock-animation-style');
                    if (typeof value === 'string' && value.length > 0)
                        return value;
                }
            }
        } catch (_e) {
            // Clave ausente en esquemas antiguos: usamos el valor del dock.
        }

        const fallback = this._dock?._animationStyle;
        return typeof fallback === 'string' && fallback.length > 0
            ? fallback
            : 'aladdin';
    }

    _shellLocked() {
        try {
            if (Main.sessionMode?.isLocked || Main.sessionMode?.isGreeter)
                return true;
            const mode = Main.sessionMode?.currentMode;
            if (mode === 'unlock-dialog' || mode === 'gdm')
                return true;
            if (Main.screenShield?.locked || Main.screenShield?._locked)
                return true;
        } catch (_e) {
            // Sin shield disponible.
        }
        return false;
    }

    _dockVisible() {
        const dock = this._dock;
        if (!dock)
            return false;
        if (dock._destroyed)
            return false;
        if (dock._enabled === false)
            return false;

        const root = dock._root ?? dock.actor ?? null;
        if (root) {
            if (!root.visible || !root.mapped)
                return false;
            if (typeof root.opacity === 'number' && root.opacity < 16)
                return false;
        }

        if (dock._autohide === true && dock._revealed === false)
            return false;

        return true;
    }

    _iconGeometry(actor) {
        const dock = this._dock;
        const win = actor?.meta_window;
        if (!dock || !win)
            return null;

        let rect = null;
        try {
            rect = dock.getIconGeometry?.(win) ??
                dock.getTargetRect?.(win) ??
                dock.getIconGeometry?.(win) ?? null;
        } catch (_e) {
            rect = null;
        }

        if (!validRect(rect))
            return null;

        return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        };
    }

    _sideFor(winRect, iconRect) {
        const iconCx = iconRect.x + iconRect.width / 2;
        const iconCy = iconRect.y + iconRect.height / 2;
        const winRight = winRect.x + winRect.width;
        const winBottom = winRect.y + winRect.height;

        if (iconCy >= winBottom)
            return 'bottom';
        if (iconCy <= winRect.y)
            return 'top';
        if (iconCx <= winRect.x)
            return 'left';
        if (iconCx >= winRight)
            return 'right';
        return null;
    }

    _isAnimatable(actor) {
        if (this._destroyed || !actor)
            return false;
        if (this._shellLocked())
            return false;
        if (Main.overview?.visible)
            return false;

        let alive = false;
        try {
            alive = !actor.is_destroyed?.();
        } catch (_e) {
            alive = false;
        }
        if (!alive)
            return false;

        const win = actor.meta_window;
        if (!win)
            return false;
        if (win.is_fullscreen?.() || win.is_monitor_sized?.())
            return false;
        if (!MINIMIZE_TYPES.includes(win.get_window_type?.()))
            return false;

        try {
            if (!actor.get_texture?.())
                return false;
        } catch (_e) {
            return false;
        }

        if (!this._dockVisible())
            return false;

        return true;
    }

    _windowRect(actor) {
        let rect = null;
        try {
            rect = actor.meta_window?.get_frame_rect?.() ?? null;
        } catch (_e) {
            rect = null;
        }

        if (!validRect(rect)) {
            try {
                const [x, y] = actor.get_position();
                const [width, height] = actor.get_size();
                rect = {x, y, width, height};
            } catch (_e) {
                rect = null;
            }
        }

        if (!validRect(rect))
            return null;

        return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };
    }

    _captureContent(actor) {
        try {
            const content = actor.paint_to_content?.(null) ?? null;
            if (!content)
                return null;
            return content;
        } catch (e) {
            console.error(`${LOG} paint_to_content falló: ${e.message}`);
            return null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Caché de contenido (para restaurar sin depender del actor escalado) */
    /* ------------------------------------------------------------------ */

    _cacheContent(actor, content, rect) {
        if (!content || !actor)
            return;

        const old = this._contents.get(actor);
        if (old) {
            this._contents.delete(actor);
            try {
                if (old.destroyId)
                    actor.disconnect(old.destroyId);
            } catch (_e) {
                // actor ya destruido
            }
        } else {
            // Límite simple: descartamos el contenido más antiguo.
            while (this._contents.size >= MAX_CACHED_CONTENTS) {
                const [key, entry] = this._contents.entries().next().value;
                this._contents.delete(key);
                try {
                    if (entry.destroyId)
                        key.disconnect(entry.destroyId);
                } catch (_e) {
                    // actor ya destruido
                }
            }
        }

        let destroyId = 0;
        try {
            destroyId = actor.connect('destroy', () => {
                this._contents.delete(actor);
            });
        } catch (_e) {
            destroyId = 0;
        }

        this._contents.set(actor, {content, rect, destroyId});
    }

    _takeCachedContent(actor, rect) {
        const entry = this._contents.get(actor);
        if (!entry)
            return null;
        if (entry.rect && rect &&
            (entry.rect.width !== rect.width || entry.rect.height !== rect.height))
            return null;
        return entry.content;
    }

    /* ------------------------------------------------------------------ */
    /* Finalización nativa                                                */
    /* ------------------------------------------------------------------ */

    /*
     * Detiene la animación nativa y completa el minimize/unminimize UNA sola
     * vez.  El guard es exactamente el Set que usa windowManager.js:
     *   - Si el actor está en el Set, quitamos sus transiciones.  Si al
     *     quitarlas onStopped ya ejecutó _minimizeWindowDone, el Set ya no lo
     *     contiene y no llamamos nada.
     *   - Si sigue en el Set, lo borramos y llamamos completed_* nosotros.
     *   - Si no está en el Set, GNOME ya completó (o no animó): no tocamos.
     */
    _completeNative(actor, kind) {
        const shellwm = global.window_manager;
        const wm = Main.wm;
        const set = kind === 'minimize' ? wm?._minimizing : wm?._unminimizing;

        if (!shellwm || !set || !set.has(actor))
            return false;

        try {
            actor.remove_all_transitions();
        } catch (_e) {
            // Sin transiciones.
        }

        if (!set.delete(actor))
            return false;

        try {
            actor.set_scale(1.0, 1.0);
            actor.set_opacity(255);
            actor.set_pivot_point(0, 0);
        } catch (_e) {
            // Actor ya destruido.
        }

        try {
            if (kind === 'minimize')
                shellwm.completed_minimize(actor);
            else
                shellwm.completed_unminimize(actor);
        } catch (e) {
            console.error(`${LOG} completed_${kind} falló: ${e.message}`);
        }

        return true;
    }

    _actorAlive(actor) {
        if (!actor)
            return false;
        try {
            return !actor.is_destroyed?.();
        } catch (_e) {
            return false;
        }
    }

    _setActorOpacity(actor, opacity) {
        if (!this._actorAlive(actor))
            return;
        try {
            actor.opacity = opacity;
        } catch (_e) {
            // Actor destruido entre la comprobación y la escritura.
        }
    }

    /*
     * Al terminar un restore devolvemos el actor real a su geometría final.
     * completed_unminimize ya se llamó al empezar; esto evita depender de que
     * Mutter re-sincronice posición/escala en el mismo frame.
     */
    _restoreActor(actor, fallbackRect = null) {
        if (!this._actorAlive(actor))
            return;
        try {
            let rect = actor.meta_window?.get_frame_rect?.();
            if (!validRect(rect))
                rect = fallbackRect;
            if (validRect(rect))
                actor.set_position(rect.x, rect.y);
            actor.set_scale(1.0, 1.0);
            actor.set_pivot_point(0, 0);
            actor.show();
            actor.set_opacity(255);
        } catch (_e) {
            // Actor destruido.
        }
    }

    /* ------------------------------------------------------------------ */
    /* Señales de ShellWM                                                 */
    /* ------------------------------------------------------------------ */

    _onMinimize(actor) {
        if (this._destroyed || !actor || !TahoeDeformEffect)
            return;

        const style = this._readStyle();
        if (!STYLES.includes(style))
            return;
        if (!this._isAnimatable(actor))
            return;

        const winRect = this._windowRect(actor);
        const iconRect = this._iconGeometry(actor);
        if (!winRect || !iconRect)
            return;

        const side = this._sideFor(winRect, iconRect);
        if (!side)
            return;

        // Si ya hay una animación en vuelo para este actor (por ejemplo el
        // usuario vuelve a minimizar durante el restore), la terminamos antes
        // de congelar el contenido.  Si el actor ya estaba minimizado hay que
        // usar la instantánea cacheada: paint_to_content() daría una textura
        // vacía.
        const existing = this._animated.get(actor);
        let content = null;
        if (existing) {
            const wasRestore = existing.restore;
            this._finishRecord(existing);
            if (wasRestore)
                content = this._captureContent(actor);
            if (!content)
                content = this._takeCachedContent(actor, winRect);
        } else {
            content = this._captureContent(actor);
            if (!content)
                content = this._takeCachedContent(actor, winRect);
        }
        if (!content)
            return;

        this._cacheContent(actor, content, winRect);

        // A partir de aquí tomamos el control visual.  La finalización nativa
        // se hace ya (una vez), de modo que el actor queda minimizado aunque
        // nuestro overlay siga pintándose.
        const nativeCancelled = this._completeNative(actor, 'minimize');

        this._startRecord(actor, {
            style,
            winRect,
            iconRect,
            unionRect: unionRect(winRect, iconRect, MARGIN),
            side,
            duration: DURATION_MINIMIZE,
            restore: false,
            reverse: false,
            nativeFallback: !nativeCancelled,
            content,
        });
    }

    _onUnminimize(actor) {
        if (this._destroyed || !actor || !TahoeDeformEffect)
            return;

        const style = this._readStyle();
        if (!STYLES.includes(style))
            return;
        if (!this._isAnimatable(actor))
            return;

        const winRect = this._windowRect(actor);
        const iconRect = this._iconGeometry(actor);
        if (!winRect || !iconRect)
            return;

        const side = this._sideFor(winRect, iconRect);
        if (!side)
            return;

        // La instantánea del minimize es imprescindible: el actor acaba de ser
        // mostrado por GNOME y paint_to_content() puede devolver una textura
        // todavía vacía en el primer frame del unminimize.  Si no hay caché
        // (la ventana ya estaba minimizada al activar la extensión), dejamos
        // la animación nativa completa.
        const content = this._takeCachedContent(actor, winRect);
        if (!content) {
            this._stopRecordFor(actor);
            return;
        }

        this._stopRecordFor(actor);

        // Cancelamos la nativa y completamos una vez; después ocultamos el
        // actor real para que sólo se vea nuestra malla.
        const nativeCancelled = this._completeNative(actor, 'unminimize');
        this._setActorOpacity(actor, 0);

        this._startRecord(actor, {
            style,
            winRect,
            iconRect,
            unionRect: unionRect(winRect, iconRect, MARGIN),
            side,
            duration: DURATION_UNMINIMIZE,
            restore: true,
            reverse: true,
            nativeFallback: !nativeCancelled,
            content,
        });
    }

    /* ------------------------------------------------------------------ */
    /* Overlay + timeline                                                 */
    /* ------------------------------------------------------------------ */

    _startRecord(actor, params) {
        let outer = null;
        let effect = null;

        try {
            outer = new St.Widget({
                name: 'tahoe-minimize-overlay',
                reactive: false,
                clip_to_allocation: false,
                x: params.unionRect.x,
                y: params.unionRect.y,
                width: params.unionRect.width,
                height: params.unionRect.height,
            });

            const child = new St.Widget({
                x: params.winRect.x - params.unionRect.x,
                y: params.winRect.y - params.unionRect.y,
                width: params.winRect.width,
                height: params.winRect.height,
                reactive: false,
                content: params.content,
            });
            outer.add_child(child);

            effect = new TahoeDeformEffect();
            effect.configure({
                style: params.style,
                win: params.winRect,
                icon: params.iconRect,
                union: params.unionRect,
                side: params.side,
            });
            effect.setProgress(params.reverse ? 1 : 0);
            outer.add_effect(effect);

            try {
                outer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
            } catch (_e) {
                // No crítico.
            }

            Main.uiGroup.add_child(outer);
            Main.uiGroup.set_child_above_sibling(outer, null);
        } catch (e) {
            console.error(`${LOG} no se pudo crear el overlay: ${e.message}`);
            try {
                if (outer) {
                    if (effect)
                        outer.remove_effect(effect);
                    outer.destroy();
                }
            } catch (_e) {
                // Nada más que hacer.
            }
            // Si ya completamos la nativa, el estado de la ventana es válido.
            // Restauramos el actor si habíamos ocultado el actor.
            if (params.restore)
                this._restoreActor(actor, params.winRect);
            return;
        }

        const record = {
            actor,
            outer,
            effect,
            timeline: null,
            timeoutId: 0,
            winRect: params.winRect,
            restore: params.restore,
            reverse: Boolean(params.reverse),
            nativeFallback: Boolean(params.nativeFallback),
            finished: false,
            destroyId: 0,
        };

        this._animated.set(actor, record);

        try {
            record.destroyId = actor.connect('destroy', () => {
                this._finishRecord(record, {actorGone: true});
            });
        } catch (_e) {
            record.destroyId = 0;
        }

        try {
            record.timeline = new Clutter.Timeline({duration: params.duration});
            // Clutter.Timeline necesita un frame clock; set_actor lo toma del
            // actor (que ya está en el stage).  Sin esto no emite new-frame.
            try {
                record.timeline.set_actor(outer);
            } catch (e) {
                console.error(`${LOG} timeline.set_actor falló: ${e.message}`);
            }
            record.timeline.connect('new-frame', timeline => {
                if (record.finished)
                    return;
                const progress = easeOutCubic(timeline.get_progress());
                effect.setProgress(record.reverse ? 1 - progress : progress);
                // En el camino normal la nativa ya está cancelada; esto cubre
                // el fallback si Main.wm no tuviera el Set privado.
                if (record.restore && record.nativeFallback)
                    this._setActorOpacity(actor, 0);
            });
            record.timeline.connect('completed', () => {
                this._finishRecord(record);
            });
            record.timeline.start();
        } catch (e) {
            console.error(`${LOG} no se pudo iniciar el timeline: ${e.message}`);
            this._finishRecord(record);
        }

        if (record.finished)
            return;

        // Red de seguridad: aunque el timeline no arranque (frame clock
        // ausente, actor destruido a mitad, etc.), el overlay no puede quedar
        // pegado.  También garantiza que el actor oculto se restaure.
        try {
            record.timeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, params.duration + 160, () => {
                    record.timeoutId = 0;
                    this._finishRecord(record);
                    return GLib.SOURCE_REMOVE;
                });
        } catch (_e) {
            record.timeoutId = 0;
        }
    }

    _stopRecordFor(actor) {
        const record = this._animated.get(actor);
        if (record)
            this._finishRecord(record);
    }

    _finishRecord(record, options = {}) {
        if (!record || record.finished)
            return;
        record.finished = true;

        const {actor, outer, effect, timeline, timeoutId, restore, destroyId} = record;
        this._animated.delete(actor);

        if (timeoutId) {
            try {
                GLib.source_remove(timeoutId);
            } catch (_e) {
                // Ya ejecutado.
            }
        }

        try {
            if (timeline) {
                timeline.stop();
                timeline.disconnect_all();
            }
        } catch (_e) {
            // Timeline ya detenido.
        }

        try {
            if (destroyId)
                actor.disconnect(destroyId);
        } catch (_e) {
            // Actor destruido.
        }

        try {
            if (outer) {
                if (effect)
                    outer.remove_effect(effect);
                outer.destroy();
            }
        } catch (_e) {
            // Overlay ya destruido.
        }

        // Si ocultamos el actor real para el unminimize, lo devolvemos a su
        // geometría final.  Si el actor murió, no hay nada que restaurar.
        if (restore && !options.actorGone)
            this._restoreActor(actor, record.winRect);

        if (options.actorGone) {
            try {
                const entry = this._contents.get(actor);
                if (entry?.destroyId)
                    actor.disconnect(entry.destroyId);
            } catch (_e) {
                // ya destruido
            }
            this._contents.delete(actor);
        }
    }

    _finishAll() {
        for (const record of [...this._animated.values()])
            this._finishRecord(record);
    }

    /* ------------------------------------------------------------------ */
    /* Destrucción                                                        */
    /* ------------------------------------------------------------------ */

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._finishAll();

        for (const [object, id] of this._handlers) {
            try {
                object.disconnect(id);
            } catch (_e) {
                // Ya desconectado.
            }
        }
        this._handlers = [];

        if (this._settingsId) {
            try {
                this._settings.disconnect(this._settingsId);
            } catch (_e) {
                // Ya desconectado.
            }
            this._settingsId = 0;
        }

        for (const [actor, entry] of this._contents) {
            try {
                if (entry.destroyId)
                    actor.disconnect(entry.destroyId);
            } catch (_e) {
                // ya destruido
            }
        }
        this._contents.clear();
        this._settings = null;
        this._extension = null;
        this._dock = null;
    }
}
