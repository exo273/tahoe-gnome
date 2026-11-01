// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Registro de controles del Centro de control.
//
// Cada entrada describe un control de forma declarativa para que la rejilla
// pueda construirse desde `control-center-layout` (y, en el futuro, desde el
// editor visual):
//
//   id          identificador estable (los externos empiezan por "ext:")
//   name        nombre en español
//   category    Conectividad, Pantalla, Sonido, Concentración, Accesibilidad,
//               Utilidades, Batería o Extensiones
//   icon        icono orientativo para el editor
//   sizes       tamaños admitidos: small, medium, large, wide
//   defaultSize tamaño preferido si el layout no especifica uno válido
//   available() si el control tiene sentido en este sistema
//   create(size) crea {actor, radius, sync(), repaint()?}
//
// Los controles externos (QuickToggle/QuickMenuToggle/QuickSlider de otras
// extensiones) se registran en caliente con `updateExternals()` y se
// reconstruyen en cada sesión con el mismo id a partir del tipo GObject y el
// título del original.

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    CircleButton,
    createMediaCard,
    createPill,
    createWideCard,
    attachSecondaryClick,
} from './widgets.js';
import {sizeSpan} from './layout.js';

const LOG = '[tahoe-topbar/cc]';

const CATEGORY = {
    connectivity: 'Conectividad',
    display: 'Pantalla',
    sound: 'Sonido',
    focus: 'Concentración',
    accessibility: 'Accesibilidad',
    utilities: 'Utilidades',
    battery: 'Batería',
    extensions: 'Extensiones',
};

const WIFI_OFF = 'network-wireless-signal-none-symbolic';

function safe(fn, fallback = false) {
    try {
        return fn();
    } catch (_e) {
        return fallback;
    }
}

function signalName(strength) {
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

function setCircleIcon(circle, iconName, gicon = null) {
    if (!circle)
        return;
    if (gicon)
        circle.setGicon(gicon, null);
    else
        circle.setIcon(iconName);
}

function setPillIcon(pill, iconName, gicon = null) {
    if (!pill)
        return;
    if (gicon)
        pill.circle.setGicon(gicon, null);
    else
        pill.setIcon(iconName);
}

function dndEnabled(cc) {
    return !cc._getShowBanners();
}

function mediaAvailable(cc) {
    return cc._getBoolean('control-center-show-now-playing', true);
}

function batterySubtitle(battery) {
    if (!battery?.present)
        return '';
    if (battery.charging)
        return `${battery.percentage}% · Cargando`;
    if (battery.fullyCharged)
        return `${battery.percentage}% · Cargada`;
    return `${battery.percentage}% · Batería`;
}

function slug(value) {
    const text = String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return text || 'item';
}

/* --------------------------------------------------------------------------
   Brillo del teclado (org.gnome.SettingsDaemon.Power.Keyboard)
   -------------------------------------------------------------------------- */

const KEYBOARD_BRIGHTNESS_XML = `<node>
  <interface name="org.gnome.SettingsDaemon.Power.Keyboard">
    <property name="Brightness" type="i" access="readwrite"/>
  </interface>
</node>`;

const KeyboardBrightnessProxy = Gio.DBusProxy.makeProxyWrapper(
    KEYBOARD_BRIGHTNESS_XML);

class KeyboardBacklightController {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._proxy = null;
        this._brightness = -1;
        this._destroyed = false;
        this._changedId = 0;

        try {
            this._proxy = new KeyboardBrightnessProxy(
                Gio.DBus.session,
                'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power',
                (proxy, error) => {
                    if (this._destroyed)
                        return;

                    if (error) {
                        console.debug(`${LOG} Sin brillo de teclado: ${error.message}`);
                        this._proxy = null;
                        this._brightness = -1;
                        this._notify();
                        return;
                    }

                    this._proxy = proxy;
                    this._changedId = proxy.connect('g-properties-changed',
                        () => this._sync());
                    this._sync();
                });
        } catch (e) {
            console.debug(`${LOG} Sin brillo de teclado: ${e.message}`);
            this._proxy = null;
        }
    }

    _sync() {
        if (this._destroyed || !this._proxy)
            return;

        let value = -1;
        try {
            value = this._proxy.Brightness;
        } catch (_e) {
            value = -1;
        }

        this._brightness = Number.isInteger(value) ? value : -1;
        this._notify();
    }

    _notify() {
        try {
            this._onChanged?.();
        } catch (_e) {
            // El Centro de control ya no existe.
        }
    }

    get available() {
        return this._brightness >= 0;
    }

    get value() {
        return this.available ? Math.clamp(this._brightness / 100, 0, 1) : 0;
    }

    set value(value) {
        if (!this._proxy || !this.available)
            return;
        try {
            this._proxy.Brightness = Math.round(Math.clamp(value, 0, 1) * 100);
        } catch (e) {
            console.debug(`${LOG} No se pudo cambiar el brillo del teclado: ${e.message}`);
        }
    }

    destroy() {
        this._destroyed = true;
        try {
            if (this._proxy && this._changedId)
                this._proxy.disconnect(this._changedId);
        } catch (_e) {
            // Ya desconectado.
        }
        this._changedId = 0;
        this._proxy = null;
        this._onChanged = null;
    }
}

