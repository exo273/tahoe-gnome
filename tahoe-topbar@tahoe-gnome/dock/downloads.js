// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Descargas, papelera y volúmenes montados para el Dock.
//
// Los modelos enumeran de forma asíncrona y emiten un cambio coalescido; el
// dock sólo reconstruye las insignias/menús cuando termina una enumeración.
// Nunca se borra nada sin pasar por el ModalDialog de confirmación.

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const LOG = '[tahoe-dock/downloads]';
const DOWNLOADS_ATTRS = 'standard::name,standard::type,standard::icon,standard::size,time::modified';
const TRASH_ATTRS = 'standard::name,standard::type,standard::icon,standard::size,time::modified';
const MAX_ITEMS = 5000;
const RECENT_LIMIT = 8;

// GJS no convierte automáticamente estas APIs de callback en promesas.
Gio._promisify(Gio.File.prototype, 'enumerate_children_async',
    'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async',
    'next_files_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.Volume.prototype, 'eject_with_operation',
    'eject_with_operation_finish');
Gio._promisify(Gio.Mount.prototype, 'unmount_with_operation',
    'unmount_with_operation_finish');

function isCancelled(error) {
    try {
        return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
    } catch (_e) {
        return false;
    }
}

function themedIcon(name) {
    return Gio.ThemedIcon.new(name);
}

function launchUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
        Main.overview.hide();
        return true;
    } catch (e) {
        console.error(`${LOG} No se pudo abrir ${uri}:`, e);
        return false;
    }
}

class ChangeEmitter {
    constructor() {
        this._listeners = new Set();
    }

    connect(callback) {
        if (typeof callback !== 'function')
            return null;
        this._listeners.add(callback);
        return callback;
    }

    disconnect(callback) {
        if (callback)
            this._listeners.delete(callback);
    }

    emit() {
        for (const callback of [...this._listeners]) {
            try {
                callback(this);
            } catch (e) {
                console.error(`${LOG} Error en un listener:`, e);
            }
        }
    }
}

async function enumerateFiles(file, attributes, cancellable, limit = MAX_ITEMS) {
    const infos = [];
    let enumerator = null;

    try {
        enumerator = await file.enumerate_children_async(
            attributes,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable);

        while (infos.length < limit) {
            const batch = await enumerator.next_files_async(
                64, GLib.PRIORITY_DEFAULT, cancellable);
            if (!batch || batch.length === 0)
                break;

            for (const info of batch) {
                const child = enumerator.get_child(info);
                if (!child)
                    continue;
                infos.push({info, file: child});
                if (infos.length >= limit)
                    break;
            }
        }
    } finally {
        if (enumerator) {
            try {
                enumerator.close(null);
            } catch (_e) {
                // El enumerador ya se cerró o se canceló.
            }
        }
    }

    return infos;
}

function infoToItem(entry) {
    const {info, file} = entry;
    const type = info.get_file_type();
    const isDir = type === Gio.FileType.DIRECTORY;
    let icon = info.get_icon();
    if (!icon)
        icon = themedIcon(isDir ? 'folder' : 'text-x-generic');

    return {
        file,
        name: info.get_name() ?? file.get_basename() ?? '',
        icon,
        isDir,
        mtime: info.get_attribute_uint64('time::modified'),
        size: info.get_size(),
    };
}

/* ---------------------------------------------------------------------- */
/* Descargas                                                               */
/* ---------------------------------------------------------------------- */

export class DownloadsModel extends ChangeEmitter {
    constructor(path = null) {
        super();
        this._path = path;
        this._file = null;
        this._monitor = null;
        this._monitorId = 0;
        this._refreshId = 0;
        this._cancellable = null;
        this._token = 0;
        this._destroyed = false;
        this.count = 0;
        this.items = [];
    }

    get folder() {
        if (!this._file) {
            let dir = this._path;
            if (!dir) {
                try {
                    dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
                } catch (_e) {
                    dir = null;
                }
            }
            if (!dir)
                dir = GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
            this._file = Gio.File.new_for_path(dir);
        }
        return this._file;
    }

