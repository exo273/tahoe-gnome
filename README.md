# Tahoe GNOME

Extensiones de GNOME Shell que replican el aspecto de **macOS Tahoe (26)** en GNOME 48–50.
Probado en Fedora 44 con GNOME 50.6 (Wayland).

## Tahoe Top Bar (`tahoe-topbar@tahoe-gnome`)

- **Barra superior** transparente estilo Tahoe; el color del texto se adapta al fondo de pantalla.
- **Menú de manzana** con logo configurable (manzana, contorno, Fedora, GNOME o imagen propia), iconos y atajos.
- **Barra de menús dinámica**: en el escritorio muestra los menús tipo Finder (Archivos, Archivo, Edición, Visualización, Ir, Ventana, Ayuda); con una app activa, lee sus acciones reales por D-Bus (`org.gtk.Actions` / `org.gtk.Menus`), usa perfiles para apps comunes o menús genéricos.
- **Centro de control** Liquid Glass (sustituye los Ajustes rápidos, Super+S): Wi‑Fi, Bluetooth, modo avión, Concentración, modo oscuro, luz nocturna, brillo, sonido, reproducción MPRIS, perfil de energía… con desenfoque de fondo.
- **Cristal Liquid Glass** con refracción real en el Centro de control, los menús, la barra superior (píldora o islas) y la ventana «Acerca de»; se elige en Preferencias → Cristal (Liquid Glass, desenfoque simple o sin efecto).
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

### Elegir el cristal

En **Preferencias → Cristal**:

- **Estilo del cristal**: `Liquid Glass` (motor con refracción y borde iluminado), `Desenfoque simple` (el `Shell.BlurEffect` de GNOME) o `Sin efecto` (sólo el fondo translúcido del CSS).
- **Cristal de la barra superior**: `Desactivado` (Tahoe transparente), `Píldora` (toda la barra como una píldora flotante) o `Islas` (una píldora por grupo de botones). Sólo se aplica con Liquid Glass.
- Los ajustes del motor (refracción, borde, aberración, luz, sombra, método y calidad del desenfoque) se aplican en vivo. El botón **Restablecer valores de cristal** vuelve a los valores originales.

Con una ventana maximizada y «Opaco con ventanas maximizadas» activo, la barra vuelve al fondo sólido y el cristal del panel se apaga; es el comportamiento pedido para ese caso.

## Créditos

- **Motor de cristal Liquid Glass**: [Ryosuke Watanabe (ryohsuke1231)](https://github.com/ryohsuke1231/liquid-glass), licencia MIT.
  Copiado en `tahoe-topbar@tahoe-gnome/vendor/liquid-glass/` desde el commit `a3fb66f`; su `LICENSE` MIT se incluye íntegro en esa carpeta y las cabeceras originales se conservan. Los cambios locales están documentados en `vendor/liquid-glass/README.md`.

## Licencia

GPL-2.0-or-later. El proyecto incluye código MIT de terceros en `vendor/liquid-glass/`, compatible con la GPL. Apple, macOS y el logo de Apple son marcas de Apple Inc.; este proyecto no está afiliado a Apple.