/* --------------------------------------------------------------------------
   Controles integrados
   -------------------------------------------------------------------------- */

function wifiControl(cc) {
    return {
        id: 'wifi',
        name: 'Wi‑Fi',
        category: CATEGORY.connectivity,
        icon: 'network-wireless-signal-good-symbolic',
        sizes: ['small', 'medium'],
        defaultSize: 'medium',
        available: () => Boolean(cc._network && !cc._network.failed),
        create: size => {
            const toggle = () => cc._network?.toggleWifi();
            const detail = () => cc._showDetail('wifi');

            if (size === 'medium') {
                const pill = createPill({
                    iconName: WIFI_OFF,
                    title: 'Wi‑Fi',
                    subtitle: 'Desactivado',
                    onIconClick: toggle,
                    onTextClick: detail,
                    accessibleName: 'Wi‑Fi',
                });

                return {
                    actor: pill.pill,
                    radius: 31,
                    sync: () => {
                        const network = cc._network;
                        let subtitle = 'No disponible';
                        let on = false;
                        let icon = WIFI_OFF;
                        let sensitive = false;

                        if (network && !network.failed) {
                            sensitive = true;
                            icon = network.wifiIconName;
                            if (!network.hasWifi) {
                                subtitle = network.ethernetConnected
                                    ? 'Ethernet'
                                    : 'No disponible';
                                on = network.ethernetConnected;
                                sensitive = false;
                            } else if (!network.wifiEnabled) {
                                subtitle = 'Desactivado';
                            } else {
                                on = true;
                                subtitle = network.wifiSsid || 'No conectado';
                            }
                        }

                        pill.setSubtitle(subtitle);
                        pill.setOn(on);
                        pill.setIcon(icon);
                        pill.setSensitive(sensitive);
                    },
                };
            }

            const circle = new CircleButton({
                iconName: WIFI_OFF,
                iconSize: 22,
                accessibleName: 'Wi‑Fi',
                size: 62,
            });
            circle.connect('clicked', toggle);
            attachSecondaryClick(circle, detail);

            return {
                actor: circle,
                radius: 31,
                sync: () => {
                    const network = cc._network;
                    let on = false;
                    let icon = WIFI_OFF;

                    if (network && !network.failed) {
                        icon = network.wifiIconName;
                        on = Boolean(network.wifiEnabled && network.hasWifi);
                    }

                    circle.setIcon(icon);
                    circle.setOn(on);
                    circle.opacity = network && !network.failed ? 255 : 150;
                    circle.reactive = Boolean(network && !network.failed);
                },
            };
        },
    };
}

function bluetoothControl(cc) {
    return {
        id: 'bluetooth',
        name: 'Bluetooth',
        category: CATEGORY.connectivity,
        icon: 'bluetooth-active-symbolic',
        sizes: ['small', 'medium'],
        defaultSize: 'small',
        available: () => Boolean(cc._bluetooth?.available),
        create: size => {
            const toggle = () => cc._bluetooth?.toggle();
            const detail = () => cc._showDetail('bluetooth');

            if (size === 'medium') {
                const pill = createPill({
                    iconName: 'bluetooth-disabled-symbolic',
                    title: 'Bluetooth',
                    subtitle: 'Desactivado',
                    onIconClick: toggle,
                    onTextClick: detail,
                    accessibleName: 'Bluetooth',
                });

                return {
                    actor: pill.pill,
                    radius: 31,
                    sync: () => {
                        const bluetooth = cc._bluetooth;
                        const available = Boolean(bluetooth?.available);
                        const enabled = Boolean(bluetooth?.enabled);
                        pill.setOn(enabled);
                        pill.setIcon(bluetooth?.iconName ??
                            'bluetooth-disabled-symbolic');
                        pill.setSubtitle(enabled ? 'Activado' : 'Desactivado');
                        pill.setSensitive(available);
                    },
                };
            }

            const circle = new CircleButton({
                iconName: 'bluetooth-disabled-symbolic',
                iconSize: 22,
                accessibleName: 'Bluetooth',
                size: 62,
            });
            circle.connect('clicked', toggle);
            attachSecondaryClick(circle, detail);

            return {
                actor: circle,
                radius: 31,
                sync: () => {
                    const bluetooth = cc._bluetooth;
                    const available = Boolean(bluetooth?.available);
                    circle.setOn(Boolean(bluetooth?.enabled));
                    circle.setIcon(bluetooth?.iconName ??
                        'bluetooth-disabled-symbolic');
                    circle.opacity = available ? 255 : 170;
                    circle.reactive = available;
                },
            };
        },
    };
}

