// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Widgets del Centro de control estilo macOS Tahoe.
//
// La estructura sigue la rejilla de 4 columnas de 62px de Tahoe: píldoras,
// botones circulares, tarjeta de reproducción 2x2, tarjetas anchas y hojas de
// detalle. El material ("Liquid Glass") se aplica con la clase tahoe-cc-glass;
// controlCenter.js añade encima el desenfoque y la máscara redondeada.

'use strict';

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

const ICON_STYLE = 'tahoe-cc-icon';

/**
 * Slider propio de Tahoe: pista de 8px y tirador en forma de píldora blanca
 * de 34x22px. Soporta arrastre, clic, rueda y flechas del teclado.
 */
export const TahoeSlider = GObject.registerClass({
    Properties: {
        'value': GObject.ParamSpec.double(
            'value', null, null,
            GObject.ParamFlags.READWRITE, 0, 1, 0),
        'maximum-value': GObject.ParamSpec.double(
            'maximum-value', null, null,
            GObject.ParamFlags.READWRITE, 1, 2, 1),
    },
    Signals: {
        'drag-begin': {},
        'drag-end': {},
    },
}, class TahoeSlider extends St.DrawingArea {
    _init(value = 0) {
        super._init({
            style_class: 'tahoe-cc-tahoeslider',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });

        this._maxValue = 1;
        this._value = Math.clamp(value, 0, 1);
        this._dragging = false;
        this._grab = null;
        this._scale = 1;

        this.connect('repaint', () => this._draw());
        this.connect('notify::allocation', () => this.queue_repaint());
        this.connect('style-changed', () => this.queue_repaint());

        this.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;

            this._dragging = true;
            try {
                this._grab = global.stage.grab(this);
            } catch (_e) {
                this._grab = null;
            }
            this.emit('drag-begin');
            this._setFromEvent(event);
            return Clutter.EVENT_STOP;
        });

        this.connect('motion-event', (actor, event) => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;
            if (this._grab?.is_revoked())
                this._endDrag();
            this._setFromEvent(event);
            return Clutter.EVENT_STOP;
        });

        this.connect('button-release-event', () => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;
            this._endDrag();
            return Clutter.EVENT_STOP;
        });

        this.connect('scroll-event', (actor, event) => {
            const direction = event.get_scroll_direction();
            let delta = 0;

            if (direction === Clutter.ScrollDirection.UP)
                delta = 0.02;
            else if (direction === Clutter.ScrollDirection.DOWN)
                delta = -0.02;
            else if (direction === Clutter.ScrollDirection.SMOOTH) {
                const [, dy] = event.get_scroll_delta();
                delta = -dy * 0.02;
            }

            if (delta !== 0) {
                this.value = Math.clamp(
                    this._value + delta, 0, this._maxValue);
            }
            return Clutter.EVENT_STOP;
        });

        this.connect('key-press-event', (actor, event) => {
            const key = event.get_key_symbol();
            const step = 0.05;

            if (key === Clutter.KEY_Left || key === Clutter.KEY_Down)
                this.value = Math.clamp(this._value - step, 0, this._maxValue);
            else if (key === Clutter.KEY_Right || key === Clutter.KEY_Up)
                this.value = Math.clamp(this._value + step, 0, this._maxValue);
            else if (key === Clutter.KEY_Home)
                this.value = 0;
            else if (key === Clutter.KEY_End)
                this.value = this._maxValue;
            else
                return Clutter.EVENT_PROPAGATE;

            return Clutter.EVENT_STOP;
        });
    }

    get value() {
        return this._value;
    }

    set value(value) {
        const clamped = Math.clamp(Number(value) || 0, 0, this._maxValue);
        if (Math.abs(clamped - this._value) < 0.0001)
            return;

        this._value = clamped;
        this.notify('value');
        this.queue_repaint();
    }

    get maximum_value() {
        return this._maxValue;
    }

    set maximum_value(value) {
        const max = Math.max(1, Number(value) || 1);
        if (Math.abs(max - this._maxValue) < 0.0001)
            return;
        this._maxValue = max;
        if (this._value > max)
            this.value = max;
        this.notify('maximum-value');
        this.queue_repaint();
    }

    _themeScale() {
        try {
            return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        } catch (_e) {
            return 1;
        }
    }

    vfunc_get_preferred_height(_forWidth) {
        const height = Math.round(22 * this._themeScale());
        return [height, height];
    }

    vfunc_get_preferred_width(_forHeight) {
        const width = Math.round(34 * this._themeScale());
        return [width, width];
    }

    _endDrag() {
        if (this._grab) {
            try {
                if (!this._grab.is_revoked())
                    this._grab.dismiss();
            } catch (_e) {
                // Ignorar.
            }
        }
        this._grab = null;
        this._dragging = false;
        this.emit('drag-end');
    }

    _setFromEvent(event) {
        if (this.width <= 0)
            return;

        const [stageX] = event.get_coords();
        const [actorX] = this.get_transformed_position();
        const x = stageX - actorX;

        this.value = this._valueFromX(x);
    }

    _valueFromX(x) {
        const scale = this._themeScale();
        const handleWidth = 34 * scale;
        const width = this.width;
        if (width <= handleWidth)
            return 0;

        const clamped = Math.clamp(x, handleWidth / 2, width - handleWidth / 2);
        return (clamped - handleWidth / 2) /
            (width - handleWidth) * this._maxValue;
    }

    _roundedRect(cr, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        cr.newSubPath();
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.lineTo(x + width - r, y);
        cr.arc(x + width - r, y + r, r, 1.5 * Math.PI, 0);
        cr.lineTo(x + width, y + height - r);
        cr.arc(x + width - r, y + height - r, r, 0, 0.5 * Math.PI);
        cr.lineTo(x + r, y + height);
        cr.arc(x + r, y + height - r, r, 0.5 * Math.PI, Math.PI);
        cr.closePath();
    }

    _isLightTheme() {
        try {
            const color = this.get_theme_node().get_foreground_color();
            const luminance = (0.2126 * color.red +
                0.7152 * color.green + 0.0722 * color.blue) / 255;
            return luminance < 0.5;
        } catch (_e) {
            return false;
        }
    }

    _draw() {
        if (this.width <= 0 || this.height <= 0)
            return;

        const cr = this.get_context();
        const scale = this._themeScale();
        const [width, height] = this.get_surface_size();
        const trackHeight = 8 * scale;
        const handleWidth = Math.min(34 * scale, width);
        const handleHeight = Math.min(22 * scale, height);
        const trackY = (height - trackHeight) / 2;
        const progress = this._maxValue > 0
            ? this._value / this._maxValue
            : 0;
        const handleCenter = handleWidth / 2 +
            (width - handleWidth) * progress;
        const handleX = handleCenter - handleWidth / 2;
        const handleY = (height - handleHeight) / 2;
        const light = this._isLightTheme();

        if (light)
            cr.setSourceRGBA(0, 0, 0, 0.15);
        else
            cr.setSourceRGBA(1, 1, 1, 0.25);
        this._roundedRect(cr, 0, trackY, width, trackHeight,
            trackHeight / 2);
        cr.fill();

        if (handleCenter > 0) {
            cr.setSourceRGBA(1, 1, 1, 0.96);
            this._roundedRect(cr, 0, trackY, handleCenter, trackHeight,
                trackHeight / 2);
            cr.fill();
        }

        // Sombra suave del tirador (Cairo no tiene blur; se aproxima).
        cr.setSourceRGBA(0, 0, 0, 0.14);
        this._roundedRect(cr, handleX + 0.5 * scale,
            handleY + 1.5 * scale, handleWidth, handleHeight,
            handleHeight / 2);
        cr.fill();

        cr.setSourceRGBA(1, 1, 1, 1);
        this._roundedRect(cr, handleX, handleY,
            handleWidth, handleHeight, handleHeight / 2);
        cr.fill();

        // En claro, un borde fino separa el tirador blanco del cristal.
        if (light) {
            cr.setSourceRGBA(0, 0, 0, 0.12);
            cr.setLineWidth(Math.max(1, scale));
            this._roundedRect(cr, handleX + 0.5 * scale,
                handleY + 0.5 * scale,
                handleWidth - scale, handleHeight - scale,
                handleHeight / 2);
            cr.stroke();
        }

        cr.$dispose();
    }
});

