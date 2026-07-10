# Investigación del salto de renderizado de `/subagents` bajo Herdr y tmux

**Fecha:** 2026-07-09  
**Alcance:** investigación read-only. No se cambió código, configuración ni tests. La única escritura es este informe.  
**Proyecto:** `/home/j0k3r/pi-subagents-j0k3r`  
**Vídeo:** `/home/j0k3r/Videos/Screencasts/recording-20260709-182209.mp4`

## Resumen ejecutivo

El vídeo confirma un defecto real de **presentación de frames no atómicos**: durante al menos un refresco de `/subagents`, varias filas ya dibujadas desaparecen durante aproximadamente un frame y reaparecen en el siguiente. El caso más nítido ocurre entre **12.233 s y 12.266 s**: a 12.250 s faltan casi todas las filas superiores del panel; a 12.266 s vuelven; a 12.283 s aparece además el siguiente estado legítimo del cuerpo. El borde exterior de Herdr, su sidebar y la geometría del pane permanecen fijos. Esto permite descartar como explicación principal un `SIGWINCH`, un resize físico o un reflow global. Tampoco tiene la firma de un simple error `wcwidth`: faltan filas completas, no sólo caracteres o un wrap local.

La explicación de mayor probabilidad es una interacción de tres capas:

1. `/subagents` monta con `ctx.ui.custom()` un componente no-overlay que devuelve **tantas filas como `process.stdout.rows`**, aunque el árbol principal de Pi conserva otras filas/chrome. Es, por tanto, una vista de altura límite o excesiva dentro de la pantalla primaria.
2. El panel pide render cada segundo; además la duración se calcula con `Date.now()`, el estado/snapshot puede cambiar y la fila `usage` es condicional. Cambios tempranos en un bloque más alto que el viewport hacen que `pi-tui` caiga con frecuencia en `fullRender(true)`, que emite `CSI 2J`, `CSI H` y `CSI 3J` antes de repintar.
3. Pi intenta hacer el repintado atómico con DECSET/DECRST 2026, pero Herdr y tmux son emuladores/multiplexores intermedios: interpretan el stream del proceso y generan otro stream/frame hacia el terminal exterior. Si esa mediación publica el clear y el cuerpo en estados distintos, el usuario ve el frame incompleto. Esto coincide con el vídeo y con fallos upstream reproducibles de tmux y antecedentes recientes de Herdr.

**Conclusión:** la causa raíz exacta todavía no está confirmada porque no se capturó el ANSI de Pi ni el motivo de `fullRender` durante la grabación. Sí queda confirmado el mecanismo visual inmediato: **un frame intermedio con filas borradas se hace visible**. La hipótesis principal —full redraw de Pi disparado por una custom UI full-height y expuesto por la capa intermedia— tiene confianza alta. La atribución final a Pi frente a la mediación concreta de Herdr/tmux requiere una captura sincronizada.

## Síntoma y reproducción conocida

- El problema se observa al abrir `/subagents` con tareas/snapshots vivos.
- Se ha observado dentro de **Herdr 0.7.3** y también dentro de **tmux**.
- Se considera exclusivo o mucho más visible en `/subagents`; otras vistas del proyecto no reproducen el mismo patrón conocido.
- El vídeo registra una sesión de Herdr con un único pane Pi. El panel muestra una ejecución `discovery` y actualizaciones del thread mientras el borde y sidebar de Herdr permanecen estables.
- La comparación solicitada toma **Kitty directo** como control conceptual. No se realizó una nueva ejecución interactiva porque el trabajo fue read-only y el launcher local `~/.pi/agent/bin/pi` apunta actualmente a un checkout ya inexistente (`/home/j0k3r/gentle-pi/...`). El paquete global 0.80.5 y su código/documentación sí están disponibles e inspeccionados.

## Metodología y evidencia inspeccionada

### Local

- Vídeo original, sin modificar, con `ffprobe` y extracción temporal de frames en `/tmp/subagents-rendering-*`.
- Código completo relevante: `index.ts`, `src/ui.ts`, `src/thread-view.ts`, `src/manager.ts`, `src/history.ts`, tipos y tests relevantes.
- Documentación del proyecto: `README.md`.
- Pi instalado: `@earendil-works/pi-coding-agent` 0.80.5 y `@earendil-works/pi-tui` 0.80.5.
- Documentación local de Pi leída completa: `docs/tui.md`, `docs/extensions.md` (2753 líneas, incluidas continuaciones), `docs/tmux.md`, `docs/terminal-setup.md` y `docs/packages.md`. Se siguieron sus referencias pertinentes a custom components, overlays, anchura, debug y paquetes.
- Renderer instalado: `pi-tui/dist/tui.js`, `terminal.js` y `utils.js`.
- Herdr local: binario `~/.local/bin/herdr`, `herdr 0.7.3`; `~/.config/herdr/{config.toml,session.json,herdr-server.log,herdr-client.log}`.
- Terminfo local mediante `infocmp -x`: `xterm-kitty`, `tmux-256color` y `xterm-256color`.
- Tests revisados, especialmente `test/subagents.test.ts`. **No se ejecutaron tests** ni se escribieron tests.

### Upstream/web y discusión humana

Se consultaron repositorios oficiales, releases, código en tags, issues y PRs. En la tabla de fuentes posterior se distingue evidencia primaria de analogías. No se trata ninguna hipótesis de un issue como hecho local sin captura equivalente.