function airplaneControl(cc) {
    return {
        id: 'airplane',
        name: 'Modo avión',
        category: CATEGORY.connectivity,
        icon: 'airplane-mode-symbolic',
        sizes: ['small', 'medium'],
        defaultSize: 'small',
        available: () => Boolean(cc._rfkill?.show_airplane_mode),
        create: size => {
            const toggle = () => {
                if (cc._rfkill)
                    cc._rfkill.airplane_mode = !cc._rfkill.airplane_mode;
            };

            if (size === 'medium') {
                const pill = createPill({
                    iconName: 'airplane-mode-symbolic',
                    title: 'Modo avión',
                    subtitle: 'Desactivado',
                    onIconClick: toggle,
                    onTextClick: toggle,
                    accessibleName: 'Modo avión',
                });
                return {
                    actor: pill.pill,
                    radius: 31,
                    sync: () => {
                        const on = Boolean(cc._rfkill?.airplane_mode);
                        const hw = Boolean(cc._rfkill?.hw_airplane_mode);
                        pill.setOn(on);
                        pill.setSubtitle(on ? 'Activado' : 'Desactivado');
                        pill.setSensitive(!hw);
                    },
                };
            }

            const circle = new CircleButton({
                iconName: 'airplane-mode-symbolic',
                iconSize: 22,
                accessibleName: 'Modo avión',
                size: 62,
            });
            circle.connect('clicked', toggle);
            return {
                actor: circle,
                radius: 31,
                sync: () => {
                    const on = Boolean(cc._rfkill?.airplane_mode);
                    const hw = Boolean(cc._rfkill?.hw_airplane_mode);
                    circle.setOn(on);
                    circle.reactive = !hw;
                    circle.opacity = hw ? 170 : 255;
                },
            };
        },
    };
}

function focusControl(cc) {
    return {
        id: 'focus',
        name: 'Concentración',
        category: CATEGORY.focus,
        icon: 'weather-clear-night-symbolic',
        sizes: ['small', 'medium'],
        defaultSize: 'medium',
        available: () => Boolean(cc._notificationSettings),
        create: size => {
            const toggle = () => cc._toggleDoNotDisturb();

            if (size === 'medium') {
                const pill = createPill({
                    iconName: 'weather-clear-night-symbolic',
                    title: 'Concentración',
                    subtitle: 'Desactivado',
                    onIconClick: toggle,
                    onTextClick: toggle,
                    accessibleName: 'Concentración',
                });
                pill.pill.add_style_class_name('tahoe-cc-pill-focus');
                pill.titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);

                return {
                    actor: pill.pill,
                    radius: 31,
                    sync: () => {
                        const on = dndEnabled(cc);
                        pill.setOn(on);
                        pill.setSubtitle(on ? 'No molestar' : 'Desactivado');
                    },
                };
            }

            const circle = new CircleButton({
                iconName: 'weather-clear-night-symbolic',
                iconSize: 22,
                accessibleName: 'Concentración',
                size: 62,
            });
            circle.connect('clicked', toggle);
            return {
                actor: circle,
                radius: 31,
                sync: () => circle.setOn(dndEnabled(cc)),
            };
        },
    };
}

function darkModeControl(cc) {
    return {
        id: 'dark-mode',
        name: 'Modo oscuro',
        category: CATEGORY.display,
        icon: 'dark-mode-symbolic',
        sizes: ['small', 'medium'],
        defaultSize: 'small',
        available: () => Boolean(cc._interfaceSettings),
        create: size => {
            const toggle = () => cc._toggleDarkMode();

            if (size === 'medium') {
                const pill = createPill({
                    iconName: 'dark-mode-symbolic',
                    title: 'Modo oscuro',
                    subtitle: 'Desactivado',
                    onIconClick: toggle,
                    onTextClick: toggle,
                    accessibleName: 'Modo oscuro',
                });
                return {
                    actor: pill.pill,
                    radius: 31,
                    sync: () => {
                        const on = Boolean(cc._tahoeTheme?.isDark);
                        pill.setOn(on);
                        pill.setSubtitle(on ? 'Activado' : 'Desactivado');
                    },
                };
            }

            const circle = new CircleButton({
                iconName: 'dark-mode-symbolic',
                iconSize: 22,
                accessibleName: 'Modo oscuro',
                size: 62,
            });
            circle.connect('clicked', toggle);
            return {
                actor: circle,
                radius: 31,
                sync: () => circle.setOn(Boolean(cc._tahoeTheme?.isDark)),
            };
        },
    };
}

function nightLightControl(cc) {
    return {
        id: 'night-light',
        name: 'Luz nocturna',
        category: CATEGORY.display,
        icon: 'night-light-symbolic',
        sizes: ['small', 'medium'],
        defaultSize: 'small',
        // La clave de gsd-color existe siempre; no se depende de que el
        // backend headless anuncie night_light_supported.
        available: () => Boolean(cc._colorSettings),
        create: size => {
            const toggle = () => cc._toggleNightLight();

            if (size === 'medium') {
                const pill = createPill({
                    iconName: 'night-light-symbolic',
                    title: 'Luz nocturna',
                    subtitle: 'Desactivado',
                    onIconClick: toggle,
                    onTextClick: toggle,
                    accessibleName: 'Luz nocturna',
                });
                return {
                    actor: pill.pill,
                    radius: 31,
                    sync: () => {
                        const on = safe(() =>
                            cc._colorSettings.get_boolean('night-light-enabled'));
                        pill.setOn(on);
                        pill.setSubtitle(on ? 'Activado' : 'Desactivado');
                    },
                };
            }

            const circle = new CircleButton({
                iconName: 'night-light-symbolic',
                iconSize: 22,
                accessibleName: 'Luz nocturna',
                size: 62,
            });
            circle.connect('clicked', toggle);
            return {
                actor: circle,
                radius: 31,
                sync: () => {
                    circle.setOn(safe(() =>
                        cc._colorSettings.get_boolean('night-light-enabled')));
                },
            };
        },
    };
}

