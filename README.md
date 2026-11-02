# Tahoe GNOME

Extensiones de GNOME Shell que replican el aspecto de **macOS Tahoe (26)** en GNOME 48–50.
Probado en Fedora 44 con GNOME 50.6 (Wayland).

## Tahoe Top Bar (`tahoe-topbar@tahoe-gnome`)

- **Barra superior** transparente estilo Tahoe; el color del texto se adapta al fondo de pantalla.
- **Menú de manzana** con logo configurable (manzana, contorno, Fedora, GNOME o imagen propia), iconos y atajos.
- **Barra de menús dinámica**: en el escritorio muestra los menús tipo Finder (Archivos, Archivo, Edición, Visualización, Ir, Ventana, Ayuda); con una app activa, lee sus acciones reales por D-Bus (`org.gtk.Actions` / `org.gtk.Menus`), usa perfiles para apps comunes o menús genéricos.
- **Centro de control** Liquid Glass (sustituye los Ajustes rápidos, Super+S): Wi‑Fi, Bluetooth, modo avión, Concentración, modo oscuro, luz nocturna, brillo, sonido, reproducción MPRIS, perfil de energía… con desenfoque de fondo. Los controles se pueden añadir, quitar, cambiar de tamaño y ordenar con **Editar controles**; también admite botones de otras extensiones como Caffeine.
- **Notificaciones**: banners Liquid Glass arriba a la derecha con el panel cerrado; al abrirlo aparecen debajo, agrupadas por aplicación. Se pueden borrar deslizando, con la X individual o con **Borrar todo**. El reloj muestra la hora sin abrir el calendario de GNOME.
- **Dock Tahoe integrado**: reemplaza Dash to Dock (lo desactiva al encender el dock Tahoe) y oculta el dash nativo de GNOME mientras esté activo; apps favoritas y abiertas, aumento de iconos al pasar el ratón, Liquid Glass, minimización Aladdin/Genie, Launchpad con icono personalizable, pila de Descargas y Papelera. Configurable en **Preferencias → Dock**.
- **Cristal Liquid Glass** con refracción real en el Centro de control, los menús, la barra superior (píldora o islas), el dock, las notificaciones y la ventana «Acerca de»; un material común de blur corto, tinte blanco sutil y borde iluminado mantiene el mismo aspecto en todas las superficies. Se elige en Preferencias → Cristal (Liquid Glass, desenfoque simple o sin efecto).
- **Indicadores** de batería, sonido y Wi‑Fi con menús propios.
- **Acerca de este Mac** con imagen personalizable y datos del equipo autodetectados.
- **Modo claro/oscuro** automático y color de acento de GNOME; sincronización opcional de los temas MacTahoe-Light/Dark.

## Instalación

```bash
git clone https://github.com/exo273/tahoe-gnome.git
cd tahoe-gnome
glib-compile-schemas tahoe-topbar@tahoe-gnome/schemas/
ln -s "$PWD/tahoe-topbar@tahoe-gnome" ~/.local/share/gnome-shell/extensions/
```

Cierra sesión y vuelve a entrar (Wayland), luego:

```bash
gnome-extensions enable tahoe-topbar@tahoe-gnome
gnome-extensions prefs tahoe-topbar@tahoe-gnome
```