    start() {
        if (this._destroyed)
            return;

        const folder = this.folder;
        if (folder.query_exists(null)) {
            try {
                this._monitor = folder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
                this._monitorId = this._monitor.connect('changed', () => this.queueRefresh(180));
            } catch (e) {
                console.error(`${LOG} No se pudo vigilar Descargas:`, e);
                this._monitor = null;
                this._monitorId = 0;
            }
        } else {
            // No todos los perfiles tienen creada la carpeta al arrancar.
            // Abrir Descargas la creará si hace falta; no enumerar una ruta
            // inexistente en cada arranque del shell.
            this.items = [];
            this.count = 0;
            this.emit();
            return;
        }

        this.refresh();
    }

    queueRefresh(delay = 120) {
        if (this._destroyed)
            return;
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._refreshId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, delay, () => {
            this._refreshId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._refreshId, '[tahoe-dock] downloads refresh');
    }

    async refresh() {
        if (this._destroyed)
            return;

        const token = ++this._token;
        if (this._cancellable)
            this._cancellable.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();

        try {
            const entries = await enumerateFiles(
                this.folder, DOWNLOADS_ATTRS, cancellable, MAX_ITEMS);
            if (this._destroyed || token !== this._token)
                return;

            const all = entries.map(infoToItem);
            all.sort((a, b) => b.mtime - a.mtime);

            this.count = all.length;
            this.items = all.slice(0, RECENT_LIMIT);
            this.emit();
        } catch (e) {
            if (!isCancelled(e) && !this._destroyed)
                console.error(`${LOG} No se pudo enumerar Descargas:`, e);
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._token++;

        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        if (this._monitor && this._monitorId) {
            try {
                this._monitor.disconnect(this._monitorId);
            } catch (_e) {
                // ya desconectado
            }
            this._monitorId = 0;
        }
        this._monitor = null;
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._listeners.clear();
    }
}

/* ---------------------------------------------------------------------- */
/* Papelera                                                                */
/* ---------------------------------------------------------------------- */

export class TrashModel extends ChangeEmitter {
    constructor() {
        super();
        this._uri = Gio.File.new_for_uri('trash:///');
        this._localFiles = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'Trash', 'files']));
        this._localInfo = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'Trash', 'info']));
        this._monitors = [];
        this._refreshId = 0;
        this._cancellable = null;
        this._token = 0;
        this._destroyed = false;
        this.count = 0;
        this.items = [];
        this._emptying = false;
    }

    start() {
        if (this._destroyed)
            return;

        this._watch(this._uri);
        this._watch(this._localFiles);
        this._watch(this._localInfo);
        this.refresh();
    }

    _watch(file) {
        try {
            if (!file.query_exists(null))
                return;
            const monitor = file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            const id = monitor.connect('changed', () => this.queueRefresh(180));
            this._monitors.push({monitor, id});
        } catch (e) {
            // trash:/// no siempre admite monitorización; los directorios
            // locales cubren ese caso.
            if (file !== this._localFiles && file !== this._localInfo)
                console.log(`${LOG} Monitor de papelera no disponible: ${e.message}`);
        }
    }

    queueRefresh(delay = 120) {
        if (this._destroyed)
            return;
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._refreshId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, delay, () => {
            this._refreshId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._refreshId, '[tahoe-dock] trash refresh');
    }

    async refresh() {
        if (this._destroyed)
            return;

        const token = ++this._token;
        if (this._cancellable)
            this._cancellable.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();

        try {
            let entries = await enumerateFiles(
                this._uri, TRASH_ATTRS, cancellable, MAX_ITEMS);

            if (entries.length === 0 && this._localFiles.query_exists(null)) {
                const local = await enumerateFiles(
                    this._localFiles, TRASH_ATTRS, cancellable, MAX_ITEMS);
                if (local.length > 0)
                    entries = local;
            }

            if (this._destroyed || token !== this._token)
                return;

            const all = entries.map(infoToItem);
            all.sort((a, b) => b.mtime - a.mtime);
            this.count = all.length;
            this.items = all.slice(0, RECENT_LIMIT);
            this.emit();
        } catch (e) {
            if (!isCancelled(e) && !this._destroyed) {
                console.error(`${LOG} No se pudo enumerar la papelera:`, e);
                this.count = 0;
                this.items = [];
                this.emit();
            }
        }
    }

    async empty() {
        if (this._destroyed || this._emptying)
            return false;

        this._emptying = true;
        const cancellable = new Gio.Cancellable();
        let deleted = 0;
        let localFallback = false;

        try {
            let entries = await enumerateFiles(
                this._uri, 'standard::name,standard::type', cancellable, MAX_ITEMS);

            if (entries.length === 0 && this._localFiles.query_exists(null)) {
                entries = await enumerateFiles(
                    this._localFiles, 'standard::name,standard::type',
                    cancellable, MAX_ITEMS);
                localFallback = true;
            }

            for (const {file} of entries) {
                try {
                    await file.delete_async(GLib.PRIORITY_DEFAULT, cancellable);
                    deleted++;
                    if (localFallback) {
                        // El respaldo local no elimina el .trashinfo solo.
                        const info = this._localInfo.get_child(
                            `${file.get_basename()}.trashinfo`);
                        try {
                            await info.delete_async(GLib.PRIORITY_DEFAULT, cancellable);
                        } catch (_e) {
                            // La entrada de info ya no existía.
                        }
                    }
                } catch (e) {
                    if (!isCancelled(e))
                        console.error(`${LOG} No se pudo borrar ${file.get_uri()}:`, e);
                }
            }
        } catch (e) {
            if (!isCancelled(e))
                console.error(`${LOG} No se pudo vaciar la papelera:`, e);
        } finally {
            this._emptying = false;
        }

        this.queueRefresh(60);
        return deleted;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._token++;

        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        for (const {monitor, id} of this._monitors) {
            try {
                monitor.disconnect(id);
            } catch (_e) {
                // ya desconectado
            }
        }
        this._monitors = [];
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._listeners.clear();
    }
}

