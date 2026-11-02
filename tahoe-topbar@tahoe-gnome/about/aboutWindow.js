// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Ventana "Acerca de este equipo" al estilo macOS Tahoe.
//
// Es un actor de St añadido al chrome superior (no un ModalDialog), para
// que se comporte como una ventana flotante normal: se puede arrastrar,
// no se cierra al hacer clic fuera y Esc la cierra cuando tiene foco.

'use strict';

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import * as SysInfo from './sysinfo.js';
import {glassLook} from '../liquidGlass.js';

const WINDOW_WIDTH = 290;
const IMAGE_MAX_WIDTH = 200;
const IMAGE_MAX_HEIGHT = 240;

const FOOTER_TEXT =
    '™ y © 1996-2026 The GNOME Project y Fedora Project.\n' +
    'Todos los derechos reservados.';

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function _extensionPath(extension) {
    try {
        if (typeof extension?.path === 'string' && extension.path)
            return extension.path;

        if (typeof extension?.dir?.get_path === 'function')
            return extension.dir.get_path();

        if (extension?.dir)
            return `${extension.dir}`;
    } catch (_e) {
        // Ignorar.
    }

    return '';
}

function _expandPath(path) {
    if (!path)
        return '';

    if (path.startsWith('file://')) {
        try {
            const file = Gio.File.new_for_uri(path);
            return file.get_path() ?? '';
        } catch (_e) {
            return '';
        }
    }

    if (path === '~')
        return GLib.get_home_dir();

    if (path.startsWith('~/')) {
        return GLib.build_filenamev([
            GLib.get_home_dir(),
            path.slice(2),
        ]);
    }

    if (!GLib.path_is_absolute(path))
        return GLib.build_filenamev([GLib.get_home_dir(), path]);

    return path;
}

function _parseSvgLength(value) {
    if (!value)
        return 0;

    const match = /^\s*([0-9]*\.?[0-9]+)\s*([a-z%]*)\s*$/i.exec(`${value}`);
    if (!match)
        return 0;

    const number = Number.parseFloat(match[1]);
    if (!Number.isFinite(number) || number <= 0)
        return 0;

    switch (match[2].toLowerCase()) {
    case '':
    case 'px':
        return number;
    case 'pt':
        return number * 96 / 72;
    case 'pc':
        return number * 16;
    case 'mm':
        return number * 96 / 25.4;
    case 'cm':
        return number * 96 / 2.54;
    case 'in':
        return number * 96;
    default:
        return 0;
    }
}

/**
 * Dimensiones de una imagen. GdkPixbuf informa bien de PNG/JPEG, pero
 * devuelve 0x0 para SVG, así que en ese caso leemos el encabezado XML.
 *
 * @param {string} path
 * @returns {[number, number]}
 */
function _getImageSize(path) {
    try {
        const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
        if (width > 0 && height > 0)
            return [width, height];
    } catch (_e) {
        // Seguimos con el análisis de SVG.
    }

    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (ok && contents && contents.length > 0) {
            const text = new TextDecoder('utf-8')
                .decode(contents.slice(0, 32768));
            const svg = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';

            if (svg) {
                const width = _parseSvgLength(
                    /\bwidth\s*=\s*["']([^"']+)["']/i.exec(svg)?.[1]);
                const height = _parseSvgLength(
                    /\bheight\s*=\s*["']([^"']+)["']/i.exec(svg)?.[1]);

                if (width > 0 && height > 0)
                    return [width, height];

                const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i
                    .exec(svg)?.[1]
                    ?.trim()
                    .split(/[\s,]+/)
                    .map(Number);

                if (viewBox?.length === 4 &&
                    viewBox[2] > 0 && viewBox[3] > 0) {
                    if (width > 0)
                        return [width, width * viewBox[3] / viewBox[2]];
                    if (height > 0)
                        return [height * viewBox[2] / viewBox[3], height];
                    return [viewBox[2], viewBox[3]];
                }
            }
        }
    } catch (_e) {
        // Ignorar y usar la proporción por defecto.
    }

    return [512, 340];
}

