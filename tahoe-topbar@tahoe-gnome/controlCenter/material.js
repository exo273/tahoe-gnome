// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Material Liquid Glass exclusivo del Centro de control. El look compartido
// (liquidGlass.js) ya es blanco, saturado y de blur corto; el CC sólo ajusta
// el blur para que los módulos se lean sobre fondos muy contrastados. El
// motor sigue aportando el desplazamiento, el rim y el resto de la óptica.

'use strict';

import {glassLook} from '../liquidGlass.js';

// Blur base de cada familia de superficies del CC. Son deliberadamente bajos:
// el cristal debe refractar el fondo, no convertirlo en una mancha.
export const CC_GLASS_BLUR_RADIUS = 3;
export const CC_SHEET_BLUR_RADIUS = 4;
export const CC_POPOVER_BLUR_RADIUS = 4;

/**
 * Look del cristal para los módulos del Centro de control.
 *
 * Reutiliza el material global sin duplicar tintes ni brillos: sólo fija el
 * blur del módulo base. Las hojas y popovers pasan su propio `blurRadius`.
 *
 * @param {object} theme tema Tahoe (sólo importa `isDark`).
 * @param {object} extra opciones del módulo (radio, blur, owner...).
 */
export function ccGlassLook(theme, extra = {}) {
    return glassLook(theme, {
        blurRadius: CC_GLASS_BLUR_RADIUS,
        ...extra,
    });
}

/**
 * Reaplica sólo el material al refrescar el tema, conservando el blur y el
 * radio propios de cada superficie (hojas, popovers, galería...). `handle._options`
 * es el estado que el propio motor fusiona en `update()`.
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
