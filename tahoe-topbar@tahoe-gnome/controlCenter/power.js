// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Estado de batería (UPower) y perfiles de energía
// (net.hadess.PowerProfiles / org.freedesktop.UPower.PowerProfiles).

'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

const LOG_PREFIX = '[tahoe-topbar/cc]';

const UPowerDeviceIface = loadInterfaceXML('org.freedesktop.UPower.Device');
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPowerDeviceIface);

const PowerProfilesIface = loadInterfaceXML('org.freedesktop.UPower.PowerProfiles');
const PowerProfilesProxy = Gio.DBusProxy.makeProxyWrapper(PowerProfilesIface);

const UPowerState = {
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
};

export const PROFILE_INFO = {
    'power-saver': {
        name: 'Ahorro de energía',
        shortName: 'Ahorro',
        iconName: 'power-profile-power-saver-symbolic',
    },
    'balanced': {
        name: 'Equilibrado',
        shortName: 'Equilibrado',
        iconName: 'power-profile-balanced-symbolic',
    },
    'performance': {
        name: 'Rendimiento',
        shortName: 'Rendimiento',
        iconName: 'power-profile-performance-symbolic',
    },
};

export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0)
        return '';

    const totalMinutes = Math.round(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours <= 0)
        return `${minutes} min`;
    if (minutes === 0)
        return `${hours} h`;
    return `${hours} h ${String(minutes).padStart(2, '0')} min`;
}

