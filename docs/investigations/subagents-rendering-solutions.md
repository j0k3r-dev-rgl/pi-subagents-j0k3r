# Opciones para estabilizar el renderizado de `/subagents`

Este documento convierte la investigación de parpadeos en un plan experimental. La recomendación es instrumentar primero el renderer, comparar todas las alternativas con la misma evidencia y aplicar inicialmente los cambios locales de menor riesgo: respetar el ancho recibido, estabilizar el layout y usar medición Unicode/ANSI compatible con Pi.

> Estado: propuesta aprobada para documentación e instrumentación. Ninguna corrección de renderizado está implementada todavía.

## Decisión rápida

1. Crear una base diagnóstica con logging JSONL desactivado por defecto.
2. Registrar únicamente metadata; nunca prompts, snapshots ni texto renderizado.
3. Reproducir el salto directamente y bajo HerdR/tmux.
4. Probar primero el contrato de ancho y el layout estable.
5. Evaluar overlay o cambios upstream solamente si el problema persiste.

El análisis que fundamenta estas opciones está en [`subagents-rendering-herdr-tmux.md`](./subagents-rendering-herdr-tmux.md).

## Problema observado

Durante determinados refrescos de `/subagents`, el panel desaparece por uno o pocos frames y deja visible la conversación principal antes de reaparecer. El vídeo analizado muestra geometría exterior estable, por lo que el evento encaja mejor con un redraw destructivo no presentado atómicamente que con un resize o scroll normal.

La evidencia actual apunta a la interacción de tres factores:

- una custom UI dinámica que ocupa la altura completa;
- los fallbacks de `pi-tui` a `fullRender(true)` sobre la pantalla primaria;
- wrappers como HerdR o tmux que emulan y vuelven a dibujar el contenido.

También existen defectos locales potencialmente contribuyentes:

- ancho mínimo artificial en paneles estrechos;
- medición por code points en lugar de celdas terminales;
- truncado que no preserva necesariamente secuencias ANSI;
- estructura vertical que puede cambiar con metadata condicional;
- posible recreación o pérdida de estado del panel durante su ciclo de vida.

## Objetivos

- Identificar el motivo exacto de cada render y redraw observable.
- Comparar terminal directo, HerdR y tmux con evidencia equivalente.
- Garantizar que `/subagents` respete el ancho y la altura asignados por Pi.
- Mantener estable el layout entre estados de una tarea.
- Preservar selección, scroll, follow-tail y cachés mientras la vista siga abierta.
- Validar Unicode, ANSI, terminales estrechas y resize con tests reproducibles.

## Fuera de alcance inicial

- Cambiar la UX de `/subagents` sin evidencia comparativa.
- Manipular alternate screen directamente desde la extensión.
- Parchear `pi-tui`, HerdR o tmux antes de aislar qué capa publica el frame intermedio.
- Registrar prompts, respuestas, snapshots o texto visible.
- Cambiar globalmente `TERM`, fuentes o configuración de la terminal.

## Estrategia de ramas

| Rama | Propósito | Parte de |
|---|---|---|
| `diagnostics/subagents-render` | Documento, logger y reproducción base | `main` |
| `fix/render-width-contract` | Respetar el ancho recibido y medir celdas correctamente | rama diagnóstica |
| `fix/render-stable-layout` | Mantener altura, chrome y estado estables | rama diagnóstica o width-contract validada |
| `experiment/render-overlay` | Comparar una composición overlay acotada | rama diagnóstica |
| `experiment/render-persistent-panel` | Probar lifecycle con una instancia persistente | rama diagnóstica |

Las ramas experimentales no deben abrirse todas a la vez. Primero debe completarse y validarse la instrumentación común.

## Instrumentación propuesta

### Principios

- Desactivada por defecto.
- Activación explícita en la configuración de subagentes.
- Formato JSONL: un objeto JSON por evento.
- Escritura best-effort: un fallo de logging nunca debe romper la UI.
- Metadata segura y acotada.
- Sin contenido de usuario o del subagente.
- Ruta configurable y adecuada para archivos temporales o de diagnóstico.

### Configuración propuesta

El nombre definitivo debe alinearse con el esquema existente durante la implementación. El contrato deseado es:

```json
{
  "renderDebug": {
    "enabled": false,
    "path": "/tmp/pi-subagents-render.jsonl"
  }
}
```

Para una reproducción controlada:

```json
{
  "renderDebug": {
    "enabled": true,
    "path": "/tmp/pi-subagents-render.jsonl"
  }
}
```

Si `path` no está definido, la implementación deberá elegir una ruta diagnóstica segura y documentada. No debe escribir dentro del repositorio por defecto.

### Eventos

| Evento | Momento |
|---|---|
| `panel_created` | Se crea o monta la vista custom. |
| `panel_disposed` | Se cierra o desmonta la vista. |
| `render_requested` | Un timer, input o cambio de tarea solicita render. |
| `render_started` | Comienza `render(width)`. |
| `tasks_loaded` | Termina la consulta de tareas para el frame. |
| `render_completed` | Se producen las líneas y métricas finales. |
| `input_received` | La vista procesa una acción normalizada, no la tecla cruda. |
| `selection_changed` | Cambia la tarea seleccionada. |
| `viewport_changed` | Cambian scroll, follow-tail o dimensiones internas. |
| `render_warning` | Una línea excede ancho, cambia altura inesperadamente o falla una invariante. |
| `logger_error` | La escritura falla; debe estar acotado y no ser recursivo. |

