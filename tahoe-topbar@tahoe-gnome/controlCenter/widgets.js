// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Widgets reutilizables del Centro de control estilo macOS Tahoe.
//
// Todas las piezas son actores de St "planos" (sin Gtk), de modo que se
// pueden insertar tanto en el panel grande como en los menús de la barra.

'use strict';

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

export const CircleButton = GObject.registerClass(
class CircleButton extends St.Button {
    _init(params = {}) {
        const {
            iconName = null,
            iconSize = 16,
            accessibleName = '',
            styleClass = null,
        } = params;

        super._init({
            style_class: 'tahoe-cc-circle',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: accessibleName,
        });

        if (styleClass)
            this.add_style_class_name(styleClass);

        this._icon = new St.Icon({
            icon_name: iconName,
            icon_size: iconSize,
            style_class: 'tahoe-cc-circle-icon',
        });
        this.set_child(this._icon);
    }

    setIcon(iconName) {
        if (iconName && this._icon)
            this._icon.icon_name = iconName;
    }

    setOn(on) {
        if (on)
            this.add_style_class_name('tahoe-cc-circle-on');
        else
            this.remove_style_class_name('tahoe-cc-circle-on');
    }

    get on() {
        return this.has_style_class_name('tahoe-cc-circle-on');
    }
});

/**
 * Fila "botón circular + título + subtítulo" de una tarjeta de conectividad.
 *
 * @param {object} options
 * @param {string} options.iconName
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {Function} [options.onToggle]
 * @param {Function} [options.onActivate]
 * @returns {object}
 */
