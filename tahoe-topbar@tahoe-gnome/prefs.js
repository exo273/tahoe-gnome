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
        page.add(this._buildControlCenterGroup(settings));
        page.add(this._buildClockGroup(settings));

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
            _('Nombre mostrado cuando no hay ninguna ventana activa (como «Finder» en macOS).')));

        return group;
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
        const sound = this._switchRow(
            settings,
            'control-center-show-sound-icon',
            _('Icono de sonido en la barra'),
            _('Volumen y selección de salida con un clic; la rueda cambia el volumen.'));
        const blur = this._switchRow(
            settings,
            'control-center-blur',
            _('Desenfoque Liquid Glass'),
            _('Desenfoca el fondo detrás de los módulos. Desactívalo si notas lentitud.'));
        group.add(battery);
        group.add(sound);
        group.add(media);
        group.add(blur);

        for (const row of [battery, sound, media, blur]) {
            settings.bind('control-center-enabled', row, 'sensitive',
                Gio.SettingsBindFlags.GET);
        }

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