function nowPlayingControl(cc) {
    return {
        id: 'now-playing',
        name: 'Reproduciendo',
        category: CATEGORY.utilities,
        icon: 'media-playback-start-symbolic',
        sizes: ['large'],
        defaultSize: 'large',
        available: () => mediaAvailable(cc),
        create: () => {
            const media = createMediaCard();
            media.previous.connect('clicked', () => cc._media?.previous());
            media.play.connect('clicked', () => cc._media?.playPause());
            media.next.connect('clicked', () => cc._media?.next());

            return {
                actor: media.card,
                radius: 24,
                refs: {media},
                repaint: () => media.art.queue_repaint(),
                sync: () => {
                    const player = cc._media;
                    const hasPlayer = Boolean(
                        mediaAvailable(cc) && player?.hasPlayer && player.title);

                    media.setEmpty(!hasPlayer);
                    if (!hasPlayer) {
                        media.setArtUrl('');
                        media._playing = null;
                        return;
                    }

                    media.title.text = player.title;
                    media.artist.text = player.artist ?? '';
                    media.artist.visible = Boolean(player.artist);
                    media.setPlaying(Boolean(player.playing));
                    media.previous.opacity = player.canGoPrevious ? 255 : 120;
                    media.previous.reactive = Boolean(player.canGoPrevious);
                    media.next.opacity = player.canGoNext ? 255 : 120;
                    media.next.reactive = Boolean(player.canGoNext);
                    media.setArtUrl(player.artUrl ?? '');
                },
            };
        },
    };
}

function displayControl(cc) {
    return {
        id: 'display',
        name: 'Pantalla',
        category: CATEGORY.display,
        icon: 'display-brightness-symbolic',
        sizes: ['wide'],
        defaultSize: 'wide',
        available: () => Boolean(Main.brightnessManager?.globalScale),
        create: () => {
            const wide = createWideCard({
                title: 'Pantalla',
                leftIcon: 'display-brightness-symbolic',
                rightIcon: 'display-brightness-symbolic',
                leftIconSize: 14,
                rightIconSize: 18,
                accessibleName: 'Brillo de la pantalla',
            });
            const name = 'Pantalla';
            wide.card.set_accessible_name('Brillo de la pantalla');
            let updating = false;

            wide.slider.connect('notify::value', () => {
                if (updating)
                    return;
                const scale = Main.brightnessManager?.globalScale;
                if (scale)
                    scale.value = wide.slider.value;
            });

            return {
                actor: wide.card,
                radius: 24,
                refs: {wide},
                repaint: () => wide.slider.queue_repaint(),
                sync: () => {
                    const scale = Main.brightnessManager?.globalScale;
                    if (!scale)
                        return;
                    updating = true;
                    wide.slider.value = scale.value;
                    updating = false;
                    wide.card.visible = true;
                    wide.card.set_accessible_name(name);
                },
            };
        },
    };
}

function soundControl(cc) {
    return {
        id: 'sound',
        name: 'Sonido',
        category: CATEGORY.sound,
        icon: 'audio-volume-high-symbolic',
        sizes: ['wide'],
        defaultSize: 'wide',
        available: () => Boolean(cc._sink),
        create: () => {
            const wide = createWideCard({
                title: 'Sonido',
                leftIcon: 'audio-volume-high-symbolic',
                rightIcon: 'audio-volume-high-symbolic',
                leftIconSize: 14,
                rightIconSize: 18,
                withOutputButton: true,
                accessibleName: 'Volumen',
            });
            wide.slider.connect('notify::value', () => {
                if (cc._updatingVolumeSlider)
                    return;
                cc._setVolumeFromSlider(wide.slider.value);
            });
            if (wide.output)
                wide.output.connect('clicked', () => cc._showDetail('sound'));

            return {
                actor: wide.card,
                radius: 24,
                refs: {wide},
                repaint: () => wide.slider.queue_repaint(),
                sync: () => {
                    const sink = cc._sink;
                    if (!sink)
                        return;

                    let volume = 0;
                    let muted = true;
                    try {
                        muted = Boolean(sink.is_muted);
                        const max = cc._mixer?.get_vol_max_norm() || 1;
                        volume = muted ? 0 : Math.clamp(sink.volume / max, 0, 1);
                    } catch (_e) {
                        volume = 0;
                        muted = true;
                    }

                    cc._updatingVolumeSlider = true;
                    wide.slider.value = volume;
                    cc._updatingVolumeSlider = false;

                    let icon = 'audio-volume-low-symbolic';
                    if (muted)
                        icon = 'audio-volume-muted-symbolic';
                    else if (volume < 0.33)
                        icon = 'audio-volume-low-symbolic';
                    else if (volume < 0.66)
                        icon = 'audio-volume-medium-symbolic';
                    else
                        icon = 'audio-volume-high-symbolic';

                    wide.setLeftIcon(icon);

                    if (wide.output) {
                        const device = cc._deviceForSink(sink);
                        wide.output.setIcon(cc._deviceIconName(device, sink));
                    }
                },
            };
        },
    };
}

