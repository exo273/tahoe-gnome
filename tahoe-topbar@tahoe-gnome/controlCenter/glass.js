// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Efectos de "cristal" para el Centro de control: desenfoque del fondo
// (Shell.BlurEffect) y una máscara GLSL propia que recorta el resultado con
// esquinas redondeadas. El blur de Shell pinta un rectángulo completo; la
// máscara evita que se vean las esquinas cuadradas.

'use strict';

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

const LOG = '[tahoe-topbar/cc]';

// Sombra redondeada + cobertura. Se aplica como último efecto del actor,
// después del BlurEffect.
const ROUNDED_MASK_SHADER = `
uniform sampler2D tex;
uniform float cc_width;
uniform float cc_height;
uniform float cc_radius;

float cc_rounded_distance(vec2 point, vec2 half_size, float radius) {
    vec2 q = abs(point) - half_size + vec2(radius);
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
    vec4 color = texture2D(tex, cogl_tex_coord_in[0].st);
    vec2 size = vec2(max(cc_width, 1.0), max(cc_height, 1.0));
    vec2 position = cogl_tex_coord_in[0].st * size;
    float radius = min(cc_radius, min(size.x, size.y) * 0.5);
    float distance = cc_rounded_distance(
        position - size * 0.5, size * 0.5, radius);
    float antialias = max(1.0, min(size.x, size.y) * 0.02);
    float coverage = 1.0 - smoothstep(-antialias, antialias, distance);
    cogl_color_out = color * coverage;
}
`;

function themeScale() {
    try {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (_e) {
        return 1;
    }
}

function updateMaskUniforms(state) {
    const {mask, actor, radius} = state;
    if (!mask || !actor)
        return;

    const width = Math.max(1, actor.width);
    const height = Math.max(1, actor.height);
    const scale = themeScale();

    try {
        mask.set_uniform_value('cc_width', Number(width));
        mask.set_uniform_value('cc_height', Number(height));
        mask.set_uniform_value('cc_radius', Number(Math.max(0, radius * scale)));
    } catch (e) {
        console.error(`${LOG} No se pudieron actualizar las esquinas del cristal:`, e);
    }
}

function createBlur(dark) {
    try {
        const blur = new Shell.BlurEffect();
        blur.mode = Shell.BlurMode.BACKGROUND;
        blur.radius = 30;
        // El cristal claro necesita un fondo más luminoso; el oscuro, más
        // ahumado. Shell.BlurEffect.brightness se puede cambiar en vivo.
        blur.brightness = dark ? 0.75 : 1.05;
        return blur;
    } catch (e) {
        console.error(`${LOG} No se pudo crear el desenfoque:`, e);
        return null;
    }
}

function createMask() {
    try {
        const mask = new Clutter.ShaderEffect();
        mask.set_shader_source(ROUNDED_MASK_SHADER);
        return mask;
    } catch (e) {
        console.error(`${LOG} No se pudo crear la máscara redondeada:`, e);
        return null;
    }
}

/**
 * Activa el cristal con blur y esquinas redondeadas en un actor.
 *
 * @param {St.Widget} actor
 * @param {object} options
 * @param {number} options.radius radio lógico (CSS px) del módulo
 * @param {boolean} options.blur
 * @param {boolean} options.dark modo oscuro (ajusta el brillo del desenfoque)
 */
export function applyGlass(actor, {radius = 24, blur = true, dark = false} = {}) {
    if (!actor)
        return;

    removeGlass(actor);

    const state = {
        actor,
        radius,
        dark: Boolean(dark),
        blur: null,
        mask: null,
        allocationId: 0,
        themeId: 0,
    };

    actor._tahoeGlass = state;

    if (blur) {
        const blurEffect = createBlur(state.dark);
        if (blurEffect) {
            try {
                actor.add_effect(blurEffect);
                state.blur = blurEffect;
            } catch (e) {
                console.error(`${LOG} No se pudo aplicar el desenfoque:`, e);
            }
        }
    }

    // La máscara se añade después para que reciba el resultado del blur.
    if (state.blur) {
        const mask = createMask();
        if (mask) {
            try {
                actor.add_effect(mask);
                state.mask = mask;
                updateMaskUniforms(state);
            } catch (e) {
                console.error(`${LOG} No se pudo aplicar la máscara del cristal:`, e);
            }
        }
    }

    state.allocationId = actor.connect('notify::allocation', () => {
        updateMaskUniforms(state);
    });

    try {
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        state.themeId = themeContext.connect('notify::scale-factor', () => {
            updateMaskUniforms(state);
        });
        state.themeContext = themeContext;
    } catch (_e) {
        state.themeId = 0;
    }
}

export function removeGlass(actor) {
    const state = actor?._tahoeGlass;
    if (!state)
        return;

    if (state.allocationId) {
        try {
            actor.disconnect(state.allocationId);
        } catch (_e) {
            // Ignorar.
        }
    }

    if (state.themeId && state.themeContext) {
        try {
            state.themeContext.disconnect(state.themeId);
        } catch (_e) {
            // Ignorar.
        }
    }

    for (const effect of [state.mask, state.blur]) {
        if (!effect)
            continue;
        try {
            actor.remove_effect(effect);
        } catch (_e) {
            // El actor ya no existe.
        }
    }

    state.mask = null;
    state.blur = null;
    actor._tahoeGlass = null;
}

export function setGlassBlur(actor, blur) {
    const state = actor?._tahoeGlass;
    if (!state)
        return;

    applyGlass(actor, {radius: state.radius, blur, dark: state.dark});
}

export function isClutterShaderAvailable() {
    return Boolean(Clutter.ShaderEffect);
}