export const CircleButton = GObject.registerClass(
class CircleButton extends St.Button {
    _init(params = {}) {
        const {
            iconName = null,
            iconSize = 22,
            accessibleName = '',
            size = 62,
            styleClass = null,
            glass = true,
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

        if (glass)
            this.add_style_class_name('tahoe-cc-glass');
        else
            this.add_style_class_name('tahoe-cc-icon-circle');

        this.add_style_class_name(`tahoe-cc-circle-${size}`);
        if (styleClass)
            this.add_style_class_name(styleClass);

        this._icon = new St.Icon({
            icon_name: iconName,
            icon_size: iconSize,
            style_class: ICON_STYLE,
        });
        this.set_child(this._icon);
    }

    setIcon(iconName) {
        if (iconName && this._icon)
            this._icon.icon_name = iconName;
    }

    setOn(on) {
        if (on)
            this.add_style_class_name('tahoe-cc-on');
        else
            this.remove_style_class_name('tahoe-cc-on');
    }

    get on() {
        return this.has_style_class_name('tahoe-cc-on');
    }
});

/**
 * Píldora de 136x62 con círculo de icono de 38px, título y subtítulo.
 */
export function createPill(options) {
    const {
        iconName,
        title,
        subtitle = '',
        onIconClick = null,
        onTextClick = null,
        accessibleName = title,
    } = options;

    const pill = new St.BoxLayout({
        style_class: 'tahoe-cc-glass tahoe-cc-pill',
        y_align: Clutter.ActorAlign.CENTER,
    });

    const circle = new CircleButton({
        iconName,
        iconSize: 18,
        accessibleName,
        size: 38,
        glass: false,
        styleClass: 'tahoe-cc-pill-icon',
    });
    if (onIconClick)
        circle.connect('clicked', () => onIconClick());

    const textButton = new St.Button({
        style_class: 'tahoe-cc-pill-text',
        x_expand: true,
        can_focus: true,
        reactive: Boolean(onTextClick),
        track_hover: Boolean(onTextClick),
        accessible_name: title,
    });

    const labels = new St.BoxLayout({
        style_class: 'tahoe-cc-pill-labels',
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

    if (onTextClick)
        textButton.connect('clicked', () => onTextClick());

    pill.add_child(circle);
    pill.add_child(textButton);

    return {
        pill,
        circle,
        textButton,
        titleLabel,
        subtitleLabel,
        setSubtitle(value) {
            subtitleLabel.text = value ?? '';
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
            textButton.reactive = sensitive && Boolean(onTextClick);
            pill.opacity = sensitive ? 255 : 170;
        },
    };
}

/**
 * Tarjeta de reproducción 2x2 (136x136). Si no hay reproductor mantiene el
 * mismo tamaño y muestra "Sin reproducción".
 */
export function createMediaCard() {
    const card = new St.BoxLayout({
        style_class: 'tahoe-cc-glass tahoe-cc-media',
        orientation: Clutter.Orientation.VERTICAL,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.FILL,
    });

    const art = new St.Bin({
        style_class: 'tahoe-cc-media-art',
        width: 40,
        height: 40,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.START,
    });
    const artIcon = new St.Icon({
        icon_name: 'audio-x-generic-symbolic',
        icon_size: 17,
        style_class: 'tahoe-cc-media-art-icon',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    art.set_child(artIcon);

    const top = new St.BoxLayout({
        style_class: 'tahoe-cc-media-top',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    top.add_child(art);

    const labels = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'tahoe-cc-media-labels',
    });
    const title = new St.Label({
        text: '',
        style_class: 'tahoe-cc-media-title',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
    });
    title.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    const artist = new St.Label({
        text: '',
        style_class: 'tahoe-cc-media-artist',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
    });
    artist.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    labels.add_child(title);
    labels.add_child(artist);
    top.add_child(labels);

    const controls = new St.BoxLayout({
        style_class: 'tahoe-cc-media-controls',
        x_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const previous = new St.Button({
        style_class: 'tahoe-cc-media-button',
        can_focus: true,
        reactive: true,
        track_hover: true,
        accessible_name: 'Anterior',
        child: new St.Icon({
            icon_name: 'media-skip-backward-symbolic',
            icon_size: 20,
            style_class: ICON_STYLE,
        }),
    });
    const play = new St.Button({
        style_class: 'tahoe-cc-media-button',
        can_focus: true,
        reactive: true,
        track_hover: true,
        accessible_name: 'Reproducir o pausar',
        child: new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 20,
            style_class: ICON_STYLE,
        }),
    });
    const next = new St.Button({
        style_class: 'tahoe-cc-media-button',
        can_focus: true,
        reactive: true,
        track_hover: true,
        accessible_name: 'Siguiente',
        child: new St.Icon({
            icon_name: 'media-skip-forward-symbolic',
            icon_size: 20,
            style_class: ICON_STYLE,
        }),
    });

    controls.add_child(previous);
    controls.add_child(play);
    controls.add_child(next);

    const empty = new St.BoxLayout({
        style_class: 'tahoe-cc-media-empty',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    empty.add_child(new St.Icon({
        icon_name: 'audio-x-generic-symbolic',
        icon_size: 26,
        style_class: 'tahoe-cc-media-empty-icon',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    empty.add_child(new St.Label({
        text: 'Sin reproducción',
        style_class: 'tahoe-cc-media-empty-label',
        x_align: Clutter.ActorAlign.CENTER,
    }));

    const content = new St.BoxLayout({
        style_class: 'tahoe-cc-media-content',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
    });
    content.add_child(top);
    content.add_child(controls);
    card.add_child(content);
    card.add_child(empty);


    return {
        card,
        art,
        artIcon,
        title,
        artist,
        previous,
        play,
        next,
        content,
        empty,
        _playing: null,
        setPlaying(playing) {
            if (this._playing === playing)
                return;
            this._playing = playing;
            play.set_child(new St.Icon({
                icon_name: playing
                    ? 'media-playback-pause-symbolic'
                    : 'media-playback-start-symbolic',
                icon_size: 20,
                style_class: ICON_STYLE,
            }));
        },
        setEmpty(isEmpty) {
            content.visible = !isEmpty;
            empty.visible = isEmpty;
        },
    };
}

/**
 * Tarjeta ancha de 284x62: título y slider fino con iconos en los extremos.
 */
export function createWideCard(options) {
    const {
        title,
        leftIcon = 'display-brightness-symbolic',
        rightIcon = 'display-brightness-symbolic',
        leftIconSize = 13,
        rightIconSize = 18,
        withOutputButton = false,
        accessibleName = title,
    } = options;

    const card = new St.BoxLayout({
        style_class: 'tahoe-cc-glass tahoe-cc-wide',
        orientation: Clutter.Orientation.VERTICAL,
    });

    card.add_child(new St.Label({
        text: title,
        style_class: 'tahoe-cc-card-title',
        x_align: Clutter.ActorAlign.START,
        x_expand: true,
    }));

    const row = new St.BoxLayout({
        style_class: 'tahoe-cc-wide-row',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const left = new St.Button({
        style_class: 'tahoe-cc-slider-end',
        can_focus: false,
        reactive: false,
        child: new St.Icon({
            icon_name: leftIcon,
            icon_size: leftIconSize,
            style_class: ICON_STYLE,
        }),
    });
    row.add_child(left);

    const slider = new TahoeSlider(0);
    slider.maximum_value = 1;
    slider.value = 0;
    slider.x_expand = true;
    slider.accessible_name = accessibleName;
    row.add_child(slider);

    const right = new St.Icon({
        icon_name: rightIcon,
        icon_size: rightIconSize,
        style_class: `${ICON_STYLE} tahoe-cc-slider-end-icon`,
        y_align: Clutter.ActorAlign.CENTER,
    });
    row.add_child(right);

    let output = null;
    if (withOutputButton) {
        output = new CircleButton({
            iconName: 'audio-headphones-symbolic',
            iconSize: 14,
            accessibleName: 'Elegir salida de sonido',
            size: 26,
            glass: false,
            styleClass: 'tahoe-cc-output-button',
        });
        row.add_child(output);
    }

    card.add_child(row);

    return {
        card,
        slider,
        left,
        right,
        output,
        setLeftIcon(name) {
            const icon = left.get_first_child();
            if (icon && name)
                icon.icon_name = name;
        },
        setRightIcon(name) {
            if (name)
                right.icon_name = name;
        },
    };
}

export function createFooterPill(text, onClick) {
    const button = new St.Button({
        style_class: 'tahoe-cc-glass tahoe-cc-footer-pill',
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
 * Interruptor tipo iOS/macOS de 38x22 con perilla de 18px.
 */
export const Switch = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class Switch extends St.Button {
    _init(params = {}) {
        super._init({
            style_class: 'tahoe-cc-switch',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            ...params,
        });

        this._checked = false;
        this._knob = new St.Widget({
            style_class: 'tahoe-cc-switch-knob',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._knob);
        this.add_style_class_name('tahoe-cc-switch-off');

        this.connect('clicked', () => {
            this.checked = !this._checked;
            this.emit('changed', this._checked);
        });
    }

    get checked() {
        return this._checked;
    }

    set checked(value) {
        this.setChecked(value, true);
    }

    vfunc_get_preferred_width(_forHeight) {
        const scale = this._scale();
        return [38 * scale, 38 * scale];
    }

    vfunc_get_preferred_height(_forWidth) {
        const scale = this._scale();
        return [22 * scale, 22 * scale];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const width = box.x2 - box.x1;
        const height = box.y2 - box.y1;
        const scale = this._scale();
        const knob = Math.min(18 * scale, height - 4 * scale);
        const knobBox = new Clutter.ActorBox();

        knobBox.x1 = this._checked ? width - knob - 2 * scale : 2 * scale;
        knobBox.y1 = Math.round((height - knob) / 2);
        knobBox.x2 = knobBox.x1 + knob;
        knobBox.y2 = knobBox.y1 + knob;
        this._knob.allocate(knobBox);
    }

    _scale() {
        try {
            return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        } catch (_e) {
            return 1;
        }
    }

    setChecked(checked, animate = false) {
        const value = Boolean(checked);
        if (this._checked === value)
            return;

        this._checked = value;
        this.add_style_class_name(value
            ? 'tahoe-cc-switch-on'
            : 'tahoe-cc-switch-off');
        this.remove_style_class_name(value
            ? 'tahoe-cc-switch-off'
            : 'tahoe-cc-switch-on');
        this.queue_relayout();

    }
});

/**
 * Cabecera de detalle: "‹", título y, opcionalmente, un Switch.
 */
export function createDetailHeader(options) {
    const {title, onBack, withSwitch = false} = options;

    const header = new St.BoxLayout({
        style_class: 'tahoe-cc-detail-header',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const back = new St.Button({
        style_class: 'tahoe-cc-back-button',
        can_focus: true,
        reactive: Boolean(onBack),
        track_hover: Boolean(onBack),
        accessible_name: 'Atrás',
        child: new St.Label({
            text: '‹',
            style_class: 'tahoe-cc-back-glyph',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }),
    });
    if (onBack)
        back.connect('clicked', () => onBack());
    else
        back.visible = false;

    const label = new St.Label({
        text: title,
        style_class: 'tahoe-cc-detail-title',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    header.add_child(back);
    header.add_child(label);

    let toggle = null;
    if (withSwitch) {
        toggle = new Switch({visible: true});
        header.add_child(toggle);
    }

    return {header, back, label, toggle};
}

export function createSectionHeader(text, withChevron = true) {
    const box = new St.BoxLayout({
        style_class: 'tahoe-cc-section-header',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.add_child(new St.Label({
        text,
        style_class: 'tahoe-cc-section-label',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
    }));
    if (withChevron) {
        box.add_child(new St.Icon({
            icon_name: 'pan-down-symbolic',
            icon_size: 11,
            style_class: 'tahoe-cc-section-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    return box;
}

/**
 * Fila de lista de detalle de 28px.
 */
export function createListRow(options) {
    const {
        iconName,
        gicon = null,
        title,
        subtitle = '',
        active = false,
        activeWhite = false,
        large = false,
        check = false,
        suffixIconName = null,
        onClick = null,
    } = options;

    let rowClass = 'tahoe-cc-list-row';
    if (large)
        rowClass += ' tahoe-cc-list-row-large';
    if (active)
        rowClass += activeWhite
            ? ' tahoe-cc-list-row-active-white'
            : ' tahoe-cc-list-row-active';

    const button = new St.Button({
        style_class: rowClass,
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

    const circleSize = large ? 30 : 24;
    const iconCircle = new St.Bin({
        style_class: 'tahoe-cc-list-circle',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        width: circleSize,
        height: circleSize,
    });
    const rowIcon = new St.Icon({
        icon_name: iconName,
        icon_size: large ? 15 : 13,
        style_class: 'tahoe-cc-list-icon',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (!iconName && gicon)
        rowIcon.gicon = gicon;
    iconCircle.set_child(rowIcon);

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
    labels.add_child(titleLabel);

    const subtitleLabel = new St.Label({
        text: subtitle,
        style_class: 'tahoe-cc-list-subtitle',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        visible: Boolean(subtitle),
    });
    subtitleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    labels.add_child(subtitleLabel);

    box.add_child(iconCircle);
    box.add_child(labels);

    if (suffixIconName) {
        box.add_child(new St.Icon({
            icon_name: suffixIconName,
            icon_size: 12,
            style_class: 'tahoe-cc-list-suffix',
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }

    const checkIcon = new St.Icon({
        icon_name: 'object-select-symbolic',
        icon_size: 13,
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
        iconCircle,
        titleLabel,
        subtitleLabel,
        checkIcon,
        setActive(value) {
            button.add_style_class_name(value
                ? 'tahoe-cc-list-row-active'
                : 'tahoe-cc-list-row');
            if (!value)
                button.remove_style_class_name('tahoe-cc-list-row-active');
        },
        setIcon(name) {
            const icon = iconCircle.get_first_child();
            if (icon && name)
                icon.icon_name = name;
        },
        setSubtitle(value) {
            subtitleLabel.text = value ?? '';
            subtitleLabel.visible = Boolean(value);
        },
    };
}

/**
 * Icono de batería horizontal dibujado con Cairo: contorno redondeado,
 * relleno proporcional, borne y rayo si está cargando.
 */
export const BatteryIcon = GObject.registerClass(
class BatteryIcon extends St.DrawingArea {
    _init(params = {}) {
        let scale = 1;
        try {
            scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        } catch (_e) {
            scale = 1;
        }

        super._init({
            style_class: 'tahoe-cc-battery-icon',
            y_align: Clutter.ActorAlign.CENTER,
            width: Math.round(22 * scale),
            height: Math.round(12 * scale),
            ...params,
        });

        this._level = 1;
        this._charging = false;
        this.connect('repaint', () => this._draw());
        this.connect('style-changed', () => this.queue_repaint());
    }

    setLevel(level) {
        const value = Math.clamp(level, 0, 1);
        if (this._level === value)
            return;
        this._level = value;
        this.queue_repaint();
    }

    setCharging(charging) {
        const value = Boolean(charging);
        if (this._charging === value)
            return;
        this._charging = value;
        this.queue_repaint();
    }

    _roundedRect(cr, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        cr.newSubPath();
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.lineTo(x + width - r, y);
        cr.arc(x + width - r, y + r, r, 1.5 * Math.PI, 0);
        cr.lineTo(x + width, y + height - r);
        cr.arc(x + width - r, y + height - r, r, 0, 0.5 * Math.PI);
        cr.lineTo(x + r, y + height);
        cr.arc(x + r, y + height - r, r, 0.5 * Math.PI, Math.PI);
        cr.closePath();
    }

    _draw() {
        const cr = this.get_context();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const [width, height] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();

        cr.setSourceColor(color);
        cr.setLineWidth(Math.max(1, Math.round(1.25 * scale)));

        const terminalWidth = 2 * scale;
        const terminalHeight = Math.max(3 * scale, height * 0.36);
        const gap = 1.5 * scale;
        const bodyWidth = Math.max(1, width - terminalWidth - gap);
        const radius = 2.5 * scale;

        this._roundedRect(cr, 0.5 * scale, 0.5 * scale,
            bodyWidth - scale, height - scale, radius);
        cr.stroke();

        // Borne derecho.
        const terminalX = bodyWidth + gap;
        const terminalY = (height - terminalHeight) / 2;
        this._roundedRect(cr, terminalX, terminalY,
            terminalWidth, terminalHeight, 0.8 * scale);
        cr.fill();

        // Relleno proporcional.
        const innerX = 2.5 * scale;
        const innerY = 2.5 * scale;
        const innerWidth = (bodyWidth - 5 * scale) * this._level;
        const innerHeight = height - 5 * scale;
        if (innerWidth > 0.5) {
            this._roundedRect(cr, innerX, innerY,
                innerWidth, innerHeight, Math.min(radius * 0.5, innerWidth / 2));
            cr.fill();
        }

        if (this._charging) {
            // Rayo recortado sobre el relleno.
            const cx = innerX + Math.max(innerWidth, 1) * 0.5;
            const cy = height / 2;
            const s = height * 0.34;

            cr.save();
            try {
                cr.setOperator(0); // Cairo.Operator.CLEAR
            } catch (_e) {
                // Ignorar.
            }
            cr.newSubPath();
            cr.moveTo(cx - s * 0.15, cy - s * 1.15);
            cr.lineTo(cx + s * 0.75, cy - s * 1.15);
            cr.lineTo(cx + s * 0.05, cy - s * 0.1);
            cr.lineTo(cx + s * 0.55, cy - s * 0.1);
            cr.lineTo(cx - s * 0.35, cy + s * 1.15);
            cr.lineTo(cx - s * 0.02, cy + s * 0.15);
            cr.lineTo(cx - s * 0.6, cy + s * 0.15);
            cr.closePath();
            cr.fill();
            cr.restore();
        }

        cr.$dispose();
    }
});

/**
 * Glifo del Centro de control: dos pastillas con un punto cada una.
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

export {ICON_STYLE};