/* ---------------------------------------------------------------------- */
/* Volúmenes montados                                                      */
/* ---------------------------------------------------------------------- */

export class MountsModel extends ChangeEmitter {
    constructor() {
        super();
        this._destroyed = false;
        this._signalIds = [];
        this._monitor = Gio.VolumeMonitor.get();

        for (const signal of [
            'mount-added', 'mount-removed', 'mount-changed',
            'volume-added', 'volume-removed', 'volume-changed',
            'drive-connected', 'drive-disconnected', 'drive-changed',
        ]) {
            try {
                this._signalIds.push([
                    this._monitor,
                    this._monitor.connect(signal, () => this.emit()),
                ]);
            } catch (_e) {
                // La señal no existe en esta versión de GIO.
            }
        }
    }

    entries() {
        if (this._destroyed)
            return [];

        const out = [];
        const seen = new Set();

        for (const mount of this._monitor.get_mounts()) {
            let volume = null;
            try {
                volume = mount.get_volume();
            } catch (_e) {
                volume = null;
            }

            let root = null;
            try {
                root = mount.get_root();
            } catch (_e) {
                root = null;
            }

            const uri = root?.get_uri?.() ?? null;
            if (!uri || seen.has(uri))
                continue;

            // El volumen raíz del sistema no aporta nada al Dock.
            if (root?.get_path?.() === '/')
                continue;

            seen.add(uri);
            out.push({
                mount,
                volume,
                uri,
                name: volume?.get_name?.() ?? mount.get_name?.() ??
                    root?.get_basename?.() ?? uri,
                icon: volume?.get_icon?.() ?? mount.get_icon?.() ??
                    themedIcon('drive-harddisk-symbolic'),
                canEject: volume?.can_eject?.() ?? false,
                canUnmount: mount.can_unmount?.() ?? false,
            });
        }

        return out;
    }

    open(entry) {
        if (entry?.uri)
            launchUri(entry.uri);
    }