function powerProfileControl(cc) {
    return {
        id: 'power-profile',
        name: 'Perfil de energía',
        category: CATEGORY.battery,
        icon: 'power-profile-balanced-symbolic',
        sizes: ['small', 'medium'],
        defaultSize: 'small',
        available: () => Boolean(cc._powerProfiles?.available),
        create: size => {
            const cycle = () => cc._powerProfiles?.cycleProfile();

            if (size === 'medium') {
                const pill = createPill({
                    iconName: 'power-profile-balanced-symbolic',
                    title: 'Energía',
                    subtitle: '',
                    onIconClick: cycle,
                    onTextClick: cycle,
                    accessibleName: 'Perfil de energía',
                });
                return {
                    actor: pill.pill,
                    radius: 31,
                    sync: () => {
                        const info = cc._powerProfiles?.activeInfo;
                        if (!info)
                            return;
                        pill.setIcon(info.iconName);
                        pill.setSubtitle(info.name);
                        pill.pill.accessible_name =
                            `Perfil de energía: ${info.name}`;
                    },
                };
            }

            const circle = new CircleButton({
                iconName: 'power-profile-balanced-symbolic',
                iconSize: 22,
                accessibleName: 'Perfil de energía',
                size: 62,
            });
            circle.connect('clicked', cycle);
            return {
                actor: circle,
                radius: 31,
                sync: () => {
                    const info = cc._powerProfiles?.activeInfo;
                    if (!info)
                        return;
                    circle.setIcon(info.iconName);
                    circle.accessible_name = `Perfil de energía: ${info.name}`;
                },
            };
        },
    };
}

function screenshotControl(cc) {
    return {
        id: 'screenshot',
        name: 'Captura de pantalla',
        category: CATEGORY.utilities,
        icon: 'camera-photo-symbolic',
        sizes: ['small'],
        defaultSize: 'small',
        available: () => Boolean(Main.screenshotUI),
        create: () => {
            const circle = new CircleButton({
                iconName: 'camera-photo-symbolic',
                iconSize: 22,
                accessibleName: 'Captura de pantalla',
                size: 62,
            });
            circle.connect('clicked', () => cc._takeScreenshot());
            return {actor: circle, radius: 31, sync: () => {}};
        },
    };
}

function screenRecordingControl(cc) {
    return {
        id: 'screen-recording',
        name: 'Grabar pantalla',
        category: CATEGORY.utilities,
        icon: 'camera-video-symbolic',
        sizes: ['small'],
        defaultSize: 'small',
        available: () => Boolean(Main.screenshotUI?.open) &&
            Main.screenshotUI?._screencastSupported !== false,
        create: () => {
            const circle = new CircleButton({
                iconName: 'camera-video-symbolic',
                iconSize: 22,
                accessibleName: 'Grabar pantalla',
                size: 62,
            });
            circle.connect('clicked', () => cc._startScreenRecording());
            return {actor: circle, radius: 31, sync: () => {}};
        },
    };
}

function lockControl(cc) {
    return {
        id: 'lock',
        name: 'Bloquear',
        category: CATEGORY.utilities,
        icon: 'changes-prevent-symbolic',
        sizes: ['small'],
        defaultSize: 'small',
        available: () => Boolean(Main.screenShield),
        create: () => {
            const circle = new CircleButton({
                iconName: 'changes-prevent-symbolic',
                iconSize: 22,
                accessibleName: 'Bloquear',
                size: 62,
            });
            circle.connect('clicked', () => cc._lockScreen());
            return {actor: circle, radius: 31, sync: () => {}};
        },
    };
}

function settingsControl(cc) {
    return {
        id: 'settings',
        name: 'Ajustes',
        category: CATEGORY.utilities,
        icon: 'org.gnome.Settings-symbolic',
        sizes: ['small'],
        defaultSize: 'small',
        available: () => true,
        create: () => {
            const circle = new CircleButton({
                iconName: 'org.gnome.Settings-symbolic',
                iconSize: 22,
                accessibleName: 'Ajustes',
                size: 62,
            });
            circle.connect('clicked', () => cc._openSettings());
            return {actor: circle, radius: 31, sync: () => {}};
        },
    };
}

