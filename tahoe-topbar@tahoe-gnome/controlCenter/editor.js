// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Editor del Centro de control ("Editar controles").
//
// La galería se inserta como hija del actor del menú del CC. Así comparte el
// mismo "grab" modal que PopupMenuManager ya tiene para el panel: cualquier
// clic dentro de la galería cuenta como dentro del menú y NO cierra el CC.
// El menú contextual y los proxies de arrastre viven en una capa BinLayout
// dentro de ese mismo menú, por la misma razón.
//
// Reordenar en el CC se hace sin reconstruir: se animan los contenedores ya
// existentes a sus nuevas celdas (200 ms) y sólo al final se reordena el
// LayoutManager; el cristal sigue a cada actor porque sus regiones se leen
// por frame.

'use strict';

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {glassLook} from '../liquidGlass.js';
import {CONTROL_SIZES, sizeSpan} from './layout.js';

const LOG = '[tahoe-topbar/cc]';

const CATEGORY_ORDER = [
    'Conectividad', 'Pantalla', 'Sonido', 'Concentración',
    'Accesibilidad', 'Batería', 'Utilidades', 'Extensiones',
];

const CATEGORY_ICONS = {
    'Conectividad': 'network-wireless-symbolic',
    'Pantalla': 'video-display-symbolic',
    'Sonido': 'audio-volume-high-symbolic',
    'Concentración': 'weather-clear-night-symbolic',
    'Accesibilidad': 'preferences-desktop-accessibility-symbolic',
    'Batería': 'battery-good-symbolic',
    'Utilidades': 'applications-utilities-symbolic',
    'Extensiones': 'application-x-addon-symbolic',
    'Todos': 'view-app-grid-symbolic',
};

const CATEGORY_SLUGS = {
    'Conectividad': 'connectivity',
    'Pantalla': 'display',
    'Sonido': 'sound',
    'Concentración': 'focus',
    'Accesibilidad': 'accessibility',
    'Batería': 'battery',
    'Utilidades': 'utilities',
    'Extensiones': 'extensions',
    'Todos': 'all',
};

const SIZE_LABELS = {
    small: 'Pequeño',
    medium: 'Mediano',
    large: 'Grande',
    wide: 'Ancho',
};

const SIZE_ORDER = ['small', 'medium', 'large', 'wide'];