    async eject(entry) {
        if (!entry)
            return;

        try {
            if (entry.canEject && entry.volume?.can_eject?.()) {
                await entry.volume.eject_with_operation(
                    Gio.MountUnmountFlags.NONE,
                    new Gio.MountOperation(),
                    null);
            } else if (entry.mount?.can_unmount?.()) {
                await entry.mount.unmount_with_operation(
                    Gio.MountUnmountFlags.NONE,
                    new Gio.MountOperation(),
                    null);
            }
        } catch (e) {
            console.error(`${LOG} No se pudo expulsar ${entry.name}:`, e);
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        for (const [monitor, id] of this._signalIds) {
            try {
                monitor.disconnect(id);
            } catch (_e) {
                // ya desconectado
            }
        }
        this._signalIds = [];
        this._listeners.clear();
    }
}

/* ---------------------------------------------------------------------- */
/* Menús                                                                   */
/* ---------------------------------------------------------------------- */

function addDisabledItem(menu, text, styleClass = null) {
    const item = new PopupMenu.PopupMenuItem(text);
    item.setSensitive(false);
    if (styleClass)
        item.add_style_class_name(styleClass);
    menu.addMenuItem(item);
    return item;
}

function addHeader(menu, text) {
    return addDisabledItem(menu, text, 'tahoe-dock-menu-title');
}

export function populateDownloadsMenu(menu, model, {showRecent = true} = {}) {
    menu.removeAll();
    const count = model?.count ?? 0;
    addHeader(menu, count > 0 ? `Descargas (${count})` : 'Descargas');

    if (showRecent) {
        if (!model?.items?.length) {
            addDisabledItem(menu, 'No hay descargas recientes');
        } else {
            for (const entry of model.items) {
                const item = new PopupMenu.PopupImageMenuItem(entry.name, entry.icon);
                item.connect('activate', () => launchUri(entry.file.get_uri()));
                menu.addMenuItem(item);
            }
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    const folder = model?.folder?.get_uri?.() ?? null;
    if (folder) {
        menu.addAction('Abrir Descargas', () => launchUri(folder), 'folder-symbolic');
        menu.addAction('Mostrar en Archivos', () => launchUri(folder), 'system-file-manager-symbolic');
    }
}

export function populateTrashMenu(menu, model, {onConfirm = null, onDialog = null} = {}) {
    menu.removeAll();
    const count = model?.count ?? 0;
    addHeader(menu, count > 0 ? `Papelera (${count})` : 'Papelera');

    menu.addAction('Abrir Papelera', () => launchUri('trash:///'), 'user-trash-symbolic');
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const empty = menu.addAction('Vaciar papelera…', () => {
        const dialog = confirmEmptyTrash(onConfirm);
        onDialog?.(dialog);
    }, 'edit-delete-symbolic');
    empty.setSensitive(!model?._emptying);
}
export function populateVolumeMenu(menu, entry, {onEject} = {}) {
    menu.removeAll();
    addHeader(menu, entry?.name ?? 'Volumen');
    menu.addAction('Abrir', () => launchUri(entry.uri), 'folder-symbolic');

    if (entry.canEject || entry.canUnmount) {
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(entry.canEject ? 'Expulsar' : 'Desmontar',
            () => onEject?.(entry), 'media-eject-symbolic');
    }
}

/**
 * Pregunta antes de vaciar. Devuelve el ModalDialog para que el Dock pueda
 * cerrarlo si se destruye mientras está abierto. onConfirm sólo se invoca si
 * el usuario pulsa el botón destructivo; cerrar/cancelar nunca borra nada.
 */
export function confirmEmptyTrash(onConfirm, onClosed = null) {
    const dialog = new ModalDialog.ModalDialog({
        styleClass: 'tahoe-dock-dialog',
        destroyOnClose: true,
    });

    const content = new St.BoxLayout({
        style_class: 'tahoe-dock-dialog-content',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
    });

    content.add_child(new St.Label({
        style_class: 'tahoe-dock-dialog-title',
        text: '¿Vaciar la papelera?',
    }));
    const text = new St.Label({
        style_class: 'tahoe-dock-dialog-text',
        text: 'Los elementos de la papelera se eliminarán de forma permanente. Esta acción no se puede deshacer.',
    });
    text.clutter_text.line_wrap = true;
    content.add_child(text);

    dialog.contentLayout.add_child(content);
    dialog.setButtons([
        {
            label: 'Cancelar',
            key: Clutter.KEY_Escape,
            action: () => dialog.close(),
        },
        {
            label: 'Vaciar papelera',
            default: true,
            action: () => {
                dialog.close();
                onConfirm?.();
            },
        },
    ]);

    dialog.connect('closed', () => onClosed?.());
    dialog.open();
    return dialog;
}
