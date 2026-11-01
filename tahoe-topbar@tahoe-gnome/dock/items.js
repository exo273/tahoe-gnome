// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Actores del Dock flotante.
//
// Un DockItem es un St.Button con un icono, una zona reservada para el punto
// de aplicación en ejecución y un menú contextual perezoso. La magnificación
// se aplica sólo al actor del icono (nunca al contenedor): así el reparto del
// St.BoxLayout no cambia y los centros de los iconos permanecen estables.

'use strict';

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

export const DOCK_ITEM_STYLE = 'tahoe-dock-item';

function safeScale(actor, scale) {
    if (!actor || typeof actor.set_scale !== 'function')
        return;
    if (Math.abs(actor.scale_x - scale) < 0.001 &&
        Math.abs(actor.scale_y - scale) < 0.001)
        return;
    actor.set_scale(scale, scale);
}

export class DockItemBase {
    constructor(dock, {styleClass = '', accessibleName = '', tooltip = ''} = {}) {
        this._dock = dock;
        this._destroyed = false;
        this._scale = 1;
        this._menu = null;
        this._tooltipText = tooltip;
        this._icon = null;
        this._iconStack = null;
        this._indicatorBox = null;
        this._focusRing = null;

        this.actor = new St.Button({
            style_class: `${DOCK_ITEM_STYLE} ${styleClass}`.trim(),
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            accessible_name: accessibleName || tooltip,
        });

        this.actor._delegate = this;
        this.actor.connect('clicked', (_actor, button) => {
            if (this._destroyed)
                return;
            this.onClicked(button);
        });
        this.actor.connect('notify::hover', () => {
            if (this._destroyed)
                return;
            const hovered = this.actor.hover;
            this._dock._onItemHover?.(this, hovered);
            if (hovered)
                this._dock._showTooltip(this);
            else
                this._dock._hideTooltip(this);
        });
        // El aro de foco sólo debe verse al navegar con teclado, nunca tras
        // un clic: se muestra el actor del aro en key-focus-in y se oculta al
        // salir. No se pinta ningún fondo sobre el botón.
        this.actor.connect('key-focus-in', () => {
            if (!this._destroyed)
                this._focusRing?.show();
        });
        this.actor.connect('key-focus-out', () => {
            if (!this._destroyed)
                this._focusRing?.hide();
        });
        this.actor.connect('destroy', () => {
            this._destroyed = true;
            this._destroyMenu();
        });
    }

    /* ------------------------------------------------------------------ */
    /* Construcción visual                                                 */
    /* ------------------------------------------------------------------ */