## Análisis cuadro a cuadro del vídeo

### Metadatos

`ffprobe`:

- contenedor MP4 (`isom`), un único stream de vídeo, sin audio;
- H.264 High, 1920×1080, SAR 1:1, progresivo, `yuvj420p`;
- duración **19.877678 s**;
- 804 frames declarados;
- `r_frame_rate=60/1`, pero `avg_frame_rate=72360000/1788991 ≈ 40.45 fps`.

Es una grabación de tasa efectiva variable/irregular. Por ello los timestamps PTS son más fiables que convertir el número de frame suponiendo 60 fps.

### Secuencia crítica verificada

Se extrajeron frames nativos con PTS sobreimpreso fuera del repositorio. La secuencia más informativa es:

| Timestamp | Observación |
|---:|---|
| 12.217 s | Panel completo; metadata y cuerpo visibles. |
| 12.233 s | Estado todavía coherente; metadata superior, reads y salida del `find` visibles. |
| **12.250 s** | **Frame anómalo:** casi todas las filas superiores de metadata desaparecen; quedan contenido inferior y algunas filas aisladas. No cambia el borde del pane ni el sidebar. |
| **12.266 s** | Las filas superiores reaparecen. Es un estado coherente del panel, no un resize. |
| 12.283 s | Entra el siguiente estado legítimo: aparece una fila de contenido adicional (`Reading documentation`) y cambia la ventana interna. |
| 12.300 s | Estado posterior estable. |

La anomalía visible dura del orden de **16–33 ms** en esta secuencia, suficiente para percibirse como salto a 40 fps efectivos. Hay más recomposiciones entre aproximadamente 8 y 13.7 s, pero ésta permite separar con claridad el frame incompleto del cambio legítimo posterior.

### Qué permite distinguir el vídeo

| Candidato | Evaluación | Evidencia del vídeo |
|---|---|---|
| Scroll físico normal | Muy improbable como mecanismo inmediato | Un scroll desplazaría filas de forma continua; aquí desaparecen filas superiores y luego regresan. |
| Reflow/wrap por ancho | Improbable en el evento crítico | La anchura y bordes no cambian; faltan filas completas. |
| Cambio de altura del componente | Posible como trigger lógico, no como fenómeno físico | El árbol puede recomponerse, pero el pane exterior no cambia de altura. |
| Doble render / frame intermedio | **Confirmado visualmente** | Hay estado A, frame incompleto, estado B. |
| Limpieza incompleta | **Compatible y muy probable** | El frame anómalo parece un clear parcial seguido de repintado. |
| Resize/SIGWINCH | No sustentado para el instante | Herdr no cambia borde/sidebar/geometría; logs no registran resize coincidente con la grabación crítica. |
| Diferencia Unicode/wcwidth | Defecto local real, causa primaria improbable | Un error de celdas explicaría wrap/drift, no desaparición y restauración de múltiples filas. |
| Exposición completa de la conversación subyacente | **No confirmada** | La inspección detallada corrige una lectura preliminar: el frame 12.250 conserva partes del panel; no demuestra que Pi retire por completo la custom UI. |

El vídeo **no** revela qué bytes ANSI se emitieron ni si Herdr recibió un bloque `?2026h…?2026l` correcto. Tampoco distingue por sí solo si Pi produjo dos renders lógicos o si una capa intermedia partió uno.

## Arquitectura y flujo de render de `/subagents`

### Entrada

`index.ts` registra `/subagents` y llama a `showSubagentsPanel`. La función:

1. suspende input del widget Claude;
2. abre `ctx.ui.custom()` **sin** `{ overlay: true }`;
3. activa mouse tracking (`DECSET 1000` y `1006`) escribiendo directamente en el terminal TUI;
4. construye `SubagentsHistoryPanel`;
5. usa `process.stdout.rows` como altura máxima;
6. instala `setInterval(...requestRender(), 1000)`;
7. pide otro render tras cada input;
8. al cerrar desactiva mouse y limpia el intervalo.

Además existe un widget de background Claude que, cuando está activo fuera del panel, refresca cada 250 ms; durante el panel se suspende su input, aunque el panel sigue usando su propio timer.

### Estado y datos vivos

`SubagentManager.listSessionTasks()` combina tareas activas en memoria y persistidas, ordenadas por `created_at`. La caché de tareas persistidas dura 1500 ms. Para el cuerpo seleccionado, el panel puede hidratar el snapshot bajo demanda por `manager.getTask()`.

Las escrituras de actividad se agrupan en ventanas de 150/250 ms en manager/history, por lo que el snapshot y `updated_at` pueden cambiar mientras el panel está abierto. La UI no se suscribe a cada update; el polling visual de un segundo termina recogiendo esos cambios en lotes.

### Layout y altura

`SubagentsHistoryPanel.render(width)`:

- fuerza ancho mínimo lógico de 40;
- toma `maxLines = max(12, configuredMaxLines)`;
- dibuja título, divisores, metadata, strip de tareas y cuerpo;
- calcula un viewport interno y `scroll`/`followTail`;
- rellena filas vacías;
- termina con divisor/posición.

