# Liquid Glass engine (vendor)

Motor de renderizado de la extensión **Liquid Glass** de GNOME Shell,
integrado en Tahoe Top Bar. Esta copia dibuja cristal y aplica el efecto a
ventanas de aplicaciones; no incluye la UI de preferencias, los managers de
superficies del chrome ni los workers.

- Origen: <https://github.com/ryohsuke1231/liquid-glass>
- Commit copiado: `a3fb66f7cfd9eb1a77cb3def03ec0dff0bf193c9` (2026-10-24)
- Licencia: MIT, © 2026 Ryosuke Watanabe. El texto íntegro está en `LICENSE`.
- Copyright y cabeceras originales conservados en todos los archivos.

## Archivos copiados

Desde `liquid-glass@thinkingcoding1231.gmail.com/`:

| Archivo aquí | Origen | Por qué |
| --- | --- | --- |
| `rendering/backdropGlass.js` | `dist/rendering/backdropGlass.js` | Actor `BackdropGlass`: copia el framebuffer del stage durante el paint, mantiene los relays, aplica blur y compone `glass.frag`. |
| `rendering/glassRenderer.js` | `dist/rendering/glassRenderer.js` | Uniforms, geometría de blur/compuesto, material ligado a GSettings y outline. |
| `rendering/pipelines.js` | `dist/rendering/pipelines.js` | Carga y compila `glass.frag`, `downsample.frag` y `upsample.frag`; pipelines de blur Gaussiano y Dual Kawase. |
| `shellVersion.js` | `dist/shellVersion.js` | Diferencias de API entre GNOME 46–51 (`paintNodeWithContext`, nodos Cogl, color state del offscreen). |
| `actors.js` | `dist/actors.js` | `placeScreenGlass`, `ensureGlassAllocated`, `resolveGlassOrigin`, rects transformados y helpers de escritura diferida. |
| `animation.js` | `dist/animation.js` | `hexToColorArray` (color del tinte) y `startSyncLoop`/`stopStageLoop` (sync por frame). |
| `diagnostics.js` | `dist/diagnostics.js` | `registerGlass`/`unregisterGlass`, que `backdropGlass.js` llama al crear y limpiar cada cristal. |
| `logger.js` | `dist/logger.js` | Logger gateado por `output-logs`, compartido por el motor. |
| `applicationManager.js` | `dist/applicationManager.js` | Aplica un `BackdropGlass` debajo de la superficie de cada `Meta.WindowActor` incluido y baja la opacidad de **toda** la superficie de la ventana. |
| `shaders/glass.frag` | `shaders/glass.frag` | Shader principal: refracción, blur, tinte, borde, sombra y multi-región. |
| `shaders/downsample.frag` | `shaders/downsample.frag` | Bajada de resolución del blur Dual Kawase. |
| `shaders/upsample.frag` | `shaders/upsample.frag` | Subida de resolución del blur Dual Kawase. |

No se copiaron `uiManager.js`, `topBarManager.js`, `quickSettingsManager.js`
ni el resto de managers del chrome: la adaptación a nuestra API vive en
`liquidGlass.js`, en la raíz de la extensión. La excepción es
`applicationManager.js`, que se copió tal cual porque no depende de la API de
superficies de Tahoe: recibe `extensionPath`, `settings` y `logger`, y crea
sus propios `BackdropGlass` dentro de los actores de Mutter.

No hizo falta ningún stub: el grafo de imports de estos nueve módulos se
cierra con los archivos de la tabla.

## Cambios respecto al upstream

1. **`rendering/glassRenderer.js`: `GlassRenderer.setOutline(width, r, g, b)`.**
   El upstream sólo escribe los uniforms `outline_*` desde `OutlineBinding`,
   que exige un prefijo de claves GSettings (`<prefijo>-outline-*`). Nuestra
   API recibe el outline por opciones, así que se añadió un setter directo
   (ancho 0 lo apaga). No se tocó `OutlineBinding`.

2. **`rendering/glassRenderer.js`: `GlassRenderer.setShadowIntensity(intensity)`.**
   La intensidad de la sombra sólo se podía cambiar con la clave
   `shadow-intensity`; con esto `attach({shadow: false})` puede apagarla por
   superficie sin añadir claves nuevas.

3. **`rendering/backdropGlass.js`: `GlassActor.setOutline()` y
   `GlassActor.setShadowIntensity()`.** Reenvían a los dos métodos anteriores,
   igual que el resto de setters del actor.

4. **`rendering/backdropGlass.js`: `trackViewPaints()` / `untrackViewPaints()`
   con contador de usuarios.** El upstream los llama una vez en `enable()`.
   Aquí puede haber dos motores vivos a la vez (la extensión real y un arnés de
   prueba); sin el contador, el segundo `trackViewPaints()` perdía los ids del
   primero y un `untrack` dejaba al otro sin `before-paint`. Con el contador
   las señales se instalan una vez y las quita el último motor.

5. **Ruta de los shaders: sin cambios en el código.** `pipelines.js` sigue
   leyendo `${extensionPath}/shaders/*.frag`; `liquidGlass.js` pasa como
   `extensionPath` el directorio `vendor/liquid-glass`, donde están
   `shaders/`. No se reescribió la carga.

