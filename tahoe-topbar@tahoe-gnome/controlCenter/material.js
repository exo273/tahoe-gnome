// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Material Liquid Glass exclusivo del Centro de control. El look compartido
// (liquidGlass.js) es oscuro y poco saturado para el escritorio; los módulos
// del CC, en cambio, siguen el cristal más luminoso y "húmedo" de macOS
// Tahoe: tinte blanco, brillo neutro y más saturación, sin línea de contorno.
// El motor sigue aportando el desplazamiento, el rim y el blur globales.

'use strict';

import {glassLook} from '../liquidGlass.js';

// El blur del módulo base; las hojas y popovers pueden subirlo con `extra`.
export const CC_GLASS_BLUR_RADIUS = 5;

/**
 * Look del cristal para los módulos del Centro de control.
 *
 * En oscuro el tinte blanco se aplica suave (0.20): el fondo azul sigue
 * leyéndose a través del cristal, pero la refracción y el rim lo aclaran.
 * En claro se acerca al blanco translúcido del CC de referencia.
 *
 * @param {object} theme tema Tahoe (sólo importa `isDark`).
 * @param {object} extra opciones del módulo (radio, blur, owner...).
 */
export function ccGlassLook(theme, extra = {}) {
    const dark = theme?.isDark ?? true;
    return glassLook(theme, {
        tint: '#ffffff',
        tintStrength: dark ? 0.20 : 0.36,
        brightness: 1.0,
        contrast: 1.0,
        saturation: 1.45,
        outline: null,
        blurRadius: CC_GLASS_BLUR_RADIUS,
        ...extra,
    });
}

/**
 * Reaplica sólo el material al refrescar el tema, conservando el blur y el
 * radio propios de cada superficie (hojas 12, popovers 10, galería 14...).
 * `handle._options` es el estado que el propio motor fusiona en `update()`.
 *
 * @param {object} theme tema Tahoe.
 * @param {object} current opciones actuales del handle.
 */
export function ccRefreshLook(theme, current = {}) {
    const look = ccGlassLook(theme);
    if (Number.isFinite(current?.blurRadius))
        look.blurRadius = current.blurRadius;
    if (Number.isFinite(current?.cornerRadius))
        look.cornerRadius = current.cornerRadius;
    return look;
}
