import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

const LOG = '[tahoe-topbar]';
const A11Y_SCHEMA = 'org.gnome.desktop.a11y.keyboard';

// Acciones de Mutter que comparten Alt+Tab y Super+Tab. GNOME registra un
// único manejador para todas las combinaciones de cada acción, de modo que
// hay que distinguir la combinación por su máscara de modificadores.
const SWITCHER_ACTIONS = [
    'switch-applications',
    'switch-applications-backward',
];

// En una Meta.KeyBinding la tecla Super llega como MOD4 (64), mientras que
// Clutter.ModifierType.SUPER_MASK es un modificador virtual distinto
// (0x4000000) que puede aparecer en eventos de Clutter. Hay que aceptar ambos.
const SUPER_MASK = Clutter.ModifierType.MOD4_MASK |
    Clutter.ModifierType.SUPER_MASK;

/**
 * Atajos de teclado del Launchpad al estilo de macOS/GNOME 50:
 *
 *  - Super solo: abre/cierra TahoeLaunchpad.
 *  - Super+Tab: abre el overview de ventanas de GNOME (el antiguo Super).
 *  - Super+Shift+Tab: igual que Super+Tab; el overview no tiene una
 *    dirección inversa real, así que no se inventa una navegación inversa.
 *  - Alt+Tab / Alt+Shift+Tab: siguen usando el cambiador nativo de GNOME.
 *
 * El "overlay-key" de Mutter es la señal que emite GNOME al pulsar Super.
 * GNOME Shell conecta su manejador en OverviewControls y nosotros no podemos
 * anteponernos a él. Por eso se bloquean temporalmente sus manejadores
 * (incluidos los de otras extensiones, que también quedarían sustituidos por
 * el nuestro) y se conecta uno propio. Al destruir este objeto se desconecta
 * el nuestro y se desbloquean exactamente los manejadores que bloqueamos.
 */
export class TahoeLaunchpadShortcuts {
    constructor(extension) {
        this._extension = extension ?? null;
        this._destroyed = false;

        this._overlayHandlerId = 0;
        this._blockedOverlayHandlers = [];
        this._switcherActions = [];

        // Se guarda el manejador original de GNOME antes de sustituirlo para
        // poder restaurarlo tal cual al desactivar la extensión.
        this._originalStartSwitcher = Main.wm?._startSwitcher?.bind(Main.wm) ?? null;
        this._switcherHandler = this._onSwitcherBinding.bind(this);

        this._a11ySettings = null;
        try {
            this._a11ySettings = new Gio.Settings({schema_id: A11Y_SCHEMA});
        } catch (error) {
            console.warn(`${LOG} No se pudo leer la configuración de accesibilidad:`, error);
        }

        this._installOverlayHandler();
        this._installSwitcherHandlers();
    }

    /* ------------------------------------------------------------------ */
    /* Super solo                                                         */
    /* ------------------------------------------------------------------ */

    _installOverlayHandler() {
        const display = global.display;
        let signalId = 0;

        try {
            signalId = GObject.signal_lookup('overlay-key', display);
        } catch (error) {
            signalId = 0;
        }

        if (!signalId) {
            console.error(`${LOG} Mutter no expone la señal overlay-key; Super queda sin cambios.`);
            return;
        }

        if (typeof GObject.signal_handler_find !== 'function' ||
            typeof GObject.signal_handler_block !== 'function') {
            console.error(`${LOG} GJS no permite inspeccionar manejadores de señales; Super queda sin cambios.`);
            return;
        }

        try {
            // signal_handler_find sólo devuelve manejadores no bloqueados, así
            // que el bucle termina cuando ya no queda ninguno. Se registran
            // los IDs para restaurarlos exactamente al desactivar.
            let handlerId = 0;
            let guard = 0;
            while (guard++ < 64) {
                handlerId = GObject.signal_handler_find(
                    display,
                    GObject.SignalMatchType.ID | GObject.SignalMatchType.UNBLOCKED,
                    signalId, 0, null, null, null);

                if (!handlerId)
                    break;

                GObject.signal_handler_block(display, handlerId);
                this._blockedOverlayHandlers.push(handlerId);
            }

            this._overlayHandlerId = display.connect('overlay-key',
                () => this._onOverlayKey());
        } catch (error) {
            console.error(`${LOG} No se pudo interceptar Super:`, error);
            this._restoreOverlayHandlers();
        }
    }

