// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Controlador de Bluetooth basado en GnomeBluetooth 3.0, la misma
// biblioteca que usa GNOME Shell para su indicador de estado.

'use strict';

import GnomeBluetooth from 'gi://GnomeBluetooth';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const LOG_PREFIX = '[tahoe-topbar/cc]';

Gio._promisify(GnomeBluetooth.Client.prototype, 'connect_service');

export const BluetoothController = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class BluetoothController extends GObject.Object {
    _init() {
        super._init();

        this._destroyed = false;
        this._devices = new Map();

        try {
            this._client = new GnomeBluetooth.Client();
        } catch (e) {
            console.error(`${LOG_PREFIX} Bluetooth no disponible:`, e);
            this._client = null;
            return;
        }

        this._client.connectObject(
            'notify::default-adapter', () => {
                this._resetDevices();
                this.emit('changed');
            },
            'notify::default-adapter-powered', () => this.emit('changed'),
            'notify::default-adapter-state', () => this.emit('changed'),
            'device-added', (client, device) => {
                this._watchDevice(device);
                this.emit('changed');
            },
            'device-removed', (client, path) => {
                const device = this._devices.get(path);
                if (device) {
                    try {
                        device.disconnectObject(this);
                    } catch (_e) {
                        // Ignorar.
                    }
                }
                this._devices.delete(path);
                this.emit('changed');
            },
            this);

        this._resetDevices();
    }

    get available() {
        try {
            return this._client?.default_adapter != null;
        } catch (_e) {
            return false;
        }
    }

    get enabled() {
        try {
            return Boolean(this._client?.default_adapter_powered);
        } catch (_e) {
            return false;
        }
    }

    get adapterName() {
        try {
            return this._client?.default_adapter?.name ?? '';
        } catch (_e) {
            return '';
        }
    }

    get devices() {
        const list = [];
        for (const device of this._devices.values()) {
            try {
                if (!device.paired && !device.trusted)
                    continue;
                list.push({
                    device,
                    path: device.get_object_path(),
                    name: device.alias || device.name || '',
                    connected: Boolean(device.connected),
                    icon: device.icon || 'bluetooth-active-symbolic',
                });
            } catch (_e) {
                // El dispositivo desapareció.
            }
        }

        return list.sort((a, b) => {
            if (a.connected !== b.connected)
                return a.connected ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    }

    get connectedDevices() {
        return this.devices.filter(item => item.connected);
    }

    get subtitle() {
        if (!this.available)
            return 'No disponible';
        if (!this.enabled)
            return 'Desactivado';

        const connected = this.connectedDevices;
        if (connected.length === 0)
            return 'Activado';
        return connected[0].name;
    }

    get iconName() {
        if (!this.enabled)
            return 'bluetooth-disabled-symbolic';
        return 'bluetooth-active-symbolic';
    }

    setEnabled(enabled) {
        if (!this._client || !this.available)
            return;

        try {
            this._client.default_adapter_powered = Boolean(enabled);
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo cambiar el estado de Bluetooth:`, e);
        }
    }

    toggle() {
        this.setEnabled(!this.enabled);
    }

    async toggleDevice(item) {
        if (!this._client || !item?.path)
            return;

        try {
            await this._client.connect_service(
                item.path,
                !item.connected,
                null);
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo conectar/desconectar «${item.name}»:`, e);
        } finally {
            this.emit('changed');
        }
    }

    _resetDevices() {
        for (const device of this._devices.values()) {
            try {
                device.disconnectObject(this);
            } catch (_e) {
                // Ignorar.
            }
        }
        this._devices.clear();

        if (!this._client)
            return;

        try {
            const store = this._client.get_devices();
            for (let i = 0; i < store.get_n_items(); i++)
                this._watchDevice(store.get_item(i));
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudieron enumerar los dispositivos Bluetooth:`, e);
        }
    }

    _watchDevice(device) {
        if (!device)
            return;

        let path;
        try {
            path = device.get_object_path();
        } catch (_e) {
            return;
        }

        if (!path || this._devices.has(path))
            return;

        this._devices.set(path, device);

        device.connectObject(
            'notify::alias', () => this.emit('changed'),
            'notify::name', () => this.emit('changed'),
            'notify::connected', () => this.emit('changed'),
            'notify::paired', () => this.emit('changed'),
            'notify::trusted', () => this.emit('changed'),
            this);
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        for (const device of this._devices.values()) {
            try {
                device.disconnectObject(this);
            } catch (_e) {
                // Ignorar.
            }
        }
        this._devices.clear();

        try {
            this._client?.disconnectObject(this);
        } catch (_e) {
            // Ignorar.
        }

        this._client = null;
    }
});
