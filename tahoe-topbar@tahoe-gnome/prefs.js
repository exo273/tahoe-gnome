// Preferencias de Tahoe Top Bar
// GNOME Shell 50 · GJS 1.88 · libadwaita 1.9 · GTK 4.22

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');
Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');

const LOGO_CHOICES = [
    {
        value: 'apple',
        label: 'Manzana',
        tooltip: 'Manzana rellena',
        asset: 'apple-logo-symbolic.svg',
    },
    {
        value: 'apple-outline',
        label: 'Manzana (contorno)',
        tooltip: 'Manzana dibujada sólo con el contorno',
        asset: 'apple-outline-symbolic.svg',
    },
    {
        value: 'fedora',
        label: 'Fedora',
        tooltip: 'Logotipo de Fedora',
        asset: 'fedora-logo-symbolic.svg',
    },
    {
        value: 'gnome',
        label: 'GNOME',
        tooltip: 'Logotipo de GNOME',
        asset: 'gnome-logo-symbolic.svg',
    },
    {
        value: 'custom',
        label: 'Personalizado',
        tooltip: 'Usar una imagen SVG o PNG propia',
        asset: null,
    },
];

const PANEL_STYLES = [
    {value: 'transparent', label: 'Transparente'},
    {value: 'translucent', label: 'Translúcido'},
    {value: 'solid', label: 'Sólido'},
];

const TEXT_COLORS = [
    {value: 'auto', label: 'Automático (según el fondo de pantalla)'},
    {value: 'light', label: 'Claro'},
    {value: 'dark', label: 'Oscuro'},
];

const GLASS_STYLES = [
    {value: 'liquid', label: 'Liquid Glass (refracción)'},
    {value: 'blur', label: 'Desenfoque simple'},
    {value: 'none', label: 'Sin efecto'},
];

const PANEL_GLASS = [
    {value: 'off', label: 'Desactivado'},
    {value: 'pill', label: 'Píldora'},
    {value: 'islands', label: 'Islas'},
];

const BLUR_METHODS = [
    {value: 0, label: 'Gaussiano (recomendado)'},
    {value: 1, label: 'Dual Kawase (rendimiento)'},
];

const BLUR_DOWNSCALE = [
    {value: 2, label: 'Calidad (media resolución)'},
    {value: 4, label: 'Rendimiento (cuarta parte)'},
];

const GLASS_TUNING_KEYS = [
    'glass-displacement-scale',
    'glass-rim-intensity',
    'glass-rim-width',
    'glass-chroma-strength',
    'glass-light-angle-deg',
    'shadow-intensity',
    'blur-method',
    'glass-blur-downscale',
];

const LIQUID_GLASS_URL = 'https://github.com/ryohsuke1231/liquid-glass';

const ABOUT_TEXT_FIELDS = [
    {
        key: 'about-title',
        title: 'Título',
        hint: 'Vacío = modelo del equipo detectado (p. ej. ThinkPad T14 Gen 2i).',
    },
    {
        key: 'about-subtitle',
        title: 'Subtítulo',
        hint: 'Vacío = datos detectados (p. ej. 14 pulgadas, 2021).',
    },
    {
        key: 'about-chip',
        title: 'Procesador',
        hint: 'Vacío = modelo de CPU detectado automáticamente.',
    },
    {
        key: 'about-graphics',
        title: 'Gráficos',
        hint: 'Vacío = controlador gráfico detectado automáticamente.',
    },
    {
        key: 'about-serial',
        title: 'Número de serie',
        hint: 'Vacío = número derivado del machine-id del sistema.',
    },
    {
        key: 'about-os-name',
        title: 'Sistema operativo',
        hint: 'Vacío = nombre leído de /etc/os-release (p. ej. Fedora Linux 44).',
    },
];


const DEFAULT_CC_LAYOUT = [
    {id: 'wifi', size: 'medium'},
    {id: 'now-playing', size: 'large'},
    {id: 'bluetooth', size: 'small'},
    {id: 'airplane', size: 'small'},
    {id: 'focus', size: 'medium'},
    {id: 'dark-mode', size: 'small'},
    {id: 'night-light', size: 'small'},
    {id: 'display', size: 'wide'},
    {id: 'sound', size: 'wide'},
    {id: 'power-profile', size: 'small'},
    {id: 'screenshot', size: 'small'},
    {id: 'lock', size: 'small'},
    {id: 'settings', size: 'small'},
];

const DEFAULT_MENUBAR_CONTROLS = ['battery', 'sound', 'wifi'];

// Respaldo si el shell aún no ha publicado control-center-catalog (por
// ejemplo, al abrir las preferencias antes de activar la extensión).
const BUILTIN_CATALOG = [
    {id: 'wifi', name: 'Wi‑Fi', category: 'Conectividad', icon: 'network-wireless-signal-good-symbolic', sizes: ['small', 'medium'], defaultSize: 'medium'},
    {id: 'bluetooth', name: 'Bluetooth', category: 'Conectividad', icon: 'bluetooth-active-symbolic', sizes: ['small', 'medium'], defaultSize: 'small'},
    {id: 'airplane', name: 'Modo avión', category: 'Conectividad', icon: 'airplane-mode-symbolic', sizes: ['small', 'medium'], defaultSize: 'small'},
    {id: 'focus', name: 'Concentración', category: 'Concentración', icon: 'weather-clear-night-symbolic', sizes: ['small', 'medium'], defaultSize: 'medium'},
    {id: 'dark-mode', name: 'Modo oscuro', category: 'Pantalla', icon: 'dark-mode-symbolic', sizes: ['small', 'medium'], defaultSize: 'small'},
    {id: 'night-light', name: 'Luz nocturna', category: 'Pantalla', icon: 'night-light-symbolic', sizes: ['small', 'medium'], defaultSize: 'small'},
    {id: 'display', name: 'Pantalla', category: 'Pantalla', icon: 'display-brightness-symbolic', sizes: ['wide'], defaultSize: 'wide'},
    {id: 'keyboard-brightness', name: 'Brillo del teclado', category: 'Pantalla', icon: 'keyboard-brightness-high-symbolic', sizes: ['wide'], defaultSize: 'wide'},
    {id: 'sound', name: 'Sonido', category: 'Sonido', icon: 'audio-volume-high-symbolic', sizes: ['wide'], defaultSize: 'wide'},
    {id: 'now-playing', name: 'Reproduciendo', category: 'Utilidades', icon: 'media-playback-start-symbolic', sizes: ['large'], defaultSize: 'large'},
    {id: 'power-profile', name: 'Perfil de energía', category: 'Batería', icon: 'power-profile-balanced-symbolic', sizes: ['small', 'medium'], defaultSize: 'small'},
    {id: 'battery', name: 'Batería', category: 'Batería', icon: 'battery-good-symbolic', sizes: ['small', 'medium'], defaultSize: 'small'},
    {id: 'screenshot', name: 'Captura de pantalla', category: 'Utilidades', icon: 'camera-photo-symbolic', sizes: ['small'], defaultSize: 'small'},
    {id: 'screen-recording', name: 'Grabar pantalla', category: 'Utilidades', icon: 'camera-video-symbolic', sizes: ['small'], defaultSize: 'small'},
    {id: 'lock', name: 'Bloquear', category: 'Utilidades', icon: 'changes-prevent-symbolic', sizes: ['small'], defaultSize: 'small'},
    {id: 'settings', name: 'Ajustes', category: 'Utilidades', icon: 'org.gnome.Settings-symbolic', sizes: ['small'], defaultSize: 'small'},
    {id: 'calculator', name: 'Calculadora', category: 'Utilidades', icon: 'accessories-calculator-symbolic', sizes: ['small', 'medium'], defaultSize: 'small'},
];