    _buildContent(iconActor, {indicator = false, badge = false} = {}) {
        const dock = this._dock;
        const iconSize = dock.iconSizePx;
        const contentHeight = iconSize + dock.indicatorSpacePx;

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            width: iconSize,
            height: contentHeight,
            x_expand: false,
            y_expand: false,
        });

        this._iconStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: iconSize,
            height: iconSize,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });

        // Aro de foco de teclado: actor propio para que sea redondeado y no
        // pinte ningún fondo detrás del icono (la losa que se veía al hover).
        const ringSize = iconSize + dock._px(6);
        this._focusRing = new St.Widget({
            style_class: 'tahoe-dock-focus-ring',
            width: ringSize,
            height: ringSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            visible: false,
        });
        this._iconStack.add_child(this._focusRing);

        this._icon = iconActor;
        if (this._icon) {
            this._icon.x_align = Clutter.ActorAlign.CENTER;
            this._icon.y_align = Clutter.ActorAlign.CENTER;
            dock.applyIconPivot(this._icon);
            this._iconStack.add_child(this._icon);
        }

        if (badge) {
            this._badge = new St.Label({
                style_class: 'tahoe-dock-badge',
                text: '',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                visible: false,
                reactive: false,
            });
            this._iconStack.add_child(this._badge);
        }

        content.add_child(this._iconStack);

        if (indicator) {
            this._indicatorBox = new St.BoxLayout({
                style_class: 'tahoe-dock-indicator-box',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
                height: dock.indicatorSpacePx,
                x_expand: false,
                y_expand: false,
                visible: false,
                reactive: false,
            });
            content.add_child(this._indicatorBox);
        }

        this.actor.set_child(content);
        return content;
    }

    get iconActor() {
        return this._icon;
    }

    get tooltipText() {
        return this._tooltipText;
    }

    setTooltipText(text) {
        this._tooltipText = text ?? '';
        this.actor.accessible_name = this._tooltipText;
        this.actor.accessible_description = this._tooltipText;
    }

    setMagnification(scale) {
        if (this._destroyed)
            return;
        this._scale = scale;
        safeScale(this._icon, scale);
    }

    getIconGeometry() {
        if (this._destroyed || !this._icon || !this.actor.mapped)
            return null;

        const [x, y] = this._icon.get_transformed_position();
        const [width, height] = this._icon.get_transformed_size();
        if (!(width > 0) || !(height > 0))
            return null;

        return {
            x, y, width, height,
            left: x, top: y,
            right: x + width, bottom: y + height,
        };
    }

    /* ------------------------------------------------------------------ */
    /* Menú y clic                                                         */
    /* ------------------------------------------------------------------ */

    openPopup() {
        if (this._destroyed)
            return;
        this._dock._hideTooltip(this);
        this._dock._openItemMenu(this);
    }

    onClicked(_button) {
        this.openPopup();
    }

    _destroyMenu() {
        if (this._menu) {
            try {
                this._menu.destroy();
            } catch (_e) {
                // El menú ya estaba destruido.
            }
            this._menu = null;
        }
    }

    destroy() {
        if (this._destroyed) {
            this._destroyMenu();
            return;
        }
        this._destroyMenu();
        this._destroyed = true;
        if (this.actor) {
            const actor = this.actor;
            this.actor = null;
            actor.destroy();
        }
        this._icon = null;
        this._iconStack = null;
        this._indicatorBox = null;
        this._focusRing = null;
        this._badge = null;
    }
}

export class DockAppItem extends DockItemBase {
    constructor(dock, app, {favorite = false} = {}) {
        super(dock, {
            styleClass: 'tahoe-dock-app',
            accessibleName: app.get_name(),
            tooltip: app.get_name(),
        });

        this.app = app;
        this.isFavorite = favorite;
        this._windows = [];
        this._draggable = null;

        const iconSize = dock.iconSizePx;
        let icon;
        try {
            icon = app.create_icon_texture(iconSize);
        } catch (e) {
            console.error(`[tahoe-dock] No se pudo crear el icono de ${app.get_id()}:`, e);
        }
        if (!icon) {
            icon = new St.Icon({
                gicon: dock.fallbackIcon,
                icon_size: iconSize,
            });
        }

        this._buildContent(icon, {indicator: true});
        this.syncWindows(this._windows, false);

        if (this.canDrag()) {
            try {
                this._draggable = DND.makeDraggable(this.actor, {timeoutThreshold: 200});
                this._draggable.connect('drag-begin', () => {
                    this._dock._hideTooltip(this);
                });
            } catch (e) {
                console.error('[tahoe-dock] No se pudo hacer arrastrable un icono:', e);
                this._draggable = null;
            }
        }
    }

    canDrag() {
        return !this.app.is_window_backed() && this._dock._canEditFavorites();
    }

    getDragActor() {
        try {
            return this.app.create_icon_texture(this._dock.iconSizePx);
        } catch (_e) {
            return new St.Icon({
                gicon: this._dock.fallbackIcon,
                icon_size: this._dock.iconSizePx,
            });
        }
    }

    getDragActorSource() {
        return this._icon;
    }

    onClicked(button) {
        if (button === Clutter.BUTTON_SECONDARY) {
            this.openPopup();
            return;
        }
        this._dock._activateApp(this.app, button);
    }

    syncWindows(windows, focused) {
        if (this._destroyed)
            return;

        this._windows = windows ?? [];
        const running = this.app.state !== Shell.AppState.STOPPED ||
            this._windows.length > 0;

        if (running)
            this.actor.add_style_class_name('tahoe-dock-item-running');
        else
            this.actor.remove_style_class_name('tahoe-dock-item-running');

        if (focused)
            this.actor.add_style_class_name('tahoe-dock-item-focused');
        else
            this.actor.remove_style_class_name('tahoe-dock-item-focused');

        this._rebuildIndicator(running);
    }