### Metadata común

```json
{
  "schemaVersion": 1,
  "event": "render_completed",
  "timestamp": "2026-07-09T22:00:00.000Z",
  "sequence": 42,
  "sessionIdHash": "sha256:…",
  "panelInstanceId": "random-non-secret-id",
  "terminal": {
    "term": "xterm-256color",
    "colorterm": "truecolor",
    "termProgram": "ghostty",
    "insideTmux": false,
    "insideHerdr": true
  },
  "dimensions": {
    "stdoutColumns": 207,
    "stdoutRows": 59,
    "renderWidth": 207,
    "configuredMaxLines": 59,
    "renderedLineCount": 59,
    "maxVisibleWidth": 205,
    "bodyHeight": 49
  },
  "state": {
    "taskCount": 4,
    "selectedIndex": 1,
    "selectedTaskIdHash": "sha256:…",
    "selectedStatus": "running",
    "scrollOffset": 0,
    "followTail": true,
    "hasUsage": false,
    "snapshotItemCount": 23
  },
  "render": {
    "reason": "interval",
    "durationMs": 3.2,
    "structureHash": "sha256:…",
    "heightChanged": false,
    "widthViolationCount": 0
  }
}
```

Los nombres exactos pueden ajustarse durante el diseño técnico, pero las garantías de privacidad y los campos necesarios para correlación deben conservarse.

### Datos prohibidos

El logger no debe guardar:

- prompt o instrucciones del usuario;
- output o razonamiento del subagente;
- snapshots serializados;
- texto renderizado;
- nombres o contenido de archivos inspeccionados;
- variables de entorno completas;
- tokens, credenciales o rutas potencialmente sensibles sin necesidad diagnóstica;
- teclas crudas o contenido pegado.

Los identificadores se deben omitir o convertir en hashes no reversibles cuando sólo se necesite correlación.

### Correlación con Pi

El logger local no puede observar por sí solo el motivo interno de `pi-tui fullRender(true)`. Durante las reproducciones se combinará con:

```bash
PI_DEBUG_REDRAW=1 \
PI_TUI_DEBUG=1 \
PI_TUI_WRITE_LOG=/tmp/pi-subagents-ansi.log \
pi
```

La correlación mínima requiere:

- timestamps comparables;
- secuencia de renders local;
- logs de redraw de Pi;
- stream ANSI;
- vídeo o frames del terminal exterior;
- dimensiones PTY y eventos de resize cuando estén disponibles.

## Opciones de solución

### Opción A — Respetar el contrato de ancho

Eliminar mínimos artificiales que hagan que `render(width)` emita contenido más ancho que el valor recibido.

**Cambios esperados**

- Permitir paneles de 20–39 columnas sin producir líneas de 40.
- Diseñar una presentación degradada para anchos mínimos.
- Verificar cada línea con la medición visible canónica de Pi.

**Ventajas**

- Corrige una violación local y comprobable.
- Reduce wrap, overflow y redraws amplificados por terminales estrechos.
- Riesgo de implementación relativamente bajo.

**Límites**

- No explica por sí sola la desaparición completa del panel en un pane ancho.

### Opción B — Medición y truncado Unicode/ANSI seguros

Sustituir helpers basados en code points por utilidades compatibles con ancho de terminal, grafemas y secuencias ANSI.

**Casos obligatorios**

- CJK;
- emoji simples;
- flags y secuencias ZWJ;
- combining marks;
- ANSI SGR y resets;
- texto sin estilo.

**Ventajas**

- Cumple el contrato documentado de `pi-tui`.
- Evita cortar escapes o producir estilos corruptos.

**Límites**

- Es hardening transversal, no una solución aislada al frame intermedio.

### Opción C — Layout vertical estable

Mantener constantes la altura total y la posición de chrome/body durante queued, running, completed y error.

**Cambios esperados**

- Reservar siempre la fila de usage aunque todavía no haya datos.
- Calcular altura disponible sin asumir que todas las filas físicas pertenecen al componente.
- Mantener header, footer y divisor en posiciones estables.
- Detectar cambios inesperados de altura mediante logging y tests.

**Ventajas**

- Reduce triggers de shrink y cambios masivos de líneas.
- Conserva la UX actual.

**Riesgos**

- Si el componente sigue anclado tras scrollback previo, puede persistir el trigger `firstChanged < viewportTop`.

### Opción D — Instancia persistente del panel

Crear la instancia fuera de callbacks que Pi pueda volver a invocar y controlar explícitamente su lifecycle.

**Objetivo**

Preservar:

- tarea seleccionada;
- scroll;
- follow-tail;
- estado expandido;
- cachés;
- secuencia de logging.

**Condición previa**