/* ------------------------------------------------------------------ */
/* Diálogo                                                             */
/* ------------------------------------------------------------------ */

export class AboutDialog {
    /**
     * @param {object} extension instancia de Extension de GNOME Shell
     */
    constructor(extension) {
        this._extension = extension;
        this._extensionPath = _extensionPath(extension);

        // Las coordenadas de Clutter son píxeles físicos; el CSS de St se
        // escala solo. Los tamaños que fijamos desde JS deben multiplicarse.
        try {
            this._scaleFactor =
                St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        } catch (_e) {
            this._scaleFactor = 1;
        }

        this._settings = null;
        this._settingsChangedId = 0;

        this._theme = null;
        this._cssFile = null;

        this._actor = null;
        this._actorAdded = false;
        this._isOpen = false;
        this._destroyed = false;
        this._minimizedPos = null;

        this._drag = null;
        this._grab = null;
        this._focusSourceId = 0;

        this._gpuCache = '';
        this._gpuPending = false;
        this._gpuToken = 0;

        this._glassEngine = null;
        this._glassHandle = null;
        this._glassUnsubscribe = null;
        this._themeGlassId = 0;

        this._image = null;
        this._imageHolder = null;
        this._title = null;
        this._subtitle = null;
        this._moreButton = null;
        this._footer = null;
        this._labels = {};

        this._loadStylesheet();
        this._bindSettings();

        this._glassUnsubscribe = extension?.onGlassEngineChanged?.(
            engine => this._setGlassEngine(engine)) ?? null;
        const theme = extension?._theme ?? null;
        if (theme?.connect)
            this._themeGlassId = theme.connect(() => this._updateGlassLook());

        this._actor = this._buildActor();
        this._ensureOnStage();
        this._refreshContent();
    }

    /* -------------------------------------------------------------- */
    /* Estilos                                                        */
    /* -------------------------------------------------------------- */

    _loadStylesheet() {
        try {
            const path = GLib.build_filenamev([
                this._extensionPath,
                'about',
                'about.css',
            ]);

            this._cssFile = Gio.File.new_for_path(path);
            this._theme = St.ThemeContext.get_for_stage(global.stage)
                .get_theme();
            this._theme.load_stylesheet(this._cssFile);
        } catch (e) {
            logError(e, 'Tahoe Top Bar: no se pudo cargar about/about.css');
            this._theme = null;
            this._cssFile = null;
        }
    }

    _unloadStylesheet() {
        if (!this._theme || !this._cssFile)
            return;

        try {
            this._theme.unload_stylesheet(this._cssFile);
        } catch (e) {
            logError(e, 'Tahoe Top Bar: no se pudo descargar about/about.css');
        }

        this._theme = null;
        this._cssFile = null;
    }

    /* -------------------------------------------------------------- */
    /* Ajustes                                                        */
    /* -------------------------------------------------------------- */

    _bindSettings() {
        try {
            this._settings = this._extension.getSettings();
        } catch (e) {
            logError(e, 'Tahoe Top Bar: no se pudieron leer los ajustes');
            this._settings = null;
        }

        if (this._settings) {
            this._settingsChangedId = this._settings.connect('changed',
                (_settings, key) => {
                    if (this._destroyed || !key)
                        return;

                    if (key.startsWith('about-'))
                        this._refreshContent();
                });
        }
    }

    _getString(key) {
        try {
            return this._settings?.get_string(key) ?? '';
        } catch (_e) {
            return '';
        }
    }

    _disconnectSettings() {
        if (this._settings && this._settingsChangedId) {
            try {
                this._settings.disconnect(this._settingsChangedId);
            } catch (_e) {
                // Ya desconectado.
            }
        }
        this._settingsChangedId = 0;
        this._settings = null;
    }

    _px(value) {
        return Math.max(1, Math.round(value * this._scaleFactor));
    }