En producción `configuredMaxLines = process.stdout.rows`. Para tareas normales el resultado se rellena hasta **exactamente esa cantidad de filas**. Pero la custom UI reemplaza el editor dentro del árbol de Pi, no todo el terminal ni su pantalla primaria; otras filas de transcript/chrome pueden seguir formando parte del árbol. Esta combinación es análoga al caso de Ink #450: un componente de altura exactamente igual a `stdout.rows` empieza a provocar scroll/flicker, mientras `rows - 1` lo evita.

La cantidad de filas de chrome no es completamente estable: `usage` sólo se agrega si existe. El título de duración cambia aunque no cambie el snapshot, porque `fmtDuration()` usa `Date.now()` para tareas activas. Por tanto, cada tick puede modificar una fila temprana y, cuando aparece `usage`, desplazar todas las filas posteriores.

### Cuerpo, snapshots y caché

`renderThreadBody()` acepta snapshots v1, limita a 200 items y acota cada campo a 4000 caracteres. Reutiliza componentes de Pi (`AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, etc.) cuando están disponibles y cae a texto si no.

El panel memoiza el body por firma de tarea, ancho y estado expandido. La firma incluye estado, actividad/timestamps y número de items. Reduce trabajo cuando nada cambia, pero invalida durante streaming, como corresponde. El body completo se renderiza y después se recorta al viewport interno.

### Scroll y follow-tail

El panel mantiene `scroll`, `lastMaxScroll` y `followTail`. Un crecimiento del cuerpo mueve automáticamente la ventana al final. Esa transición explica desplazamientos **legítimos** del contenido entre 12.266 y 12.283, pero no explica el frame vacío de 12.250.

### Pi TUI: render incremental y full redraw

`pi-tui` 0.80.5 limita/coalesce renders y compara `newLines` con `previousLines`. Cada línea recibe reset SGR/OSC. El camino diferencial mueve el cursor, emite `CSI 2K` por fila cambiada y reescribe sólo el rango.

`fullRender(true)` construye un único buffer:

```text
CSI ?2026 h             begin synchronized output
[delete Kitty images]
CSI 2 J                 clear screen
CSI H                   home
CSI 3 J                 clear scrollback
...todas las filas...
CSI ?2026 l             end synchronized output
```

Se usa, entre otros casos, cuando:

- cambia ancho o alto del terminal;
- el contenido encoge bajo el high-water mark (`clearOnShrink`);
- se borran demasiadas filas;
- un target borrado queda por encima del viewport;
- **`firstChanged < prevViewportTop`**;
- ciertos bloques de imagen no pueden repintarse sin scroll.

Una custom UI de altura total, insertada tras transcript previo y con líneas tempranas mutables, maximiza `firstChanged < viewportTop` y los clears completos. Pi #6073 documenta exactamente ese fallback en un salto sólo visible dentro de tmux.

### Mouse, cursor y alternate screen

`/subagents` activa mouse press/release + SGR (`1000`, `1006`) pero no entra en alternate screen (`1049`). Pi usa la pantalla primaria para preservar scrollback. No se encontró save/restore de cursor local en `/subagents`; el posicionamiento queda en `pi-tui`. Pi usa synchronized output, no alternate screen, para atomicidad.

## Tabla de archivos, símbolos y rangos relevantes

| Archivo | Símbolo/rango | Relevancia |
|---|---|---|
| `index.ts` | `visibleWidth`, `truncateToWidth`, 65–71 | Helpers por code points, no anchura de terminal real. |
| `index.ts` | `setMouseTracking`, 102–106 | Escribe DECSET/DECRST 1000 y 1006. |
| `index.ts` | `subagentsExtension`, 361–537 | Registro principal. |
| `index.ts` | widget/timer, 370–430 | Widget Claude; refresh 250 ms. |
| `index.ts` | `showSubagentsPanel`, 432–488 | Custom UI, provider de tareas, altura, timer 1 s, input/render. |
| `index.ts` | registro `/subagents`, 527–530 | Entrada del comando. |
| `src/ui.ts` | helpers de ancho, 38–49 | Fallback Unicode incompleto. |
| `src/ui.ts` | `SubagentsHistoryPanel`, 62–364 | Estado, scroll, cachés y render completo. |
| `src/ui.ts` | `handleInput`, 87–144 | Navegación, scroll, follow-tail. |
| `src/ui.ts` | `render`, 146–208 | Layout, metadata condicional, altura y padding. |
| `src/ui.ts` | `taskSignature`/caché, 285–329 | Invalidación del snapshot/body. |
| `src/thread-view.ts` | límites, 21–25 y 138–143 | 4000 caracteres/200 items. |
| `src/thread-view.ts` | carga de componentes, 174–214 | Integración dinámica con Pi runtime. |
| `src/thread-view.ts` | renderers, 217–450 | Componentes de mensajes/tools/bash/custom. |
| `src/thread-view.ts` | `renderThreadBody`, 464–481 | Render completo y truncado por ancho. |
| `src/manager.ts` | constantes 150–153 | Flush 150/250 ms y caché 1500 ms. |
| `src/manager.ts` | `listSessionTasks`, 175–183 | Mezcla activo/persistido y orden. |
| `src/history.ts` | snapshot helpers, 29–40 | Persistencia acotada. |
| `src/history.ts` | consultas, 198–253 | List/get y carga opcional del snapshot. |
| `test/subagents.test.ts` | 91–162 | Validación/bounds y componentes Pi al ancho solicitado. |
| `test/subagents.test.ts` | 603–712 | Filas largas, hidratación lazy, memoización y snapshots. |
| `test/subagents.test.ts` | 823–970 | Multilínea y expansión `Ctrl+O`. |
| `test/subagents.test.ts` | 973–1060 | Navegación y scroll. |
| `test/subagents.test.ts` | 1127–1269 | Altura, bodies largos, ratón y follow-tail. |
| Pi `dist/tui.js` | 498–545 | Cadencia/coalescing de render. |
| Pi `dist/tui.js` | 976–1273 | Composición, diff, full redraw, clears, viewport y validación de ancho. |
| Pi `dist/terminal.js` | `ProcessTerminal` | `SIGWINCH`, rows/columns, input protocols y raw ANSI logging. |
| Pi `dist/utils.js` | `visibleWidth`/`truncateToWidth` | Segmentación por grafema, emoji y East Asian width. |

Los rangos de tests corresponden al archivo inspeccionado actual; no implican que esos tests cubran terminales reales.

## Comparación Kitty directo vs tmux vs Herdr

| Aspecto | Kitty directo | Dentro de tmux | Dentro de Herdr 0.7.3 |
|---|---|---|---|
| Ruta | Pi → PTY/Kitty | Pi → PTY tmux → grid/diff tmux → Kitty | Pi → PTY Herdr → terminal Ghostty interna → frame semántico → cliente Herdr → terminal host |
| `TERM` esperado | `xterm-kitty` | `tmux-256color` | **forzado** a `xterm-256color` |
| `COLORTERM` | heredado, normalmente `truecolor` | heredado/configurado | **forzado** a `truecolor` |
| Terminfo local | `xterm-kitty` incluye `Sync`, `smcup/rmcup`, wrap | `tmux-256color` incluye `smcup/rmcup`, `E3`; su Sync depende de features de cliente | Pi ve capacidades genéricas xterm, no la identidad Kitty/Ghostty exterior |
| Alternate screen | Host lo implementa directamente | tmux puede mediar `smcup/rmcup`; `alternate-screen` configurable | Herdr rastrea primary/alternate en su terminal interna |
| Synchronized output 2026 | El host recibe el batch de Pi directamente | Versiones estables antiguas consumen/rehacen; master reciente media batches de aplicaciones, con fixes posteriores | Herdr interpreta 2026 internamente y suprime request de render mientras el modo está activo; después genera otro frame exterior también envuelto en 2026 |
| Cursor | Una capa de CUP/visibility | tmux reubica/restaura cursor del pane | Cursor interno + cursor del frame/cliente; 0.7.3 corrigió orden hide/sync |
| Wrap/wcwidth | Kitty y Pi pueden discrepar en casos extremos | grid tmux añade otra medición | Ghostty interna en modo grapheme + `unicode-width` del blitter añade otra medición |
| Mouse | Pi recibe Kitty protocol/SGR directamente | tmux traduce/filtra según modos | Herdr captura mouse del workspace y reenvía al pane según estado 1000/1006 |
| Resize | SIGWINCH directo; una geometría | tmux recalcula pane y manda SIGWINCH | cliente negocia tamaño, Herdr redimensiona terminal y PTY; logs muestran conexiones/resize |
| Riesgo de frame intermedio | Menor si Kitty honra 2026 | Dependiente de versión/configuración; confirmado históricamente | Mayor complejidad por doble emulación/diff; antecedente #967 |

### Terminfo y capacidades verificadas

- `xterm-kitty`: `am` (autowrap), `smam/rmam`, `smcup/rmcup` (`?1049h/l`), save/restore (`sc/rc`) y capacidad extendida `Sync`.
- `tmux-256color`: `am`, alternate screen, save/restore y `E3=CSI 3J`; la capacidad `Sync` hacia el host se anuncia mediante `terminal-features`, pero esto históricamente describía el **output de tmux al host**, no la atomicidad del batch entrante de una aplicación.
- `xterm-256color`: alternate screen, autowrap, cursor y `E3`, pero no identifica las extensiones específicas del terminal exterior.

### Resize/SIGWINCH

Pi registra `process.stdout.on("resize")` y al arrancar se autoenvía `SIGWINCH` para refrescar dimensiones. Un cambio de ancho/alto fuerza full redraw (salvo excepción Termux para altura). Herdr conserva servidor/PTY y clientes separados: logs locales muestran pane inicial 80×24, conexiones a 114×57, 234×60 y resizes 114↔234 columnas. Es evidencia de la arquitectura, **no** de resize durante el frame 12.250.

### Frecuencia

- `/subagents`: 1 Hz explícito, más renders por input y cambios globales de Pi.
- widget Claude: 4 Hz fuera del panel.
- `pi-tui`: coalesce con intervalo mínimo; otras animaciones/spinners pueden solicitar renders más rápidos.
- Herdr: dirty notification por output PTY y stream de frames al cliente.
- tmux: event loop/diff propio; la atomicidad depende de su soporte de batches entrantes y salida `Sync`.

## Qué es exactamente Herdr/HerdR

La identidad está verificada local y upstream: el producto se llama actualmente **Herdr** (en referencias informales aparece “HerdR”), repositorio oficial [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr), web [herdr.dev](https://herdr.dev/) y documentación [herdr.dev/docs](https://herdr.dev/docs/). No es Laravel Herd.

Es un **multiplexor/workspace manager terminal-native para agentes de código**, escrito en Rust, con servidor persistente, workspaces, tabs y panes PTY. El README oficial lo describe como “agent multiplexer that lives in your terminal” y “one rust binary, no electron”. La documentación de conceptos separa sesión, servidor y clientes.

Evidencia primaria del tag `v0.7.3`:

- [`src/pane.rs`](https://github.com/ogulcancelik/herdr/blob/v0.7.3/src/pane.rs): crea PTYs, fuerza `TERM=xterm-256color` y `COLORTERM=truecolor`, habilita grapheme cluster mode en la terminal Ghostty interna, rastrea alternate screen, mouse y resize.
- [`src/pane/terminal.rs`](https://github.com/ogulcancelik/herdr/blob/v0.7.3/src/pane/terminal.rs): procesa bytes en libghostty, consulta `MODE_SYNCHRONIZED_OUTPUT`; `request_render = !synchronized_output`; tiene test explícito de supresión entre `?2026h` y `?2026l`.
- [`src/server/render_stream.rs`](https://github.com/ogulcancelik/herdr/blob/v0.7.3/src/server/render_stream.rs): mantiene baseline por cliente y entrega `SemanticFrame` o `TerminalAnsi` sólo si cambia.
- [`src/protocol/render_ansi.rs`](https://github.com/ogulcancelik/herdr/blob/v0.7.3/src/protocol/render_ansi.rs): blit full/differential; cada frame exterior usa `?2026h`, oculta cursor, dibuja, restaura cursor y usa `?2026l`; cambio de dimensiones fuerza clear/full redraw.

El log local confirma handshake `render_encoding=SemanticFrame`, servidor y cliente separados, y detección del proceso `pi` dentro del pane.

## Hallazgos locales

1. **Altura límite:** `/subagents` usa todas las filas físicas para un componente que no es una pantalla alternativa ni overlay.
2. **Refresh aun sin cambio funcional:** la duración activa depende de reloj, así que el timer de 1 s cambia una línea de header aunque el snapshot no cambie.
3. **Chrome variable:** `usage` condicional desplaza el cuerpo al aparecer.
4. **Cuerpo vivo + follow-tail:** snapshots agregan items, invalidan caché y cambian la ventana visible.
5. **Full clears de Pi:** ante cambios por encima del viewport, Pi borra screen+scrollback y repinta, dentro de 2026.
6. **Anchura no canónica:** helpers locales cuentan code points tras un regex ANSI parcial. Pi usa grafemas, emoji y East Asian width. Riesgo: CJK, flags, ZWJ, combining marks y ANSI/OSC.
7. **No alternate screen:** la custom UI comparte pantalla primaria y scrollback con el chat.
8. **Mouse directo:** la extensión escribe modos de mouse al terminal interno; no parece causa del salto, pero amplía el estado que wrappers deben mediar/limpiar.
9. **Sin evidencia de spinner local en el panel:** el timer es fijo; componentes de Pi embebidos pueden representar estados vivos, pero no se encontró spinner propio de `SubagentsHistoryPanel`.
10. **Launcher local inconsistente:** `which pi` apunta a un checkout ausente. Para esta investigación se usó la instalación global 0.80.5, consistente con las fuentes ya instaladas. Esto debe corregirse antes de una reproducción instrumental, sin que sea causa del vídeo ya grabado.

## Tests existentes y superficies relevantes

La suite cubre correctamente mucha lógica pura:

- validación y bounding de snapshots;
- render con componentes Pi y ancho solicitado;
- truncado de filas largas;
- hidratación lazy y memoización;
- salida multilinea;
- expand/collapse `Ctrl+O`;
- teclado, rueda y scroll/follow-tail;
- altura configurada;
- persistencia acotada.

Huecos para este fallo:

- no hay harness con el renderer real de `pi-tui` y transcript previo mayor que el viewport;
- no se afirma que el árbol completo, no sólo el panel, quepa en `rows`;
- no se cuentan `CSI 2J/3J` ni motivos de `fullRender`;
- no se prueba transición `usage` ausente→presente con posición estable;
- no se prueba un PTY que fragmente BSU/clear/body/ESU;
- no hay matriz E2E Kitty/tmux/Herdr;
- los mocks de ancho usan a menudo `text.length`, insuficiente para Unicode terminal real.

## Investigación web y discusiones

| Fuente | Fecha/estado al 2026-07-09 | Evidencia aportada |
|---|---|---|
| [Herdr v0.7.3](https://github.com/ogulcancelik/herdr/releases/tag/v0.7.3) | Publicada 2026-07-07 | Incluye fix #967: cursor oculto dentro de synchronized output. |
| [Herdr #967](https://github.com/ogulcancelik/herdr/issues/967) | Cerrado; comentario posterior abierto de facto | Captura raw mostró `?25l` fuera de 2026 en 0.7.1; fix en 0.7.3. Un usuario aún reporta flicker en 0.7.3 + Ghostty 1.3.1. Es antecedente, no prueba de este panel. |
| [Herdr #756](https://github.com/ogulcancelik/herdr/issues/756) | Cerrado | Scrollback duplicado/no refluido tras resize. Mantainer lo atribuyó al renderer antiguo de Claude y recomendó alt screen; útil para diferenciar resize/reflow. |
| [Pi #5990](https://github.com/earendil-works/pi/issues/5990) | Abierto, `bug`, `inprogress` | Dialog más alto que viewport flickerea; intento de evitar writes offscreen fue reconocido por su autor como incorrecto. Caso muy cercano a altura excesiva. |
| [Pi #6073](https://github.com/earendil-works/pi/issues/6073) | Cerrado `no-action` por política automática | Salto dentro de tmux al expandir tools; señala `firstChanged < prevViewportTop → fullRender(true)`. Evidencia reproducida por reportante, sin aceptación de maintainer. |
| [Pi #3371](https://github.com/earendil-works/pi/issues/3371) | Cerrado | Flicker de streaming dependiente de terminal/tasa; reportado en iTerm2, no Ghostty. Apoya sensibilidad a frecuencia, no causa local. |
| [Pi #5023](https://github.com/earendil-works/pi/issues/5023) | Cerrado | Mantenedor: redibujar fuera del viewport hace scroll y no hay API terminal genérica que lo impida. Confirma limitación de pantalla primaria. |
| [Pi #6391](https://github.com/earendil-works/pi/issues/6391) | Cerrado `no-action` | Documenta `CSI 2K` por fila y blank visible cuando 2026 se ignora; reporte de usuario, no fix upstream. |
| [tmux #3325](https://github.com/tmux/tmux/issues/3325) | Cerrado, 2022 | Históricamente tmux no hacía nada con sync entrante; sólo usaba sync para sus updates y requería mediación entre panes. |
| [tmux PR #4744](https://github.com/tmux/tmux/pull/4744) | Cerrado, **no mergeado como PR** | Implementó mediación de DECSET 2026. Importante corrección: el maintainer dijo “applied to OpenBSD… in GitHub”; el código se aplicó directamente, aunque GitHub marque el PR no mergeado. |
| [tmux #4983](https://github.com/tmux/tmux/issues/4983) | Cerrado 2026-07-08 | Repro primario: clear estructural escapaba cuando BSU/ESU cruzaban múltiples reads, mostrando pantalla vacía ~183 ms. Patch del maintainer verificado y aplicado a master. Es casi la misma firma visual. |
| [tmux PR #5092](https://github.com/tmux/tmux/pull/5092) | Cerrado/no mergeado | Propuesta alternativa para #4983; no es la forma aplicada. |
| [tmux PR #5195](https://github.com/tmux/tmux/pull/5195) | Cerrado/no mergeado | Midió bytes fuera de sync en master previo y otros leaks; maintainer remitió a su patch #4983. Útil como evidencia de complejidad, no estado final. |
| [Ink #450](https://github.com/vadimdemedes/ink/issues/450) | Cerrado | Flicker al renderizar exactamente `process.stdout.rows`; varios usuarios confirman que `rows - 1` casi lo elimina. Analogía directa para la altura local. |
| [Ink #935](https://github.com/vadimdemedes/ink/issues/935) | Abierto 2026-04-10 | `CSI 2J/3J/H` en full redraw de contenido > viewport borra scrollback y causa jank; historia técnica detallada. Otra librería, evidencia analógica. |
| [terminal-kit #59](https://github.com/cronvel/terminal-kit/issues/59) | Cerrado/histórico | Save/restore cursor no compensa scroll físico en bottom row; el terminal no informa mágicamente el scroll. Apoya reservar filas/no tocar borde inferior. |
| [Contour synchronized output](https://contour-terminal.org/vt-extensions/synchronized-output/) | Especificación/documentación | Semántica de batch 2026 y necesidad de timeout; base usada por implementaciones. |
| [Kitty terminal protocol/docs](https://sw.kovidgoyal.net/kitty/) | Oficial | Kitty implementa protocolos modernos; la evidencia local de terminfo incluye `Sync`. |

No se encontraron casos específicos de `terminal-kit` con la misma vista; el issue #59 sólo documenta la limitación de scroll/cursor. Tampoco apareció un caso de Hacker News con valor probatorio superior a las fuentes primarias, por lo que no se usa como evidencia.

## Hipótesis ordenadas

### H1 — Full redraw de Pi expuesto como frame parcial por la capa intermedia

**Probabilidad: alta. Confianza: alta en el mecanismo; media en la capa culpable final.**

A favor:

- el vídeo confirma clear/repintado no atómico;
- `pi-tui` contiene rutas explícitas a `CSI 2J/H/3J`;
- `/subagents` cambia líneas tempranas cada segundo en un bloque full-height;
- Pi #6073 y #5990 describen condiciones casi idénticas;
- tmux #4983 reproduce exactamente “clear visible antes del cuerpo” cuando el batch cruza reads.

En contra/pendiente:

- falta `PI_DEBUG_REDRAW=1` del instante;
- Herdr 0.7.3 tiene un test explícito que debería suprimir renders durante 2026, por lo que hay que demostrar el borde o carrera concreta.

### H2 — Altura `rows` sin reservar chrome/bottom row dispara scroll y full clears

**Probabilidad: alta como trigger, no como mecanismo final. Confianza: media-alta.**

A favor: código local, Ink #450, Pi #5990, pantalla primaria y transcript previo.  
En contra: el panel rellena a altura estable; se necesita medir el árbol completo de Pi para saber el exceso exacto.

### H3 — Dos renders lógicos de Pi, no un solo batch fragmentado

**Probabilidad: media. Confianza: baja-media.**

A favor: a 12.250 aparece estado intermedio y a 12.283 un update legítimo; timers/global components pueden coalescer de modo distinto.  
En contra: no se encontró lifecycle local que retire/reinstale el panel cada tick; lo normal es una sola llamada `requestRender`.

### H4 — Carrera/mediación restante de Herdr 0.7.3

**Probabilidad: media. Confianza: media-baja.**

A favor: arquitectura de doble frame, #967 y reporte posterior en 0.7.3 + Ghostty; stream local `SemanticFrame`.  
En contra: su código comprueba synchronized mode después de cada write y tiene test de fragmentación por chunks begin/body/end. Podría requerir un render ya pendiente o dos batches de Pi, pero no está probado.

### H5 — tmux antiguo sin mediación completa de 2026

**Probabilidad: alta para reproducciones en tmux 3.6a o anterior/master previo; baja para master posterior al fix #4983.**

A favor: #3325, #4744 y #4983.  
En contra: el estado upstream cambió esta misma semana; master ya recibió fixes. `terminal-features '*:sync'` por sí solo no sustituye el soporte entrante en versiones antiguas.

### H6 — Resize/reflow real

**Probabilidad: baja para el vídeo.** Logs prueban que Herdr redimensiona, pero no hay resize coincidente ni cambio geométrico.

### H7 — Unicode/wcwidth/autowrap

**Probabilidad: baja como causa principal; media como amplificador.** Helpers locales son incorrectos para emoji/CJK/ZWJ, pero la firma sería drift/wrap y no clear-restauración masiva.

### H8 — Coste de snapshots/SQLite

**Probabilidad: baja.** Puede alargar el intervalo entre clear y paint si el render es pesado, pero por sí solo produciría latencia/congelación, no borrado de filas.

## Causa raíz confirmada o datos necesarios

### Confirmado

- `/subagents` genera una vista full-height dinámica con refresh periódico.
- Pi puede ejecutar full redraw destructivo en pantalla primaria.
- El vídeo contiene un frame intermedio incompleto.
- Herdr y tmux interponen emulación/diff y cambian capacidades/variables.

### No confirmado

No puede asignarse todavía “el bug es de X” sin correlacionar estos cuatro streams:

1. motivo de redraw de Pi;
2. bytes exactos escritos por Pi;
3. estado/frame publicado por Herdr o tmux;
4. frame del vídeo.

Criterio de cierre:

```text
Pi debug: fullRender: firstChanged < viewportTop (o clearOnShrink/height)
Pi raw:   ?2026h 2J H 3J ...panel... ?2026l
Wrapper:  publica frame con clear antes del frame panel
Vídeo:    coincide con 12.250 s
```

Si el raw de Pi contiene un único batch correcto y Herdr publica dos frames, la causa final está en Herdr. Si Pi emite dos batches y el primero representa filas vacías, está en Pi/composición. Si tmux antiguo reproduce y master post-#4983 no, queda atribuida esa variante a tmux.

## Opciones de solución (sin implementar)

### A. Reservar altura y estabilizar el chrome local

Usar altura disponible real, como mínimo `rows - 1` o una API de viewport de Pi; mantener siempre una fila `usage` (vacía cuando no existe) y evitar que headers cambien posición.

- **Ventajas:** cambio local y pequeño; ataca el trigger demostrado por Ink/Pi.
- **Riesgos:** `rows - 1` es heurístico; podría seguir habiendo transcript/chrome adicional y `firstChanged < viewportTop`.

### B. No refrescar por reloj cuando no cambió el estado renderizable

Separar duración dinámica o actualizar sólo una fila segura; renderizar por eventos/signatura en vez de polling fijo.

- **Ventajas:** reduce frecuencia y probabilidad del fallo.
- **Riesgos:** mitigación, no garantiza atomicidad; duración puede quedar menos viva; eventos de manager requieren diseño.

### C. Overlay acotado

Abrir `/subagents` con `{ overlay: true, overlayOptions: { maxHeight: ... } }` y viewport interno.

- **Ventajas:** compositor acota al viewport; evita añadir un bloque `rows` al final del transcript.
- **Riesgos:** cambia UX/foco; overlays altos también han tenido bugs; experimental según `extensions.md`.

### D. Soporte upstream de custom UI fullscreen en alternate screen

Pedir a Pi un contrato explícito para vistas fullscreen con `?1049h/l`, restauración coordinada y sin scrollback primario.

- **Ventajas:** solución arquitectónica robusta para vistas fullscreen.
- **Riesgos:** no debe implementarse unilateralmente desde una extensión; interacción con imágenes Kitty, nested TUIs, selección, wrappers y restore.

### E. Mejorar el renderer de Pi para cambios offscreen

Evitar full clear/replay cuando sólo cambian filas no visibles, manteniendo un modelo de stale rows/anclas correcto.

- **Ventajas:** arregla clase general.
- **Riesgos:** Pi #5990 demuestra que una solución ingenua fue incorrecta; resize/Termux/imágenes complican garantías.

### F. Unificar ancho con `@earendil-works/pi-tui`

Usar `visibleWidth`, `truncateToWidth` y wrapping ANSI/grapheme-aware canónicos.

- **Ventajas:** elimina un defecto real y previene autowrap.
- **Riesgos:** hardening secundario; no resuelve el frame 12.250 por sí solo; cuidar peer dependency/runtime.

### G. Actualizar/validar wrappers

- tmux: probar master posterior a #4983 o la release que lo incluya; no asumir que PR #4744 “no mergeado” significa ausencia del código.
- Herdr: abrir repro con raw ANSI y frames semánticos si un batch correcto genera frame parcial.

- **Ventajas:** arregla cualquier TUI contenida.
- **Riesgos:** fuera del control del proyecto y sujeto a versiones/configuración.

## Estrategia TDD y validación futura

### 1. Unit tests del panel

- Alturas 12/24/42/59: `render().length` exactamente igual a la altura **disponible**, no necesariamente `stdout.rows`.
- Transiciones queued→running→completed y `usage` ausente→presente sin mover header/footer/body origin.
- Duración/tick sin cambio de snapshot: afirmar qué fila puede cambiar.
- Unicode: `日本語`, `🙂`, `🇧🇷`, familia ZWJ, combining accents, VS16, OSC 8 y SGR; validar con `pi-tui.visibleWidth`.

### 2. Harness real de `pi-tui`

Crear terminal fake de 59 filas y transcript previo >59; abrir custom UI, hacer ticks y capturar writes.

Afirmar:

- longitud total del árbol;
- motivos y número de `fullRender(true)`;
- ausencia de `CSI 2J/3J` para cambios puramente visibles si ése es el contrato;
- BSU/ESU balanceados y envolviendo todo clear+paint;
- ninguna fila del transcript reaparece mientras el panel está activo.

### 3. Harness PTY fragmentado

Fragmentar en cada límite posible:

```text
?2026h | 2J/H/3J | primer tercio | resto | ?2026l
```

El wrapper no debe publicar frame entre begin/end, incluso si había un render pending antes de begin. Probar también begin+parte del clear en un mismo read y ESU en otro; éste es el patrón de tmux #4983.

### 4. Matriz E2E

| Exterior | Wrapper | Versiones |
|---|---|---|
| Kitty | ninguno | control |
| Ghostty | ninguno | control adicional |
| Kitty/Ghostty | tmux 3.6a | variante histórica |
| Kitty/Ghostty | tmux master post-#4983/release futura | verificación del fix |
| Kitty/Ghostty | Herdr 0.7.3 | repro actual |
| Kitty/Ghostty | Herdr preview/master | regresión upstream |

Capturar vídeo 60 fps, ANSI raw, motivo Pi, `stty size`, SIGWINCH y frames del wrapper con reloj monotónico.

### 5. Instrumentación recomendada

```bash
PI_DEBUG_REDRAW=1
PI_TUI_WRITE_LOG=/tmp/pi-subagents-ansi.log
PI_TUI_DEBUG=1
```

- `PI_DEBUG_REDRAW`: `~/.pi/agent/pi-debug.log` con motivo.
- `PI_TUI_WRITE_LOG`: stream exacto.
- `PI_TUI_DEBUG`: snapshots del diff en `/tmp/tui`.
- En Herdr: habilitar profiling/log de `pty.synchronized_output_suppressed`, `prepare_frame.*` y timestamps.
- En tmux: socket nuevo y versión exacta para no reutilizar servidor antiguo; #4983 mostró que olvidar reiniciar el socket dio un falso negativo.

## Preguntas abiertas y próximos pasos

1. ¿Qué motivo exacto de `fullRender(true)` coincide con 12.250 s: `firstChanged < viewportTop`, shrink, altura u otro?
2. ¿Cuántas líneas devuelve el árbol completo de Pi al abrir `/subagents` con 59 filas?
3. ¿Pi emitió uno o dos bloques 2026 alrededor del salto?
4. ¿Herdr tenía un frame/render pending al comenzar el synchronized output interno?
5. ¿La reproducción tmux usa 3.6a, master anterior o posterior al fix #4983?
6. ¿`rows - 1` elimina el fallo o sólo reduce su frecuencia?
7. ¿La incidencia se mantiene con snapshot fixture ASCII y chrome fijo? Eso separaría Unicode/datos vivos del renderer.
8. ¿Cuál es el terminal exterior real de cada repro? El vídeo/local Herdr usa evidencias de Ghostty; la comparación solicitada incluye Kitty, pero no deben mezclarse resultados.
9. Antes del siguiente repro debe repararse o sustituirse el launcher `~/.pi/agent/bin/pi` que apunta a un checkout ausente, sin tocarlo como parte de esta investigación.

## Conclusión

`/subagents` combina exactamente los factores de mayor riesgo para una TUI inline: superficie de altura total, contenido dinámico, cambios tempranos, pantalla primaria con scrollback y repintado periódico. Pi responde a ciertos cambios con un clear completo correctamente envuelto —en intención— por DECSET 2026. Kitty directo puede presentar ese batch de forma atómica; tmux y Herdr deben interpretarlo y volver a dibujarlo, y los antecedentes primarios demuestran que esa mediación ha dejado escapar estados parciales.

El vídeo no confirma aún la capa culpable, pero sí descarta que todo sea una impresión subjetiva o un mero wrap: a 12.250 s existe un frame incompleto entre dos estados coherentes. La corrección futura debe empezar por una captura raw reproducible; luego conviene reducir localmente altura/churn y estabilizar layout, y sólo después decidir entre overlay, fullscreen/alternate-screen upstream o corrección del wrapper.