export const BatteryController = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class BatteryController extends GObject.Object {
    _init() {
        super._init();

        this._proxy = null;
        this._ready = false;
        this._failed = false;
        this._destroyed = false;

        try {
            this._proxy = new UPowerDeviceProxy(
                Gio.DBus.system,
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower/devices/DisplayDevice',
                (proxy, error) => {
                    if (this._destroyed)
                        return;

                    if (error) {
                        console.error(`${LOG_PREFIX} UPower no disponible:`, error.message);
                        this._failed = true;
                        this._ready = true;
                        this.emit('changed');
                        return;
                    }

                    try {
                        this._proxy.connectObject(
                            'g-properties-changed', () => this.emit('changed'),
                            'notify::g-name-owner', () => this.emit('changed'),
                            this);
                    } catch (e) {
                        console.error(`${LOG_PREFIX} No se pudo seguir la batería:`, e);
                    }

                    this._ready = true;
                    this.emit('changed');
                });
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo crear el proxy de UPower:`, e);
            this._failed = true;
            this._ready = true;
        }
    }

    get ready() {
        return this._ready;
    }

    get present() {
        try {
            return Boolean(this._proxy?.IsPresent);
        } catch (_e) {
            return false;
        }
    }

    get percentage() {
        try {
            const value = Number(this._proxy?.Percentage);
            return Number.isFinite(value) ? Math.round(value) : 0;
        } catch (_e) {
            return 0;
        }
    }

    get state() {
        try {
            return Number(this._proxy?.State);
        } catch (_e) {
            return UPowerState.UNKNOWN;
        }
    }

    get charging() {
        return this.state === UPowerState.CHARGING ||
            this.state === UPowerState.PENDING_CHARGE ||
            this.state === UPowerState.FULLY_CHARGED;
    }

    get fullyCharged() {
        return this.state === UPowerState.FULLY_CHARGED;
    }

    get discharging() {
        return this.state === UPowerState.DISCHARGING ||
            this.state === UPowerState.PENDING_DISCHARGE;
    }

    get powerSource() {
        if (!this.present)
            return '';
        return this.charging ? 'Adaptador de corriente' : 'Batería';
    }

    get timeRemaining() {
        try {
            if (this.charging) {
                const value = Number(this._proxy?.TimeToFull);
                return Number.isFinite(value) && value > 0 ? value : 0;
            }
            const value = Number(this._proxy?.TimeToEmpty);
            return Number.isFinite(value) && value > 0 ? value : 0;
        } catch (_e) {
            return 0;
        }
    }

    get iconName() {
        if (!this.present)
            return 'battery-missing-symbolic';

        const percentage = this.percentage;
        const fillLevel = 10 * Math.floor(percentage / 10);
        const charged = this.state === UPowerState.FULLY_CHARGED ||
            (this.state === UPowerState.CHARGING && fillLevel === 100);

        if (charged)
            return 'battery-level-100-charged-symbolic';

        let suffix = '';
        if (this.state === UPowerState.CHARGING)
            suffix = '-charging';
        else if (this.state === UPowerState.PENDING_CHARGE)
            suffix = '-plugged-in';

        return `battery-level-${fillLevel}${suffix}-symbolic`;
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        try {
            this._proxy?.disconnectObject(this);
        } catch (_e) {
            // Ignorar.
        }

        this._proxy = null;
    }
});

function unpackProfile(entry) {
    if (!entry)
        return null;

    let value;

    if (entry instanceof GLib.Variant) {
        value = entry.deepUnpack();
    } else if (typeof entry === 'object') {
        value = entry.Profile ?? entry['Profile'] ?? null;
        if (value instanceof GLib.Variant)
            value = value.deepUnpack();
    } else {
        value = entry;
    }

    return typeof value === 'string' ? value : null;
}

export const PowerProfilesController = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class PowerProfilesController extends GObject.Object {
    _init() {
        super._init();

        this._proxy = null;
        this._profiles = [];
        this._activeProfile = '';
        this._ready = false;
        this._destroyed = false;

        try {
            this._proxy = new PowerProfilesProxy(
                Gio.DBus.system,
                'org.freedesktop.UPower.PowerProfiles',
                '/org/freedesktop/UPower/PowerProfiles',
                (proxy, error) => {
                    if (this._destroyed)
                        return;

                    if (error) {
                        // El servicio es opcional; no lo tratamos como error grave.
                        this._ready = true;
                        this._sync();
                        return;
                    }

                    try {
                        proxy.connectObject(
                            'g-properties-changed', () => this._sync(),
                            'notify::g-name-owner', () => this._sync(),
                            this);
                    } catch (e) {
                        console.error(`${LOG_PREFIX} No se pudo seguir PowerProfiles:`, e);
                    }

                    this._ready = true;
                    this._sync();
                });
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo crear el proxy de perfiles de energía:`, e);
            this._ready = true;
        }
    }

    get available() {
        try {
            return this._proxy != null && this._proxy.g_name_owner != null;
        } catch (_e) {
            return false;
        }
    }

    get profiles() {
        return this._profiles;
    }

    get activeProfile() {
        return this._activeProfile;
    }

    get activeInfo() {
        return PROFILE_INFO[this._activeProfile] ?? {
            name: 'Personalizado',
            shortName: 'Personalizado',
            iconName: 'power-profile-balanced-symbolic',
        };
    }

    setProfile(profile) {
        if (!this.available || !profile)
            return;

        try {
            this._proxy.ActiveProfile = profile;
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudo cambiar el perfil de energía:`, e);
        }
    }

    cycleProfile() {
        const profiles = this._profiles;
        if (profiles.length === 0)
            return;

        const index = profiles.indexOf(this._activeProfile);
        const next = profiles[(index + 1) % profiles.length];
        this.setProfile(next);
    }

    _sync() {
        if (this._destroyed)
            return;

        let profiles = [];
        let active = '';

        try {
            const rawProfiles = this._proxy?.Profiles ?? [];
            profiles = [...new Set(rawProfiles
                .map(entry => unpackProfile(entry))
                .filter(profile => profile && PROFILE_INFO[profile]))];
            active = this._proxy?.ActiveProfile ?? '';
        } catch (e) {
            console.error(`${LOG_PREFIX} No se pudieron leer los perfiles de energía:`, e);
        }

        this._profiles = profiles;
        this._activeProfile = active;
        this.emit('changed');
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        try {
            this._proxy?.disconnectObject(this);
        } catch (_e) {
            // Ignorar.
        }

        this._proxy = null;
        this._profiles = [];
    }
});