    /* -------------------------------------------------------------- */
    /* Construcción de la interfaz                                    */
    /* -------------------------------------------------------------- */

    _buildActor() {
        const actor = new St.BoxLayout({
            name: 'tahoeAboutWindow',
            style_class: 'tahoe-about-window',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            can_focus: true,
            track_hover: true,
            visible: false,
        });

        actor.set_width(this._px(WINDOW_WIDTH));
        actor.set_pivot_point(0.5, 0.5);

        actor.connect('key-press-event', (_actor, event) => {
            if (this._isOpen &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        actor.connect('button-press-event',
            this._onButtonPress.bind(this));
        actor.connect('motion-event', this._onMotion.bind(this));
        actor.connect('button-release-event',
            this._onButtonRelease.bind(this));

        actor.connect('destroy', () => this._onActorDestroyed());

        this._buildHeader(actor);
        this._buildImage(actor);
        this._buildText(actor);
        this._buildInfoTable(actor);
        this._buildMoreButton(actor);
        this._buildFooter(actor);

        return actor;
    }

    _buildHeader(actor) {
        const header = new St.BoxLayout({
            style_class: 'tahoe-about-header',
        });

        const close = this._createTrafficButton(
            'tahoe-about-traffic-close', '×', 'Cerrar', () => this.close());

        const minimize = this._createTrafficButton(
            'tahoe-about-traffic-minimize', '−', 'Minimizar',
            () => this.minimize());

        // En macOS el semáforo verde aparece deshabilitado cuando la
        // ventana no se puede redimensionar.
        const zoom = this._createTrafficButton(
            null, '', 'Maximizar (no disponible)', null);

        header.add_child(close);
        header.add_child(minimize);
        header.add_child(zoom);

        actor.add_child(header);
    }

    _createTrafficButton(colorClass, glyphText, accessibleName, onActivate) {
        const button = new St.Button({
            style_class: 'tahoe-about-traffic',
            width: this._px(12),
            height: this._px(12),
            reactive: Boolean(onActivate),
            can_focus: Boolean(onActivate),
            track_hover: Boolean(onActivate),
            accessible_name: accessibleName,
        });

        if (!onActivate || !colorClass) {
            button.add_style_class_name('tahoe-about-traffic-disabled');
            return button;
        }

        button.add_style_class_name(colorClass);

        if (glyphText) {
            const glyph = new St.Label({
                text: glyphText,
                style_class: 'tahoe-about-traffic-glyph',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            glyph.opacity = 0;
            button.set_child(glyph);

            button.connect('enter-event', () => {
                glyph.opacity = 255;
                return Clutter.EVENT_PROPAGATE;
            });
            button.connect('leave-event', () => {
                glyph.opacity = 0;
                return Clutter.EVENT_PROPAGATE;
            });
        }

        button.connect('clicked', () => onActivate());

        return button;
    }

    _buildImage(actor) {
        this._image = new St.Bin({
            style_class: 'tahoe-about-image',
            width: this._px(IMAGE_MAX_WIDTH),
            height: this._px(IMAGE_MAX_WIDTH * 340 / 512),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._imageHolder = new St.Bin({
            style_class: 'tahoe-about-image-holder',
            x_expand: true,
        });
        this._imageHolder.set_child(this._image);

        actor.add_child(this._imageHolder);
    }

    _buildText(actor) {
        this._title = new St.Label({
            style_class: 'tahoe-about-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._title.clutter_text.set_line_wrap(true);

        this._subtitle = new St.Label({
            style_class: 'tahoe-about-subtitle',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._subtitle.clutter_text.set_line_wrap(true);

        actor.add_child(this._title);
        actor.add_child(this._subtitle);
    }

    _buildInfoTable(actor) {
        const table = new St.BoxLayout({
            style_class: 'tahoe-about-table',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._labels.chip = this._addInfoRow(table, 'Chip');
        this._labels.graphics = this._addInfoRow(table, 'Gráficos');
        this._labels.memory = this._addInfoRow(table, 'Memoria');
        this._labels.serial = this._addInfoRow(table, 'Número de serie');
        this._labels.os = this._addInfoRow(table, 'Sistema operativo');

        actor.add_child(table);
    }

    _addInfoRow(table, labelText) {
        const row = new St.BoxLayout({
            style_class: 'tahoe-about-row',
            x_expand: true,
        });

        const key = new St.Label({
            text: labelText,
            style_class: 'tahoe-about-key',
            width: this._px(98),
        });
        key.clutter_text.set_line_wrap(true);

        const value = new St.Label({
            text: '—',
            style_class: 'tahoe-about-value',
            x_expand: true,
        });
        value.clutter_text.set_line_wrap(true);

        row.add_child(key);
        row.add_child(value);
        table.add_child(row);

        return {key, value};
    }

    _buildMoreButton(actor) {
        this._moreButton = new St.Button({
            style_class: 'tahoe-about-more-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: 'Más información',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const label = new St.Label({
            text: 'Más información…',
            style_class: 'tahoe-about-more-label',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._moreButton.set_child(label);

        this._moreButton.connect('clicked', () => this._openSystemSettings());

        const holder = new St.Bin({
            style_class: 'tahoe-about-more-holder',
            x_expand: true,
        });
        holder.set_child(this._moreButton);

        actor.add_child(holder);
    }

    _buildFooter(actor) {
        this._footer = new St.Label({
            text: FOOTER_TEXT,
            style_class: 'tahoe-about-footer',
            x_expand: true,
        });
        this._footer.clutter_text.set_line_wrap(true);

        actor.add_child(this._footer);
    }

    /* -------------------------------------------------------------- */
    /* Contenido                                                      */
    /* -------------------------------------------------------------- */

    _refreshContent() {
        if (!this._actor || this._destroyed)
            return;

        const title = this._getString('about-title').trim();
        this._title.text = title || SysInfo.getModel() || 'Equipo';

        const subtitle = this._getString('about-subtitle').trim() ||
            SysInfo.getSubtitle();
        this._subtitle.text = subtitle;
        this._subtitle.visible = Boolean(subtitle);

        const chip = this._getString('about-chip').trim() ||
            SysInfo.getCpu();
        this._labels.chip.value.text = chip || '—';

        const graphics = this._getString('about-graphics').trim();
        if (graphics) {
            this._labels.graphics.value.text = graphics;
        } else {
            this._labels.graphics.value.text = this._gpuCache || '—';

            if (!this._gpuCache && !this._gpuPending)
                this._loadGpu();
        }

        const memory = SysInfo.getMemory();
        this._labels.memory.value.text = memory || '—';

        const serial = this._getString('about-serial').trim() ||
            SysInfo.getSerial();
        this._labels.serial.value.text = serial || '—';

        const os = SysInfo.getOsInfo(Config.PACKAGE_VERSION);
        const osName = this._getString('about-os-name').trim() ||
            os.name || 'Sistema operativo';
        this._labels.os.key.text = osName;
        this._labels.os.value.text = os.version || '—';

        this._updateImage();
    }

    _loadGpu() {
        if (this._destroyed || this._gpuPending)
            return;

        const token = ++this._gpuToken;
        this._gpuPending = true;

        SysInfo.getGpuAsync().then(name => {
            if (this._destroyed || token !== this._gpuToken)
                return;

            this._gpuPending = false;
            this._gpuCache = name || '';

            const override = this._getString('about-graphics').trim();
            if (!override && this._labels.graphics)
                this._labels.graphics.value.text = this._gpuCache || '—';
        }).catch(() => {
            if (token === this._gpuToken) {
                this._gpuPending = false;
                this._gpuCache = '';
            }
        });
    }

    _updateImage() {
        if (!this._image)
            return;

        const configured = this._getString('about-image-path').trim();
        const defaultPath = this._extensionPath
            ? GLib.build_filenamev([
                this._extensionPath,
                'assets',
                'about-default.svg',
            ])
            : '';

        let path = configured ? _expandPath(configured) : defaultPath;

        if (!path || !GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            path = defaultPath;

        if (!path || !GLib.file_test(path, GLib.FileTest.IS_REGULAR)) {
            this._image.hide();
            return;
        }

        const [imageWidth, imageHeight] = _getImageSize(path);
        const scale = Math.min(
            this._px(IMAGE_MAX_WIDTH) / imageWidth,
            this._px(IMAGE_MAX_HEIGHT) / imageHeight);

        const width = Math.max(1, Math.round(imageWidth * scale));
        const height = Math.max(1, Math.round(imageHeight * scale));

        this._image.set_size(width, height);

        try {
            const uri = GLib.filename_to_uri(path, null);
            this._image.set_style(`background-image: url("${uri}");`);
        } catch (_e) {
            this._image.hide();
            return;
        }

        this._image.show();
    }

    /* -------------------------------------------------------------- */
    /* Ventana                                                        */
    /* -------------------------------------------------------------- */

    _setGlassEngine(engine) {
        this._glassEngine = engine;
        this._syncGlass();
    }

    _updateGlassLook() {
        this._glassHandle?.update(glassLook(this._extension?._theme));
    }

    _syncGlass() {
        if (!this._isOpen || !this._actor || !this._glassEngine) {
            this._destroyGlass();
            return;
        }

        if (this._glassHandle) {
            this._updateGlassLook();
            return;
        }

        this._glassHandle = this._glassEngine.attach(this._actor,
            glassLook(this._extension?._theme, {
                cornerRadius: 18,
                blurRadius: 4,
                owner: 'about-window',
            }));
    }

    _destroyGlass() {
        this._glassHandle?.destroy();
        this._glassHandle = null;
    }

    _ensureOnStage() {
        if (!this._actor || this._actorAdded)
            return;

        if (this._actor.get_parent()) {
            this._actorAdded = true;
            return;
        }

        try {
            Main.layoutManager.addTopChrome(this._actor);
            this._actorAdded = true;
        } catch (e) {
            logError(e, 'Tahoe Top Bar: no se pudo añadir la ventana Acerca de');
        }
    }

    _raise() {
        if (!this._actor)
            return;

        const parent = this._actor.get_parent();
        if (parent)
            parent.set_child_above_sibling(this._actor, null);
    }

    _positionOnPrimary() {
        if (!this._actor)
            return;

        let width = this._actor.width || this._px(WINDOW_WIDTH);
        let height = this._actor.height || this._px(460);

        try {
            const [, naturalHeight] =
                this._actor.get_preferred_height(width);
            if (naturalHeight > 0)
                height = Math.ceil(naturalHeight);
        } catch (_e) {
            // Usamos la altura estimada.
        }

        const monitor = Main.layoutManager?.primaryMonitor;

        let x, y;
        if (monitor) {
            x = monitor.x + Math.round((monitor.width - width) / 2);
            y = monitor.y + Math.round((monitor.height - height) / 2);
        } else {
            const stageWidth = global.stage.width || width;
            const stageHeight = global.stage.height || height;
            x = Math.round((stageWidth - width) / 2);
            y = Math.round((stageHeight - height) / 2);
        }

        this._actor.set_position(x, y);
    }

    _clampPosition(x, y) {
        if (!this._actor)
            return;

        let newX = Math.round(x);
        let newY = Math.round(y);

        try {
            const monitors = Main.layoutManager?.monitors ?? [];

            if (monitors.length > 0) {
                const left = Math.min(...monitors.map(m => m.x));
                const top = Math.min(...monitors.map(m => m.y));
                const right = Math.max(
                    ...monitors.map(m => m.x + m.width));
                const bottom = Math.max(
                    ...monitors.map(m => m.y + m.height));

                const width = this._actor.width || this._px(WINDOW_WIDTH);
                const height = this._actor.height || this._px(400);

                // Dejar siempre una parte visible para poder recuperarla.
                const keepVisible = this._px(80);
                newX = Math.max(left - width + keepVisible,
                    Math.min(newX, right - keepVisible));
                newY = Math.max(top, Math.min(newY, bottom - this._px(40)));
            }
        } catch (_e) {
            // Sin geometría de monitores: posición libre.
        }

        this._actor.set_position(newX, newY);
    }

    /**
     * Muestra la ventana centrada en el monitor principal. Si ya está
     * abierta, simplemente la trae al frente.
     */
    open() {
        if (this._destroyed || !this._actor)
            return;

        this._ensureOnStage();

        if (this._isOpen) {
            this._raise();
            this._actor.grab_key_focus();
            return;
        }

        this._isOpen = true;

        this._refreshContent();
        this._syncGlass();

        this._actor.remove_all_transitions();

        if (this._minimizedPos) {
            // Restaurar desde minimizado: vuelve a su posición anterior
            // creciendo desde la esquina superior izquierda (menú de manzana).
            const [x, y] = this._minimizedPos;
            this._minimizedPos = null;
            this._actor.set_position(x, y);
            this._actor.set_pivot_point(0, 0);
            this._actor.opacity = 0;
            this._actor.set_scale(0.1, 0.1);
            this._actor.translation_x = -x;
            this._actor.translation_y = -y;
            this._actor.show();
            this._raise();
            this._actor.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                translation_x: 0,
                translation_y: 0,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._actor.set_pivot_point(0.5, 0.5);
            this._actor.opacity = 0;
            this._actor.set_scale(0.95, 0.95);
            this._actor.show();

            this._positionOnPrimary();
            this._raise();

            this._actor.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._actor.grab_key_focus();
        this._queueFocusGrab();
    }

    /**
     * Minimiza: la ventana se encoge hacia el menú de manzana. Al volver a
     * abrirla desde el menú reaparece en la misma posición.
     */
    minimize() {
        if (!this._actor || !this._isOpen)
            return;

        const actor = this._actor;
        const x = actor.x;
        const y = actor.y;

        this._isOpen = false;
        this._minimizedPos = [x, y];
        this._endDrag();
        this._clearFocusSource();
        this._releaseKeyFocus();

        actor.remove_all_transitions();
        actor.set_pivot_point(0, 0);
        actor.ease({
            opacity: 0,
            scale_x: 0.1,
            scale_y: 0.1,
            translation_x: -x,
            translation_y: -y,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (this._isOpen || this._actor !== actor)
                    return;
                actor.hide();
                actor.opacity = 255;
                actor.set_scale(1, 1);
                actor.translation_x = 0;
                actor.translation_y = 0;
                this._destroyGlass();
            },
        });
    }

    /**
     * Oculta la ventana sin destruirla.
     */
    close() {
        if (!this._actor || !this._isOpen)
            return;

        this._isOpen = false;
        this._minimizedPos = null;
        this._endDrag();
        this._clearFocusSource();
        this._destroyGlass();

        this._actor.remove_all_transitions();
        this._actor.hide();
        this._actor.opacity = 255;
        this._actor.set_scale(1, 1);
        this._actor.translation_x = 0;
        this._actor.translation_y = 0;
        this._releaseKeyFocus();
    }

    _releaseKeyFocus() {
        if (!this._actor)
            return;

        try {
            const focus = global.stage.get_key_focus();
            if (focus &&
                (focus === this._actor || this._actor.contains(focus))) {
                global.stage.set_key_focus(null);
            }
        } catch (_e) {
            // Nada que liberar.
        }
    }

    _queueFocusGrab() {
        this._clearFocusSource();

        this._focusSourceId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._focusSourceId = 0;

                if (this._isOpen && this._actor)
                    this._actor.grab_key_focus();

                return GLib.SOURCE_REMOVE;
            });
    }

    _clearFocusSource() {
        if (!this._focusSourceId)
            return;

        GLib.source_remove(this._focusSourceId);
        this._focusSourceId = 0;
    }

    _openSystemSettings() {
        try {
            Util.spawn(['gnome-control-center', 'system']);
        } catch (e) {
            logError(e, 'Tahoe Top Bar: no se pudo abrir gnome-control-center');
        }

        this.close();
    }

    /* -------------------------------------------------------------- */
    /* Arrastre y foco                                                */
    /* -------------------------------------------------------------- */

    _isInteractiveSource(source) {
        let actor = source;

        while (actor) {
            if (actor === this._actor)
                return false;

            if (actor instanceof St.Button || actor instanceof St.Entry)
                return true;

            actor = actor.get_parent();
        }

        return false;
    }

    _onButtonPress(_actor, event) {
        if (!this._isOpen || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        this._actor.grab_key_focus();

        // En GNOME 50 event.get_source() ya no devuelve el actor pulsado;
        // hay que pedírselo al stage. Si es un botón, dejamos que lo gestione.
        let source = null;
        try {
            source = global.stage.get_event_actor(event);
        } catch (_e) {
            source = null;
        }

        if (!source || this._isInteractiveSource(source))
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();

        this._drag = {
            startX: x,
            startY: y,
            actorX: this._actor.x,
            actorY: this._actor.y,
        };

        try {
            this._grab = global.stage.grab(this._actor);
        } catch (e) {
            this._grab = null;
            logError(e, 'Tahoe Top Bar: no se pudo iniciar el arrastre');
        }

        return Clutter.EVENT_STOP;
    }

    _onMotion(_actor, event) {
        if (!this._drag || !this._isOpen)
            return Clutter.EVENT_PROPAGATE;

        if (this._grab?.is_revoked()) {
            this._endDrag();
            return Clutter.EVENT_PROPAGATE;
        }

        const [x, y] = event.get_coords();

        this._clampPosition(
            this._drag.actorX + (x - this._drag.startX),
            this._drag.actorY + (y - this._drag.startY));

        return Clutter.EVENT_STOP;
    }

    _onButtonRelease(_actor, _event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;

        this._endDrag();
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        const grab = this._grab;

        this._grab = null;
        this._drag = null;

        if (!grab)
            return;

        try {
            if (!grab.is_revoked())
                grab.dismiss();
        } catch (_e) {
            // El grab ya no era válido.
        }
    }

    /* -------------------------------------------------------------- */
    /* Destrucción                                                    */
    /* -------------------------------------------------------------- */

    _onActorDestroyed() {
        this._actor = null;
        this._actorAdded = false;
        this._isOpen = false;

        this._endDrag();
        this._clearFocusSource();
        this._disconnectSettings();

        if (!this._destroyed)
            this._unloadStylesheet();
    }

    /**
     * Limpia ajustes, arrastre, actor y hoja de estilos.
     */
    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        if (this._isOpen)
            this.close();

        this._isOpen = false;

        this._clearFocusSource();
        this._endDrag();
        this._disconnectSettings();

        this._destroyGlass();
        if (this._glassUnsubscribe) {
            this._glassUnsubscribe();
            this._glassUnsubscribe = null;
        }
        if (this._themeGlassId) {
            this._extension?._theme?.disconnect(this._themeGlassId);
            this._themeGlassId = 0;
        }
        this._glassEngine = null;

        const actor = this._actor;
        const wasAdded = this._actorAdded;

        this._actor = null;
        this._actorAdded = false;

        if (wasAdded && actor && Main.layoutManager) {
            try {
                Main.layoutManager.removeChrome(actor);
            } catch (e) {
                logError(e, 'Tahoe Top Bar: no se pudo quitar la ventana Acerca de');
            }
        }

        if (actor) {
            try {
                actor.remove_all_transitions();
                actor.destroy();
            } catch (e) {
                logError(e, 'Tahoe Top Bar: no se pudo destruir la ventana Acerca de');
            }
        }

        this._unloadStylesheet();
    }
}