    _onOverlayKey() {
        if (this._destroyed)
            return;

        // Mismo comportamiento que GNOME: con Sticky Keys activo, Super no
        // dispara el overview (y aquí tampoco el Launchpad).
        try {
            if (this._a11ySettings?.get_boolean('stickykeys-enable'))
                return;
        } catch (_e) {
            // Si la configuración no está disponible, se sigue adelante.
        }

        const launchpad = this._extension?._launchpad;
        if (!launchpad)
            return;

        try {
            if (launchpad.isOpen) {
                launchpad.close();
                return;
            }

            // Launchpad no debe convivir con el overview de GNOME.
            if (Main.overview?.visible)
                Main.overview.hide();

            launchpad.open();
        } catch (error) {
            console.error(`${LOG} No se pudo alternar el Launchpad con Super:`, error);
        }
    }

    _restoreOverlayHandlers() {
        if (this._overlayHandlerId) {
            try {
                global.display.disconnect(this._overlayHandlerId);
            } catch (_e) {
                // La señal ya no existía (por ejemplo, durante el apagado).
            }
            this._overlayHandlerId = 0;
        }

        for (const handlerId of this._blockedOverlayHandlers) {
            try {
                // Sólo se desbloquea si sigue conectado; el shell puede haber
                // destruido el actor/señal durante el apagado.
                if (GObject.signal_handler_is_connected(global.display, handlerId))
                    GObject.signal_handler_unblock(global.display, handlerId);
            } catch (_e) {
                // Manejador ya eliminado.
            }
        }
        this._blockedOverlayHandlers = [];
    }

    /* ------------------------------------------------------------------ */
    /* Super+Tab                                                          */
    /* ------------------------------------------------------------------ */

    _installSwitcherHandlers() {
        for (const action of SWITCHER_ACTIONS) {
            try {
                // En algunas versiones de GJS el valor de retorno no está
                // anotado y llega como undefined aunque el registro funcione.
                const installed = Meta.keybindings_set_custom_handler(
                    action, this._switcherHandler);
                if (installed !== false)
                    this._switcherActions.push(action);
            } catch (error) {
                console.error(`${LOG} No se pudo registrar el atajo ${action}:`, error);
            }
        }
    }

    _onSwitcherBinding(display, window, event, binding) {
        if (this._destroyed)
            return;

        let mask = 0;
        try {
            mask = binding?.get_mask?.() ?? 0;
        } catch (_e) {
            mask = 0;
        }

        // Algunas versiones de Mutter no incluyen los modificadores en
        // get_mask(); el evento de Clutter es una segunda fuente fiable.
        if (!mask) {
            try {
                mask = event?.get_state?.() ?? 0;
            } catch (_e) {
                mask = 0;
            }
        }

        if (!(mask & SUPER_MASK)) {
            // Alt+Tab (y Alt+Shift+Tab) siguen siendo el cambiador nativo.
            if (this._originalStartSwitcher)
                this._originalStartSwitcher(display, window, event, binding);
            return;
        }

        this._showWindowsOverview();
    }

    _showWindowsOverview() {
        const launchpad = this._extension?._launchpad;
        if (launchpad?.isOpen)
            launchpad.close();

        try {
            if (Main.overview?.visible) {
                // Si el overview estaba en la rejilla de aplicaciones, se
                // vuelve al selector de ventanas sin cerrarlo.
                const showAppsButton =
                    Main.overview._overview?.controls?.dash?.showAppsButton;
                if (showAppsButton?.checked)
                    showAppsButton.checked = false;
                return;
            }

            Main.overview.show(ControlsState.WINDOW_PICKER);
        } catch (error) {
            console.error(`${LOG} No se pudo abrir el overview de ventanas:`, error);
        }
    }

    _restoreSwitcherHandlers() {
        for (const action of this._switcherActions) {
            try {
                if (this._originalStartSwitcher) {
                    Main.wm.setCustomKeybindingHandler(action, Shell.ActionMode.NORMAL,
                        this._originalStartSwitcher);
                }
            } catch (error) {
                console.error(`${LOG} No se pudo restaurar el atajo ${action}:`, error);
            }
        }
        this._switcherActions = [];
    }

    /* ------------------------------------------------------------------ */
    /* Ciclo de vida                                                       */
    /* ------------------------------------------------------------------ */

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._restoreSwitcherHandlers();
        this._restoreOverlayHandlers();

        this._a11ySettings = null;
        this._extension = null;
        this._switcherHandler = null;
        this._originalStartSwitcher = null;
    }
}
