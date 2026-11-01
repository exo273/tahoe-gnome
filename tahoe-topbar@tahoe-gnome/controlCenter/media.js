// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Soporte MPRIS para la tarjeta "Reproduciendo" del Centro de control.
// Se mantienen proxies propios (en lugar de reutilizar MprisSource, cuyo
// ciclo de vida es global al shell) para poder limpiarlos en destroy().

'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

const LOG_PREFIX = '[tahoe-topbar/cc]';
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

const MprisPlayerIface = loadInterfaceXML('org.mpris.MediaPlayer2.Player');
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

Gio._promisify(Gio.DBusConnection.prototype, 'call');

function metadataValue(metadata, key) {
    if (!metadata)
        return null;

    const value = metadata[key];
    if (value instanceof GLib.Variant)
        return value.deepUnpack();
    return value ?? null;
}

export const MediaController = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class MediaController extends GObject.Object {
    _init() {
        super._init();

        this._players = new Map();
        this._current = null;
        this._destroyed = false;
        this._nameOwnerId = 0;

        try {
            this._nameOwnerId = Gio.DBus.session.signal_subscribe(
                'org.freedesktop.DBus',
                'org.freedesktop.DBus',
                'NameOwnerChanged',
                '/org/freedesktop/DBus',
                null,
                Gio.DBusSignalFlags.NONE,
                this._onNameOwnerChanged.bind(this));
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo escuchar MPRIS:`, e);
        }

        this._listPlayers();
    }

    get hasPlayer() {
        return this._current != null;
    }

    get player() {
        return this._current;
    }

    get title() {
        return this._current?.title ?? '';
    }

    get artist() {
        return this._current?.artist ?? '';
    }

    get artUrl() {
        return this._current?.artUrl ?? '';
    }

    get playing() {
        return this._current?.status === 'Playing';
    }

    get canGoNext() {
        return Boolean(this._current?.canGoNext);
    }

    get canGoPrevious() {
        return Boolean(this._current?.canGoPrevious);
    }

    playPause() {
        const player = this._current;
        if (!player)
            return;

        player.proxy.PlayPauseAsync()
            .catch(e => console.error(`${LOG_PREFIX} MPRIS PlayPause:`, e));
    }

    next() {
        const player = this._current;
        if (!player)
            return;

        player.proxy.NextAsync()
            .catch(e => console.error(`${LOG_PREFIX} MPRIS Next:`, e));
    }

    previous() {
        const player = this._current;
        if (!player)
            return;

        player.proxy.PreviousAsync()
            .catch(e => console.error(`${LOG_PREFIX} MPRIS Previous:`, e));
    }

    async _listPlayers() {
        try {
            const result = await Gio.DBus.session.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null);

            if (this._destroyed)
                return;

            const names = result.deepUnpack();
            for (const name of names) {
                if (typeof name === 'string' && name.startsWith(MPRIS_PREFIX))
                    this._addPlayer(name);
            }
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo listar reproductores MPRIS:`, e);
        }
    }

    _onNameOwnerChanged(connection, sender, path, iface, signal, params) {
        const [name, oldOwner, newOwner] = params.deepUnpack();
        if (!name?.startsWith(MPRIS_PREFIX))
            return;

        if (oldOwner && !newOwner)
            this._removePlayer(name);
        else if (newOwner && !oldOwner)
            this._addPlayer(name);
    }

    _addPlayer(busName) {
        if (this._destroyed || this._players.has(busName))
            return;

        const player = {
            busName,
            proxy: null,
            title: '',
            artist: '',
            album: '',
            artUrl: '',
            status: 'Stopped',
            canGoNext: false,
            canGoPrevious: false,
        };

        this._players.set(busName, player);

        try {
            player.proxy = new MprisPlayerProxy(
                Gio.DBus.session,
                busName,
                MPRIS_PATH,
                (proxy, error) => {
                    if (this._destroyed || !this._players.has(busName))
                        return;

                    if (error) {
                        console.debug(`${LOG_PREFIX} Reproductor MPRIS no disponible (${busName}): ${error.message}`);
                        this._removePlayer(busName);
                        return;
                    }

                    try {
                        if (!proxy.g_name_owner) {
                            this._removePlayer(busName);
                            return;
                        }

                        proxy.connectObject(
                            'g-properties-changed', () => this._updatePlayer(player),
                            this);
                    } catch (e) {
                        console.error(`${LOG_PREFIX} No se pudo seguir el reproductor ${busName}:`, e);
                    }

                    this._updatePlayer(player);
                });
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo crear el proxy MPRIS ${busName}:`, e);
            this._players.delete(busName);
        }
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;

        this._players.delete(busName);

        try {
            player.proxy?.disconnectObject(this);
        } catch (_e) {
            // Ignorar.
        }

        this._selectCurrent();
        this.emit('changed');
    }

    _updatePlayer(player) {
        if (this._destroyed || !player.proxy)
            return;

        const proxy = player.proxy;
        let metadata = null;

        try {
            metadata = proxy.Metadata;
        } catch (_e) {
            metadata = null;
        }

        const title = metadataValue(metadata, 'xesam:title');
        const artists = metadataValue(metadata, 'xesam:artist');
        const album = metadataValue(metadata, 'xesam:album');
        const artUrl = metadataValue(metadata, 'mpris:artUrl');

        player.title = typeof title === 'string' ? title : '';
        player.artist = Array.isArray(artists)
            ? artists.filter(a => typeof a === 'string').join(', ')
            : typeof artists === 'string' ? artists : '';
        player.album = typeof album === 'string' ? album : '';
        player.artUrl = typeof artUrl === 'string' ? artUrl : '';

        try {
            player.status = proxy.PlaybackStatus ?? 'Stopped';
            player.canGoNext = Boolean(proxy.CanGoNext);
            player.canGoPrevious = Boolean(proxy.CanGoPrevious);
        } catch (_e) {
            player.status = 'Stopped';
        }

        this._selectCurrent();
        this.emit('changed');
    }

    _selectCurrent() {
        const players = [...this._players.values()]
            .filter(player => player.title);

        if (players.length === 0) {
            this._current = null;
            return;
        }

        const playing = players.find(player => player.status === 'Playing');
        if (playing) {
            this._current = playing;
            return;
        }

        if (this._current && players.includes(this._current))
            return;

        this._current = players.find(player => player.status === 'Paused') ??
            players[0];
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        if (this._nameOwnerId) {
            try {
                Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
            } catch (_e) {
                // Ignorar.
            }
            this._nameOwnerId = 0;
        }

        for (const player of this._players.values()) {
            try {
                player.proxy?.disconnectObject(this);
            } catch (_e) {
                // Ignorar.
            }
        }

        this._players.clear();
        this._current = null;
    }
});