6. **`rendering/pipelines.js`: pipelines estáticos compartidos.** Las pasadas
   de bajada/subida, el passthrough y el box-down no llevan estado por
   cristal (RenderPasses las copia antes de escribir uniforms). Se cachean por
   contexto Cogl para que abrir y cerrar menús no vuelva a compilar los mismos
   shaders en cada superficie. `reloadShaders()` en desarrollo seguiría usando
   la copia cacheada hasta reiniciar la shell.

7. **`applicationManager.js`: óptica específica de Nautilus (modificación
   local).** Sobre la copia del commit se añadió la detección de Nautilus por
   `Meta.Window.get_wm_class()`, `get_gtk_application_id()` y
   `get_sandboxed_app_id()`, y un look fijo tomado de `glassLook()` del Centro
   de control. Cuando `application-nautilus-glass` está activo y la ventana es
   Nautilus, `_applyAppearance()` usa blur 4, tinte blanco 0.12, brillo 1.04,
   contraste 1.0 y saturación 1.35 en vez de `application-*`. El rim/specular/
   sheen (`setSurfaceLightEnabled(true)`) sólo se enciende si
   `application-content-opacity >= 0.99`; con el contenido translúcido sigue
   apagado para no dibujar un marco brillante. El resto de aplicaciones y el
   perfil `desktop-menu` conservan el comportamiento original, incluido
   `setSurfaceLightEnabled(false)` y `setCornerSmoothingEnabled(false)`. El
   resto del archivo sigue siendo el código del commit.

Todo lo demás es el código compilado del commit `a3fb66f` sin modificar.

## Settings