    _rebuildIndicator(running) {
        const box = this._indicatorBox;
        if (!box)
            return;

        box.destroy_all_children();
        if (!running) {
            box.hide();
            return;
        }

        const windows = this._windows;
        const minimized = windows.length > 0 && windows.every(w => w.minimized);
        const launching = windows.length === 0;
        const style = this._dock.indicatorStyle;
        const dock = this._dock;

        if (style === 'lines') {
            const line = new St.Widget({
                style_class: 'tahoe-dock-indicator tahoe-dock-indicator-line',
                y_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });
            const count = Math.max(1, windows.length);
            line.set_size(dock._px(12 + Math.min(count - 1, 3) * 4), dock._px(3));
            if (minimized)
                line.add_style_class_name('minimized');
            if (launching)
                line.add_style_class_name('launching');
            box.add_child(line);
        } else {
            const count = Math.max(1, Math.min(windows.length, 4));
            for (let i = 0; i < count; i++) {
                const dot = new St.Widget({
                    style_class: 'tahoe-dock-indicator tahoe-dock-indicator-dot',
                    y_align: Clutter.ActorAlign.CENTER,
                    reactive: false,
                });
                dot.set_size(dock._px(4), dock._px(4));
                if (minimized || windows[i]?.minimized)
                    dot.add_style_class_name('minimized');
                if (launching)
                    dot.add_style_class_name('launching');
                box.add_child(dot);
            }
        }

        box.show();
    }

    destroy() {
        this._draggable = null;
        super.destroy();
    }
}

export class DockControlItem extends DockItemBase {
    constructor(dock, {
        id = '',
        iconName = null,
        gicon = null,
        iconSize = null,
        label = '',
        styleClass = '',
        badge = false,
        onClick = null,
        onSecondary = null,
    } = {}) {
        super(dock, {
            styleClass: `tahoe-dock-control ${styleClass}`.trim(),
            accessibleName: label,
            tooltip: label,
        });

        this.id = id;
        this._onClick = onClick;
        this._onSecondary = onSecondary;
        this._name = label;

        const size = iconSize ?? Math.round(dock.iconSizePx * 0.82);
        // No pasar gicon: null junto a icon_name: St.Icon aplica las
        // propiedades en orden y un gicon nulo puede borrar el nombre.
        const iconProps = {icon_size: size};
        if (gicon)
            iconProps.gicon = gicon;
        else
            iconProps.icon_name = iconName ?? 'application-x-executable-symbolic';
        const icon = new St.Icon(iconProps);

        this._buildContent(icon, {badge});
    }

    onClicked(button) {
        if (button === Clutter.BUTTON_SECONDARY && this._onSecondary) {
            this._onSecondary();
            return;
        }
        this._onClick?.();
    }

    setBadge(count) {
        if (!this._badge)
            return;

        if (!count || count <= 0) {
            this._badge.hide();
            return;
        }

        this._badge.text = count > 99 ? '99+' : `${count}`;
        this._badge.show();
    }

    setIconName(name) {
        if (!this._icon)
            return;
        this._icon.gicon = null;
        this._icon.icon_name = name;
    }

    setGIcon(gicon) {
        if (!this._icon)
            return;
        this._icon.icon_name = null;
        this._icon.gicon = gicon;
    }

    setName(name) {
        this._name = name;
        this.setTooltipText(name);
    }

    get name() {
        return this._name;
    }
}

export class DockSeparator {
    constructor(dock, vertical = false) {
        this._destroyed = false;
        const length = Math.round(dock.iconSizePx * 0.66);
        this.actor = new St.Widget({
            style_class: 'tahoe-dock-separator',
            reactive: false,
        });

        if (vertical) {
            // Línea vertical para un dock horizontal.
            this.actor.set_size(dock._px(1), length);
            this.actor.y_align = Clutter.ActorAlign.CENTER;
        } else {
            // Línea horizontal para un dock vertical.
            this.actor.set_size(length, dock._px(1));
            this.actor.x_align = Clutter.ActorAlign.CENTER;
        }
    }

    setMagnification(_scale) {
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this.actor) {
            const actor = this.actor;
            this.actor = null;
            actor.destroy();
        }
    }
}
