// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Pequeño controlador de NetworkManager para el Centro de control.
// Mantiene un único NM.Client y expone el estado que necesita la interfaz:
// adaptadores Wi-Fi/Ethernet, redes visibles, conexión activa y operaciones
// para activar conexiones guardadas.

'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import NM from 'gi://NM';
import Shell from 'gi://Shell';

const LOG_PREFIX = '[tahoe-topbar/cc]';

Gio._promisify(NM.Client, 'new_async');
Gio._promisify(NM.DeviceWifi.prototype, 'request_scan_async');

const NM80211ApFlags = NM['80211ApFlags'];

function ssidToString(ssid) {
    if (!ssid)
        return '';

    try {
        return NM.utils_ssid_to_utf8(ssid.get_data()) ?? '';
    } catch (e) {
        console.error(`${LOG_PREFIX} No se pudo leer un SSID:`, e);
        return '';
    }
}

function signalLevel(strength) {
    if (strength < 20)
        return 'none';
    if (strength < 40)
        return 'weak';
    if (strength < 50)
        return 'ok';
    if (strength < 80)
        return 'good';
    return 'excellent';
}

function isSecureAccessPoint(ap) {
    try {
        return (ap.flags & NM80211ApFlags.PRIVACY) !== 0;
    } catch (_e) {
        return false;
    }
}