`liquidGlass.js` construye el motor con el `Gio.Settings` de Tahoe Top Bar.
Las claves que lee el código copiado se añadieron al esquema
`org.gnome.shell.extensions.tahoe-topbar` con los mismos nombres, tipos,
rangos y valores por defecto que el esquema original (bloque "Motor Liquid
Glass"): `glass-*`, `blur-method`, `shadow-radius`, `shadow-intensity`,
`output-logs`, `glass-debug-diagnostics`, `enable-dump-shortcut` y
`dump-loop-keybinding`.

`applicationManager.js` lee su propio bloque, también en el esquema de Tahoe
(`Cristal en ventanas de aplicaciones`):

- interruptores: `enable-application-glass` (opt-in, `false` por defecto),
  `application-glass-all-windows` (`false`), `application-corner-on-maximized`
  (`false`), `application-glass-on-maximized` (`true`) y
  `application-nautilus-glass` (`true`, óptica reforzada sólo para Nautilus);
- listas: `application-window-whitelist` (por defecto
  `['org.gnome.Nautilus', 'nautilus']`) y `application-window-blacklist`
  (vacía);
- apariencia: `application-tint-color`, `application-tint-strength`,
  `application-blur-radius`, `application-corner-radius` (18 px),
  `application-content-opacity` (0.88, rango 0.5–1.0),
  `application-brightness`, `application-contrast`,
  `application-saturation` y `application-outline-*`.

El manager también recorre el perfil `desktop-menu` del upstream al arrancar
(`enable-desktop-menu-glass`, `desktop-menu-*`). Esas claves están declaradas
para que el módulo no lea claves inexistentes, pero Tahoe no activa ni expone
ese perfil. `shadow-radius` y `shadow-intensity` del motor común determinan el
margen del cristal de las ventanas.

### Óptica de Nautilus (opción B)

`application-nautilus-glass` (por defecto `true`) sólo cambia el material de
las ventanas que Mutter identifica como Nautilus. Está pensado para el override
GTK4 de `scripts/nautilus-glass.sh`: la superficie completa queda opaca
(`application-content-opacity = 1.0`) y el CSS deja un velo base de alfa ~0.52
únicamente en la barra lateral y las cabeceras, con un gradiente vertical suave,
highlight blanco de 1 px, oclusión ambiental interior y borde neutro de 1 px.
Así el cristal del compositor se ve a través de esas franjas, el contenido de
archivos sigue opaco y el texto mantiene contraste (el CSS añade un
`text-shadow` oscuro suave para los rótulos).

Con ese ajuste el manager aplica el mismo look que el Centro de control (blur 4,
tinte blanco 0.12, brillo 1.04, saturación 1.35) y enciende el rim/specular del
shader. Si se baja `application-content-opacity` por debajo de 0.99, el rim se
apaga solo para no enmarcar con una línea brillante una superficie que ya es
translúcida. Desactivar la clave devuelve a Nautilus el cristal genérico de
`application-*`, sin tocar a las demás apps. En la prueba real el alfa efectivo
quedó en ~0.536 para la sidebar y ~0.668 para la cabecera (el gradiente y el AO
suman capas); el contenido midió 1.0 y fue pixel-idéntico antes/después.

**Límite:** el shader dibuja el borde y la refracción en el perímetro del
rectángulo de cristal, que es el perímetro de la ventana. El CSS sí conoce los
widgets y por eso puede añadir el canto de 1 px y el acabado de la superficie
en la sidebar/cabecera, pero no puede pedirle al compositor una lente o
refracción independiente para el límite interior: eso exigiría una región en
`BackdropGlass`, y `applicationManager.js` sólo ve el rectángulo de
`Meta.Window`. En Nautilus real se midieron ~209 px de sidebar y ~71 px de
cabecera con 1040x680, pero la sidebar pasó a ~188 px con 800x600, se puede
ocultar con F9 y cambia de tamaño. Una región interior fija (por ejemplo 180 px)
sería incorrecta en esos casos. `Meta.WindowActor.get_image()` devuelve la
superficie ya compuesta (alfa 255), no el alfa del cliente, así que tampoco
sirve para detectar el límite. Por eso la óptica es más marcada que antes y el
canto interior existe, pero la refracción sigue siendo la del borde exterior:
no es idéntica al Centro de control.

## Notas de integración

- `liquidGlass.js`, en la raíz de la extensión, expone `LiquidGlassEngine`,
  `glassLook(theme)` (tintes claro/oscuro) y `stageRect(actor)`. Los módulos
  piden handles mientras el elemento está visible y los destruyen al cerrar,
  de modo que el motor no deja ningún `before-update` conectado con todo
  cerrado.
- El Centro de control usa tres `attachRegions` (círculos/píldoras radio 31,
  tarjetas radio 24, pie radio 13) y `attach` para las hojas de detalle
  (radio 22). Los toggles activos se excluyen de las regiones porque su
  relleno CSS es opaco.
- Los menús usan `attach(menu.box, radio 14)`; los popovers del Centro de
  control y la ventana Acerca de, radio 22 y 18.
- El cristal se coloca en `Main.layoutManager.uiGroup`, justo debajo del
  ancestro del actor que cuelga de `uiGroup` (como hacen los menús del
  upstream). No se mete dentro del padre del actor porque muchos contenedores
  del shell se pintan a través de un offscreen y el cristal leería ese
  offscreen, no el stage.
- El actor de cristal cubre el monitor y se recorta alrededor del cuerpo, así
  que mover o redimensionar el objetivo sólo cambia uniforms y el clip.
- `Shell.Screenshot` pinta fuera del stage: en esas capturas el cristal usa la
  última copia on-screen (o no dibuja si aún no hubo ninguna). Para
  verificarlo visualmente hace falta una "cámara": un actor que copie el
  rectángulo del framebuffer durante cada frame y se capture a sí mismo, como
  en `tools/backdrop-spike/lg-driver@liquid-glass.test`.
- En modo multi-región el shader usa un único `corner_radius` para todas las
  regiones; no hay radio por región.
- **Ventanas de aplicaciones.** `extension.js` crea un `ApplicationManager`
  sólo cuando `glass-style = liquid` y `enable-application-glass = true`, y lo
  destruye antes que `LiquidGlassEngine` (también al bloquear la sesión). El
  manager no usa los handles del motor: inserta un `BackdropGlass` debajo del
  `surfaceActor` de cada `Meta.WindowActor` y baja la opacidad de toda la
  superficie a `application-content-opacity` (0.88 → 224/255). Su `cleanup()`
  restaura la opacidad original y desconecta las señales de ventana.
- La lista blanca compara `Meta.Window.get_wm_class()` sin distinguir
  mayúsculas. En Wayland con GTK4 suele ser el app-id
  (`org.gnome.Nautilus`); en X11, el nombre corto (`nautilus`). Nautilus real
  se verificó en una sesión Wayland anidada con WM_CLASS
  `org.gnome.Nautilus`.
- **Limitación del modo genérico:** GNOME Shell no inyecta CSS en apps
  GTK4/GTK3. Mientras el cristal sea el que baja la opacidad de la ventana
  (`application-content-opacity` &lt; 1.0), el texto y los controles de toda la
  superficie se vuelven translúcidos y el compositor no distingue la barra
  lateral del resto. La opción B de Nautilus evita eso manteniendo la
  superficie en 1.0 y dejando el alfa sólo en el CSS; aun así el compositor no
  puede dibujar el borde interior de la sidebar (ver «Óptica de Nautilus»). Por
  eso el cristal de ventanas viene apagado por defecto, la lista blanca es
  explícita y «aplicar a todas las ventanas» está oculto tras una advertencia
  en preferencias.
- El cristal de ventanas sólo sigue ventanas del workspace activo y ventanas
  normales/diálogos; los menús emergentes y las ventanas override-redirect se
  dejan intactos. En maximizado se puede conservar o apagar con
  `application-glass-on-maximized`.
- El `before-update` del stage sólo corre cuando el compositor pinta. En una
  sesión headless recién arrancada con la vista general abierta el
  `window_group` está oculto y los actores no están `mapped`; hay que cerrar
  la vista general para probar el efecto. En una sesión real esto no ocurre.
- Las capturas con `Shell.Screenshot` no garantizan ver el cristal de
  ventanas; el arnés `/tmp/opencode/nested-windows` usa una cámara que copia el
  framebuffer durante el paint, como el resto de pruebas visuales del motor.