function batteryControl(cc) {
    return {
        id: 'battery',
        name: 'Batería',
        category: CATEGORY.battery,
        icon: 'battery-good-symbolic',
        sizes: ['small', 'medium'],
        defaultSize: 'small',
        available: () => Boolean(cc._battery?.present),
        create: size => {
            if (size === 'medium') {
                const pill = createPill({
                    iconName: 'battery-good-symbolic',
                    title: 'Batería',
                    subtitle: '',
                    onIconClick: () => cc._openBatteryPopover?.(),
                    onTextClick: () => cc._openBatteryPopover?.(),
                    accessibleName: 'Batería',
                });
                return {
                    actor: pill.pill,
                    radius: 31,
                    sync: () => {
                        const battery = cc._battery;
                        if (!battery?.present)
                            return;
                        pill.setSubtitle(batterySubtitle(battery));
                        pill.setOn(Boolean(battery.charging));
                        pill.setIcon(battery.charging
                            ? 'battery-charging-symbolic'
                            : 'battery-good-symbolic');
                    },
                };
            }

            const label = new St.Label({
                text: '',
                style_class: 'tahoe-cc-battery-circle-label',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const circle = new CircleButton({
                iconName: null,
                iconSize: 22,
                accessibleName: 'Batería',
                size: 62,
                child: label,
            });
            circle.connect('clicked', () => cc._openBatteryPopover?.());

            return {
                actor: circle,
                radius: 31,
                sync: () => {
                    const battery = cc._battery;
                    if (!battery?.present)
                        return;
                    label.text = `${battery.percentage}%`;
                    circle.setOn(Boolean(battery.charging));
                    circle.accessible_name =
                        `Batería: ${batterySubtitle(battery)}`;
                },
            };
        },
    };
}

function keyboardBrightnessControl(cc) {
    const controller = cc._keyboardBacklight;
    return {
        id: 'keyboard-brightness',
        name: 'Brillo del teclado',
        category: CATEGORY.display,
        icon: 'keyboard-brightness-high-symbolic',
        sizes: ['wide'],
        defaultSize: 'wide',
        available: () => Boolean(controller?.available),
        create: () => {
            const wide = createWideCard({
                title: 'Brillo del teclado',
                leftIcon: 'keyboard-brightness-medium-symbolic',
                rightIcon: 'keyboard-brightness-high-symbolic',
                leftIconSize: 14,
                rightIconSize: 18,
                accessibleName: 'Brillo del teclado',
            });
            let updating = false;

            wide.slider.connect('notify::value', () => {
                if (updating || !controller)
                    return;
                controller.value = wide.slider.value;
            });

            return {
                actor: wide.card,
                radius: 24,
                refs: {wide},
                repaint: () => wide.slider.queue_repaint(),
                sync: () => {
                    if (!controller?.available)
                        return;
                    updating = true;
                    wide.slider.value = controller.value;
                    updating = false;
                },
            };
        },
    };
}

function calculatorControl(cc) {
    return {
        id: 'calculator',
        name: 'Calculadora',
        category: CATEGORY.utilities,
        icon: 'accessories-calculator-symbolic',
        sizes: ['small', 'medium'],
        defaultSize: 'small',
        available: () => cc._calculatorAvailable(),
        create: size => {
            const open = () => cc._openCalculator();

            if (size === 'medium') {
                const pill = createPill({
                    iconName: 'accessories-calculator-symbolic',
                    title: 'Calculadora',
                    subtitle: 'Abrir',
                    onIconClick: open,
                    onTextClick: open,
                    accessibleName: 'Calculadora',
                });
                return {actor: pill.pill, radius: 31, sync: () => {}};
            }

            const circle = new CircleButton({
                iconName: 'accessories-calculator-symbolic',
                iconSize: 22,
                accessibleName: 'Calculadora',
                size: 62,
            });
            circle.connect('clicked', open);
            return {actor: circle, radius: 31, sync: () => {}};
        },
    };
}

/* --------------------------------------------------------------------------
   Registro
   -------------------------------------------------------------------------- */

export class ControlRegistry {
    constructor(cc) {
        this._cc = cc;
        this._entries = new Map();
        this._externals = new Map();

        this._cc._keyboardBacklight = new KeyboardBacklightController(
            () => {
                if (!this._cc?._destroyed)
                    this._cc._queueSync();
            });

        for (const descriptor of [
            wifiControl(cc),
            bluetoothControl(cc),
            airplaneControl(cc),
            focusControl(cc),
            darkModeControl(cc),
            nightLightControl(cc),
            nowPlayingControl(cc),
            displayControl(cc),
            soundControl(cc),
            powerProfileControl(cc),
            screenshotControl(cc),
            screenRecordingControl(cc),
            lockControl(cc),
            settingsControl(cc),
            batteryControl(cc),
            keyboardBrightnessControl(cc),
            calculatorControl(cc),
        ]) {
            this._entries.set(descriptor.id, descriptor);
        }
    }

    get(id) {
        return this._entries.get(id) ?? this._externals.get(id) ?? null;
    }

    /** Entradas integradas (sin externos). */
    getBuiltins() {
        return [...this._entries.values()];
    }

    /**
     * Lista pensada para el editor: metadatos serializables y disponibilidad
     * actual. Incluye los controles externos descubiertos.
     */
    list() {
        const result = [];

        for (const entry of [...this._entries.values(), ...this._externals.values()]) {
            let available = false;
            try {
                available = Boolean(entry.available());
            } catch (_e) {
                available = false;
            }

            result.push({
                id: entry.id,
                name: entry.name,
                category: entry.category,
                icon: entry.icon,
                sizes: [...entry.sizes],
                defaultSize: entry.defaultSize,
                available,
                external: Boolean(entry.external),
            });
        }

        return result;
    }

    _externalName(item) {
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        if (title)
            return title;

        const accessible = typeof item.accessible_name === 'string'
            ? item.accessible_name.trim()
            : '';
        if (accessible)
            return accessible;

        const icon = item.iconName ?? item.icon_name ?? '';
        if (icon) {
            return icon.replace(/-symbolic$/, '').replace(/-/g, ' ')
                .replace(/^./, c => c.toUpperCase());
        }

        return item.constructor?.name ?? 'Control externo';
    }

    _externalIcon(item) {
        let gicon = null;
        let iconName = null;

        try {
            gicon = item.gicon ?? null;
        } catch (_e) {
            gicon = null;
        }

        try {
            iconName = item.iconName ?? item.icon_name ?? null;
        } catch (_e) {
            iconName = null;
        }

        if (gicon?.to_string) {
            try {
                iconName = gicon.to_string();
            } catch (_e) {
                // Sin representación textual.
            }
        }

        return {
            gicon,
            iconName: iconName || 'application-x-addon-symbolic',
        };
    }

    _newExternalId(item, used) {
        const type = item.constructor?.name ?? 'QuickToggle';
        const name = this._externalName(item);
        const base = `ext:${slug(type)}-${slug(name)}`;
        let id = base;
        let index = 2;

        while (used.has(id))
            id = `${base}-${index++}`;

        return id;
    }

    _createExternal(item, used) {
        const id = this._newExternalId(item, used);
        const name = this._externalName(item);
        const icon = this._externalIcon(item);
        const isSlider = Boolean(item.slider);
        const menu = item.menu ?? null;

        const descriptor = {
            id,
            name,
            category: CATEGORY.extensions,
            icon: icon.iconName,
            sizes: isSlider ? ['wide'] : ['small', 'medium'],
            defaultSize: isSlider ? 'wide' : 'small',
            external: true,
            item,
            menu,
            destroyed: false,
            cleanups: [],
            available: () => !descriptor.destroyed && item.visible !== false,
            create: size => isSlider
                ? this._createExternalSlider(descriptor, item, size)
                : this._createExternalToggle(descriptor, item, size),
        };

        this._cc._connect(item, 'destroy', () => {
            descriptor.destroyed = true;
            this._cc?._queueExternalRefresh?.();
        });

        this._cc._connect(item, 'notify::visible', () => {
            this._cc?._queueExternalRefresh?.();
        });

        return descriptor;
    }

    _bindExternalUpdates(control, item, apply, entry) {
        const ids = [];
        control.destroyed = false;

        // El espejo se reconstruye cada vez que cambia el layout. Las
        // conexiones deben morir con el actor; si no, un notify del original
        // tocaría widgets disposed.
        const guarded = () => {
            if (control.destroyed)
                return;
            apply();
        };

        for (const signal of [
            'notify::title',
            'notify::subtitle',
            'notify::icon-name',
            'notify::gicon',
            'notify::checked',
            'notify::reactive',
            'notify::sensitive',
        ]) {
            try {
                ids.push(item.connect(signal, guarded));
            } catch (_e) {
                // La propiedad no existe en este tipo de control.
            }
        }

        const cleanup = () => {
            control.destroyed = true;

            if (!entry?.destroyed) {
                for (const id of ids) {
                    try {
                        item.disconnect(id);
                    } catch (_e) {
                        // El original ya no existe.
                    }
                }
            }
            ids.length = 0;

            const index = entry?.cleanups?.indexOf(cleanup) ?? -1;
            if (index >= 0)
                entry.cleanups.splice(index, 1);
        };

        control.actor.connect('destroy', cleanup);
        entry?.cleanups?.push(cleanup);

        apply();
        return control;
    }

    _createExternalToggle(entry, item, size) {
        const cc = this._cc;
        const openMenu = entry.menu
            ? () => cc._showExternalMenu(entry.id)
            : null;
        const invoke = () => cc._invokeExternal(entry);

        const applyCommon = actor => {
            const icon = this._externalIcon(item);
            const name = this._externalName(item);
            const checked = Boolean(item.checked);
            const reactive = item.reactive !== false &&
                (item.find_property?.('sensitive')
                    ? item.sensitive !== false
                    : true);

            if (actor instanceof CircleButton) {
                setCircleIcon(actor, icon.iconName, icon.gicon);
                actor.setOn(checked);
                actor.reactive = reactive;
                actor.opacity = reactive ? 255 : 150;
                actor.accessible_name = name;
            } else {
                setPillIcon(actor, icon.iconName, icon.gicon);
                actor.setOn(checked);
                actor.pill.reactive = reactive;
                actor.pill.opacity = reactive ? 255 : 150;
                actor.pill.accessible_name = name;
            }

            return {name, checked, reactive};
        };

        if (size === 'medium') {
            const pill = createPill({
                iconName: null,
                title: entry.name,
                subtitle: '',
                onIconClick: invoke,
                onTextClick: invoke,
                accessibleName: entry.name,
            });

            let chevron = null;
            if (openMenu && item.menuEnabled !== false) {
                chevron = new St.Button({
                    style_class: 'tahoe-cc-pill-chevron',
                    can_focus: true,
                    reactive: true,
                    track_hover: true,
                    accessible_name: 'Abrir menú',
                    child: new St.Icon({
                        icon_name: 'go-next-symbolic',
                        icon_size: 12,
                        style_class: 'tahoe-cc-icon',
                    }),
                });
                chevron.connect('clicked', openMenu);
                pill.pill.add_child(chevron);
                pill.pill.add_style_class_name('tahoe-cc-pill-ext');
            }

            const control = {
                actor: pill.pill,
                radius: 31,
                refs: {pill, chevron},
                sync: () => {
                    const state = applyCommon(pill);
                    const subtitle = typeof item.subtitle === 'string'
                        ? item.subtitle
                        : '';
                    pill.titleLabel.text = state.name;
                    pill.setSubtitle(subtitle);
                    pill.textButton.reactive = state.reactive &&
                        Boolean(invoke);
                    if (chevron)
                        chevron.visible = Boolean(openMenu);
                },
            };

            return this._bindExternalUpdates(control, item, () => {
                control.sync();
            }, entry);
        }

        const circle = new CircleButton({
            iconName: null,
            iconSize: 22,
            accessibleName: entry.name,
            size: 62,
        });
        circle.connect('clicked', invoke);
        if (openMenu)
            attachSecondaryClick(circle, openMenu);

        const control = {
            actor: circle,
            radius: 31,
            sync: () => {
                applyCommon(circle);
            },
        };

        return this._bindExternalUpdates(control, item, () => {
            control.sync();
        }, entry);
    }

    _createExternalSlider(entry, item, _size) {
        const cc = this._cc;
        const icon = this._externalIcon(item);
        const wide = createWideCard({
            title: entry.name,
            leftIcon: icon.gicon ? null : icon.iconName,
            rightIcon: icon.gicon ? null : icon.iconName,
            leftIconSize: 14,
            rightIconSize: 18,
            accessibleName: entry.name,
        });

        if (icon.gicon) {
            try {
                const leftIcon = wide.left.get_first_child();
                if (leftIcon) {
                    leftIcon.icon_name = null;
                    leftIcon.gicon = icon.gicon;
                }
                wide.right.icon_name = null;
                wide.right.gicon = icon.gicon;
            } catch (_e) {
                // Icono no disponible.
            }
        }

        let updating = false;

        const sync = () => {
            if (!item.slider)
                return;
            updating = true;
            try {
                wide.slider.value = Math.clamp(
                    Number(item.slider.value) || 0, 0, 1);
            } catch (_e) {
                // Slider ajeno no disponible.
            }
            updating = false;
        };

        wide.slider.connect('notify::value', () => {
            if (updating || !item.slider)
                return;
            try {
                item.slider.value = wide.slider.value;
            } catch (e) {
                console.debug(`${LOG} No se pudo mover un slider externo: ${e.message}`);
            }
        });

        const control = {
            actor: wide.card,
            radius: 24,
            refs: {wide},
            destroyed: false,
            repaint: () => wide.slider.queue_repaint(),
            sync,
        };

        const guarded = () => {
            if (!control.destroyed)
                sync();
        };

        let sliderId = 0;
        try {
            sliderId = item.slider.connect('notify::value', guarded);
        } catch (_e) {
            sliderId = 0;
        }

        const cleanup = () => {
            control.destroyed = true;

            if (!entry?.destroyed && sliderId) {
                try {
                    item.slider.disconnect(sliderId);
                } catch (_e) {
                    // El slider original ya no existe.
                }
            }
            sliderId = 0;

            const index = entry?.cleanups?.indexOf(cleanup) ?? -1;
            if (index >= 0)
                entry.cleanups.splice(index, 1);
        };

        control.actor.connect('destroy', cleanup);
        entry?.cleanups?.push(cleanup);

        sync();
        return control;
    }

    /**
     * Reconcilia los QuickToggle/QuickMenuToggle/QuickSlider encontrados en
     * el menú de GNOME. Devuelve los descriptores externos activos.
     */
    updateExternals(items) {
        const previous = new Map(this._externals);
        /** @type {Map<string, object>} */
        const next = new Map();
        const used = new Set(this._entries.keys());
        const list = [];

        for (const item of items) {
            let entry = null;
            for (const candidate of previous.values()) {
                if (candidate.item === item && !candidate.destroyed) {
                    entry = candidate;
                    break;
                }
            }

            if (entry && (used.has(entry.id) || next.has(entry.id)))
                entry = null;

            if (!entry)
                entry = this._createExternal(item, used);

            used.add(entry.id);
            next.set(entry.id, entry);
            list.push(entry);
        }

        for (const [id, entry] of previous) {
            if (!next.has(id)) {
                // Limpiar antes de marcar destroyed para desconectar las
                // señales de los espejos que aún viven.
                for (const cleanup of [...entry.cleanups]) {
                    try {
                        cleanup();
                    } catch (_e) {
                        // Ya limpiado.
                    }
                }
                entry.destroyed = true;
                entry.cleanups.length = 0;
                next.delete(id);
            }
        }

        this._externals = next;
        return list;
    }

    getExternal(id) {
        return this._externals.get(id) ?? null;
    }

    destroy() {
        for (const entry of this._externals.values()) {
            for (const cleanup of [...entry.cleanups]) {
                try {
                    cleanup();
                } catch (_e) {
                    // Ya limpiado.
                }
            }
            entry.destroyed = true;
            entry.cleanups.length = 0;
        }
        this._externals.clear();
        this._entries.clear();

        try {
            this._cc?._keyboardBacklight?.destroy();
        } catch (_e) {
            // Ignorar.
        }

        if (this._cc)
            this._cc._keyboardBacklight = null;
        this._cc = null;
    }
}