La investigación de código debe confirmar si la factory se recrea durante el evento observado. No se implementará basándose únicamente en la captura secundaria.

### Opción E — Overlay acotado

Renderizar `/subagents` como overlay con altura máxima y viewport interno estable.

**Ventajas**

- Reduce interacción con el scrollback principal.
- Usa composición y clipping proporcionados por Pi.

**Riesgos**

- Cambia UX, foco y posiblemente navegación.
- Overlays altos también pueden provocar redraws conservadores.

Debe tratarse como experimento comparativo, no como primera corrección.

### Opción F — Superficie fullscreen coordinada con Pi

Proponer upstream un contrato de custom UI fullscreen o alternate screen gestionado por Pi.

**Ventajas**

- Separa la vista del scrollback de conversación.
- Ataca la limitación arquitectónica de una UI fullscreen sobre pantalla primaria.

**Riesgos**

- Mayor alcance y dependencia upstream.
- Puede afectar imágenes, selección, restore y TUIs anidadas.
- La extensión no debe emitir `CSI ?1049` unilateralmente.

### Opción G — Atomicidad en HerdR/tmux

Si el stream demuestra que Pi emite un único batch sincronizado pero el wrapper publica dos frames, preparar un caso mínimo upstream.

**Evidencia necesaria**

```text
Pi: ?2026h → clear → panel completo → ?2026l
Wrapper: frame sin panel → frame con panel
Vídeo: exposición temporal de la conversación
```

Sin esa secuencia no se atribuirá el defecto exclusivamente al wrapper.

## Orden recomendado de experimentos

| Orden | Experimento | Razón |
|---:|---|---|
| 1 | Instrumentación común | Convierte hipótesis en evidencia comparable. |
| 2 | Ancho + Unicode/ANSI | Corrige violaciones locales verificables. |
| 3 | Layout estable | Reduce redraws destructivos sin cambiar UX. |
| 4 | Lifecycle persistente | Sólo si los logs muestran recreación o pérdida de estado. |
| 5 | Overlay | Alternativa de composición si persiste el salto. |
| 6 | Cambio upstream Pi/HerdR/tmux | Requiere captura mínima que identifique la capa responsable. |

## Estrategia TDD

### Logger

Los tests deben escribirse antes de la implementación y demostrar:

- desactivado por defecto: no crea ni abre archivos;
- activado: escribe JSONL válido y ordenado;
- no incluye campos o contenido prohibidos;
- errores de filesystem no interrumpen render ni input;
- cada panel tiene una secuencia monotónica;
- paths configurados se validan y fallan de forma segura;
- metadata mantiene límites de tamaño;
- el logger se cierra o libera correctamente al disponer el panel.

### Ancho y Unicode

- anchos 20, 25, 39, 40, 80 y 100;
- `visibleWidth(line) <= renderWidth` para todas las líneas;
- CJK, emoji, ZWJ, combining marks y ANSI;
- nunca cortar una secuencia ANSI;
- degradación legible en paneles estrechos.

### Layout y lifecycle

- igual cantidad de líneas durante cambios de estado;
- posiciones estables al aparecer usage o error;
- selección, scroll y follow-tail preservados;
- resize repetido sin estado inválido;
- timer e input no crean renders duplicados innecesarios.

### Integración con `pi-tui`

Un terminal fake debe capturar writes ANSI con conversación previa mayor que el viewport. Las pruebas deben contar:

- renders completos;
- `CSI 2J` y `CSI 3J`;
- batches `?2026h/l` balanceados;
- exposición de líneas pertenecientes exclusivamente a la conversación principal.

## Matriz de validación

| Caso | Terminal exterior | Wrapper | Ancho | Resultado esperado |
|---|---|---|---:|---|
| Control | Ghostty | ninguno | normal | Sin frame intermedio. |
| Control | Kitty | ninguno | normal | Sin frame intermedio. |
| Estrecho | Ghostty/Kitty | ninguno | 20–39 | Sin overflow ni ANSI roto. |
| Multiplexor | Ghostty | tmux | normal | Sin exposición de conversación. |
| Workspace | Ghostty | HerdR | normal | Sin exposición de conversación. |
| Resize | cualquiera | cada wrapper | variable | Layout y estado estables. |

## Criterios para aceptar una corrección

- No aparece la conversación subyacente mientras `/subagents` está abierto.
- No hay líneas cuyo ancho visible exceda el entregado por Pi.
- La altura total permanece estable salvo resize confirmado.
- El panel conserva selección y viewport durante refreshes.
- Logging desactivado no produce I/O ni altera comportamiento observable.
- Logging activado no contiene información sensible.
- Los tests unitarios, de integración y la matriz manual relevante pasan.
- No se modifica configuración terminal global para ocultar el defecto.

## Próximo paso aprobado

Implementar únicamente la instrumentación en `diagnostics/subagents-render`, comenzando por tests que fallen correctamente. Antes de editar código se debe inspeccionar el esquema real de configuración y los puntos de lifecycle/render con herramientas de investigación de código. La implementación y su verificación serán una fase separada de este documento y requerirán su propio checkpoint antes del commit.