function normalize(text) {
    return String(text ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function px(value) {
    try {
        return Math.max(1, Math.round(
            value * (St.ThemeContext.get_for_stage(global.stage).scale_factor || 1)));
    } catch (_e) {
        return value;
    }
}

function rectOf(actor) {
    if (!actor)
        return [0, 0, 0, 0];
    const r = actor.get_transformed_extents();
    return [r.origin.x, r.origin.y, r.size.width, r.size.height];
}

function contains(rect, x, y) {
    return x >= rect[0] && x <= rect[0] + rect[2] &&
        y >= rect[1] && y <= rect[1] + rect[3];
}

function makeInert(actor) {
    if (!actor)
        return;

    const stack = [actor];
    while (stack.length > 0) {
        const node = stack.pop();
        try {
            node.reactive = false;
            node.can_focus = false;
            node.track_hover = false;
        } catch (_e) {
            // Actor ya destruido.
        }
        for (const child of node.get_children?.() ?? [])
            stack.push(child);
    }
}

export class ControlCenterEditor {
    constructor(cc) {
        this._cc = cc;
        this._editing = false;

        this._gallery = null;
        this._galleryHandle = null;
        this._categoryButtons = new Map();
        this._rightContent = null;
        this._rightScroll = null;
        this._searchEntry = null;
        this._searchText = '';
        this._category = 'Todos';

        this._galleryItems = new Map();
        this._stageCaptureId = 0;

        this._drag = null;
        this._dropHint = null;
        this._barHint = null;
        this._timeouts = new Set();
        this._layoutCommit = null;
        this._context = null;
        this._footerNormal = null;
        this._footerConfirm = null;

        this._barBackup = new Map();
        this._suppressGalleryClick = false;
    }

    // ------------------------------------------------------------------
    // Entrada / salida del modo edición
    // ------------------------------------------------------------------

    enter() {
        if (this._editing)
            return;

        this._editing = true;
        this._ensureGallery();
        this._gallery.visible = true;
        this._attachGalleryGlass();
        this._refreshGallery();
        this._connectStageCapture();
        this._beginBarEdit();
    }

    leave() {
        if (!this._editing) {
            if (this._gallery)
                this._gallery.visible = false;
            return;
        }

        this._editing = false;
        try {
            if (this._gallery?.contains(global.stage.get_key_focus()))
                global.stage.set_key_focus(null);
        } catch (_e) {
            // Sin foco.
        }
        this._flushLayoutCommit();
        this._cancelDrag();
        this._clearDropHint(true);
        this._clearTimers();
        this._closeContext();
        this._endBarEdit();
        this._disconnectStageCapture();
        this._destroyPreviewGlass();
        this._destroyGalleryGlass();

        if (this._gallery)
            this._gallery.visible = false;
    }

    destroy() {
        this.leave();
        if (this._gallery) {
            this._gallery.destroy();
            this._gallery = null;
        }
        this._cc = null;
    }

    onMainRendered(_placed, _grid) {
        if (!this._editing)
            return;

        // Si el CC se reconstruye por otra vía mientras hay un arrastre,
        // los wrappers del drag dejan de existir: cancelamos antes de tocar
        // actores liberados (el proxy y los hints se limpian aquí).
        if (this._drag)
            this._cancelDrag();

        this._closeContext();
        this._decorateMain();
        this._refreshGallery();
    }

    // ------------------------------------------------------------------
    // Cristal
    // ------------------------------------------------------------------

    _attachGalleryGlass() {
        const cc = this._cc;
        if (!cc || !this._gallery || this._galleryHandle)
            return;

        if (cc._glassStyle !== 'liquid' || !cc._glassEngine)
            return;

        this._galleryHandle = cc._glassEngine.attach(this._gallery,
            glassLook(cc._tahoeTheme, {
                cornerRadius: 26,
                blurRadius: 14,
                owner: 'cc-gallery',
            }));
    }

    _destroyGalleryGlass() {
        this._galleryHandle?.destroy();
        this._galleryHandle = null;
    }

    _destroyPreviewGlass() {
        // Las vistas previas usan cristal CSS sobre el de la galería.
    }

    refreshGlass() {
        if (!this._editing)
            return;

        this._destroyGalleryGlass();
        this._attachGalleryGlass();
        this._closeContext();
        this._refreshGallery();
    }

    refreshLook() {
        const cc = this._cc;
        if (!cc || !this._editing)
            return;

        const look = glassLook(cc._tahoeTheme);
        for (const handle of [
            this._galleryHandle,
            this._context?.handle,
        ]) {
            try {
                handle?.update(look);
            } catch (_e) {
                // Handle ya destruido.
            }
        }
    }

    // ------------------------------------------------------------------
    // Galería
    // ------------------------------------------------------------------

    _ensureGallery() {
        if (this._gallery)
            return;

        const cc = this._cc;
        const gallery = new St.BoxLayout({
            style_class: 'tahoe-cc-glass tahoe-cc-gallery',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });

        // Columna izquierda: búsqueda y categorías.
        const sidebar = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-sidebar',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: false,
            y_expand: true,
        });

        const title = new St.Label({
            text: 'Editar controles',
            style_class: 'tahoe-cc-gallery-title',
            x_align: Clutter.ActorAlign.START,
        });
        sidebar.add_child(title);

        this._searchEntry = new St.Entry({
            style_class: 'tahoe-cc-gallery-search',
            hint_text: 'Buscar controles',
            can_focus: true,
            primary_icon: new St.Icon({
                icon_name: 'edit-find-symbolic',
                icon_size: 14,
                style_class: 'tahoe-cc-gallery-search-icon',
            }),
        });
        this._searchEntry.clutter_text.connect('notify::text', () => {
            if (!this._searchEntry)
                return;
            this._searchText = this._searchEntry.text ?? '';
            if (!this._editing)
                return;
            if (this._searchText.trim() && this._category !== 'Todos') {
                this._category = 'Todos';
                this._refreshCategories();
            }
            this._rebuildRight();
        });
        sidebar.add_child(this._searchEntry);

        this._categoryList = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-categories',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        sidebar.add_child(this._categoryList);

        // Columna derecha: contenido desplazable + pie.
        const right = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-main',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this._rightScroll = new St.ScrollView({
            style_class: 'tahoe-cc-gallery-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });

        this._rightContent = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._rightScroll.set_child(this._rightContent);
        right.add_child(this._rightScroll);

        right.add_child(this._buildFooter());

        gallery.add_child(sidebar);
        gallery.add_child(right);

        gallery.connect('destroy', () => {
            if (this._gallery === gallery) {
                this._gallery = null;
                this._rightContent = null;
                this._rightScroll = null;
                this._categoryList = null;
                this._searchEntry = null;
                this._galleryHandle = null;
            }
        });

        cc._ccRow.insert_child_at_index(gallery, 0);
        this._gallery = gallery;
    }

    _buildFooter() {
        const footer = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-footer',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._footerNormal = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-footer-normal',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const hint = new St.Label({
            text: 'Arrastra un control al Centro de control o a la barra de menús…',
            style_class: 'tahoe-cc-gallery-hint',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        hint.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._footerNormal.add_child(hint);

        const reset = new St.Button({
            style_class: 'tahoe-cc-gallery-reset',
            can_focus: true,
            reactive: true,
            track_hover: true,
            child: new St.Label({text: 'Restablecer'}),
            accessible_name: 'Restablecer el diseño de Tahoe',
        });
        reset.connect('clicked', () => this._showResetConfirm());
        this._footerNormal.add_child(reset);

        const done = new St.Button({
            style_class: 'tahoe-cc-gallery-done',
            can_focus: true,
            reactive: true,
            track_hover: true,
            child: new St.Label({text: 'Hecho'}),
            accessible_name: 'Hecho',
        });
        done.connect('clicked', () => this._cc?.exitEditMode());
        this._footerNormal.add_child(done);

        this._footerConfirm = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-footer-confirm',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._footerConfirm.add_child(new St.Label({
            text: '¿Restablecer el diseño de Tahoe?',
            style_class: 'tahoe-cc-gallery-hint',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        const yes = new St.Button({
            style_class: 'tahoe-cc-gallery-done',
            child: new St.Label({text: 'Sí'}),
            reactive: true,
            can_focus: true,
        });
        yes.connect('clicked', () => {
            this._cc?.resetLayout();
            this._cc?.setMenubarControls(['battery', 'sound', 'wifi']);
            this._hideResetConfirm();
        });
        this._footerConfirm.add_child(yes);

        const no = new St.Button({
            style_class: 'tahoe-cc-gallery-reset',
            child: new St.Label({text: 'No'}),
            reactive: true,
            can_focus: true,
        });
        no.connect('clicked', () => this._hideResetConfirm());
        this._footerConfirm.add_child(no);

        footer.add_child(this._footerNormal);
        footer.add_child(this._footerConfirm);
        return footer;
    }

    _showResetConfirm() {
        this._footerNormal.visible = false;
        this._footerConfirm.visible = true;
    }

    _hideResetConfirm() {
        this._footerNormal.visible = true;
        this._footerConfirm.visible = false;
    }

    _catalog() {
        const list = this._cc?.getRegistry?.() ?? [];
        return list.map(entry => ({
            ...entry,
            control: this._cc._registry?.get(entry.id) ?? null,
        })).filter(entry => entry.control);
    }

    _refreshGallery() {
        if (!this._editing || !this._gallery)
            return;

        this._refreshCategories();
        this._rebuildRight();
    }

    _refreshCategories() {
        const catalog = this._catalog();
        const present = new Set(catalog.map(entry => entry.category));
        const categories = ['Todos',
            ...CATEGORY_ORDER.filter(category => present.has(category))];

        if (!categories.includes(this._category))
            this._category = 'Todos';

        this._categoryList.destroy_all_children();
        this._categoryButtons.clear();

        for (const category of categories) {
            const button = new St.Button({
                style_class: 'tahoe-cc-gallery-category',
                can_focus: true,
                reactive: true,
                track_hover: true,
                x_expand: true,
                accessible_name: category === 'Todos'
                    ? 'Todos los controles'
                    : category,
            });

            const row = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'tahoe-cc-gallery-category-row',
            });

            const square = new St.Bin({
                style_class: `tahoe-cc-cat-square tahoe-cc-cat-${CATEGORY_SLUGS[category]}`,
                width: 24,
                height: 24,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            square.set_child(new St.Icon({
                icon_name: CATEGORY_ICONS[category] ?? 'application-x-addon-symbolic',
                icon_size: 13,
                style_class: 'tahoe-cc-cat-icon',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(square);
            row.add_child(new St.Label({
                text: category === 'Todos'
                    ? 'Todos los controles'
                    : category,
                style_class: 'tahoe-cc-gallery-category-label',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            }));

            button.set_child(row);
            if (category === this._category)
                button.add_style_class_name('tahoe-cc-gallery-category-selected');

            button.connect('clicked', () => {
                this._category = category;
                this._refreshCategories();
                this._rebuildRight();
            });

            this._categoryButtons.set(category, button);
            this._categoryList.add_child(button);
        }
    }

    _rebuildRight() {
        if (!this._rightContent)
            return;

        this._destroyPreviewGlass();
        this._galleryItems.clear();
        this._rightContent.destroy_all_children();

        const layout = this._cc?.getLayout?.() ?? [];
        const inLayout = new Set(layout.map(entry => entry.id));
        const query = normalize(this._searchText);

        let catalog = this._catalog();
        if (this._category !== 'Todos' && !query)
            catalog = catalog.filter(entry => entry.category === this._category);

        if (query) {
            catalog = catalog.filter(entry =>
                normalize(entry.name).includes(query) ||
                normalize(entry.id).includes(query));
        } else if (this._category === 'Todos') {
            this._rightContent.add_child(this._buildNewsCard());
        }

        if (catalog.length === 0) {
            const empty = new St.Label({
                text: this._searchText
                    ? 'No se encontraron controles'
                    : 'No hay controles en esta categoría',
                style_class: 'tahoe-cc-gallery-empty',
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._rightContent.add_child(empty);
            return;
        }

        const grouped = new Map();
        for (const entry of catalog) {
            if (!grouped.has(entry.category))
                grouped.set(entry.category, []);
            grouped.get(entry.category).push(entry);
        }

        const categories = [
            ...CATEGORY_ORDER.filter(category => grouped.has(category)),
            ...[...grouped.keys()].filter(category =>
                !CATEGORY_ORDER.includes(category)),
        ];

        for (const category of categories) {
            const entries = grouped.get(category) ?? [];
            if (entries.length === 0)
                continue;

            const section = new St.BoxLayout({
                style_class: 'tahoe-cc-gallery-section',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            section.add_child(new St.Label({
                text: category,
                style_class: 'tahoe-cc-gallery-section-title',
                x_align: Clutter.ActorAlign.START,
            }));

            let row = null;
            let rowWidth = 0;
            const maxWidth = 480;

            for (const entry of entries) {
                const span = sizeSpan(entry.defaultSize);
                const itemWidth = span.columns * px(62) +
                    (span.columns - 1) * px(12);

                if (!row || rowWidth + itemWidth + 16 > maxWidth) {
                    row = new St.BoxLayout({
                        style_class: 'tahoe-cc-gallery-row',
                        x_expand: true,
                        x_align: Clutter.ActorAlign.START,
                    });
                    section.add_child(row);
                    rowWidth = 0;
                }

                const item = this._createPreview(entry, span, inLayout);
                row.add_child(item);
                rowWidth += itemWidth + 16;
            }

            this._rightContent.add_child(section);
        }

    }

    _buildNewsCard() {
        const card = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-news',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        card.add_child(new St.Label({
            text: 'Novedades',
            style_class: 'tahoe-cc-gallery-news-title',
            x_align: Clutter.ActorAlign.START,
        }));
        const body = new St.Label({
            text: 'Personaliza el Centro de control: añade, quita,\ncambia de tamaño y reordena controles.\n' +
                'Los controles de otras extensiones aparecen en Extensiones.',
            style_class: 'tahoe-cc-gallery-news-body',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        body.clutter_text.set_line_wrap(false);
        card.add_child(body);
        return card;
    }

    _createPreview(entry, span, inLayout) {
        const cc = this._cc;
        const exists = inLayout.has(entry.id);

        const button = new St.Button({
            style_class: 'tahoe-cc-gallery-item',
            name: `tahoe-gallery-${entry.id}`,
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            accessible_name: entry.name,
        });

        const column = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-item-column',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
        });

        const holder = new St.Bin({
            style_class: 'tahoe-cc-gallery-preview',
            width: span.columns * px(62) + (span.columns - 1) * px(12),
            height: span.rows * px(62) + (span.rows - 1) * px(12),
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });

        let built = null;
        try {
            built = entry.control.create(entry.defaultSize);
        } catch (e) {
            console.error(`${LOG} No se pudo previsualizar «${entry.id}»:`, e);
        }

        if (built?.actor) {
            makeInert(built.actor);
            holder.set_child(built.actor);
            button._tahoePreviewActor = built.actor;
        }

        button._tahoePreviewWidth =
            span.columns * px(62) + (span.columns - 1) * px(12);
        button._tahoePreviewHeight =
            span.rows * px(62) + (span.rows - 1) * px(12);

        column.add_child(holder);

        const labelRow = new St.BoxLayout({
            style_class: 'tahoe-cc-gallery-item-label-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        labelRow.add_child(new St.Label({
            text: entry.name,
            style_class: 'tahoe-cc-gallery-item-label',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        if (exists) {
            labelRow.add_child(new St.Icon({
                icon_name: 'object-select-symbolic',
                icon_size: 11,
                style_class: 'tahoe-cc-gallery-check',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        column.add_child(labelRow);
        button._tahoeControlId = entry.id;
        button._tahoePreviewEntry = entry;
        this._galleryItems.set(entry.id, button);
        button.set_child(column);

        if (exists)
            button.add_style_class_name('tahoe-cc-gallery-in-layout');

        button.connect('clicked', () => {
            if (this._suppressGalleryClick) {
                this._suppressGalleryClick = false;
                return;
            }
            if (!exists)
                this._addControl(entry);
        });

        this._attachDragHandlers(button, {
            id: entry.id,
            source: 'gallery',
            actor: built?.actor ?? button,
            width: span.columns * px(62) + (span.columns - 1) * px(12),
            height: span.rows * px(62) + (span.rows - 1) * px(12),
            button,
        });

        return button;
    }

    // ------------------------------------------------------------------
    // Operaciones sobre el layout
    // ------------------------------------------------------------------

    _addControl(entry, index = null) {
        const layout = this._cc.getLayout();
        if (layout.some(item => item.id === entry.id))
            return;

        const size = entry.sizes.includes(entry.defaultSize)
            ? entry.defaultSize
            : entry.sizes[0];

        const next = [...layout];
        const at = index === null
            ? next.length
            : Math.clamp(index, 0, next.length);
        next.splice(at, 0, {id: entry.id, size});
        this._cc.setLayout(next);
    }

    _removeControl(id) {
        const layout = this._cc.getLayout()
            .filter(entry => entry.id !== id);
        this._cc.setLayout(layout);
    }

    _changeSize(id, size) {
        const layout = this._cc.getLayout();
        const entry = layout.find(item => item.id === id);
        if (!entry || entry.size === size)
            return;

        const control = this._cc._registry?.get(id);
        if (!control?.sizes.includes(size))
            return;

        entry.size = size;
        this._cc.setLayout(layout);
    }

    _cycleSize(id, direction) {
        const layout = this._cc.getLayout();
        const entry = layout.find(item => item.id === id);
        const control = this._cc._registry?.get(id);
        if (!entry || !control)
            return;

        const sizes = SIZE_ORDER.filter(size => control.sizes.includes(size));
        if (sizes.length < 2)
            return;

        let index = sizes.indexOf(entry.size);
        if (index < 0)
            index = 0;
        index = Math.clamp(index + direction, 0, sizes.length - 1);
        this._changeSize(id, sizes[index]);
    }

    _reorderAnimated(id, targetIndex) {
        const cc = this._cc;
        if (!cc)
            return;

        const layout = cc.getLayout();
        const from = layout.findIndex(entry => entry.id === id);
        if (from < 0)
            return;

        const next = [...layout];
        const [entry] = next.splice(from, 1);
        const to = Math.clamp(targetIndex, 0, next.length);
        next.splice(to, 0, entry);

        if (from === to) {
            cc._persistLayout(layout, false);
            return;
        }

        this._commitReorderLayout(next, null);
    }

    /**
     * Aplica `next` sin reconstruir el CC: primero "hornea" las traslaciones
     * de la vista previa (lo que se ve ahora pasa a ser x/y) y después anima
     * cada wrapper a su celda final. El reordenado real de hijos se hace al
     * terminar, que es lo que fija el LayoutManager.
     */
    _commitReorderLayout(next, plan) {
        const cc = this._cc;
        const grid = cc?._mainRefs?.grid;
        if (!cc || !grid)
            return;

        cc._persistLayout(next, false);

        const placed = cc._mainRefs?.controls ?? [];
        const byId = new Map(placed.map(item => [item.control.id, item]));
        let targets = plan?.posById ?? null;

        if (!targets) {
            const entries = next
                .filter(entry => byId.has(entry.id))
                .map(entry => ({id: entry.id, size: entry.size}));
            const positions = this._computePositions(entries);
            targets = new Map(entries.map((entry, index) => [
                entry.id, positions[index],
            ]));
        }

        for (const item of placed) {
            const wrapper = item.wrapper;
            if (!wrapper?.get_parent())
                continue;

            const visualX = wrapper.x + (wrapper.translation_x || 0);
            const visualY = wrapper.y + (wrapper.translation_y || 0);

            try {
                wrapper.remove_all_transitions();
                wrapper.translation_x = 0;
                wrapper.translation_y = 0;
                wrapper.x = visualX;
                wrapper.y = visualY;
            } catch (_e) {
                continue;
            }

            const target = targets.get(item.control.id);
            if (!target)
                continue;

            try {
                wrapper.ease({
                    x: target.x,
                    y: target.y,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } catch (_e) {
                // Wrapper destruido entre medias.
            }
        }

        cc._mainRefs.controls = next
            .map(entry => byId.get(entry.id))
            .filter(Boolean);

        this._scheduleLayoutCommit(() => {
            if (cc._destroyed || cc._mainRefs?.grid !== grid)
                return;

            for (const entry of next) {
                const item = byId.get(entry.id);
                const wrapper = item?.wrapper;
                if (!wrapper?.get_parent())
                    continue;

                try {
                    wrapper.remove_all_transitions();
                    wrapper.translation_x = 0;
                    wrapper.translation_y = 0;
                    grid.remove_child(wrapper);
                    grid.add_child(wrapper);
                    const span = sizeSpan(entry.size);
                    grid.layout_manager.setSpan(grid, wrapper,
                        span.columns, span.rows);
                } catch (_e) {
                    // El actor ya no existe.
                }
            }
            grid.queue_relayout();
        });
    }

    _computePositions(placed) {
        const columns = 4;
        const cell = px(62);
        const gap = px(12);
        const occupied = new Set();
        const positions = [];
        let maxRow = 0;

        const free = (x, y, w, h) => {
            for (let dy = 0; dy < h; dy++) {
                for (let dx = 0; dx < w; dx++) {
                    if (occupied.has((y + dy) * columns + x + dx))
                        return false;
                }
            }
            return true;
        };

        for (const item of placed) {
            const span = sizeSpan(item.size);
            let found = false;

            for (let y = 0; y < 64 && !found; y++) {
                for (let x = 0; x <= columns - span.columns; x++) {
                    if (!free(x, y, span.columns, span.rows))
                        continue;

                    for (let dy = 0; dy < span.rows; dy++) {
                        for (let dx = 0; dx < span.columns; dx++)
                            occupied.add((y + dy) * columns + x + dx);
                    }

                    positions.push({
                        x: x * (cell + gap),
                        y: y * (cell + gap),
                    });
                    maxRow = Math.max(maxRow, y + span.rows);
                    found = true;
                    break;
                }
            }
        }

        return positions;
    }

    // ------------------------------------------------------------------
    // Utilidades de ciclo de vida del arrastre
    // ------------------------------------------------------------------

    _later(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            try {
                callback();
            } catch (e) {
                console.error(`${LOG} Error en temporizador del editor:`, e);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _cancelTimer(id) {
        if (!id)
            return;
        this._timeouts.delete(id);
        try {
            GLib.source_remove(id);
        } catch (_e) {
            // Ya se ejecutó.
        }
    }

    _clearTimers() {
        for (const id of [...this._timeouts])
            this._cancelTimer(id);
    }

    /**
     * El commit que reordena los hijos de la grid no se puede cancelar a
     * medias: si se sale del editor antes, se ejecuta en el acto.
     */
    _scheduleLayoutCommit(callback) {
        this._cancelLayoutCommit();
        const id = this._later(220, () => {
            this._layoutCommit = null;
            callback();
        });
        this._layoutCommit = {id, callback};
    }

    _cancelLayoutCommit() {
        const commit = this._layoutCommit;
        if (!commit)
            return;
        this._layoutCommit = null;
        this._cancelTimer(commit.id);
    }

    _flushLayoutCommit() {
        const commit = this._layoutCommit;
        if (!commit)
            return;
        this._layoutCommit = null;
        this._cancelTimer(commit.id);
        try {
            commit.callback();
        } catch (e) {
            console.error(`${LOG} No se pudo completar el reordenado:`, e);
        }
    }

    _dragEntrySize(drag) {
        const cc = this._cc;
        const existing = (cc?._mainRefs?.controls ?? [])
            .find(item => item.control.id === drag.id);
        if (existing)
            return existing.size;
        if (drag.item?.size)
            return drag.item.size;

        const entry = this._catalog().find(item => item.id === drag.id);
        if (!entry)
            return 'small';
        if (entry.sizes?.includes(entry.defaultSize))
            return entry.defaultSize;
        return entry.sizes?.[0] ?? 'small';
    }

    _basePositions() {
        const cc = this._cc;
        const placed = cc?._mainRefs?.controls ?? [];
        const byId = new Set(placed.map(item => item.control.id));
        const entries = (cc?.getLayout() ?? [])
            .filter(entry => byId.has(entry.id))
            .map(entry => ({id: entry.id, size: entry.size}));
        const positions = this._computePositions(entries);
        return new Map(entries.map((entry, index) => [
            entry.id, positions[index],
        ]));
    }

    /**
     * Distribución "virtual" con el control ya colocado en `targetIndex`.
     * No toca el LayoutManager: sólo sirve para calcular a qué celda debe
     * viajar cada wrapper (y dónde queda el hueco de inserción).
     */
    _buildPreviewPlan(drag, targetIndex) {
        const cc = this._cc;
        if (!cc)
            return null;

        const placed = cc._mainRefs?.controls ?? [];
        const byId = new Map(placed.map(item => [item.control.id, item]));
        const layout = cc.getLayout();
        const rest = layout
            .filter(entry => entry.id !== drag.id && byId.has(entry.id))
            .map(entry => ({id: entry.id, size: entry.size}));

        const entry = {id: drag.id, size: this._dragEntrySize(drag)};
        const index = Math.clamp(targetIndex, 0, rest.length);
        const entries = [
            ...rest.slice(0, index),
            entry,
            ...rest.slice(index),
        ];

        const positions = this._computePositions(entries);
        const posById = new Map();
        entries.forEach((item, i) => posById.set(item.id, positions[i]));

        const span = sizeSpan(entry.size);
        const cell = px(62);
        const gap = px(12);
        return {
            index,
            entry,
            entries,
            posById,
            hole: positions[index],
            width: span.columns * cell + (span.columns - 1) * gap,
            height: span.rows * cell + (span.rows - 1) * gap,
        };
    }

    _applyPreview(drag, plan) {
        const placed = this._cc?._mainRefs?.controls ?? [];

        for (const item of placed) {
            const wrapper = item.wrapper;
            if (!wrapper?.get_parent())
                continue;

            const id = item.control.id;
            const target = plan.posById.get(id);
            if (!target)
                continue;

            const base = drag.base.get(id) ?? {x: wrapper.x, y: wrapper.y};
            const dx = Math.round(target.x - base.x);
            const dy = Math.round(target.y - base.y);
            if (!Number.isFinite(dx) || !Number.isFinite(dy))
                continue;
            const previous = drag.targets.get(id);

            if (previous &&
                Math.abs(previous.x - dx) < 0.5 &&
                Math.abs(previous.y - dy) < 0.5)
                continue;

            drag.targets.set(id, {x: dx, y: dy});

            try {
                wrapper.remove_all_transitions();
                wrapper.ease({
                    translation_x: dx,
                    translation_y: dy,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } catch (_e) {
                // Wrapper destruido.
            }
        }
    }

    _restorePreview(drag, duration = 200) {
        const placed = this._cc?._mainRefs?.controls ?? [];
        for (const item of placed) {
            const wrapper = item.wrapper;
            if (!wrapper?.get_parent())
                continue;
            if (!drag.targets.has(item.control.id))
                continue;

            try {
                wrapper.remove_all_transitions();
                wrapper.ease({
                    translation_x: 0,
                    translation_y: 0,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } catch (_e) {
                // Wrapper destruido.
            }
        }

        drag.targets.clear();
        drag.plan = null;
        drag.targetIndex = null;
        this._hideDropHint();
        this._clearBarHint(true);
    }

    _restorePreviewNow(drag) {
        const placed = this._cc?._mainRefs?.controls ?? [];
        for (const item of placed) {
            const wrapper = item.wrapper;
            if (!wrapper?.get_parent())
                continue;
            try {
                wrapper.remove_all_transitions();
                wrapper.translation_x = 0;
                wrapper.translation_y = 0;
            } catch (_e) {
                // Wrapper destruido.
            }
        }
        drag.targets.clear();
        drag.plan = null;
        drag.targetIndex = null;
        this._hideDropHint();
        this._clearBarHint(true);
    }

    _setSourceOpacity(info, opacity) {
        try {
            if (info.source === 'cc' && info.item?.wrapper)
                info.item.wrapper.opacity = opacity;
            else if (info.button)
                info.button.opacity = opacity;
        } catch (_e) {
            // El actor de origen ya no existe.
        }
    }

    // ------------------------------------------------------------------
    // Hueco de inserción y pista de la barra
    // ------------------------------------------------------------------

    _showDropHint(stageX, stageY, width, height, drag) {
        const overlay = this._cc?._editorOverlay;
        if (!overlay)
            return;
        if (![stageX, stageY, width, height].every(Number.isFinite))
            return;

        let hint = this._dropHint;
        if (!hint) {
            const dark = this._cc?._tahoeTheme?.isDark ?? true;
            const border = dark
                ? 'rgba(255, 255, 255, 0.62)'
                : 'rgba(0, 0, 0, 0.38)';
            const fill = dark
                ? 'rgba(255, 255, 255, 0.07)'
                : 'rgba(0, 0, 0, 0.05)';

            hint = new St.Widget({
                style_class: 'tahoe-cc-drop-hint',
                reactive: false,
                x_expand: false,
                y_expand: false,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
            });
            hint.style = `background-color: ${fill}; border: 1.5px dashed ${border}; border-radius: 18px;`;
            hint.opacity = 0;
            this._dropHint = hint;
        }

        if (!hint.get_parent()) {
            overlay.add_child(hint);
            try {
                hint.ease({
                    opacity: 255,
                    duration: 140,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } catch (_e) {
                hint.opacity = 255;
            }
        }

        hint.set_size(Math.max(1, Math.round(width)),
            Math.max(1, Math.round(height)));
        hint._overlayStageX = Math.round(stageX);
        hint._overlayStageY = Math.round(stageY);

        if (drag?.proxy) {
            try {
                overlay.set_child_below_sibling(hint, drag.proxy);
            } catch (_e) {
                // El proxy ya no está.
            }
        }
        overlay.queue_relayout();
    }

    _showDropHintForPlan(drag, plan) {
        const grid = this._cc?._mainRefs?.grid;
        if (!grid || !plan)
            return;
        const [gx, gy] = grid.get_transformed_position();
        this._showDropHint(gx + plan.hole.x, gy + plan.hole.y,
            plan.width, plan.height, drag);
    }

    _hideDropHint() {
        const hint = this._dropHint;
        this._dropHint = null;
        if (!hint)
            return;
        try {
            hint.destroy();
        } catch (_e) {
            // Ya destruido.
        }
    }

    _clearDropHint(immediate = false) {
        this._hideDropHint();
        this._clearBarHint(immediate);
    }

    /**
     * Línea vertical flotante sobre la barra. Vive en uiGroup para no
     * alterar la disposición del panel (y por tanto el anclaje del CC)
     * mientras se arrastra.
     */
    _showBarHint(index, excludeId) {
        const cc = this._cc;
        if (!cc)
            return;

        const ids = cc.getMenubarControls().filter(id => id !== excludeId);
        let anchor = null;
        let after = false;

        if (index < ids.length) {
            anchor = cc._getMenubarButton(ids[index])?.container ?? null;
        } else if (ids.length > 0) {
            anchor = cc._getMenubarButton(ids[ids.length - 1])?.container ?? null;
            after = true;
        } else {
            anchor = cc._ccButton?.container ?? null;
        }

        if (!anchor?.get_parent()) {
            this._clearBarHint(true);
            return;
        }

        const [ax, ay, aw, ah] = rectOf(anchor);
        const gap = px(6);
        const height = Math.max(14, Math.round(ah - px(8)));
        const x = after ? ax + aw + gap : ax - gap;
        const y = ay + Math.max(0, Math.round((ah - height) / 2));
        if (![x, y, height].every(Number.isFinite)) {
            this._clearBarHint(true);
            return;
        }

        let hint = this._barHint;
        if (!hint) {
            const dark = cc._tahoeTheme?.isDark ?? true;
            hint = new St.Widget({
                style_class: 'tahoe-cc-bar-insert-hint',
                reactive: false,
                width: px(3),
                height,
                opacity: 0,
            });
            hint.set_pivot_point(0.5, 0.5);
            hint.style = dark
                ? 'background-color: rgba(255, 255, 255, 0.92); border-radius: 2px; box-shadow: 0 0 6px rgba(255, 255, 255, 0.65);'
                : 'background-color: rgba(0, 0, 0, 0.72); border-radius: 2px; box-shadow: 0 0 6px rgba(0, 0, 0, 0.35);';
            this._barHint = hint;
        }

        const parent = Main.layoutManager?.uiGroup ?? global.stage;
        if (hint.get_parent() !== parent) {
            if (hint.get_parent())
                hint.get_parent().remove_child(hint);
            parent.add_child(hint);
            try {
                hint.ease({
                    opacity: 255,
                    scale_y: 1,
                    duration: 140,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } catch (_e) {
                hint.opacity = 255;
            }
        }

        hint.set_size(px(3), height);
        hint.set_position(Math.round(x), Math.round(y));
    }

    _clearBarHint(immediate = false) {
        const hint = this._barHint;
        this._barHint = null;
        if (!hint)
            return;

        if (immediate || !hint.get_parent()) {
            try {
                hint.destroy();
            } catch (_e) {
                // Ya destruido.
            }
            return;
        }

        try {
            hint.ease({
                opacity: 0,
                scale_y: 0.6,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    try {
                        hint.destroy();
                    } catch (_e) {
                        // Ya destruido.
                    }
                },
            });
        } catch (_e) {
            try {
                hint.destroy();
            } catch (_error) {
                // Ignorar.
            }
        }
    }

    // ------------------------------------------------------------------
    // Proxy y cierre del arrastre
    // ------------------------------------------------------------------

    _animateProxy(drag, stageX, stageY, options = {}) {
        const overlay = this._cc?._editorOverlay;
        const proxy = drag?.proxy;
        if (!overlay || !proxy?.get_parent())
            return false;

        // transform_stage_point() devuelve [ok, x, y].
        const [ok, lx, ly] = overlay.transform_stage_point(stageX, stageY);
        if (!ok || !Number.isFinite(lx) || !Number.isFinite(ly))
            return false;

        const {
            duration = 190,
            fade = false,
            scale = 1,
        } = options;

        try {
            proxy.remove_all_transitions();
            proxy.ease({
                translation_x: lx,
                translation_y: ly,
                scale_x: scale,
                scale_y: scale,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });

            if (fade) {
                proxy.ease({
                    opacity: 0,
                    delay: Math.round(duration * 0.55),
                    duration: Math.round(duration * 0.45),
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                });
            }
            return true;
        } catch (_e) {
            return false;
        }
    }

    _proxyHoleTarget(drag, plan) {
        const grid = this._cc?._mainRefs?.grid;
        if (!grid || !plan?.hole)
            return null;
        const [gx, gy] = grid.get_transformed_position();
        const x = gx + plan.hole.x;
        const y = gy + plan.hole.y;
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return null;
        return [x, y];
    }

    _proxyOriginTarget(drag) {
        const x = drag.start[0] - drag.offsetX;
        const y = drag.start[1] - drag.offsetY;
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return null;
        return [x, y];
    }

    _proxyBarTarget(drag) {
        const hint = this._barHint;
        if (!hint?.get_parent())
            return null;
        const [x, y, w, h] = rectOf(hint);
        const px = x + w / 2 - drag.offsetX;
        const py = y + h / 2 - drag.offsetY;
        if (!Number.isFinite(px) || !Number.isFinite(py))
            return null;
        return [px, py];
    }

    _destroyDragProxy(drag) {
        if (!drag)
            return;
        try {
            drag.clone?.set_source(null);
        } catch (_e) {
            // La fuente ya no existe.
        }
        drag.clone = null;
        try {
            drag.proxy?.destroy();
        } catch (_e) {
            // Ya destruido.
        }
        drag.proxy = null;
    }

    _finishDrag(drag, delay, action = null) {
        this._later(delay, () => {
            if (drag.cancelled || this._drag !== drag)
                return;

            this._destroyDragProxy(drag);
            if (this._drag === drag)
                this._drag = null;

            if (!action)
                return;
            try {
                action();
            } catch (e) {
                console.error(`${LOG} No se pudo completar el arrastre:`, e);
            }
        });
    }

    _commitGridDrop(drag, plan) {
        const cc = this._cc;
        if (!cc || !plan)
            return;

        const layout = cc.getLayout();
        const from = layout.findIndex(entry => entry.id === drag.id);

        if (from >= 0) {
            const rest = layout.filter((_entry, index) => index !== from);
            const to = Math.clamp(plan.index, 0, rest.length);
            if (to === from) {
                this._restorePreviewNow(drag);
                return;
            }

            const next = [...rest];
            next.splice(to, 0, layout[from]);
            this._commitReorderLayout(next, plan);
            return;
        }

        const entry = this._catalog().find(item => item.id === drag.id);
        if (entry)
            this._addControl(entry, Math.clamp(plan.index, 0, layout.length));
    }

    // ------------------------------------------------------------------
    // Decoración del CC en modo edición
    // ------------------------------------------------------------------

    _decorateMain() {
        const cc = this._cc;
        const placed = cc._mainRefs?.controls ?? [];
        if (placed.length === 0)
            return;

        for (const item of placed) {
            const wrapper = item.wrapper;
            if (!wrapper || wrapper._tahoeEditDecorated)
                continue;

            wrapper._tahoeEditDecorated = true;
            wrapper.reactive = true;
            wrapper.track_hover = true;
            makeInert(item.built.actor);

            const minus = new St.Button({
                style_class: 'tahoe-cc-edit-minus',
                can_focus: true,
                reactive: true,
                track_hover: true,
                accessible_name: `Quitar ${item.control.name}`,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
                child: new St.Icon({
                    icon_name: 'list-remove-symbolic',
                    icon_size: 12,
                    style_class: 'tahoe-cc-edit-minus-glyph',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
            minus.connect('clicked', () => this._removeControl(item.control.id));
            wrapper.add_child(minus);

            if (item.control.sizes.length > 1) {
                const handle = new St.Button({
                    style_class: 'tahoe-cc-edit-resize',
                    can_focus: true,
                    reactive: true,
                    track_hover: true,
                    accessible_name: `Cambiar tamaño de ${item.control.name}`,
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.END,
                    child: this._createResizeGlyph(),
                });
                this._attachResizeHandlers(handle, item);
                wrapper.add_child(handle);
            }

            wrapper.connect('button-press-event', (actor, event) => {
                if (event.get_button() === 3) {
                    const [x, y] = event.get_coords();
                    this._openContext(item, x, y);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            const span = sizeSpan(item.size);
            this._attachDragHandlers(wrapper, {
                id: item.control.id,
                source: 'cc',
                actor: item.built.actor,
                width: span.columns * px(62) + (span.columns - 1) * px(12),
                height: span.rows * px(62) + (span.rows - 1) * px(12),
                item,
            });

            // Un clic normal en un control inerte no debe hacer nada.
            wrapper.connect('button-release-event', () => Clutter.EVENT_PROPAGATE);
        }
    }

    _createResizeGlyph() {
        const area = new St.DrawingArea({
            style_class: 'tahoe-cc-edit-resize-glyph',
            width: 12,
            height: 12,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        area.connect('repaint', () => {
            const cr = area.get_context();
            const [width, height] = area.get_surface_size();
            cr.setLineWidth(1.4);
            cr.setSourceRGBA(1, 1, 1, 0.95);
            cr.arc(width / 2, height / 2, Math.min(width, height) * 0.42,
                0.15 * Math.PI, 0.85 * Math.PI);
            cr.stroke();
            cr.setSourceRGBA(1, 1, 1, 0.55);
            cr.arc(width / 2, height / 2, Math.min(width, height) * 0.22,
                0.15 * Math.PI, 0.85 * Math.PI);
            cr.stroke();
            cr.$dispose();
        });
        return area;
    }

    _attachResizeHandlers(handle, item) {
        let start = null;
        let grab = null;

        handle.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            start = {x, y};
            try {
                grab = global.stage.grab(actor);
            } catch (_e) {
                grab = null;
            }
            return Clutter.EVENT_STOP;
        });

        handle.connect('motion-event', () => Clutter.EVENT_STOP);

        handle.connect('button-release-event', (actor, event) => {
            if (!start)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            const delta = (x - start.x) + (y - start.y);
            start = null;

            try {
                if (grab && !grab.is_revoked())
                    grab.dismiss();
            } catch (_e) {
                // Ignorar.
            }
            grab = null;

            if (Math.abs(delta) > 8)
                this._cycleSize(item.control.id, delta > 0 ? 1 : -1);
            return Clutter.EVENT_STOP;
        });
    }

    // ------------------------------------------------------------------
    // Menú contextual
    // ------------------------------------------------------------------

    _openContext(item, stageX, stageY) {
        this._closeContext();

        const overlay = this._cc?._editorOverlay;
        if (!overlay)
            return;

        const catcher = new St.Widget({
            style_class: 'tahoe-cc-context-catcher',
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        catcher.connect('button-press-event', () => {
            this._closeContext();
            return Clutter.EVENT_STOP;
        });
        overlay.add_child(catcher);

        const dark = this._cc?._tahoeTheme?.isDark ?? true;
        const menu = new St.BoxLayout({
            style_class: 'tahoe-cc-context-menu tahoe-cc-context-solid',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            style: dark
                ? 'background-color: rgba(40, 40, 44, 0.84); border: 1px solid rgba(255, 255, 255, 0.24); border-radius: 14px;'
                : 'background-color: rgba(248, 248, 250, 0.92); border: 1px solid rgba(0, 0, 0, 0.12); border-radius: 14px; color: #1d1d1f;',
        });

        menu.add_child(new St.Label({
            text: item.control.name,
            style_class: 'tahoe-cc-context-title',
            x_align: Clutter.ActorAlign.START,
        }));

        for (const size of SIZE_ORDER) {
            if (!item.control.sizes.includes(size))
                continue;

            const row = new St.Button({
                style_class: 'tahoe-cc-context-item',
                can_focus: true,
                reactive: true,
                track_hover: true,
                x_expand: true,
                accessible_name: SIZE_LABELS[size],
            });
            const rowBox = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            rowBox.add_child(new St.Label({
                text: SIZE_LABELS[size],
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            }));
            if (item.size === size) {
                rowBox.add_child(new St.Icon({
                    icon_name: 'object-select-symbolic',
                    icon_size: 12,
                    style_class: 'tahoe-cc-context-check',
                }));
            }
            row.set_child(rowBox);
            row.connect('clicked', () => {
                this._closeContext();
                this._changeSize(item.control.id, size);
            });
            menu.add_child(row);
        }

        const separator = new St.Widget({
            style_class: 'tahoe-cc-context-separator',
            x_expand: true,
        });
        menu.add_child(separator);

        const remove = new St.Button({
            style_class: 'tahoe-cc-context-item tahoe-cc-context-remove',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
            accessible_name: `Quitar ${item.control.name}`,
            child: new St.Label({
                text: 'Quitar',
                x_align: Clutter.ActorAlign.START,
            }),
        });
        remove.connect('clicked', () => {
            this._closeContext();
            this._removeControl(item.control.id);
        });
        menu.add_child(remove);

        overlay.add_child(menu);
        menu.style = dark
            ? 'background-color: rgba(40, 40, 44, 0.90) !important; border: 1px solid rgba(255, 255, 255, 0.24); border-radius: 14px;'
            : 'background-color: rgba(248, 248, 250, 0.95) !important; border: 1px solid rgba(0, 0, 0, 0.12); border-radius: 14px; color: #1d1d1f;';

        let handle = null;
        const cc = this._cc;
        if (cc._glassStyle === 'liquid' && cc._glassEngine) {
            handle = cc._glassEngine.attach(menu,
                glassLook(cc._tahoeTheme, {
                    cornerRadius: 14,
                    blurRadius: 10,
                    owner: 'cc-context-menu',
                }));
        }

        const [, , mw, mh] = menu.get_preferred_size();
        const stageRect = rectOf(this._cc?._ccStage ?? overlay);
        const minX = stageRect[0] + 2;
        const minY = stageRect[1] + 2;
        const maxX = stageRect[0] + stageRect[2] - mw - 2;
        const maxY = stageRect[1] + stageRect[3] - mh - 2;
        menu._overlayStageX = Math.clamp(stageX, minX, Math.max(minX, maxX));
        menu._overlayStageY = Math.clamp(stageY, minY, Math.max(minY, maxY));
        overlay.queue_relayout();

        this._context = {catcher, menu, handle};
    }

    _closeContext() {
        const context = this._context;
        this._context = null;
        if (!context)
            return;

        try {
            context.handle?.destroy();
        } catch (_e) {
            // Ignorar.
        }
        try {
            context.menu?.destroy();
            context.catcher?.destroy();
        } catch (_e) {
            // Ignorar.
        }
    }

    // ------------------------------------------------------------------
    // Arrastrar y soltar
    // ------------------------------------------------------------------

    _attachDragHandlers(actor, info) {
        let pending = null;
        let grab = null;

        // Los St.Button (galería) usan Clutter.ClickGesture, que se queda
        // con la secuencia del puntero: sus señales motion-event no llegan.
        // Escuchamos en la fase de captura, que va antes que los gestos.
        // En los módulos del CC hay que dejar pasar el «−» y el tirador.
        const isDecoration = event => {
            let target = global.stage.get_event_actor(event);
            while (target && target !== actor) {
                if (target.has_style_class_name?.('tahoe-cc-edit-minus') ||
                    target.has_style_class_name?.('tahoe-cc-edit-resize'))
                    return true;
                target = target.get_parent();
            }
            return false;
        };

        const onPress = event => {
            if (event.get_button() !== 1 || isDecoration(event))
                return Clutter.EVENT_PROPAGATE;
            // Mientras el proxy de un soltado anterior termina de volar no
            // se inicia otro arrastre: su temporizador de limpieza sigue vivo.
            if (this._drag)
                return Clutter.EVENT_PROPAGATE;

            pending = {
                ...info,
                eventActor: actor,
                start: event.get_coords(),
                started: false,
            };
            return Clutter.EVENT_PROPAGATE;
        };

        const onMotion = event => {
            if (!pending)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            const dx = x - pending.start[0];
            const dy = y - pending.start[1];

            if (!pending.started && Math.hypot(dx, dy) < 5)
                return Clutter.EVENT_PROPAGATE;

            if (!pending.started) {
                pending.started = true;
                this._suppressGalleryClick = info.source === 'gallery';
                this._startDrag(pending, x, y);
                grab = this._drag?.grab ?? null;
            }

            this._moveDrag(x, y);
            return Clutter.EVENT_STOP;
        };

        const onRelease = event => {
            if (!pending)
                return Clutter.EVENT_PROPAGATE;

            const wasStarted = pending.started;
            const infoRef = pending;
            pending = null;

            if (!wasStarted) {
                try {
                    if (grab && !grab.is_revoked())
                        grab.dismiss();
                } catch (_e) {
                    // Ignorar.
                }
                grab = null;
                return Clutter.EVENT_PROPAGATE;
            }

            const [x, y] = event.get_coords();
            this._endDrag(x, y, infoRef);
            grab = null;

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._suppressGalleryClick = false;
                return GLib.SOURCE_REMOVE;
            });

            return Clutter.EVENT_STOP;
        };

        actor.connect('captured-event', (_actor, event) => {
            switch (event.type()) {
            case Clutter.EventType.BUTTON_PRESS:
                return onPress(event);
            case Clutter.EventType.MOTION:
                return onMotion(event);
            case Clutter.EventType.BUTTON_RELEASE:
                return onRelease(event);
            default:
                return Clutter.EVENT_PROPAGATE;
            }
        });
    }

    _startDrag(pending, stageX, stageY) {
        const overlay = this._cc?._editorOverlay;
        if (!overlay)
            return;

        const ow = Math.max(1, Math.round(pending.width));
        const oh = Math.max(1, Math.round(pending.height));
        const proxy = new St.Widget({
            style_class: 'tahoe-cc-drag-proxy',
            width: ow,
            height: oh,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            reactive: false,
        });
        proxy.set_pivot_point(0.5, 0.5);
        proxy.set_scale(1, 1);
        proxy.opacity = 0;
        try {
            // La sombra del CSS se refuerza mientras el control va "en el aire".
            proxy.style = 'box-shadow: 0 18px 46px rgba(0, 0, 0, 0.46);';
        } catch (_e) {
            // Estilo no disponible.
        }

        let clone = null;
        try {
            clone = new Clutter.Clone({
                source: pending.actor,
                width: ow,
                height: oh,
            });
            clone.set_pivot_point(0.5, 0.5);
            proxy.add_child(clone);
        } catch (e) {
            console.error(`${LOG} No se pudo crear el proxy de arrastre:`, e);
        }

        overlay.add_child(proxy);

        let grab = null;
        try {
            grab = global.stage.grab(pending.eventActor);
        } catch (_e) {
            grab = null;
        }

        const drag = {
            ...pending,
            proxy,
            clone,
            grab,
            offsetX: ow * 0.5,
            offsetY: oh * 0.5,
            phase: 'drag',
            zone: null,
            plan: null,
            targetIndex: null,
            targets: new Map(),
            base: this._basePositions(),
            start: [stageX, stageY],
            lastX: stageX,
            lastY: stageY,
            cancelled: false,
        };
        this._drag = drag;

        this._setSourceOpacity(drag, pending.source === 'cc' ? 110 : 140);

        // El proxy nace un poco más pequeño y sube a escala 1.05.
        try {
            proxy.ease({
                opacity: 255,
                scale_x: 1.05,
                scale_y: 1.05,
                duration: 170,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } catch (_e) {
            proxy.opacity = 255;
            proxy.set_scale(1.05, 1.05);
        }

        this._moveDrag(stageX, stageY);
    }

    _moveDrag(stageX, stageY) {
        const drag = this._drag;
        const overlay = this._cc?._editorOverlay;
        if (!drag || drag.phase !== 'drag' || !overlay)
            return;

        // transform_stage_point() devuelve [ok, x, y].
        const [ok, lx, ly] = overlay.transform_stage_point(stageX, stageY);
        if (!ok)
            return;
        drag.proxy.translation_x = lx - drag.offsetX;
        drag.proxy.translation_y = ly - drag.offsetY;

        drag.lastX = stageX;
        drag.lastY = stageY;
        this._updateDropHint(stageX, stageY);
    }

    _endDrag(stageX, stageY, info) {
        const drag = this._drag;
        if (!drag) {
            this._clearDropHint();
            return;
        }

        drag.phase = 'drop';
        drag.releaseX = stageX;
        drag.releaseY = stageY;

        if (drag.grab) {
            try {
                if (!drag.grab.is_revoked())
                    drag.grab.dismiss();
            } catch (_e) {
                // Ignorar.
            }
            drag.grab = null;
        }

        // El control real vuelve a mostrarse en el hueco mientras el proxy
        // termina de encajar; así el soltado no parpadea.
        this._setSourceOpacity(info, 255);

        const cc = this._cc;
        if (!cc || !drag.proxy) {
            this._cancelDrag();
            return;
        }

        const inBar = stageY <= this._panelBottom();
        const grid = cc._mainRefs?.grid;
        const gridRect = grid ? rectOf(grid) : null;
        const inGrid = !inBar && gridRect && contains(gridRect, stageX, stageY);

        if (inBar) {
            this._restorePreview(drag);
            this._hideDropHint();
            const index = this._barInsertionIndex(stageX, info.id);
            this._showBarHint(index, info.id);

            // Sobre la barra el hueco se cierra y el proxy vuela al indicador.
            const target = this._proxyBarTarget(drag) ??
                this._proxyOriginTarget(drag);
            if (target) {
                this._animateProxy(drag, target[0], target[1],
                    {duration: 180, fade: true, scale: 1});
            } else {
                try {
                    drag.proxy.ease({
                        opacity: 0,
                        duration: 180,
                        mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    });
                } catch (_e) {
                    // Ignorar.
                }
            }

            if (cc.getMenubarControls().includes(info.id))
                cc.moveMenubarControl(info.id, index);
            else
                cc.addMenubarControl(info.id, index);

            this._finishDrag(drag, 300, () => this._clearBarHint(true));
            return;
        }

        this._clearBarHint(true);

        if (inGrid) {
            const targetIndex = this._layoutIndexAt(stageX, stageY, info.id);
            const plan = drag.plan && drag.plan.index === targetIndex
                ? drag.plan
                : this._buildPreviewPlan(drag, targetIndex);

            if (plan) {
                drag.plan = plan;
                drag.targetIndex = targetIndex;
                this._applyPreview(drag, plan);
                this._showDropHintForPlan(drag, plan);

                const hole = this._proxyHoleTarget(drag, plan);
                if (hole) {
                    this._animateProxy(drag, hole[0], hole[1],
                        {duration: 190, fade: true, scale: 1});
                }

                const layout = cc.getLayout();
                const from = layout.findIndex(entry => entry.id === info.id);
                const sameSpot = from >= 0 &&
                    from === Math.clamp(plan.index, 0, layout.length - 1);

                if (sameSpot) {
                    // Se soltó en su propia celda: los vecinos vuelven y el
                    // proxy regresa al hueco original.
                    this._restorePreview(drag);
                    this._finishDrag(drag, 230, () => this._hideDropHint());
                    return;
                }

                if (info.source === 'cc') {
                    // El origen está en la rejilla: aplicamos ya el layout;
                    // el proxy sigue volando al hueco (los wrappers no se
                    // reconstruyen en este camino).
                    this._commitGridDrop(drag, plan);
                    this._finishDrag(drag, 230, () => this._hideDropHint());
                } else {
                    // Desde la galería: el commit reconstruye la galería y
                    // destruiría la fuente del clon. Se hace justo cuando el
                    // proxy ya aterrizó.
                    this._finishDrag(drag, 220, () => {
                        this._hideDropHint();
                        this._commitGridDrop(drag, plan);
                    });
                }
                return;
            }
        }

        // Fuera de la rejilla y de la barra: los vecinos recuperan su sitio
        // y el clon vuelve al punto de origen.
        this._restorePreview(drag);
        this._hideDropHint();
        const origin = this._proxyOriginTarget(drag);
        if (origin) {
            this._animateProxy(drag, origin[0], origin[1],
                {duration: 220, fade: true, scale: 1});
        }
        this._finishDrag(drag, 250);
    }

    /**
     * Hook de pruebas: ejecuta el mismo camino que un arrastre real
     * (_startDrag/_moveDrag/_endDrag) sin depender de la inyección de
     * punteros de Clutter, que en headless hace caer a Mutter.
     */
    simulateDrag(id, source, endX, endY) {
        const cc = this._cc;
        if (!cc)
            return false;

        let info = null;

        if (source === 'cc') {
            const item = (cc._mainRefs?.controls ?? [])
                .find(entry => entry.control.id === id);
            if (!item)
                return false;

            const span = sizeSpan(item.size);
            const [sx, sy, sw, sh] = rectOf(item.wrapper);
            info = {
                id,
                source: 'cc',
                actor: item.built.actor,
                eventActor: item.wrapper,
                width: span.columns * px(62) + (span.columns - 1) * px(12),
                height: span.rows * px(62) + (span.rows - 1) * px(12),
                item,
                start: [sx + sw / 2, sy + sh / 2],
            };
        } else {
            const button = this._galleryItems.get(id);
            if (!button?.get_stage())
                return false;

            const [sx, sy, sw, sh] = rectOf(button);
            info = {
                id,
                source: 'gallery',
                actor: button._tahoePreviewActor ?? button,
                eventActor: button,
                button,
                width: button._tahoePreviewWidth,
                height: button._tahoePreviewHeight,
                start: [sx + sw / 2, sy + sh / 2],
            };
        }

        this._startDrag(info, info.start[0], info.start[1]);
        this._moveDrag(endX, endY);
        this._endDrag(endX, endY, info);
        return true;
    }

    _panelBottom() {
        try {
            const [y] = Main.panel.get_transformed_position();
            return y + Main.panel.height;
        } catch (_e) {
            return 32;
        }
    }

    _layoutIndexAt(stageX, stageY, excludeId) {
        const cc = this._cc;
        const placed = (cc._mainRefs?.controls ?? [])
            .filter(item => item.control.id !== excludeId);
        if (placed.length === 0)
            return 0;

        const layout = cc.getLayout().filter(entry => entry.id !== excludeId);
        let best = null;
        let bestDistance = Infinity;

        for (const item of placed) {
            const rect = rectOf(item.wrapper);
            // La geometría de referencia es la celda sin las traslaciones
            // de la vista previa: si no, el hueco "persigue" al puntero y
            // el índice oscila mientras los vecinos se mueven.
            const wrapper = item.wrapper;
            if (wrapper) {
                rect[0] -= wrapper.translation_x || 0;
                rect[1] -= wrapper.translation_y || 0;
            }
            const cx = rect[0] + rect[2] / 2;
            const cy = rect[1] + rect[3] / 2;

            if (contains(rect, stageX, stageY)) {
                best = {item, after: stageX > cx || stageY > cy};
                bestDistance = 0;
                break;
            }

            const distance = Math.hypot(stageX - cx, stageY - cy);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = {
                    item,
                    after: stageY > cy || (Math.abs(stageY - cy) < rect[3] / 2 &&
                        stageX > cx),
                };
            }
        }

        if (!best)
            return layout.length;

        const anchorIndex = layout.findIndex(entry =>
            entry.id === best.item.control.id);
        if (anchorIndex < 0)
            return layout.length;

        return anchorIndex + (best.after ? 1 : 0);
    }

    _barInsertionIndex(stageX, excludeId) {
        const cc = this._cc;
        const ids = cc.getMenubarControls().filter(id => id !== excludeId);
        let index = 0;

        for (const id of ids) {
            const button = cc._getMenubarButton(id);
            if (!button?.container)
                continue;
            const rect = rectOf(button.container);
            if (stageX > rect[0] + rect[2] / 2)
                index++;
        }

        return index;
    }

    /**
     * Pista en vivo: según la zona bajo el puntero se abre el hueco en la
     * rejilla (moviendo los wrappers con translation_x/y) o se muestra la
     * línea de inserción de la barra. No se reconstruye el CC.
     */
    _updateDropHint(stageX, stageY) {
        const drag = this._drag;
        const cc = this._cc;
        if (!drag || drag.phase !== 'drag' || !cc)
            return;

        const inBar = stageY <= this._panelBottom();
        const grid = cc._mainRefs?.grid;
        let inGrid = false;

        if (!inBar && grid) {
            const [gx, gy, gw, gh] = rectOf(grid);
            const pad = px(10);
            inGrid = stageX >= gx - pad && stageX <= gx + gw + pad &&
                stageY >= gy - pad && stageY <= gy + gh + pad;
        }

        if (inBar) {
            if (drag.zone !== 'bar')
                this._restorePreview(drag);

            const index = this._barInsertionIndex(stageX, drag.id);
            this._showBarHint(index, drag.id);
            drag.zone = 'bar';
            drag.plan = null;
            drag.targetIndex = null;
            return;
        }

        this._clearBarHint(true);

        if (inGrid && grid) {
            const targetIndex = this._layoutIndexAt(stageX, stageY, drag.id);
            const samePlan = drag.zone === 'grid' && drag.plan &&
                drag.plan.index === targetIndex;

            if (!samePlan) {
                const plan = this._buildPreviewPlan(drag, targetIndex);
                if (plan) {
                    drag.plan = plan;
                    drag.targetIndex = targetIndex;
                    this._applyPreview(drag, plan);
                }
            }

            if (drag.plan)
                this._showDropHintForPlan(drag, drag.plan);

            drag.zone = 'grid';
            return;
        }

        if (drag.zone !== 'none') {
            this._restorePreview(drag);
            drag.zone = 'none';
        }
    }

    _cancelDrag() {
        const drag = this._drag;
        this._drag = null;

        this._hideDropHint();
        this._clearBarHint(true);

        if (!drag)
            return;

        drag.cancelled = true;
        drag.phase = 'cancelled';

        try {
            if (drag.grab && !drag.grab.is_revoked())
                drag.grab.dismiss();
        } catch (_e) {
            // Ignorar.
        }
        drag.grab = null;

        this._restorePreviewNow(drag);
        this._setSourceOpacity(drag, 255);
        this._destroyDragProxy(drag);
    }

    // ------------------------------------------------------------------
    // Esc
    // ------------------------------------------------------------------

    _connectStageCapture() {
        if (this._stageCaptureId)
            return;

        this._stageCaptureId = global.stage.connect('captured-event',
            (_stage, event) => {
                if (!this._editing)
                    return Clutter.EVENT_PROPAGATE;

                if (event.type() !== Clutter.EventType.KEY_PRESS)
                    return Clutter.EVENT_PROPAGATE;

                if (event.get_key_symbol() !== Clutter.KEY_Escape)
                    return Clutter.EVENT_PROPAGATE;

                if (this._context) {
                    this._closeContext();
                    return Clutter.EVENT_STOP;
                }

                this._cc?._leaveEditMode(true);
                return Clutter.EVENT_STOP;
            });
    }

    _disconnectStageCapture() {
        if (!this._stageCaptureId)
            return;
        try {
            global.stage.disconnect(this._stageCaptureId);
        } catch (_e) {
            // Ya desconectado.
        }
        this._stageCaptureId = 0;
    }

    // ------------------------------------------------------------------
    // Iconos de la barra en modo edición
    // ------------------------------------------------------------------

    _beginBarEdit() {
        const cc = this._cc;
        if (!cc)
            return;

        for (const id of cc.getMenubarControls()) {
            if (this._barBackup.has(id))
                continue;

            const button = cc._getMenubarButton(id);
            const container = button?.container;
            if (!button || !container)
                continue;

            const original = container.get_child();
            if (!original)
                continue;

            const wrapper = new St.Widget({
                style_class: 'tahoe-cc-bar-edit-wrap',
                layout_manager: new Clutter.BinLayout(),
                reactive: true,
                track_hover: true,
            });

            container.set_child(null);
            if (original.get_parent())
                original.get_parent().remove_child(original);
            wrapper.add_child(original);

            const minus = new St.Button({
                style_class: 'tahoe-cc-bar-minus',
                can_focus: true,
                reactive: true,
                accessible_name: `Quitar ${id} de la barra`,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                child: new St.Label({
                    text: '−',
                    style_class: 'tahoe-cc-bar-minus-glyph',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
            minus.connect('clicked', () => {
                this._endBarEdit();
                cc.removeMenubarControl(id);
                if (this._editing)
                    this._beginBarEdit();
            });

            wrapper.add_child(minus);
            container.set_child(wrapper);

            const wasReactive = button.reactive;
            button.reactive = false;
            try {
                button._clickGesture?.set_enabled(false);
                button.menu?.close();
            } catch (_e) {
                // Ignorar.
            }

            const backup = {
                button,
                container,
                original,
                wrapper,
                minus,
                wasReactive,
                dead: false,
            };
            // Al apagar el shell el panel se destruye antes de que el menú
            // salga del modo edición: no hay que tocar actores ya liberados.
            const markDead = () => {
                backup.dead = true;
            };
            backup.deadIds = [
                [button, button.connect('destroy', markDead)],
                [container, container.connect('destroy', markDead)],
                [wrapper, wrapper.connect('destroy', markDead)],
            ];
            this._barBackup.set(id, backup);

            this._attachBarDragHandlers(wrapper, id);
        }
    }

    _endBarEdit() {
        this._clearBarHint(true);
        for (const [id, backup] of [...this._barBackup]) {
            this._barBackup.delete(id);
            const {button, container, original, wrapper, wasReactive} = backup;

            if (backup.dead)
                continue;

            for (const [object, signalId] of backup.deadIds ?? [])
                object.disconnect(signalId);

            try {
                if (container?.get_child() === wrapper) {
                    container.set_child(null);
                    if (original.get_parent() === wrapper)
                        wrapper.remove_child(original);
                    container.set_child(original);
                } else if (original.get_parent() === wrapper) {
                    wrapper.remove_child(original);
                }
                wrapper.destroy();
            } catch (_e) {
                // El botón ya no existe.
            }

            try {
                if (button) {
                    button.reactive = wasReactive;
                    button._clickGesture?.set_enabled(true);
                }
            } catch (_e) {
                // Ignorar.
            }
        }
    }

    refreshBarEdit() {
        if (!this._editing)
            return;
        this._endBarEdit();
        this._beginBarEdit();
    }

    _attachBarDragHandlers(wrapper, id) {
        let press = null;
        let grab = null;

        wrapper.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== 1 || this._drag)
                return Clutter.EVENT_PROPAGATE;
            press = {start: event.get_coords(), started: false};
            return Clutter.EVENT_PROPAGATE;
        });

        wrapper.connect('motion-event', (actor, event) => {
            if (!press)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            if (!press.started) {
                if (Math.hypot(x - press.start[0], y - press.start[1]) < 5)
                    return Clutter.EVENT_PROPAGATE;
                press.started = true;
                try {
                    grab = global.stage.grab(wrapper);
                } catch (_e) {
                    grab = null;
                }
                try {
                    wrapper.ease({
                        scale_x: 1.08,
                        scale_y: 1.08,
                        duration: 160,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    });
                } catch (_e) {
                    // Ignorar.
                }
            }
            press.last = [x, y];
            this._showBarHint(this._barInsertionIndex(x, id), id);
            return Clutter.EVENT_STOP;
        });

        wrapper.connect('button-release-event', (actor, event) => {
            if (!press)
                return Clutter.EVENT_PROPAGATE;

            const started = press.started;
            press = null;

            try {
                if (grab && !grab.is_revoked())
                    grab.dismiss();
            } catch (_e) {
                // Ignorar.
            }
            grab = null;

            if (!started)
                return Clutter.EVENT_PROPAGATE;

            const [x] = event.get_coords();
            const cc = this._cc;
            this._clearBarHint(true);
            if (!cc)
                return Clutter.EVENT_STOP;

            const index = this._barInsertionIndex(x, id);
            this._endBarEdit();
            cc.moveMenubarControl(id, index);
            if (this._editing)
                this._beginBarEdit();
            return Clutter.EVENT_STOP;
        });
    }
}
