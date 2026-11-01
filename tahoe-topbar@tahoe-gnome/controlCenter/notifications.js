// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Notificaciones estilo macOS Tahoe para el Centro de control.
//
// La columna de notificaciones vive debajo de la rejilla del CC. Con el CC
// cerrado no creamos banners propios: reutilizamos el banner de GNOME
// (Main.messageTray._banner), le damos el material Liquid Glass y lo alineamos
// a la derecha. Al abrir el CC se bloquean los banners de GNOME para que las
// notificaciones nuevas entren directamente en la pila.
//
// Privacidad: el módulo nunca escribe títulos ni cuerpos en disco. Sólo lee
// los objetos Notification/Source que ya mantiene GNOME en memoria.

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {glassLook} from '../liquidGlass.js';

const LOG = '[tahoe-topbar/notifications]';

const PANEL_WIDTH = 284;
const MAX_CARD_HANDLES = 4;
const MAX_SCROLL_HEIGHT = 420;
const SWIPE_MIN = 60;
const SWIPE_RATIO = 0.3;
const STACK_OFFSET = 6;
const COLLAPSED_BODY_LIMIT = 180;
const TITLE_LIMIT = 120;

function scaleFactor() {
    try {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (_e) {
        return 1;
    }
}

function px(value) {
    return Math.max(1, Math.round(value * scaleFactor()));
}

function timeText(datetime) {
    try {
        if (!datetime)
            return '';
        return datetime.format('%H:%M');
    } catch (_e) {
        return '';
    }
}

function shortText(text, limit) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (value.length <= limit)
        return value;
    return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function panDeltaX(gesture) {
    const delta = gesture.get_accumulated_delta();
    if (Array.isArray(delta))
        return Number(delta[0]) || 0;
    if (typeof delta?.x === 'number')
        return delta.x;
    if (typeof delta?.get_x === 'function')
        return Number(delta.get_x()) || 0;
    return 0;
}

function iconFor(notification) {
    if (notification?.gicon)
        return notification.gicon;
    if (notification?.source?.icon)
        return notification.source.icon;
    if (notification?.source?.iconName)
        return new Gio.ThemedIcon({name: notification.source.iconName});
    if (notification?.iconName)
        return new Gio.ThemedIcon({name: notification.iconName});
    return new Gio.ThemedIcon({name: 'dialog-information-symbolic'});
}

function safeTitle(notification) {
    return shortText(notification?.title, TITLE_LIMIT) ||
        shortText(notification?.source?.title, TITLE_LIMIT) ||
        'Notificación';
}

export class TahoeNotifications {
    constructor(cc) {
        this._cc = cc;
        this._settings = cc?._settings ?? null;
        this._destroyed = false;
        this._enabled = false;
        this._open = false;

        this._sources = new Map();
        this._notificationSignals = new Map();
        this._expanded = new Set();
        this._cardActors = [];
        this._cardHandles = [];

        this._timeoutIds = new Set();
        this._idleIds = new Set();
        this._renderId = 0;
        this._heightId = 0;

        this._tray = Main.messageTray ?? null;
        this._bannerBin = null;
        this._bannerBinSignals = [];
        this._bannerSignals = new Map();
        this._banner = null;
        this._bannerHandle = null;
        this._bannerBlockSaved = false;
        this._bannerBlockPrevious = false;
        this._bannerStyleSaved = false;
        this._savedBannerAlignment = Clutter.ActorAlign.CENTER;
        this._savedBannerBinMarginRight = 0;
        this._savedBannerBinTranslationX = 0;
        this._savedBannerBinXExpand = true;

        this._box = this._buildView();
        this._settingsConnection = 0;

        if (this._settings) {
            try {
                this._settingsConnection = this._settings.connect(
                    'changed::control-center-notifications',
                    () => this.setEnabled(this._settings.get_boolean(
                        'control-center-notifications')));
            } catch (_e) {
                this._settingsConnection = 0;
            }
        }

        this._connect(this._cc?._ccRoot, 'notify::height',
            () => this._queueHeight());
        this._connect(this._cc?._ccButton?.container, 'notify::height',
            () => this._queueHeight());
        this._connect(Main.layoutManager, 'monitors-changed',
            () => this._onMonitorsChanged());
        this._connect(Main.sessionMode, 'updated',
            () => this._onSessionUpdated());

        try {
            this._scaleContext = St.ThemeContext.get_for_stage(global.stage);
            this._connect(this._scaleContext, 'notify::scale-factor',
                () => this._onMonitorsChanged());
        } catch (_e) {
            this._scaleContext = null;
        }

        this.setEnabled(this._settings?.get_boolean(
            'control-center-notifications') ?? false);
    }

    get actor() {
        return this._box;
    }

    // ------------------------------------------------------------------
    // Construcción de la columna
    // ------------------------------------------------------------------

    _buildView() {
        const box = new St.BoxLayout({
            style_class: 'tahoe-notifications',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
            visible: false,
        });

        const header = new St.BoxLayout({
            style_class: 'tahoe-notifications-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const title = new St.Label({
            text: 'Notificaciones',
            style_class: 'tahoe-notifications-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);

        this._clearButton = new St.Button({
            style_class: 'tahoe-notifications-clear',
            can_focus: true,
            reactive: false,
            accessible_name: 'Borrar todas las notificaciones',
        });
        this._clearButton.set_child(new St.Label({
            text: 'Borrar todo',
            style_class: 'tahoe-notifications-clear-label',
        }));
        this._clearButton.connect('clicked', () => this._clearAll());
        header.add_child(this._clearButton);
        box.add_child(header);

        this._holder = new St.Bin({
            style_class: 'tahoe-notifications-holder',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });

        this._scroll = new St.ScrollView({
            style_class: 'tahoe-notifications-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });

        this._content = new St.BoxLayout({
            style_class: 'tahoe-notifications-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll.set_child(this._content);
        this._holder.set_child(this._scroll);
        box.add_child(this._holder);

        return box;
    }

    // ------------------------------------------------------------------
    // Activación y ciclo de vida
    // ------------------------------------------------------------------

    setEnabled(enabled) {
        if (this._destroyed)
            return;

        enabled = Boolean(enabled);
        if (enabled === this._enabled)
            return;

        this._enabled = enabled;
        if (enabled) {
            this._attachBannerStyle();
            this._connectTray();
            if (this._cc?._ccButton?.menu.isOpen && !this._open)
                this.setOpen(true);
        } else {
            this.setOpen(false);
            this._disconnectTray();
            this._restoreBannerStyle();
            this._box.hide();
        }
    }

    setOpen(open) {
        if (this._destroyed)
            return;

        open = Boolean(open) && this._enabled;
        if (open === this._open) {
            if (open)
                this._scheduleRender();
            return;
        }

        this._open = open;
        if (open) {
            this._blockBanners(true);
            this._box.show();
            this._render();
        } else {
            this._expanded.clear();
            this._box.hide();
            this._destroyCards();
            this._blockBanners(false);
        }
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this.setOpen(false);
        this._disconnectTray();
        this._restoreBannerStyle();

        if (this._settingsConnection) {
            try {
                this._settings.disconnect(this._settingsConnection);
            } catch (_e) {
                // Ajustes ya destruidos.
            }
            this._settingsConnection = 0;
        }

        for (const id of [...this._timeoutIds]) {
            try {
                GLib.source_remove(id);
            } catch (_e) {
                // Ya retirado.
            }
        }
        this._timeoutIds.clear();

        for (const id of [...this._idleIds]) {
            try {
                GLib.source_remove(id);
            } catch (_e) {
                // Ya retirado.
            }
        }
        this._idleIds.clear();

        this._disconnectAllTracked();
        this._destroyCards();
        this._box.destroy();
        this._box = null;
        this._cc = null;
        this._settings = null;
        this._tray = null;
        this._scaleContext = null;
    }

    // ------------------------------------------------------------------
    // Señales
    // ------------------------------------------------------------------

    _connect(object, signal, callback) {
        if (!object)
            return 0;

        try {
            return object.connect(signal, callback);
        } catch (e) {
            console.error(`${LOG} No se pudo conectar «${signal}»:`, e);
            return 0;
        }
    }

    _disconnectAllTracked() {
        // Las conexiones se guardan por objeto para poder retirarlas sin
        // tocar objetos que GNOME ya haya destruido.
        for (const [object, ids] of this._ownedSignals ?? []) {
            for (const id of ids) {
                try {
                    object.disconnect(id);
                } catch (_e) {
                    // El objeto ya no existe.
                }
            }
        }
        this._ownedSignals = null;
    }

    _track(object, signal, callback) {
        if (!object)
            return;
        const id = this._connect(object, signal, callback);
        if (!id)
            return;
        if (!this._ownedSignals)
            this._ownedSignals = new Map();
        const ids = this._ownedSignals.get(object) ?? [];
        ids.push(id);
        this._ownedSignals.set(object, ids);
    }

    _connectTray() {
        if (!this._tray || this._trayConnected)
            return;

        this._trayConnected = true;
        this._track(this._tray, 'source-added',
            (_tray, source) => this._watchSource(source));
        this._track(this._tray, 'source-removed',
            (_tray, source) => this._unwatchSource(source));
        this._track(this._tray, 'queue-changed', () => this._scheduleRender());

        for (const source of this._tray.getSources())
            this._watchSource(source);
    }

    _disconnectTray() {
        if (!this._trayConnected)
            return;

        this._trayConnected = false;
        for (const source of [...this._sources.keys()])
            this._unwatchSource(source, false);
        this._sources.clear();

        if (this._ownedSignals) {
            for (const [object, ids] of [...this._ownedSignals]) {
                if (object === this._cc?._ccRoot ||
                    object === this._cc?._ccButton?.container ||
                    object === Main.layoutManager ||
                    object === Main.sessionMode ||
                    object === this._scaleContext)
                    continue;
                for (const id of ids) {
                    try {
                        object.disconnect(id);
                    } catch (_e) {
                        // Ignorar.
                    }
                }
                this._ownedSignals.delete(object);
            }
        }
    }

    _watchSource(source) {
        if (!source || this._sources.has(source))
            return;

        this._sources.set(source, []);
        const ids = [];
        const add = (object, signal, callback) => {
            const id = this._connect(object, signal, callback);
            if (id)
                ids.push([object, id]);
        };

        add(source, 'notification-added', (_source, notification) => {
            this._watchNotification(notification);
            this._scheduleRender();
        });
        add(source, 'notification-removed', (_source, notification) => {
            this._unwatchNotification(notification);
            this._scheduleRender();
        });
        add(source, 'notify::title', () => this._scheduleRender());
        add(source, 'destroy', () => this._unwatchSource(source));

        this._sources.set(source, ids);
        for (const notification of source.notifications ?? [])
            this._watchNotification(notification);
    }

    _unwatchSource(source, schedule = true) {
        const ids = this._sources.get(source);
        if (ids) {
            for (const [object, id] of ids) {
                try {
                    object.disconnect(id);
                } catch (_e) {
                    // Ignorar.
                }
            }
        }
        this._sources.delete(source);
        this._expanded.delete(source);

        for (const notification of source.notifications ?? [])
            this._unwatchNotification(notification);

        if (schedule)
            this._scheduleRender();
    }

    _watchNotification(notification) {
        if (!notification || this._notificationSignals.has(notification))
            return;

        const ids = [];
        const add = (signal, callback) => {
            const id = this._connect(notification, signal, callback);
            if (id)
                ids.push([notification, id]);
        };

        for (const signal of ['notify::title', 'notify::body',
            'notify::datetime', 'notify::gicon', 'notify::urgency',
            'action-added', 'action-removed']) {
            add(signal, () => this._scheduleRender());
        }
        add('destroy', () => this._unwatchNotification(notification));

        this._notificationSignals.set(notification, ids);
    }

    _unwatchNotification(notification) {
        const ids = this._notificationSignals.get(notification);
        if (!ids)
            return;

        this._notificationSignals.delete(notification);
        for (const [object, id] of ids) {
            try {
                object.disconnect(id);
            } catch (_e) {
                // Ignorar.
            }
        }
    }

    _onMonitorsChanged() {
        this._applyBannerOffset();
        if (!this._open)
            return;
        this._queueHeight();
        this._scheduleRender();
    }

    _onSessionUpdated() {
        if (this._destroyed)
            return;
        if (Main.sessionMode.isLocked || !Main.sessionMode.hasNotifications) {
            this._expanded.clear();
            this._render();
            return;
        }
        this._scheduleRender();
    }

    _addTimeout(interval, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._timeoutIds.delete(id);
            if (!this._destroyed)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutIds.add(id);
        return id;
    }

    _addIdle(callback) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleIds.delete(id);
            if (!this._destroyed)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._idleIds.add(id);
        return id;
    }

    // ------------------------------------------------------------------
    // Banner de GNOME
    // ------------------------------------------------------------------

    _attachBannerStyle() {
        if (this._bannerStyleSaved || !this._tray)
            return;

        const bin = this._tray._bannerBin;
        if (!bin)
            return;

        this._bannerBin = bin;
        this._savedBannerAlignment = this._tray.bannerAlignment;
        this._savedBannerBinMarginRight = bin.margin_right;
        this._savedBannerBinTranslationX = bin.translation_x;
        this._savedBannerBinXExpand = bin.x_expand;
        this._bannerStyleSaved = true;

        this._tray.bannerAlignment = Clutter.ActorAlign.END;
        this._applyBannerOffset();

        this._bannerBinSignals = [
            this._connect(bin, 'child-added',
                (_bin, child) => this._onBannerChildAdded(child)),
            this._connect(bin, 'child-removed',
                (_bin, child) => this._onBannerChildRemoved(child)),
        ];

        if (this._tray._banner)
            this._styleBanner(this._tray._banner);
        for (const child of bin.get_children()) {
            if (child.has_style_class_name('notification-banner'))
                this._styleBanner(child);
        }
    }

    _applyBannerOffset() {
        const bin = this._bannerBin;
        if (!bin || !this._bannerStyleSaved)
            return;

        // BinLayout alinea el banner contra el borde derecho. El margen del
        // actor no siempre lo respeta Clutter; el banner de GNOME además
        // trae 4 px de margen propio, así que el desplazamiento se ajusta
        // para dejar exactamente 8 px respecto al borde del monitor.
        bin.margin_right = px(8);
        bin.translation_x = -px(4);
        bin.add_style_class_name('tahoe-notification-banner-bin');
    }

    _restoreBannerStyle() {
        this._blockBanners(false);
        this._destroyBannerGlass();

        const bin = this._bannerBin;
        if (bin) {
            try {
                bin.remove_style_class_name('tahoe-notification-banner-bin');
            } catch (_e) {
                // Actor ya destruido.
            }
        }

        for (const [banner, ids] of [...this._bannerSignals]) {
            try {
                banner.remove_style_class_name('tahoe-notification-banner');
                banner.remove_style_class_name('tahoe-notification-banner-glass');
            } catch (_e) {
                // Ignorar.
            }
            for (const id of ids) {
                try {
                    banner.disconnect(id);
                } catch (_e) {
                    // Ignorar.
                }
            }
        }
        this._bannerSignals.clear();
        this._banner = null;

        if (this._bannerStyleSaved && this._tray) {
            try {
                this._tray.bannerAlignment = this._savedBannerAlignment;
            } catch (_e) {
                // MessageTray ya destruido.
            }
        }

        if (bin) {
            try {
                bin.margin_right = this._savedBannerBinMarginRight;
                bin.translation_x = this._savedBannerBinTranslationX;
                bin.x_expand = this._savedBannerBinXExpand;
            } catch (_e) {
                // Actor ya destruido.
            }
        }

        for (const id of this._bannerBinSignals) {
            try {
                bin?.disconnect(id);
            } catch (_e) {
                // Ignorar.
            }
        }
        this._bannerBinSignals = [];
        this._bannerBin = null;
        this._bannerStyleSaved = false;
    }

    _onBannerChildAdded(child) {
        if (!this._enabled || !child)
            return;
        if (child.has_style_class_name('notification-banner'))
            this._styleBanner(child);
    }

    _onBannerChildRemoved(child) {
        if (this._banner === child)
            this._banner = null;
        this._unwatchBanner(child);
        this._bannerHandle = null;
        try {
            child.remove_style_class_name('tahoe-notification-banner-glass');
        } catch (_e) {
            // Actor ya destruido.
        }
    }

    _styleBanner(banner) {
        if (!banner || this._bannerSignals.has(banner))
            return;

        banner.add_style_class_name('tahoe-notification-banner');
        this._banner = banner;

        const ids = [
            this._connect(banner, 'notify::mapped',
                () => this._syncBannerGlass()),
            this._connect(banner, 'notify::visible',
                () => this._syncBannerGlass()),
            this._connect(banner, 'destroy', () => {
                if (this._banner === banner)
                    this._banner = null;
                this._unwatchBanner(banner);
                // El banner está siendo destruido: el propio GlassHandle se
                // encarga de liberar su superficie al recibir «destroy».
                // Volver a destruirlo aquí puede tocar un actor ya liberado
                // durante el apagado del shell.
                this._bannerHandle = null;
                try {
                    banner.remove_style_class_name('tahoe-notification-banner-glass');
                } catch (_e) {
                    // Actor ya destruido.
                }
            }),
        ];
        this._bannerSignals.set(banner, ids);
        this._syncBannerGlass();
    }

    _unwatchBanner(banner) {
        const ids = this._bannerSignals.get(banner);
        if (!ids)
            return;
        this._bannerSignals.delete(banner);
        for (const id of ids) {
            try {
                banner.disconnect(id);
            } catch (_e) {
                // Ignorar.
            }
        }
    }

    _canUseLiquidGlass() {
        return this._cc?._glassStyle === 'liquid' &&
            Boolean(this._cc?._glassEngine);
    }

    _syncBannerGlass() {
        if (!this._enabled || this._open || this._destroyed) {
            this._destroyBannerGlass();
            return;
        }

        const banner = this._banner ?? this._tray?._banner ?? null;
        if (!banner || !banner.mapped || !banner.visible ||
            !this._canUseLiquidGlass()) {
            this._destroyBannerGlass();
            return;
        }

        if (this._bannerHandle)
            return;

        try {
            this._bannerHandle = this._cc._glassEngine.attach(banner,
                glassLook(this._cc._tahoeTheme, {
                    cornerRadius: 18,
                    blurRadius: 12,
                    owner: 'notification-banner',
                }));
            banner.add_style_class_name('tahoe-notification-banner-glass');
        } catch (e) {
            this._bannerHandle = null;
            console.error(`${LOG} No se pudo aplicar cristal al banner:`, e);
        }
    }

    _destroyBannerGlass() {
        const handle = this._bannerHandle;
        this._bannerHandle = null;
        // Si el motor ya no existe, sus handles fueron destruidos por él;
        // volver a destruirlos tocaría un BackdropGlass ya liberado.
        if (handle && this._cc?._glassEngine) {
            try {
                handle.destroy();
            } catch (_e) {
                // Handle ya destruido.
            }
        }
        try {
            for (const banner of this._bannerSignals.keys())
                banner.remove_style_class_name('tahoe-notification-banner-glass');
            this._banner?.remove_style_class_name('tahoe-notification-banner-glass');
        } catch (_e) {
            // Actor ya destruido.
        }
    }

    refreshLook() {
        if (this._destroyed)
            return;

        if (this._bannerHandle) {
            try {
                this._bannerHandle.update(glassLook(this._cc?._tahoeTheme, {
                    cornerRadius: 18,
                    blurRadius: 12,
                    owner: 'notification-banner',
                }));
            } catch (_e) {
                // Handle ya destruido.
            }
        }

        for (const {handle} of this._cardHandles) {
            try {
                handle.update(glassLook(this._cc?._tahoeTheme, {
                    cornerRadius: 18,
                    blurRadius: 12,
                    owner: 'notification-card',
                }));
            } catch (_e) {
                // Handle ya destruido.
            }
        }
    }

    refreshGlass() {
        if (this._destroyed)
            return;
        this._destroyBannerGlass();
        this._destroyCardGlass();
        this._syncBannerGlass();
        this._syncCardGlass();
    }

    _blockBanners(block) {
        const tray = this._tray;
        if (!tray)
            return;

        if (block) {
            if (!this._bannerBlockSaved) {
                this._bannerBlockPrevious = Boolean(tray._bannerBlocked);
                this._bannerBlockSaved = true;
            }
            tray.bannerBlocked = true;
        } else if (this._bannerBlockSaved) {
            try {
                tray.bannerBlocked = this._bannerBlockPrevious;
            } catch (_e) {
                // MessageTray ya destruido.
            }
            this._bannerBlockSaved = false;
        }
    }

    // ------------------------------------------------------------------
    // Modelo y render
    // ------------------------------------------------------------------

    _scheduleRender() {
        if (!this._open || !this._enabled || this._destroyed || this._renderId)
            return;

        this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleIds.delete(this._renderId);
            this._renderId = 0;
            if (this._open && this._enabled && !this._destroyed)
                this._render();
            return GLib.SOURCE_REMOVE;
        });
        this._idleIds.add(this._renderId);
    }

    _collectGroups() {
        if (!this._tray || Main.sessionMode.isLocked ||
            !Main.sessionMode.hasNotifications)
            return [];

        const groups = [];
        for (const source of this._tray.getSources()) {
            const notifications = (source.notifications ?? [])
                .filter(n => Boolean(n))
                .sort((a, b) => this._compareNotifications(a, b));

            if (notifications.length === 0)
                continue;

            groups.push({
                source,
                notifications,
                latest: notifications[0],
            });
        }

        groups.sort((a, b) => this._compareNotifications(a.latest, b.latest));
        return groups;
    }

    _compareNotifications(a, b) {
        const ta = a?.datetime?.to_unix?.() ?? 0;
        const tb = b?.datetime?.to_unix?.() ?? 0;
        if (ta !== tb)
            return tb - ta;
        return 0;
    }

    _render() {
        if (this._destroyed || !this._open || !this._box)
            return;

        this._destroyCardGlass();
        this._cardActors = [];
        this._content.destroy_all_children();

        const groups = this._collectGroups();
        const hasNotifications = groups.length > 0;

        this._clearButton.reactive = hasNotifications;
        this._clearButton.can_focus = hasNotifications;
        if (hasNotifications)
            this._clearButton.remove_style_class_name('tahoe-notifications-clear-disabled');
        else
            this._clearButton.add_style_class_name('tahoe-notifications-clear-disabled');

        if (!hasNotifications) {
            const empty = new St.Label({
                text: 'No hay notificaciones',
                style_class: 'tahoe-notifications-empty',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._content.add_child(empty);
        } else {
            for (const group of groups)
                this._content.add_child(this._buildGroup(group));
        }

        this._syncCardGlass();
        this._queueHeight();
    }

    _buildGroup(group) {
        if (this._expanded.has(group.source))
            return this._buildExpandedGroup(group);
        return this._buildCollapsedGroup(group);
    }

    _buildCollapsedGroup(group) {
        const stack = new St.Widget({
            style_class: 'tahoe-notification-stack',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            reactive: true,
        });
        let alive = true;
        stack.connect('destroy', () => {
            alive = false;
        });

        const visibleCount = Math.min(group.notifications.length, 3);
        const ghosts = [];
        for (let depth = visibleCount - 1; depth >= 1; depth--) {
            const ghost = new St.Widget({
                style_class: `tahoe-notification-ghost tahoe-notification-ghost-${depth}`,
                x_expand: true,
                y_align: Clutter.ActorAlign.START,
                reactive: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            ghost.set_pivot_point(0.5, 0.0);
            ghost.set_scale(1 - 0.05 * depth, 1 - 0.05 * depth);
            ghost.translation_y = px(STACK_OFFSET * depth);
            ghost.connect('button-release-event', () => {
                this._expandSource(group.source);
                return Clutter.EVENT_STOP;
            });
            stack.add_child(ghost);
            ghosts.push({actor: ghost, depth});
        }

        const top = this._buildCard(group.notifications[0], {
            group,
            collapsed: true,
            badge: group.notifications.length,
        });
        stack.add_child(top);

        const syncHeight = () => {
            if (!alive || !stack || !top || !top.get_stage())
                return;
            let height = top.height;
            if (!height)
                height = top.get_preferred_height(px(PANEL_WIDTH - 24))[1];
            if (!height)
                return;
            for (const {actor, depth} of ghosts) {
                actor.height = height;
                actor.translation_y = px(STACK_OFFSET * depth);
            }
            const wanted = height + px(STACK_OFFSET * Math.max(0, ghosts.length));
            if (wanted > 0 && stack.height !== wanted)
                stack.height = wanted;
        };

        top.connect('notify::height', syncHeight);
        top.connect('notify::allocation', syncHeight);
        this._addIdle(syncHeight);
        syncHeight();

        return stack;
    }

    _buildExpandedGroup(group) {
        const box = new St.BoxLayout({
            style_class: 'tahoe-notification-group tahoe-notification-group-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const header = new St.Button({
            style_class: 'tahoe-notification-group-header',
            x_expand: true,
            can_focus: true,
            reactive: true,
            accessible_name: `Ocultar notificaciones de ${group.source.title ?? 'la aplicación'}`,
        });

        const row = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(new St.Label({
            text: group.source.title ?? 'Aplicación',
            style_class: 'tahoe-notification-group-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        row.add_child(new St.Label({
            text: String(group.notifications.length),
            style_class: 'tahoe-notification-badge',
        }));
        row.add_child(new St.Label({
            text: '⌃',
            style_class: 'tahoe-notification-group-chevron',
        }));
        header.set_child(row);
        header.connect('clicked', () => this._collapseSource(group.source));
        box.add_child(header);

        for (const notification of group.notifications) {
            box.add_child(this._buildCard(notification, {
                group,
                collapsed: false,
                badge: 0,
            }));
        }

        return box;
    }

    _buildCard(notification, {group, collapsed, badge = 0}) {
        const source = notification.source ?? group.source;
        const card = new St.Button({
            style_class: 'tahoe-notification-card',
            x_expand: true,
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: `${source?.title ?? 'Aplicación'}: ${safeTitle(notification)}`,
        });
        card.set_width(px(PANEL_WIDTH));
        this._cardActors.push(card);

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        content.set_width(px(PANEL_WIDTH - 24));
        card.set_child(content);
        card._tahoeNotification = notification;

        const header = new St.BoxLayout({
            style_class: 'tahoe-notification-card-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.set_width(px(PANEL_WIDTH - 24));

        header.add_child(new St.Icon({
            style_class: 'tahoe-notification-icon',
            gicon: iconFor(notification),
            icon_size: px(16),
            y_align: Clutter.ActorAlign.CENTER,
        }));

        header.add_child(new St.Label({
            text: source?.title ?? 'Aplicación',
            style_class: 'tahoe-notification-source',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const sourceLabel = header.get_last_child();
        sourceLabel.clutter_text.line_wrap = false;
        sourceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const time = new St.Label({
            text: timeText(notification.datetime),
            style_class: 'tahoe-notification-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(time);

        if (badge > 1) {
            const badgeButton = new St.Button({
                style_class: 'tahoe-notification-badge-button',
                can_focus: true,
                reactive: true,
                accessible_name: `Mostrar ${badge} notificaciones de ${source?.title ?? 'la aplicación'}`,
            });
            badgeButton.set_child(new St.Label({
                text: badge > 99 ? '99+' : String(badge),
                style_class: 'tahoe-notification-badge',
            }));
            badgeButton.connect('clicked', () => this._expandSource(source));
            header.add_child(badgeButton);
        }

        const close = new St.Button({
            style_class: 'tahoe-notification-close',
            label: '×',
            can_focus: true,
            reactive: true,
            accessible_name: 'Cerrar notificación',
        });
        close.connect('clicked', () => this._dismiss(notification));
        close._tahoeNotificationClose = true;
        header.add_child(close);

        content.add_child(header);

        content.add_child(new St.Label({
            text: safeTitle(notification),
            style_class: 'tahoe-notification-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        const titleLabel = content.get_last_child();
        titleLabel.clutter_text.line_wrap = false;
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const body = shortText(notification.body,
            collapsed ? COLLAPSED_BODY_LIMIT : 900);
        if (body) {
            const bodyLabel = new St.Label({
                text: body,
                style_class: 'tahoe-notification-body',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            bodyLabel.clutter_text.line_wrap = true;
            bodyLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            content.add_child(bodyLabel);
        }

        if (!collapsed && notification.actions?.length) {
            const actions = new St.BoxLayout({
                style_class: 'tahoe-notification-actions',
                x_expand: true,
            });
            for (const action of notification.actions.slice(0, 3)) {
                const button = new St.Button({
                    style_class: 'tahoe-notification-action',
                    label: action.label,
                    x_expand: true,
                    can_focus: true,
                    reactive: true,
                    accessible_name: action.label,
                });
                button.connect('clicked', () => {
                    try {
                        action.activate();
                    } catch (e) {
                        console.error(`${LOG} Falló una acción de notificación:`, e);
                    }
                });
                actions.add_child(button);
            }
            content.add_child(actions);
        }

        card.connect('clicked', () => {
            if (card._tahoeSuppressClick) {
                card._tahoeSuppressClick = false;
                return;
            }
            if (collapsed && group.notifications.length > 1)
                this._expandSource(group.source);
            else
                this._activate(notification);
        });

        this._attachSwipe(card, notification);

        return card;
    }

    _attachSwipe(card, notification) {
        const gesture = new Clutter.PanGesture();
        gesture.set_begin_threshold(px(12));
        try {
            gesture.set_pan_axis(Clutter.PanAxis.X);
            gesture.set_required_button(Clutter.BUTTON_PRIMARY);
        } catch (_e) {
            // API antigua: se deja el eje por defecto.
        }

        gesture.connect('recognize', () => {
            card._tahoeSuppressClick = true;
            return Clutter.EVENT_STOP;
        });

        gesture.connect('pan-update', () => {
            const deltaX = panDeltaX(gesture);
            card.translation_x = deltaX;
            card.opacity = Math.max(100, 255 - Math.round(Math.abs(deltaX) / 2));
        });

        gesture.connect('end', () => {
            const deltaX = panDeltaX(gesture);
            const width = card.width || px(PANEL_WIDTH);
            const threshold = Math.max(px(SWIPE_MIN), width * SWIPE_RATIO);
            if (Math.abs(deltaX) >= threshold) {
                const direction = Math.sign(deltaX) || 1;
                card.reactive = false;
                card.ease({
                    translation_x: direction * (width + px(24)),
                    opacity: 0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                });
                this._addTimeout(150, () => this._dismiss(notification));
            } else {
                card.ease({
                    translation_x: 0,
                    opacity: 255,
                    duration: 160,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        card._tahoeSuppressClick = false;
                    },
                });
            }
        });

        card.add_action(gesture);
    }

    _expandSource(source) {
        if (!source || this._expanded.has(source))
            return;
        this._expanded.add(source);
        this._render();
    }

    _collapseSource(source) {
        if (!this._expanded.delete(source))
            return;
        this._render();
    }

    _activate(notification) {
        if (!notification)
            return;
        try {
            // En GNOME 50 el CC sigue abierto; cerrar el menú antes de
            // activar evita que la app quede detrás del panel modal.
            this._cc?._ccButton?.menu?.close();
            notification.activate();
        } catch (e) {
            console.error(`${LOG} No se pudo activar la notificación:`, e);
        }
    }

    _dismiss(notification) {
        if (!notification)
            return;
        try {
            notification.destroy(
                MessageTray.NotificationDestroyedReason.DISMISSED);
        } catch (e) {
            console.error(`${LOG} No se pudo cerrar la notificación:`, e);
        }
        this._scheduleRender();
    }

    _clearAll() {
        if (!this._tray)
            return;

        const notifications = [];
        for (const source of this._tray.getSources()) {
            for (const notification of source.notifications ?? []) {
                if (notification)
                    notifications.push(notification);
            }
        }

        for (const notification of notifications) {
            try {
                notification.destroy(
                    MessageTray.NotificationDestroyedReason.DISMISSED);
            } catch (e) {
                console.error(`${LOG} No se pudo borrar una notificación:`, e);
            }
        }

        this._expanded.clear();
        this._scheduleRender();
    }

    // ------------------------------------------------------------------
    // Cristal de las tarjetas y altura
    // ------------------------------------------------------------------

    _syncCardGlass() {
        this._destroyCardGlass();
        if (!this._open || !this._canUseLiquidGlass())
            return;

        for (const card of this._cardActors) {
            if (this._cardHandles.length >= MAX_CARD_HANDLES)
                break;
            if (!card)
                continue;
            try {
                const handle = this._cc._glassEngine.attach(card,
                    glassLook(this._cc._tahoeTheme, {
                        cornerRadius: 18,
                        blurRadius: 12,
                        owner: 'notification-card',
                    }));
                this._cardHandles.push({card, handle});
                card.add_style_class_name('tahoe-notification-card-glass');
            } catch (e) {
                console.error(`${LOG} No se pudo aplicar cristal a una tarjeta:`, e);
            }
        }
    }

    _destroyCardGlass() {
        const engine = this._cc?._glassEngine;
        for (const {card, handle} of this._cardHandles) {
            if (engine) {
                try {
                    handle.destroy();
                } catch (_e) {
                    // Handle ya destruido.
                }
            }
            try {
                card.remove_style_class_name('tahoe-notification-card-glass');
            } catch (_e) {
                // Actor ya destruido.
            }
        }
        this._cardHandles = [];
    }

    _destroyCards() {
        this._destroyCardGlass();
        this._cardActors = [];
        if (this._content) {
            try {
                this._content.destroy_all_children();
            } catch (_e) {
                // Ignorar.
            }
        }
    }

    _queueHeight() {
        if (!this._open || this._destroyed || this._heightId)
            return;

        this._heightId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleIds.delete(this._heightId);
            this._heightId = 0;
            if (this._open && !this._destroyed)
                this._updateHeight();
            return GLib.SOURCE_REMOVE;
        });
        this._idleIds.add(this._heightId);
    }

    _updateHeight() {
        if (!this._holder || !this._content || !this._cc)
            return;

        const monitor = Main.layoutManager.findMonitorForActor(
            this._cc._ccButton?.container ?? this._box) ??
            Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor?.(monitor.index) ??
            monitor;
        const stageY = this._cc._ccStage?.get_transformed_extents?.().origin.y ?? 0;
        const top = stageY > 0
            ? stageY
            : workArea.y + (Main.panel.height || px(32));
        const rootHeight = this._cc._ccRoot?.height ||
            this._cc._ccRoot?.get_preferred_height?.(px(PANEL_WIDTH))?.[1] || 0;
        const headerHeight = this._box.get_children()[0]?.height || px(24);
        const available = Math.max(
            px(96),
            workArea.y + workArea.height - px(16) - top - rootHeight -
                px(12) - headerHeight - px(6));

        const [, natural] = this._content.get_preferred_height(px(PANEL_WIDTH - 4));
        const maxHeight = Math.min(available, px(MAX_SCROLL_HEIGHT));
        const wanted = Math.max(px(40), Math.min(natural, maxHeight));
        if (this._holder.height !== wanted)
            this._holder.height = wanted;
    }
}