const CC_SIZES = ['small', 'medium', 'large', 'wide'];
const CC_SIZE_LABELS = {
    small: 'Pequeño',
    medium: 'Mediano',
    large: 'Grande',
    wide: 'Ancho',
};
const CC_CATEGORY_ORDER = [
    'Conectividad', 'Pantalla', 'Sonido', 'Concentración',
    'Accesibilidad', 'Batería', 'Utilidades', 'Extensiones',
];

const DEFAULT_CLOCK_FORMAT = '%a %e %b  %H:%M';
const IMAGE_MIME_TYPES = [
    'image/svg+xml',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
];
const IMAGE_PATTERNS = ['*.svg', '*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif'];

export default class TahoeTopBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Mantener una referencia viva mientras la ventana exista.
        window._settings = settings;
        window.set_default_size(680, 760);

        window.add(this._buildBarPage(window, settings));
        window.add(this._buildDockPage(window, settings));
        window.add(this._buildControlCenterPage(window, settings));
        window.add(this._buildGlassPage(window, settings));
        window.add(this._buildAboutMacPage(window, settings));
        window.add(this._buildAboutPage(window, settings));
    }

    // ------------------------------------------------------------------
    // Utilidades
    // ------------------------------------------------------------------

    _assetsPath(...parts) {
        const base = this.path ?? this.dir?.get_path() ?? '';
        return GLib.build_filenamev([base, 'assets', ...parts]);
    }

    _fileExists(path) {
        return Boolean(path) && GLib.file_test(path, GLib.FileTest.IS_REGULAR);
    }

    _newLogoImage(path, pixelSize) {
        const image = this._fileExists(path)
            ? Gtk.Image.new_from_file(path)
            : Gtk.Image.new_from_icon_name('image-missing-symbolic');

        image.set_pixel_size(pixelSize);
        return image;
    }

    _setImageFromPath(image, path, pixelSize) {
        if (this._fileExists(path))
            image.set_from_file(path);
        else
            image.set_from_icon_name('image-missing-symbolic');

        image.set_pixel_size(pixelSize);
    }

    _spinRow(settings, key, title, subtitle, lower, upper) {
        const adjustment = new Gtk.Adjustment({
            lower,
            upper,
            step_increment: 1,
            page_increment: 1,
            value: settings.get_int(key),
        });

        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment,
            digits: 0,
        });

        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _switchRow(settings, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _entryRow(settings, key, title, tooltip = null) {
        const row = new Adw.EntryRow({title});
        if (tooltip)
            row.set_tooltip_text(tooltip);
        settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _stringComboRow(settings, key, title, choices, subtitle = null) {
        const model = Gtk.StringList.new(choices.map(choice => _(choice.label)));
        const row = new Adw.ComboRow({title, subtitle, model});

        let syncing = false;

        const syncFromSettings = () => {
            const value = settings.get_string(key);
            let index = choices.findIndex(choice => choice.value === value);
            if (index < 0)
                index = 0;

            syncing = true;
            row.set_selected(index);
            syncing = false;
        };

        row.connect('notify::selected', () => {
            if (syncing)
                return;

            const choice = choices[row.get_selected()];
            if (choice)
                settings.set_string(key, choice.value);
        });

        settings.connect(`changed::${key}`, syncFromSettings);
        syncFromSettings();

        return row;
    }

    _intComboRow(settings, key, title, choices, subtitle = null) {
        const model = Gtk.StringList.new(choices.map(choice => _(choice.label)));
        const row = new Adw.ComboRow({title, subtitle, model});

        let syncing = false;

        const syncFromSettings = () => {
            const value = settings.get_int(key);
            let index = choices.findIndex(choice => choice.value === value);
            if (index < 0)
                index = 0;

            syncing = true;
            row.set_selected(index);
            syncing = false;
        };

        row.connect('notify::selected', () => {
            if (syncing)
                return;

            const choice = choices[row.get_selected()];
            if (choice)
                settings.set_int(key, choice.value);
        });

        settings.connect(`changed::${key}`, syncFromSettings);
        syncFromSettings();

        return row;
    }

    _doubleSpinRow(settings, key, title, subtitle, lower, upper, step, digits = 2) {
        const adjustment = new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 10,
            value: settings.get_double(key),
        });

        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment,
            digits,
        });

        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _openUri(window, uri) {
        const launcher = new Gtk.UriLauncher({uri});
        launcher.launch(window, null, (obj, result) => {
            try {
                obj.launch_finish(result);
            } catch (e) {
                logError(e, 'No se pudo abrir el enlace');
            }
        });
    }

    _glassCreditsRow(window) {
        const row = new Adw.ActionRow({
            title: _('Motor Liquid Glass'),
            subtitle: _('Ryosuke Watanabe (ryohsuke1231) — MIT'),
        });

        const button = new Gtk.Button({
            label: _('Abrir'),
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => this._openUri(window, LIQUID_GLASS_URL));
        row.add_suffix(button);

        return row;
    }

    _makeImageFilter() {
        const filter = new Gtk.FileFilter();
        filter.set_name(_('Imágenes'));

        for (const mimeType of IMAGE_MIME_TYPES)
            filter.add_mime_type(mimeType);

        for (const pattern of IMAGE_PATTERNS)
            filter.add_pattern(pattern);

        return filter;
    }

    async _chooseImage(window, settings, key, dialogTitle) {
        const dialog = new Gtk.FileDialog({
            title: dialogTitle,
            modal: true,
        });

        const filter = this._makeImageFilter();
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
        filters.append(filter);

        dialog.set_filters(filters);
        dialog.set_default_filter(filter);

        try {
            const file = await dialog.open(window, null);
            const path = file?.get_path?.();
            if (path)
                settings.set_string(key, path);
        } catch (e) {
            if (e?.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                return;

            logError(e, 'No se pudo elegir la imagen');
        }
    }

    // ------------------------------------------------------------------
    // Página «Barra»
    // ------------------------------------------------------------------

    _buildBarPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Barra'),
            icon_name: 'preferences-desktop-display-symbolic',
        });

        page.add(this._buildLogoGroup(window, settings));
        page.add(this._buildAppearanceGroup(settings));
        page.add(this._buildApplicationGroup(settings));
        page.add(this._buildClockGroup(settings));

        return page;
    }

    _buildDockPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Dock'),
            icon_name: 'user-desktop-symbolic',
        });
        const general = new Adw.PreferencesGroup({
            title: _('Dock Tahoe'),
            description: _('Reemplaza el dash de GNOME y desactiva Dash to Dock al encenderlo. No lo reactiva automáticamente.'),
        });
        general.add(this._switchRow(settings, 'dock-enabled', _('Activar el dock Tahoe')));
        general.add(this._stringComboRow(settings, 'dock-position', _('Posición'), [
            {value: 'bottom', label: 'Abajo'},
            {value: 'left', label: 'Izquierda'},
            {value: 'right', label: 'Derecha'},
        ]));
        general.add(this._spinRow(settings, 'dock-icon-size', _('Tamaño de los iconos'),
            _('Píxeles'), 16, 96));
        const magAdjustment = new Gtk.Adjustment({
            lower: 1.0, upper: 3.0, step_increment: 0.1,
            page_increment: 0.2, value: settings.get_double('dock-magnification'),
        });
        const magRow = new Adw.SpinRow({
            title: _('Aumento al pasar el ratón'), adjustment: magAdjustment, digits: 1,
        });
        settings.bind('dock-magnification', magRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(magRow);
        general.add(this._switchRow(settings, 'dock-autohide', _('Ocultar automáticamente')));
        general.add(this._spinRow(settings, 'dock-hide-delay', _('Retraso al ocultar'),
            _('Milisegundos'), 0, 10000));
        general.add(this._switchRow(settings, 'dock-glass', _('Liquid Glass en el dock')));
        general.add(this._stringComboRow(settings, 'dock-indicators', _('Indicador de apps abiertas'), [
            {value: 'dots', label: 'Puntos'}, {value: 'lines', label: 'Líneas'},
        ]));
        general.add(this._stringComboRow(settings, 'dock-animation-style',
            _('Minimizar y restaurar ventanas'), [
                {value: 'aladdin', label: 'Aladdin (curva)'},
                {value: 'genie', label: 'Genie (onda)'},
                {value: 'scale', label: 'Escala de GNOME'},
                {value: 'none', label: 'Animación nativa'},
            ]));
        page.add(general);

        const contents = new Adw.PreferencesGroup({title: _('Contenido')});
        for (const [key, title] of [
            ['dock-show-apps', _('Launchpad')],
            ['dock-show-running', _('Aplicaciones en ejecución')],
            ['dock-show-downloads', _('Pila de Descargas')],
            ['dock-show-recent-downloads', _('Archivos recientes en Descargas')],
            ['dock-show-trash', _('Papelera')],
            ['dock-show-mounts', _('Volúmenes montados')],
        ])
            contents.add(this._switchRow(settings, key, title));
        page.add(contents);

        const grid = new Adw.PreferencesGroup({title: _('Icono de Launchpad')});
        const iconRow = new Adw.ActionRow({
            title: _('Imagen personalizada'),
            subtitle: settings.get_string('dock-app-grid-icon-path') || _('Usar el icono incluido'),
        });
        const choose = new Gtk.Button({label: _('Elegir…'), valign: Gtk.Align.CENTER});
        choose.connect('clicked', () => this._chooseImage(window, settings,
            'dock-app-grid-icon-path', _('Elegir icono de Launchpad')));
        iconRow.add_suffix(choose);
        const reset = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER});
        reset.set_tooltip_text(_('Restablecer icono'));
        reset.connect('clicked', () => settings.reset('dock-app-grid-icon-path'));
        iconRow.add_suffix(reset);
        settings.connect('changed::dock-app-grid-icon-path', () => {
            iconRow.set_subtitle(settings.get_string('dock-app-grid-icon-path') ||
                _('Usar el icono incluido'));
        });
        grid.add(iconRow);
        page.add(grid);
        return page;
    }

    _buildLogoGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Logo'),
            description: _('Elige el icono que abre el menú principal de la barra.'),
        });

        const buttons = new Map();
        let syncing = false;

        const chooserBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            homogeneous: true,
        });
        chooserBox.set_margin_top(12);
        chooserBox.set_margin_bottom(12);
        chooserBox.set_margin_start(12);
        chooserBox.set_margin_end(12);

        for (const choice of LOGO_CHOICES) {
            const button = new Gtk.ToggleButton({
                valign: Gtk.Align.CENTER,
                hexpand: true,
            });
            button.add_css_class('flat');
            button.set_tooltip_text(_(choice.tooltip));

            const content = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 6,
            });
            content.set_halign(Gtk.Align.CENTER);

            const initialPath = choice.value === 'custom'
                ? settings.get_string('custom-logo-path')
                : this._assetsPath(choice.asset);
            const image = this._newLogoImage(initialPath, 28);

            const label = new Gtk.Label({
                label: _(choice.label),
                wrap: true,
                justify: Gtk.Justification.CENTER,
                max_width_chars: 14,
                lines: 2,
            });

            content.append(image);
            content.append(label);
            button.set_child(content);

            button.connect('toggled', () => {
                if (syncing)
                    return;

                if (!button.get_active()) {
                    // Impide que un clic sobre el logo ya elegido lo deje
                    // sin selección.
                    if (settings.get_string('logo-type') === choice.value) {
                        syncing = true;
                        button.set_active(true);
                        syncing = false;
                    }
                    return;
                }

                syncing = true;
                for (const [value, entry] of buttons) {
                    if (value !== choice.value)
                        entry.button.set_active(false);
                }
                syncing = false;

                settings.set_string('logo-type', choice.value);
            });

            buttons.set(choice.value, {button, image});
            chooserBox.append(button);
        }

        const chooserRow = new Adw.PreferencesRow();
        chooserRow.set_child(chooserBox);
        group.add(chooserRow);

        const customRow = new Adw.ActionRow({
            title: _('Imagen personalizada'),
        });

        const chooseButton = new Gtk.Button({
            label: _('Elegir…'),
            valign: Gtk.Align.CENTER,
        });
        chooseButton.connect('clicked', () => {
            this._chooseImage(
                window,
                settings,
                'custom-logo-path',
                _('Elegir imagen del logo'));
        });

        const clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Quitar la imagen personalizada'),
        });
        clearButton.add_css_class('flat');
        clearButton.connect('clicked', () => {
            settings.set_string('custom-logo-path', '');
        });

        customRow.add_suffix(chooseButton);
        customRow.add_suffix(clearButton);
        group.add(customRow);

        const currentType = settings.get_string('logo-type');
        const currentChoice = LOGO_CHOICES.find(item => item.value === currentType) ?? LOGO_CHOICES[0];
        const currentPath = currentChoice.value === 'custom'
            ? settings.get_string('custom-logo-path')
            : this._assetsPath(currentChoice.asset);

        const preview = this._newLogoImage(currentPath, 64);
        preview.set_valign(Gtk.Align.CENTER);

        const previewRow = new Adw.ActionRow({
            title: _('Vista previa'),
            subtitle: _('El logo se dibuja con el tamaño elegido en la barra.'),
        });
        previewRow.add_prefix(preview);
        group.add(previewRow);

        const syncButtons = () => {
            const type = settings.get_string('logo-type');
            syncing = true;
            for (const [value, entry] of buttons)
                entry.button.set_active(value === type);
            syncing = false;
        };

        const updateCustomRow = () => {
            const path = settings.get_string('custom-logo-path');
            const isCustom = settings.get_string('logo-type') === 'custom';

            customRow.set_subtitle(path || _('Ninguna imagen seleccionada'));
            customRow.set_tooltip_text(path || null);
            customRow.set_sensitive(isCustom);
            clearButton.set_sensitive(Boolean(path));

            const customEntry = buttons.get('custom');
            if (customEntry)
                this._setImageFromPath(customEntry.image, path, 28);
        };

        const updatePreview = () => {
            const type = settings.get_string('logo-type');
            const choice = LOGO_CHOICES.find(item => item.value === type) ?? LOGO_CHOICES[0];

            const path = choice.value === 'custom'
                ? settings.get_string('custom-logo-path')
                : this._assetsPath(choice.asset);

            this._setImageFromPath(preview, path, 64);

            previewRow.set_subtitle(
                `${_('Tamaño en la barra:')} ${settings.get_int('logo-size')} px`);
        };

        const sizeRow = this._spinRow(
            settings,
            'logo-size',
            _('Tamaño del logo'),
            _('De 10 a 32 píxeles'),
            10,
            32);

        const symbolicRow = this._switchRow(
            settings,
            'logo-symbolic',
            _('Monocromo (usar color del texto)'),
            _('Colorea el logo con el color del texto del panel.'));
        group.add(sizeRow);
        group.add(symbolicRow);

        settings.connect('changed::logo-type', () => {
            syncButtons();
            updateCustomRow();
            updatePreview();
        });
        settings.connect('changed::custom-logo-path', () => {
            updateCustomRow();
            updatePreview();
        });
        settings.connect('changed::logo-size', updatePreview);

        syncButtons();
        updateCustomRow();
        updatePreview();

        return group;
    }

    _buildAppearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Apariencia'),
            description: _('Altura, fondo y tipografía de la barra superior. Vacío en «Familia de fuente» = SF Pro Text / Inter / fuente del sistema.'),
        });

        const heightRow = this._spinRow(
            settings,
            'panel-height',
            _('Altura del panel'),
            _('De 20 a 48 píxeles'),
            20,
            48);

        const styleRow = this._stringComboRow(
            settings,
            'panel-style',
            _('Estilo del panel'),
            PANEL_STYLES,
            _('Transparente es el aspecto de macOS Tahoe.'));

        // GtkRange:value no es escribible en GTK 4; se enlaza el ajuste.
        const opacityAdjustment = new Gtk.Adjustment({
            lower: 0.0,
            upper: 1.0,
            step_increment: 0.05,
            page_increment: 0.1,
            value: settings.get_double('panel-opacity'),
        });
        settings.bind(
            'panel-opacity',
            opacityAdjustment,
            'value',
            Gio.SettingsBindFlags.DEFAULT);

        const opacityScale = new Gtk.Scale({
            adjustment: opacityAdjustment,
            digits: 2,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            hexpand: true,
            width_request: 200,
        });

        const opacityRow = new Adw.ActionRow({
            title: _('Opacidad del fondo'),
            subtitle: _('Sólo se aplica al estilo translúcido.'),
        });
        opacityRow.add_suffix(opacityScale);

        const syncOpacitySensitivity = () => {
            opacityRow.set_sensitive(
                settings.get_string('panel-style') === 'translucent');
        };

        const maximizedRow = this._switchRow(
            settings,
            'solid-when-maximized',
            _('Opaco con ventanas maximizadas'),
            _('Vuelve el fondo sólido cuando una ventana ocupa la parte superior.'));

        const textColorRow = this._stringComboRow(
            settings,
            'text-color',
            _('Color del texto'),
            TEXT_COLORS,
            _('Automático calcula el contraste a partir de la franja superior del fondo de pantalla.'));

        const fontRow = this._entryRow(
            settings,
            'font-family',
            _('Familia de fuente'),
            // Adw.EntryRow no tiene placeholder en libadwaita 1.9: la ayuda
            // se muestra en la descripción del grupo y en el tooltip.
            _('Vacío = SF Pro Text / Inter / fuente del sistema.'));

        const fontSizeRow = this._spinRow(
            settings,
            'font-size',
            _('Tamaño de fuente'),
            _('De 9 a 18 píxeles'),
            9,
            18);

        const hideActivitiesRow = this._switchRow(
            settings,
            'hide-activities',
            _('Ocultar Actividades'),
            _('Quita el botón «Actividades» de la barra.'));

        const syncThemeRow = this._switchRow(
            settings,
            'sync-shell-theme',
            _('Sincronizar tema de shell y GTK con el modo claro/oscuro'),
            _('Usa MacTahoe-Light / MacTahoe-Dark (conserva sufijos como -solid o -hdpi).'));

        group.add(heightRow);
        group.add(styleRow);
        group.add(opacityRow);
        group.add(maximizedRow);
        group.add(textColorRow);
        group.add(fontRow);
        group.add(fontSizeRow);
        group.add(hideActivitiesRow);
        group.add(syncThemeRow);

        settings.connect('changed::panel-style', syncOpacitySensitivity);
        syncOpacitySensitivity();

        return group;
    }

    _buildApplicationGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Aplicación'),
            description: _('Contenido mostrado junto al menú de la aplicación activa.'),
        });

        group.add(this._switchRow(
            settings,
            'show-app-name',
            _('Mostrar nombre de la aplicación'),
            _('Muestra en negrita el nombre de la app activa.')));

        group.add(this._switchRow(
            settings,
            'show-fake-menus',
            _('Mostrar barra de menús'),
            _('Archivo, Edición, Visualización… adaptados a cada aplicación.')));

        group.add(this._switchRow(
            settings,
            'menu-use-app-actions',
            _('Leer acciones reales de las apps'),
            _('Consulta por D-Bus las acciones que exporta cada app (Acerca de, Ajustes, Nueva ventana…).')));

        group.add(this._entryRow(
            settings,
            'desktop-app-name',
            _('Nombre en el escritorio'),
            _('Nombre mostrado cuando no hay ninguna ventana activa. Por defecto «Finder», como en macOS; las acciones siguen abriendo Nautilus.')));

        return group;
    }

    _buildControlCenterPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Centro de control'),
            icon_name: 'preferences-system-symbolic',
        });

        page.add(this._buildControlCenterGroup(settings));
        page.add(this._buildControlCenterLayoutGroup(settings, window));
        page.add(this._buildMenubarControlsGroup(settings, window));
        page.add(this._buildControlCenterResetGroup(window, settings));

        return page;
    }

    _buildControlCenterGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Centro de control'),
            description: _('Reemplaza los Ajustes rápidos de GNOME. Atajo: Super+S.'),
        });

        group.add(this._switchRow(
            settings,
            'control-center-enabled',
            _('Usar Centro de control estilo Tahoe'),
            _('Wi-Fi, Bluetooth, brillo, sonido y reproducción en un panel Liquid Glass.')));

        const battery = this._switchRow(
            settings,
            'control-center-show-battery-percent',
            _('Porcentaje de batería en la barra'));
        const media = this._switchRow(
            settings,
            'control-center-show-now-playing',
            _('Mostrar «Reproduciendo»'),
            _('Controles del reproductor multimedia activo (MPRIS).'));
        const notifications = this._switchRow(
            settings,
            'control-center-notifications',
            _('Notificaciones en el Centro de control'),
            _('Pila de notificaciones bajo el CC y banners Liquid Glass arriba a la derecha.'));
        group.add(battery);
        group.add(media);
        group.add(notifications);

        for (const row of [battery, media, notifications]) {
            settings.bind('control-center-enabled', row, 'sensitive',
                Gio.SettingsBindFlags.GET);
        }

        return group;
    }

    // ------------------------------------------------------------------
    // Editor accesible: layouts y barra
    // ------------------------------------------------------------------

    _parseJSONList(raw) {
        try {
            const value = JSON.parse(raw);
            return Array.isArray(value) ? value : [];
        } catch (_e) {
            return [];
        }
    }

    _catalog(settings) {
        const list = this._parseJSONList(
            settings.get_string('control-center-catalog'));
        const catalog = list.length > 0 ? list : BUILTIN_CATALOG;
        const byId = new Map();

        for (const entry of catalog) {
            if (entry?.id)
                byId.set(entry.id, entry);
        }
        for (const entry of BUILTIN_CATALOG) {
            if (!byId.has(entry.id))
                byId.set(entry.id, entry);
        }

        return {catalog: [...byId.values()], byId};
    }

    _controlImage(icon, size = 22) {
        const value = String(icon ?? '');
        const image = (value.includes('/') || value.startsWith('file:'))
            ? Gtk.Image.new_from_file(value.replace(/^file:\/\//, ''))
            : Gtk.Image.new_from_icon_name(value || 'application-x-addon-symbolic');
        image.set_pixel_size(size);
        return image;
    }

    _readLayout(settings) {
        const list = this._parseJSONList(
            settings.get_string('control-center-layout'));
        if (list.length === 0)
            return DEFAULT_CC_LAYOUT.map(entry => ({...entry}));
        return list;
    }

    _readMenubar(settings) {
        const list = this._parseJSONList(
            settings.get_string('menubar-controls'));
        return list.length > 0 ? list : [...DEFAULT_MENUBAR_CONTROLS];
    }

    _saveLayout(settings, list) {
        settings.set_string('control-center-layout',
            JSON.stringify(list));
    }

    _saveMenubar(settings, list) {
        settings.set_string('menubar-controls', JSON.stringify(list));
    }

    _buildControlCenterLayoutGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: _('Controles del Centro de control'),
            description: _('El orden de la lista es el orden de la rejilla (first fit, 4 columnas).'),
        });

        let rows = [];

        const rebuild = () => {
            for (const row of rows) {
                try {
                    group.remove(row);
                } catch (_e) {
                    // Fila ya eliminada.
                }
            }
            rows = [];

            const {byId} = this._catalog(settings);
            const layout = this._readLayout(settings);

            layout.forEach((entry, index) => {
                const meta = byId.get(entry.id) ?? {
                    id: entry.id,
                    name: entry.id,
                    category: '',
                    icon: 'application-x-addon-symbolic',
                    sizes: ['small'],
                };

                const row = new Adw.ActionRow({
                    title: meta.name,
                    subtitle: meta.category || entry.id,
                });
                row.add_prefix(this._controlImage(meta.icon));

                const sizes = (meta.sizes?.length ? meta.sizes : ['small'])
                    .filter(size => CC_SIZES.includes(size));
                const sizeModel = Gtk.DropDown.new_from_strings(
                    sizes.map(size => _(CC_SIZE_LABELS[size] ?? size)));
                sizeModel.set_valign(Gtk.Align.CENTER);
                let sizeIndex = sizes.indexOf(entry.size);
                if (sizeIndex < 0)
                    sizeIndex = sizes.indexOf(meta.defaultSize);
                if (sizeIndex < 0)
                    sizeIndex = 0;
                sizeModel.set_selected(sizeIndex);
                sizeModel.connect('notify::selected', () => {
                    const size = sizes[sizeModel.get_selected()];
                    if (!size || size === entry.size)
                        return;
                    const current = this._readLayout(settings);
                    const target = current.find(item => item.id === entry.id);
                    if (!target)
                        return;
                    target.size = size;
                    this._saveLayout(settings, current);
                });
                row.add_suffix(sizeModel);

                const up = new Gtk.Button({
                    icon_name: 'go-up-symbolic',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                    sensitive: index > 0,
                    tooltip_text: _('Subir'),
                });
                up.connect('clicked', () => {
                    const current = this._readLayout(settings);
                    if (index <= 0)
                        return;
                    [current[index - 1], current[index]] =
                        [current[index], current[index - 1]];
                    this._saveLayout(settings, current);
                });
                row.add_suffix(up);

                const down = new Gtk.Button({
                    icon_name: 'go-down-symbolic',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                    sensitive: index < layout.length - 1,
                    tooltip_text: _('Bajar'),
                });
                down.connect('clicked', () => {
                    const current = this._readLayout(settings);
                    if (index >= current.length - 1)
                        return;
                    [current[index], current[index + 1]] =
                        [current[index + 1], current[index]];
                    this._saveLayout(settings, current);
                });
                row.add_suffix(down);

                const remove = new Gtk.Button({
                    icon_name: 'window-close-symbolic',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Quitar'),
                });
                remove.connect('clicked', () => {
                    const current = this._readLayout(settings)
                        .filter(item => item.id !== entry.id);
                    this._saveLayout(settings, current);
                });
                row.add_suffix(remove);

                rows.push(row);
                group.add(row);
            });

            const add = new Adw.ActionRow({
                title: _('Añadir control'),
                subtitle: _('Añade un control integrado o de otra extensión.'),
            });
            const addButton = new Gtk.Button({
                label: _('Añadir'),
                css_classes: ['suggested-action'],
                valign: Gtk.Align.CENTER,
            });
            addButton.connect('clicked', () => {
                const current = this._readLayout(settings);
                this._openAddDialog(window, settings, 'control-center-layout',
                    current.map(entry => entry.id), id => {
                        const {byId} = this._catalog(settings);
                        const meta = byId.get(id);
                        if (!meta)
                            return;
                        const size = meta.sizes?.includes(meta.defaultSize)
                            ? meta.defaultSize
                            : (meta.sizes?.[0] ?? 'small');
                        current.push({id, size});
                        this._saveLayout(settings, current);
                    });
            });
            add.add_suffix(addButton);
            rows.push(add);
            group.add(add);
        };

        const changeIds = [];
        for (const key of ['control-center-layout', 'control-center-catalog']) {
            changeIds.push(settings.connect(`changed::${key}`, rebuild));
        }
        group.connect('destroy', () => {
            for (const id of changeIds) {
                try {
                    settings.disconnect(id);
                } catch (_e) {
                    // Ya desconectado.
                }
            }
        });

        rebuild();
        return group;
    }

    _buildMenubarControlsGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: _('Barra de menús'),
            description: _('Iconos a la izquierda del Centro de control. Orden de izquierda a derecha.'),
        });

        let rows = [];

        const rebuild = () => {
            for (const row of rows) {
                try {
                    group.remove(row);
                } catch (_e) {
                    // Fila ya eliminada.
                }
            }
            rows = [];

            const {byId} = this._catalog(settings);
            const list = this._readMenubar(settings);

            list.forEach((id, index) => {
                const meta = byId.get(id) ?? {
                    id,
                    name: id,
                    category: '',
                    icon: 'application-x-addon-symbolic',
                };
                const row = new Adw.ActionRow({
                    title: meta.name,
                    subtitle: meta.category || id,
                });
                row.add_prefix(this._controlImage(meta.icon));

                const up = new Gtk.Button({
                    icon_name: 'go-up-symbolic',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                    sensitive: index > 0,
                    tooltip_text: _('Mover a la izquierda'),
                });
                up.connect('clicked', () => {
                    const current = this._readMenubar(settings);
                    if (index <= 0)
                        return;
                    [current[index - 1], current[index]] =
                        [current[index], current[index - 1]];
                    this._saveMenubar(settings, current);
                });
                row.add_suffix(up);

                const down = new Gtk.Button({
                    icon_name: 'go-down-symbolic',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                    sensitive: index < list.length - 1,
                    tooltip_text: _('Mover a la derecha'),
                });
                down.connect('clicked', () => {
                    const current = this._readMenubar(settings);
                    if (index >= current.length - 1)
                        return;
                    [current[index], current[index + 1]] =
                        [current[index + 1], current[index]];
                    this._saveMenubar(settings, current);
                });
                row.add_suffix(down);

                const remove = new Gtk.Button({
                    icon_name: 'window-close-symbolic',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Quitar de la barra'),
                });
                remove.connect('clicked', () => {
                    this._saveMenubar(settings,
                        this._readMenubar(settings).filter(item => item !== id));
                });
                row.add_suffix(remove);

                rows.push(row);
                group.add(row);
            });

            const add = new Adw.ActionRow({
                title: _('Añadir a la barra'),
                subtitle: _('Muestra el icono de un control en la barra superior.'),
            });
            const addButton = new Gtk.Button({
                label: _('Añadir'),
                css_classes: ['suggested-action'],
                valign: Gtk.Align.CENTER,
            });
            addButton.connect('clicked', () => {
                const current = this._readMenubar(settings);
                this._openAddDialog(window, settings, 'menubar-controls',
                    current, id => {
                        current.push(id);
                        this._saveMenubar(settings, current);
                    });
            });
            add.add_suffix(addButton);
            rows.push(add);
            group.add(add);
        };

        const changeIds = [];
        for (const key of ['menubar-controls', 'control-center-catalog']) {
            changeIds.push(settings.connect(`changed::${key}`, rebuild));
        }
        group.connect('destroy', () => {
            for (const id of changeIds) {
                try {
                    settings.disconnect(id);
                } catch (_e) {
                    // Ya desconectado.
                }
            }
        });

        rebuild();
        return group;
    }

    _openAddDialog(window, settings, key, current, onPick) {
        const {catalog} = this._catalog(settings);
        const dialog = new Adw.Dialog({
            title: _('Añadir control'),
            content_width: 420,
            content_height: 540,
        });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        toolbar.add_top_bar(header);

        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vexpand: true,
        });
        const page = new Adw.PreferencesPage();

        const grouped = new Map();
        for (const entry of catalog) {
            if (!grouped.has(entry.category))
                grouped.set(entry.category, []);
            grouped.get(entry.category).push(entry);
        }

        const categories = [
            ...CC_CATEGORY_ORDER.filter(category => grouped.has(category)),
            ...[...grouped.keys()].filter(category =>
                !CC_CATEGORY_ORDER.includes(category)),
        ];

        for (const category of categories) {
            const group = new Adw.PreferencesGroup({title: _(category)});
            for (const entry of grouped.get(category)) {
                const row = new Adw.ActionRow({
                    title: entry.name,
                    subtitle: entry.id,
                    activatable: !current.includes(entry.id),
                });
                row.add_prefix(this._controlImage(entry.icon));
                if (current.includes(entry.id)) {
                    row.add_suffix(new Gtk.Image({
                        icon_name: 'object-select-symbolic',
                        pixel_size: 16,
                    }));
                } else {
                    row.connect('activated', () => {
                        onPick(entry.id);
                        dialog.close();
                    });
                }
                group.add(row);
            }
            page.add(group);
        }

        scroll.set_child(page);
        toolbar.set_content(scroll);
        dialog.set_child(toolbar);
        dialog.present(window);
    }

    _buildControlCenterResetGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Restablecer'),
            description: _('Vuelve a la distribución de macOS Tahoe.'),
        });

        const row = new Adw.ActionRow({
            title: _('Restablecer diseño'),
            subtitle: _('Rejilla del Centro de control y controles de la barra.'),
        });
        const button = new Gtk.Button({
            label: _('Restablecer'),
            css_classes: ['destructive-action'],
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', async () => {
            const dialog = new Adw.AlertDialog({
                heading: _('¿Restablecer el diseño de Tahoe?'),
                body: _('Se restauran la rejilla del Centro de control y los iconos de la barra.'),
            });
            dialog.add_response('cancel', _('Cancelar'));
            dialog.add_response('reset', _('Restablecer'));
            dialog.set_response_appearance('reset',
                Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');

            try {
                const response = await dialog.choose(window, null);
                if (response !== 'reset')
                    return;
                this._saveLayout(settings, DEFAULT_CC_LAYOUT);
                this._saveMenubar(settings, DEFAULT_MENUBAR_CONTROLS);
            } catch (e) {
                if (e?.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    return;
                logError(e, 'No se pudo restablecer el diseño');
            }
        });
        row.add_suffix(button);
        group.add(row);
        return group;
    }

    _buildClockGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Reloj'),
            description: _('Códigos: %a día, %e día del mes, %b mes, %H:%M hora.'),
        });

        group.add(this._switchRow(
            settings,
            'move-clock-right',
            _('Mover el reloj a la derecha'),
            _('Coloca el reloj en el extremo derecho de la barra.')));

        const clockRow = this._entryRow(
            settings,
            'clock-format',
            _('Formato del reloj'),
            _('Ejemplo: %a %e %b %H:%M. Vacío = formato de GNOME.'));
        group.add(clockRow);

        const previewRow = new Adw.ActionRow({
            title: _('Vista previa'),
        });
        group.add(previewRow);

        const updateClockPreview = () => {
            const format = settings.get_string('clock-format').trim() ||
                DEFAULT_CLOCK_FORMAT;

            let text = null;
            try {
                text = GLib.DateTime.new_now_local().format(format);
            } catch (e) {
                text = null;
            }

            previewRow.set_subtitle(text ?? _('Formato no válido'));
        };

        settings.connect('changed::clock-format', updateClockPreview);
        updateClockPreview();

        return group;
    }

    // ------------------------------------------------------------------
    // Página «Cristal»
    // ------------------------------------------------------------------

    _buildGlassPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Cristal'),
            icon_name: 'weather-clear-symbolic',
        });

        const styleGroup = new Adw.PreferencesGroup({
            title: _('Material'),
            description: _('Liquid Glass usa el motor con refracción; el desenfoque simple usa el efecto de GNOME Shell; sin efecto deja sólo el fondo translúcido.'),
        });

        styleGroup.add(this._stringComboRow(
            settings,
            'glass-style',
            _('Estilo del cristal'),
            GLASS_STYLES,
            _('Se aplica al Centro de control, los menús y la ventana Acerca de.')));

        styleGroup.add(this._stringComboRow(
            settings,
            'panel-glass',
            _('Cristal de la barra superior'),
            PANEL_GLASS,
            _('Sólo con Liquid Glass: píldora flotante o islas detrás de los grupos de botones.')));

        page.add(styleGroup);

        const tuning = new Adw.PreferencesGroup({
            title: _('Ajustes de Liquid Glass'),
            description: _('Sólo se aplican al estilo Liquid Glass. Los cambios se ven en vivo.'),
        });

        tuning.add(this._doubleSpinRow(
            settings,
            'glass-displacement-scale',
            _('Refracción'),
            _('Fuerza de la distorsión del fondo. En Tahoe es sutil.'),
            0, 30, 0.5, 1));

        tuning.add(this._doubleSpinRow(
            settings,
            'glass-rim-intensity',
            _('Brillo del borde'),
            _('Intensidad de la luz del borde iluminado.'),
            0, 2, 0.05, 2));

        tuning.add(this._doubleSpinRow(
            settings,
            'glass-rim-width',
            _('Grosor del borde'),
            _('Ancho de la banda de luz junto al borde.'),
            0, 8, 0.1, 1));

        tuning.add(this._doubleSpinRow(
            settings,
            'glass-chroma-strength',
            _('Aberración cromática'),
            _('Separación de colores en la refracción (0 = sin separación).'),
            0, 1, 0.05, 2));

        tuning.add(this._doubleSpinRow(
            settings,
            'glass-light-angle-deg',
            _('Ángulo de la luz'),
            _('Dirección de la fuente de luz virtual, en grados.'),
            0, 360, 5, 0));

        tuning.add(this._doubleSpinRow(
            settings,
            'shadow-intensity',
            _('Sombra'),
            _('Oscuridad de la sombra bajo el cristal (0 = sin sombra).'),
            0, 1, 0.01, 2));

        tuning.add(this._intComboRow(
            settings,
            'blur-method',
            _('Método de desenfoque'),
            BLUR_METHODS));

        tuning.add(this._intComboRow(
            settings,
            'glass-blur-downscale',
            _('Calidad del desenfoque'),
            BLUR_DOWNSCALE));

        const resetRow = new Adw.ActionRow({
            title: _('Restablecer valores de cristal'),
            subtitle: _('Vuelve a los valores del motor; no cambia el estilo elegido.'),
        });
        const resetButton = new Gtk.Button({
            label: _('Restablecer'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            for (const key of GLASS_TUNING_KEYS)
                settings.reset(key);
        });
        resetRow.add_suffix(resetButton);
        tuning.add(resetRow);

        const syncTuning = () => {
            tuning.set_sensitive(
                settings.get_string('glass-style') === 'liquid');
        };
        settings.connect('changed::glass-style', syncTuning);
        syncTuning();

        page.add(tuning);

        const credits = new Adw.PreferencesGroup({title: _('Créditos')});
        credits.add(this._glassCreditsRow(window));
        page.add(credits);

        return page;
    }

    // ------------------------------------------------------------------
    // Página «Acerca de este Mac»
    // ------------------------------------------------------------------

    _buildAboutMacPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Acerca de este Mac'),
            icon_name: 'computer-symbolic',
        });

        const defaultImage = this._assetsPath('about-default.svg');

        const imageGroup = new Adw.PreferencesGroup({
            title: _('Imagen'),
            description: _('Imagen que aparece en la ventana «Acerca de este Mac».'),
        });

        const picture = new Gtk.Picture({
            content_fit: Gtk.ContentFit.CONTAIN,
            can_shrink: true,
        });
        picture.set_size_request(200, 140);

        const fallback = Gtk.Image.new_from_icon_name('image-x-generic-symbolic');
        fallback.set_pixel_size(96);
        fallback.add_css_class('dim-label');

        const stack = new Gtk.Stack();
        stack.set_size_request(200, 140);
        stack.add_named(picture, 'picture');
        stack.add_named(fallback, 'fallback');

        const chooseButton = new Gtk.Button({
            label: _('Elegir imagen…'),
            valign: Gtk.Align.CENTER,
        });
        chooseButton.connect('clicked', () => {
            this._chooseImage(
                window,
                settings,
                'about-image-path',
                _('Elegir imagen de «Acerca de este Mac»'));
        });

        const resetButton = new Gtk.Button({
            label: _('Restablecer'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            settings.set_string('about-image-path', '');
        });

        const imageBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
        });
        imageBox.set_margin_top(18);
        imageBox.set_margin_bottom(18);
        imageBox.set_margin_start(12);
        imageBox.set_margin_end(12);

        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
        });
        buttonBox.append(chooseButton);
        buttonBox.append(resetButton);

        imageBox.append(stack);
        imageBox.append(buttonBox);

        const imageRow = new Adw.PreferencesRow();
        imageRow.set_child(imageBox);
        imageGroup.add(imageRow);

        const updateImage = () => {
            const customPath = settings.get_string('about-image-path');
            const path = customPath || defaultImage;

            if (this._fileExists(path)) {
                try {
                    picture.set_filename(path);
                    stack.set_visible_child_name('picture');
                } catch (e) {
                    logError(e, 'No se pudo cargar la imagen de «Acerca de este Mac»');
                    stack.set_visible_child_name('fallback');
                }
            } else {
                stack.set_visible_child_name('fallback');
            }

            resetButton.set_sensitive(Boolean(customPath));
        };

        settings.connect('changed::about-image-path', updateImage);
        updateImage();

        page.add(imageGroup);

        const textGroup = new Adw.PreferencesGroup({
            title: _('Textos'),
            description: _('Deja vacío para detectar automáticamente.'),
        });

        for (const field of ABOUT_TEXT_FIELDS) {
            const row = new Adw.EntryRow({
                title: _(field.title),
            });
            row.set_tooltip_text(_(field.hint));
            settings.bind(field.key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
            textGroup.add(row);
        }

        page.add(textGroup);

        return page;
    }

    // ------------------------------------------------------------------
    // Página «Acerca de»
    // ------------------------------------------------------------------

    _buildAboutPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Acerca de'),
            icon_name: 'help-about-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: this.metadata.name,
            description: this.metadata.description,
        });

        const versionRow = new Adw.ActionRow({
            title: _('Versión'),
            subtitle: String(this.metadata.version),
        });
        group.add(versionRow);

        const resetRow = new Adw.ActionRow({
            title: _('Restablecer todos los ajustes'),
            subtitle: _('Vuelve a los valores predeterminados de la extensión.'),
        });

        const resetButton = new Gtk.Button({
            label: _('Restablecer…'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('destructive-action');
        resetButton.connect('clicked', () => {
            this._confirmReset(window, settings);
        });

        resetRow.add_suffix(resetButton);
        group.add(resetRow);

        page.add(group);

        const creditsGroup = new Adw.PreferencesGroup({title: _('Créditos')});
        creditsGroup.add(this._glassCreditsRow(window));
        page.add(creditsGroup);

        return page;
    }

    async _confirmReset(window, settings) {
        const dialog = new Adw.AlertDialog({
            heading: _('¿Restablecer todos los ajustes?'),
            body: _('Se perderán todos los cambios de la barra, el logo y la ventana «Acerca de este Mac».'),
        });

        dialog.add_response('cancel', _('Cancelar'));
        dialog.add_response('reset', _('Restablecer'));
        dialog.set_response_appearance(
            'reset',
            Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        try {
            const response = await dialog.choose(window, null);
            if (response !== 'reset')
                return;

            for (const key of settings.settings_schema.list_keys())
                settings.reset(key);
        } catch (e) {
            if (e?.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                return;

            logError(e, 'No se pudieron restablecer los ajustes');
        }
    }
}