export function createModuleRow(options) {
    const {
        iconName,
        title,
        subtitle = '',
        onToggle = null,
        onActivate = null,
    } = options;

    const row = new St.BoxLayout({
        style_class: 'tahoe-cc-row',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const circle = new CircleButton({
        iconName,
        accessibleName: title,
    });

    if (onToggle)
        circle.connect('clicked', () => onToggle());

    const textButton = new St.Button({
        style_class: 'tahoe-cc-row-text',
        x_expand: true,
        can_focus: true,
        reactive: Boolean(onActivate),
        track_hover: Boolean(onActivate),
        accessible_name: title,
    });

    const labels = new St.BoxLayout({
        style_class: 'tahoe-cc-row-labels',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const titleLabel = new St.Label({
        text: title,
        style_class: 'tahoe-cc-title',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
    });
    titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    const subtitleLabel = new St.Label({
        text: subtitle,
        style_class: 'tahoe-cc-subtitle',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        visible: Boolean(subtitle),
    });
    subtitleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    labels.add_child(titleLabel);
    labels.add_child(subtitleLabel);
    textButton.set_child(labels);

    if (onActivate)
        textButton.connect('clicked', () => onActivate());

    row.add_child(circle);
    row.add_child(textButton);

    return {
        row,
        circle,
        textButton,
        titleLabel,
        subtitleLabel,
        setSubtitle(text) {
            const value = text ?? '';
            if (subtitleLabel)
                subtitleLabel.text = value;
            if (subtitleLabel)
                subtitleLabel.visible = Boolean(value);
        },
        setOn(on) {
            circle.setOn(on);
        },
        setIcon(name) {
            circle.setIcon(name);
        },
        setSensitive(sensitive) {
            circle.reactive = sensitive;
            textButton.reactive = sensitive && Boolean(onActivate);
            circle.opacity = sensitive ? 255 : 140;
            textButton.opacity = sensitive ? 255 : 140;
        },
    };
}

/**
 * Tarjeta vertical con botón circular y etiqueta debajo (Modo oscuro,
 * Luz nocturna…).
 */
export function createTile(options) {
    const {
        iconName,
        title,
        onToggle = null,
        styleClass = '',
    } = options;

    const tile = new St.BoxLayout({
        style_class: `tahoe-cc-card tahoe-cc-tile ${styleClass}`.trim(),
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
    });

    const circle = new CircleButton({
        iconName,
        accessibleName: title,
    });

    if (onToggle)
        circle.connect('clicked', () => onToggle());

    const label = new St.Label({
        text: title,
        style_class: 'tahoe-cc-tile-label',
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    label.clutter_text.set_line_wrap(true);
    label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
    try {
        label.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
    } catch (_e) {
        // Versiones antiguas de Pango.
    }

    tile.add_child(circle);
    tile.add_child(label);

    return {
        tile,
        circle,
        label,
        setOn(on) {
            circle.setOn(on);
        },
        setIcon(name) {
            circle.setIcon(name);
        },
        setSensitive(sensitive) {
            circle.reactive = sensitive;
            circle.opacity = sensitive ? 255 : 140;
        },
    };
}

/**
 * Acción de la fila inferior: círculo + etiqueta.
 */
export function createQuickAction(options) {
    const {
        iconName,
        label,
        onClick,
        accessibleName = null,
    } = options;

    const box = new St.BoxLayout({
        style_class: 'tahoe-cc-action',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
    });

    const circle = new CircleButton({
        iconName,
        accessibleName: accessibleName ?? label,
    });
    circle.connect('clicked', () => onClick());

    const labelWidget = new St.Label({
        text: label,
        style_class: 'tahoe-cc-action-label',
        x_align: Clutter.ActorAlign.CENTER,
    });
    labelWidget.clutter_text.set_line_wrap(true);
    labelWidget.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
    try {
        labelWidget.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
    } catch (_e) {
        // Ignorar.
    }

    box.add_child(circle);
    box.add_child(labelWidget);

    return {
        box,
        circle,
        label: labelWidget,
        setIcon(name) {
            circle.setIcon(name);
        },
        setVisible(visible) {
            box.visible = visible;
        },
    };
}

/**
 * Contenedor que dibuja el slider ocupando todo el ancho y superpone el
 * icono a la izquierda (Clutter.BinLayout centra a sus hijos, por eso no
 * sirve aquí).
 */
const SliderWithIcon = GObject.registerClass(
class SliderWithIcon extends St.Widget {
    _init(slider, icon) {
        super._init({
            style_class: 'tahoe-cc-slider-wrap',
            x_expand: true,
        });

        this._slider = slider;
        this._icon = icon;

        this.add_child(slider);
        this.add_child(icon);
    }

    vfunc_get_preferred_height(forWidth) {
        const [, sliderHeight] = this._slider.get_preferred_height(forWidth);
        const [, iconHeight] = this._icon.get_preferred_height(-1);
        const height = Math.max(sliderHeight, iconHeight);
        return [height, height];
    }

    vfunc_get_preferred_width(forHeight) {
        return this._slider.get_preferred_width(forHeight);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const width = box.x2 - box.x1;
        const height = box.y2 - box.y1;
        const childBox = new Clutter.ActorBox();

        childBox.x1 = 0;
        childBox.y1 = 0;
        childBox.x2 = width;
        childBox.y2 = height;
        this._slider.allocate(childBox);

        let marginLeft = 0;
        try {
            marginLeft = this._icon.get_theme_node()
                .get_margin(St.Side.LEFT);
        } catch (_e) {
            marginLeft = 0;
        }

        const [iconWidth, iconNaturalWidth] = this._icon.get_preferred_width(-1);
        const [, iconHeight] = this._icon.get_preferred_height(iconNaturalWidth);
        const iconAllocHeight = Math.min(iconHeight, height);

        const x1 = marginLeft;
        const y1 = Math.round((height - iconAllocHeight) / 2);

        childBox.x1 = x1;
        childBox.y1 = y1;
        childBox.x2 = x1 + iconWidth;
        childBox.y2 = y1 + iconAllocHeight;
        this._icon.allocate(childBox);
    }
});

/**
 * Slider grueso estilo Tahoe con un icono dentro, a la izquierda.
 *
 * @returns {object} {actor, slider, iconButton, setIcon}
 */
export function createTahoeSlider(options = {}) {
    const {
        iconName = 'display-brightness-symbolic',
        iconSize = 14,
        onIconClick = null,
        accessibleName = '',
    } = options;

    const slider = new Slider(0);
    slider.add_style_class_name('tahoe-cc-slider');
    slider.maximum_value = 1;
    slider.value = 0;
    slider.x_expand = true;
    if (accessibleName)
        slider.accessible_name = accessibleName;

    const iconButton = new St.Button({
        style_class: 'tahoe-cc-slider-icon',
        reactive: Boolean(onIconClick),
        can_focus: false,
        track_hover: Boolean(onIconClick),
        accessible_name: onIconClick ? accessibleName : '',
    });
    iconButton.set_child(new St.Icon({
        icon_name: iconName,
        icon_size: iconSize,
        style_class: 'tahoe-cc-slider-icon-image',
    }));
    if (onIconClick)
        iconButton.connect('clicked', () => onIconClick());

    const actor = new SliderWithIcon(slider, iconButton);

    return {
        actor,
        slider,
        iconButton,
        setIcon(name) {
            if (!name)
                return;
            const icon = iconButton.get_first_child();
            if (icon)
                icon.icon_name = name;
        },
    };
}

/**
 * Fila de una lista de detalle (redes, dispositivos, salidas de audio).
 */
export function createListRow(options) {
    const {
        iconName,
        title,
        subtitle = '',
        check = false,
        suffixIconName = null,
        onClick = null,
    } = options;

    const button = new St.Button({
        style_class: 'tahoe-cc-list-row',
        x_expand: true,
        can_focus: true,
        reactive: Boolean(onClick),
        track_hover: Boolean(onClick),
        accessible_name: title,
    });

    const box = new St.BoxLayout({
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'tahoe-cc-list-row-box',
    });

    const icon = new St.Icon({
        icon_name: iconName,
        icon_size: 16,
        style_class: 'tahoe-cc-list-icon',
        y_align: Clutter.ActorAlign.CENTER,
    });

    const labels = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        style_class: 'tahoe-cc-list-labels',
    });

    const titleLabel = new St.Label({
        text: title,
        style_class: 'tahoe-cc-list-title',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
    });
    titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    const subtitleLabel = new St.Label({
        text: subtitle,
        style_class: 'tahoe-cc-subtitle',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        visible: Boolean(subtitle),
    });
    subtitleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    labels.add_child(titleLabel);
    labels.add_child(subtitleLabel);

    box.add_child(icon);
    box.add_child(labels);

    if (suffixIconName) {
        box.add_child(new St.Icon({
            icon_name: suffixIconName,
            icon_size: 13,
            style_class: 'tahoe-cc-list-suffix',
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }

    const checkIcon = new St.Icon({
        icon_name: 'object-select-symbolic',
        icon_size: 14,
        style_class: 'tahoe-cc-list-check',
        y_align: Clutter.ActorAlign.CENTER,
        visible: check,
    });
    box.add_child(checkIcon);

    button.set_child(box);

    if (onClick)
        button.connect('clicked', () => onClick());

    return {
        button,
        icon,
        titleLabel,
        subtitleLabel,
        checkIcon,
        setCheck(value) {
            if (checkIcon)
                checkIcon.visible = value;
        },
        setIcon(name) {
            if (name && icon)
                icon.icon_name = name;
        },
        setSubtitle(value) {
            if (subtitleLabel) {
                subtitleLabel.text = value ?? '';
                subtitleLabel.visible = Boolean(value);
            }
        },
    };
}

export function createSectionLabel(text) {
    return new St.Label({
        text,
        style_class: 'tahoe-cc-section-label',
        x_align: Clutter.ActorAlign.START,
        x_expand: true,
    });
}

export function createSeparator() {
    return new St.Widget({
        style_class: 'tahoe-cc-separator',
        x_expand: true,
    });
}

/**
 * Cabecera de una vista de detalle: flecha "‹" + título.
 */
export function createDetailHeader(title, onBack) {
    const header = new St.BoxLayout({
        style_class: 'tahoe-cc-detail-header',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const back = new St.Button({
        style_class: 'tahoe-cc-back-button',
        can_focus: true,
        reactive: true,
        track_hover: true,
        accessible_name: 'Atrás',
    });
    back.set_child(new St.Label({
        text: '‹',
        style_class: 'tahoe-cc-back-glyph',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    back.connect('clicked', () => onBack());

    const label = new St.Label({
        text: title,
        style_class: 'tahoe-cc-detail-title',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    header.add_child(back);
    header.add_child(label);

    return {header, back, label};
}

/**
 * Enlace de pie (texto gris pequeño, centrado).
 */
export function createFooterLink(text, onClick) {
    const button = new St.Button({
        style_class: 'tahoe-cc-footer-link',
        can_focus: true,
        reactive: true,
        track_hover: true,
        x_align: Clutter.ActorAlign.CENTER,
        accessible_name: text,
    });
    button.set_child(new St.Label({
        text,
        style_class: 'tahoe-cc-footer-label',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    button.connect('clicked', () => onClick());
    return button;
}

/**
 * Icono del Centro de control: dos pastillas horizontales con un círculo
 * cada una. Se dibuja con actores St para heredar el color del panel
 * (blanco sobre fondo oscuro, negro en el tema claro).
 */
export function createControlCenterGlyph() {
    const glyph = new St.BoxLayout({
        style_class: 'tahoe-cc-glyph',
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });

    for (let i = 0; i < 2; i++) {
        const pill = new St.Bin({
            style_class: 'tahoe-cc-glyph-pill',
            x_align: Clutter.ActorAlign.CENTER,
        });

        const knob = new St.Widget({
            style_class: 'tahoe-cc-glyph-knob',
            x_align: i === 0 ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        pill.set_child(knob);
        glyph.add_child(pill);
    }

    return glyph;
}