Para el aspecto completo se recomiendan los temas [MacTahoe](https://github.com/vinceliuice/MacTahoe-gtk-theme).

### Instalación opcional del tema MacTahoe (GTK/Shell)

El tema **no está incluido** en este repositorio y **no es obligatorio** para usar la extensión. Si quieres el aspecto completo, `scripts/install-mactahoe-theme.sh` descarga el tema oficial [MacTahoe GTK Theme](https://github.com/vinceliuice/MacTahoe-gtk-theme) en `${XDG_CACHE_HOME:-~/.cache}/tahoe-gnome/mactahoe-gtk-theme`, ejecuta su instalador para el usuario actual y comprueba el resultado en `~/.themes`.

Requisitos: `git`, `sassc`, `glib-compile-resources` y `xmllint`. Por ejemplo:

```bash
# Fedora
sudo dnf install git sassc glib2-devel libxml2

# Debian/Ubuntu
sudo apt install git sassc libglib2.0-dev-bin libxml2-utils
```

```bash
bash scripts/install-mactahoe-theme.sh          # instala y verifica
bash scripts/install-mactahoe-theme.sh --apply  # además lo aplica al escritorio
```

El script muestra el comando del instalador upstream antes de ejecutarlo, no usa `sudo`, no escribe en `/usr/share` y no sobrescribe el `gresource` global de GNOME Shell. Verifica que existan `~/.themes/MacTahoe-Light` y `~/.themes/MacTahoe-Dark`. El instalador upstream también deja un pequeño lanzador `gnome-theme-switcher` en `~/.local`.

Con `--apply`, el script lee `org.gnome.desktop.interface color-scheme` y establece `gtk-theme` a `MacTahoe-Dark` o `MacTahoe-Light`. Si el esquema de **User Themes** está disponible, ajusta su clave `name`; nunca activa esa extensión automáticamente. Si tienes activada la sincronización de la extensión (`sync-shell-theme`), ésta seguirá cambiando entre `MacTahoe-Light` y `MacTahoe-Dark` al cambiar el modo claro/oscuro; `--apply` sólo hace la aplicación inicial.

#### GTK4 y libadwaita

La opción `--libadwaita` se acepta pero **no se implementa a propósito**. El instalador upstream con `-l` escribe directamente en `~/.config/gtk-4.0` (`gtk.css`, `gtk-dark.css`, `assets`, `windows-assets`…), sobrescribe la configuración GTK4 del usuario y deja un tema fijo que no se puede alternar entre claro y oscuro. Si aun así quieres usarlo, hazlo manualmente y con copia de seguridad:

```bash
backup="$HOME/.config/gtk-4.0.backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$HOME/.config/gtk-4.0" "$backup"
cd /ruta/al/clon/MacTahoe-gtk-theme
./install.sh -l -c light   # o -c dark
```

Para restaurar: `rm -rf "$HOME/.config/gtk-4.0" && mv "$backup" "$HOME/.config/gtk-4.0"`. La sincronización de tahoe-gnome sólo cambia el enlace `~/.config/gtk-4.0/gtk.css` entre las variantes instaladas; no instala ni sobrescribe libadwaita por su cuenta.

### Cristal selectivo en Nautilus (opcional)

Con MacTahoe GTK4 instalado, puedes conservar **texto e iconos completamente opacos** en Archivos y ver el cristal únicamente detrás de su barra lateral y cabecera. El script añade una capa CSS encima del tema original sin editar `gtk-Dark.css` ni `gtk-Light.css`; hace copia de seguridad de los enlaces que modifica.

```bash
scripts/nautilus-glass.sh install --mode auto
scripts/nautilus-glass.sh status
# Para revertir: scripts/nautilus-glass.sh remove
```

Después, en **Preferencias → Ventanas**, deja activado el cristal sólo para Nautilus, desactiva «Aplicar a todas las ventanas», ajusta **Opacidad del contenido** a `1.0` y **Radio del desenfoque** a `10`. Cierra Nautilus y vuelve a abrirlo (`nautilus -q`) para que GTK4 cargue el nuevo CSS. Si tienes activada la sincronización de temas, el modo claro/oscuro alterna entre los wrappers `gtk-Light-Tahoe.css` y `gtk-Dark-Tahoe.css`.

El CSS se limita a Nautilus; otras apps mantienen MacTahoe sin esta variante. Una reinstalación de MacTahoe puede borrar los wrappers: `status` lo detecta y puedes repetir `install`. Es una integración GTK4 de usuario, no una inyección CSS del compositor.

### Elegir el cristal

En **Preferencias → Cristal**:

- **Estilo del cristal**: `Liquid Glass` (motor con refracción, tinte blanco suave, reflejos especulares discretos y borde iluminado), `Desenfoque simple` (el `Shell.BlurEffect` de GNOME) o `Sin efecto` (sólo el fondo translúcido del CSS).
- **Cristal de la barra superior**: `Desactivado` (Tahoe transparente), `Píldora` (toda la barra como una píldora flotante) o `Islas` (una píldora por grupo de botones). Sólo se aplica con Liquid Glass.
- Los ajustes del motor (refracción, borde, aberración, luz, sombra, método y calidad del desenfoque) se aplican en vivo. El botón **Restablecer valores de cristal** vuelve a los valores originales.

Con una ventana maximizada y «Opaco con ventanas maximizadas» activo, la barra vuelve al fondo sólido y el cristal del panel se apaga; es el comportamiento pedido para ese caso.

## Créditos

- **Tema MacTahoe GTK/Shell** (opcional, no incluido en este repositorio): [Vince Liuice (vinceliuice)](https://github.com/vinceliuice/MacTahoe-gtk-theme), basado en [WhiteSur GTK Theme](https://github.com/vinceliuice/WhiteSur-gtk-theme). Licencia MIT, Copyright (c) 2021 WhiteSur Developers; el texto completo está en el [`COPYING`](https://github.com/vinceliuice/MacTahoe-gtk-theme/blob/main/COPYING) del upstream. `scripts/install-mactahoe-theme.sh` sólo lo descarga e instala localmente.
- **Motor de cristal Liquid Glass**: [Ryosuke Watanabe (ryohsuke1231)](https://github.com/ryohsuke1231/liquid-glass), licencia MIT.
  Copiado en `tahoe-topbar@tahoe-gnome/vendor/liquid-glass/` desde el commit `a3fb66f`; su `LICENSE` MIT se incluye íntegro en esa carpeta y las cabeceras originales se conservan. Los cambios locales están documentados en `vendor/liquid-glass/README.md`.

## Licencia

GPL-2.0-or-later. El proyecto incluye código MIT de terceros en `vendor/liquid-glass/`, compatible con la GPL. El tema MacTahoe GTK/Shell no forma parte de este repositorio ni de su licencia: se instala opcionalmente desde el upstream, con su propia licencia MIT. Apple, macOS y el logo de Apple son marcas de Apple Inc.; este proyecto no está afiliado a Apple.