export const NetworkController = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class NetworkController extends GObject.Object {
    _init() {
        super._init();

        this._client = null;
        this._failed = false;
        this._ready = false;
        this._destroyed = false;
        this._wifiDevices = [];
        this._wiredDevices = [];
        this._idleId = 0;

        this._initClient().catch(e => {
            console.error(`${LOG_PREFIX} NetworkManager no disponible:`, e);
            this._failed = true;
            this._ready = true;
            this._emitChanged();
        });
    }

    get ready() {
        return this._ready;
    }

    get failed() {
        return this._failed;
    }

    get hasWifi() {
        return this._wifiDevices.length > 0;
    }

    get hasEthernet() {
        return this._wiredDevices.length > 0;
    }

    get wifiEnabled() {
        try {
            return Boolean(this._client?.wireless_enabled);
        } catch (_e) {
            return false;
        }
    }

    get wifiHardwareEnabled() {
        try {
            return this._client?.wireless_hardware_enabled !== false;
        } catch (_e) {
            return true;
        }
    }

    get ethernetConnected() {
        return this._wiredDevices.some(device => {
            try {
                return device.state === NM.DeviceState.ACTIVATED;
            } catch (_e) {
                return false;
            }
        });
    }

    get activeAccessPoint() {
        for (const device of this._wifiDevices) {
            try {
                if (device.active_access_point)
                    return device.active_access_point;
            } catch (_e) {
                // Ignorar dispositivos que desaparecen.
            }
        }
        return null;
    }

    get wifiSsid() {
        const ap = this.activeAccessPoint;
        if (ap) {
            const ssid = ssidToString(ap.get_ssid());
            if (ssid)
                return ssid;
        }

        try {
            const active = this._client?.primary_connection ??
                this._client?.activating_connection;
            if (active)
                return active.get_id() ?? '';
        } catch (_e) {
            // Ignorar.
        }

        return '';
    }

    get wifiIconName() {
        if (!this.hasWifi) {
            return this.ethernetConnected
                ? 'network-wired-symbolic'
                : 'network-wireless-signal-none-symbolic';
        }

        if (!this.wifiEnabled)
            return 'network-wireless-disabled-symbolic';

        const ap = this.activeAccessPoint;
        if (ap) {
            let strength = 0;
            try {
                strength = ap.strength;
            } catch (_e) {
                strength = 0;
            }
            return `network-wireless-signal-${signalLevel(strength)}-symbolic`;
        }

        try {
            const primary = this._client?.primary_connection;
            const [device] = primary?.get_devices() ?? [];
            if (device?.device_type === NM.DeviceType.WIFI)
                return 'network-wireless-acquiring-symbolic';
        } catch (_e) {
            // Ignorar.
        }

        return 'network-wireless-signal-none-symbolic';
    }

    get primaryIsWifi() {
        try {
            const primary = this._client?.primary_connection;
            const [device] = primary?.get_devices() ?? [];
            return device?.device_type === NM.DeviceType.WIFI;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Redes Wi-Fi visibles, ya deduplicadas por SSID.
     */
    get accessPoints() {
        const bySsid = new Map();

        for (const device of this._wifiDevices) {
            let aps = [];
            try {
                aps = device.get_access_points();
            } catch (_e) {
                continue;
            }

            for (const ap of aps) {
                const ssid = ssidToString(ap.get_ssid());
                if (!ssid)
                    continue;

                let strength = 0;
                let active = false;
                try {
                    strength = ap.strength;
                    active = ap === device.active_access_point;
                } catch (_e) {
                    // Ignorar AP destruido.
                }

                const previous = bySsid.get(ssid);
                if (previous && !active && previous.strength >= strength)
                    continue;

                bySsid.set(ssid, {
                    ssid,
                    strength: active ? Math.max(strength, previous?.strength ?? 0) : strength,
                    secure: isSecureAccessPoint(ap),
                    active: active || Boolean(previous?.active),
                    saved: this._isSavedSsid(ssid),
                });
            }
        }

        return [...bySsid.values()].sort((a, b) => {
            if (a.active !== b.active)
                return a.active ? -1 : 1;
            if (a.saved !== b.saved)
                return a.saved ? -1 : 1;
            return b.strength - a.strength;
        });
    }

    get savedConnections() {
        const result = [];
        try {
            for (const connection of this._client?.get_connections() ?? []) {
                const wireless = connection.get_setting_wireless();
                if (!wireless)
                    continue;
                result.push({
                    connection,
                    id: connection.get_id() ?? '',
                    ssid: ssidToString(wireless.get_ssid()),
                });
            }
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudieron leer las conexiones guardadas:`, e);
        }
        return result;
    }

    get volumeLabel() {
        return this.wifiSsid || (this.wifiEnabled ? 'No conectado' : 'Desactivado');
    }

    async _initClient() {
        const client = await NM.Client.new_async(null);
        if (this._destroyed) {
            client.run_dispose();
            return;
        }

        this._client = client;
        this._connectClient();
        this._syncDevices();
        this._ready = true;
        this._emitChanged();
    }

    _connectClient() {
        if (!this._client)
            return;

        this._client.connectObject(
            'notify::wireless-enabled', () => this._emitChanged(),
            'notify::wireless-hardware-enabled', () => this._emitChanged(),
            'notify::primary-connection', () => this._emitChanged(),
            'notify::activating-connection', () => this._emitChanged(),
            'notify::connectivity', () => this._emitChanged(),
            'notify::nm-running', () => this._emitChanged(),
            'device-added', () => this._syncDevices(),
            'device-removed', () => this._syncDevices(),
            this);
    }

    _syncDevices() {
        if (!this._client)
            return;

        for (const device of [...this._wifiDevices, ...this._wiredDevices]) {
            try {
                device.disconnectObject(this);
            } catch (_e) {
                // Ya estaba desconectado.
            }
        }

        this._wifiDevices = [];
        this._wiredDevices = [];

        try {
            for (const device of this._client.get_devices()) {
                switch (device.device_type) {
                case NM.DeviceType.WIFI:
                    this._wifiDevices.push(device);
                    break;
                case NM.DeviceType.ETHERNET:
                    this._wiredDevices.push(device);
                    break;
                default:
                    break;
                }
            }
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudieron enumerar los dispositivos de red:`, e);
        }

        for (const device of this._wifiDevices) {
            device.connectObject(
                'notify::active-access-point', () => this._emitChanged(),
                'notify::active-connection', () => this._emitChanged(),
                'notify::state', () => this._emitChanged(),
                'access-point-added', () => this._emitChanged(),
                'access-point-removed', () => this._emitChanged(),
                this);
        }

        for (const device of this._wiredDevices) {
            device.connectObject(
                'notify::active-connection', () => this._emitChanged(),
                'notify::state', () => this._emitChanged(),
                this);
        }

        this._emitChanged();
    }

    _isSavedSsid(ssid) {
        return this.savedConnections.some(item =>
            item.ssid === ssid || item.id === ssid);
    }

    findSavedConnection(ssid) {
        return this.savedConnections.find(item =>
            item.ssid === ssid || item.id === ssid)?.connection ?? null;
    }

    async requestScan() {
        if (!this._client || !this._client.wireless_enabled)
            return;

        for (const device of this._wifiDevices) {
            try {
                await device.request_scan_async(null);
            } catch (e) {
                // Un escaneo puede fallar si otro se está ejecutando; no es grave.
                console.debug(`${LOG_PREFIX} Escaneo Wi-Fi no completado: ${e.message}`);
            }
        }

        this._emitChanged();
    }

    connectSaved(ssid) {
        const connection = this.findSavedConnection(ssid);
        if (!connection) {
            this.openWifiSettings();
            return false;
        }

        const device = this._wifiDevices[0] ?? null;

        try {
            this._client.activate_connection_async(
                connection,
                device,
                null,
                null,
                (client, result) => {
                    try {
                        client.activate_connection_finish(result);
                    } catch (e) {
                        console.error(`${LOG_PREFIX} No se pudo conectar a «${ssid}»:`, e);
                        this.openWifiSettings();
                    }
                    this._emitChanged();
                });
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo activar la conexión «${ssid}»:`, e);
            return false;
        }

        return true;
    }

    disconnectCurrent() {
        try {
            const active = this._client?.primary_connection;
            if (active)
                this._client.deactivate_connection_async(active, null, null);
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo desconectar la red actual:`, e);
        }
    }

    setWifiEnabled(enabled) {
        if (!this._client)
            return;

        try {
            this._client.dbus_set_property(
                NM.DBUS_PATH,
                NM.DBUS_INTERFACE,
                'WirelessEnabled',
                new GLib.Variant('b', Boolean(enabled)),
                2000,
                null,
                (client, result) => {
                    try {
                        client.dbus_set_property_finish(result);
                    } catch (e) {
                        console.error(`${LOG_PREFIX} No se pudo cambiar el estado de Wi-Fi:`, e);
                    }
                    this._emitChanged();
                });
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo cambiar el estado de Wi-Fi:`, e);
        }
    }

    toggleWifi() {
        this.setWifiEnabled(!this.wifiEnabled);
    }

    openWifiSettings() {
        try {
            const app = Shell.AppSystem.get_default()
                .lookup_app('org.gnome.Settings.desktop');

            if (app) {
                const param = new GLib.Variant('av', [
                    new GLib.Variant('(sav)', ['wifi', []]),
                ]);
                app.activate_action('launch-panel', param, 0, -1, null)
                    .catch(e => console.error(`${LOG_PREFIX} No se pudo abrir Ajustes:`, e));
                return;
            }
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo abrir el panel de Wi-Fi:`, e);
        }

        try {
            Gio.Subprocess.new(
                ['gnome-control-center', 'wifi'],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo lanzar gnome-control-center:`, e);
        }
    }

    _emitChanged() {
        if (this._destroyed || this._idleId)
            return;

        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            if (!this._destroyed)
                this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }

        for (const device of [...this._wifiDevices, ...this._wiredDevices]) {
            try {
                device.disconnectObject(this);
            } catch (_e) {
                // Ignorar.
            }
        }

        try {
            this._client?.disconnectObject(this);
        } catch (_e) {
            // Ignorar.
        }

        this._wifiDevices = [];
        this._wiredDevices = [];
        this._client = null;
    }
});
