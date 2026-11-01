# Liquid Glass engine (vendor)

Motor de renderizado de la extensión **Liquid Glass** de GNOME Shell,
integrado en Tahoe Top Bar. Esta copia sólo dibuja cristal; no incluye la UI
de preferencias, los managers de superficies ni los workers.

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
| `shaders/glass.frag` | `shaders/glass.frag` | Shader principal: refracción, blur, tinte, borde, sombra y multi-región. |
| `shaders/downsample.frag` | `shaders/downsample.frag` | Bajada de resolución del blur Dual Kawase. |
| `shaders/upsample.frag` | `shaders/upsample.frag` | Subida de resolución del blur Dual Kawase. |

No se copiaron `uiManager.js`, `topBarManager.js`, `quickSettingsManager.js`
ni el resto de managers: la adaptación a nuestra API vive en
`liquidGlass.js`, en la raíz de la extensión.

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

Todo lo demás es el código compilado del commit `a3fb66f` sin modificar.

## Settings

`liquidGlass.js` construye el motor con el `Gio.Settings` de Tahoe Top Bar.
Las claves que lee el código copiado se añadieron al esquema
`org.gnome.shell.extensions.tahoe-topbar` con los mismos nombres, tipos,
rangos y valores por defecto que el esquema original (bloque "Motor Liquid
Glass"): `glass-*`, `blur-method`, `shadow-radius`, `shadow-intensity`,
`output-logs`, `glass-debug-diagnostics`, `enable-dump-shortcut` y
`dump-loop-keybinding`.

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
