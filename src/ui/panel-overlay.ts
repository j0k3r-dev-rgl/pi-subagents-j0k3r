import { readSubagentsConfig } from '../config.js';
import type { GenerationToken, RuntimeResolverV1 } from '../runtime-registry.js';
import type { SubagentTask } from '../types.js';
import { createSubagentsRenderLogger } from '../render-debug.js';
import { truncateToWidth, visibleWidth } from '../render/text-width.js';
import { resolveSubagentExternalToolDefinitionFromInfo } from '../thread-view.js';
import { SubagentsHistoryPanel } from './subagents-history-panel.js';
import { classifySubagentsPanelInput, createSubagentsPanelKeyMatcher } from './panel-input.js';

function contextWindowForTask(ctx: any, task: SubagentTask): number | undefined {
  const label = task.model;
  const current = ctx?.model;
  const currentLabel = current?.provider && current?.id ? `${current.provider}/${current.id}` : undefined;
  let model = !label || label === 'default/current' || label === currentLabel ? current : undefined;
  if (!model && label) {
    const separator = label.indexOf('/');
    if (separator > 0) model = ctx?.modelRegistry?.find?.(label.slice(0, separator), label.slice(separator + 1));
  }
  const contextWindow = Number(model?.contextWindow);
  return Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
}

function setMouseTracking(tui: any, enabled: boolean): void {
  // In Pi fullscreen mode (TuiAltScreen), the host TUI already enables and owns
  // full mouse tracking (ENABLE_BUTTON_MOTION_MOUSE / SGR mode). Emitting raw
  // disabling escapes like \u001b[?1000l can break the terminal mouse mode in
  // fullscreen or regular scroll mode upon closing or refocusing the overlay.
  if (tui?.mode === 'fullscreen') return;
  const write = tui?.terminal?.write?.bind(tui.terminal);
  if (typeof write !== 'function') return;
  write(enabled ? '\u001b[?1000h\u001b[?1006h' : '\u001b[?1006l\u001b[?1000l');
}

function toolFromRegistry(registry: any, name: string): unknown {
  if (!registry) return undefined;
  if (typeof registry.get === 'function') return registry.get(name);
  if (Array.isArray(registry)) return registry.find((tool) => tool?.name === name);
  if (typeof registry === 'object') return registry[name];
  return undefined;
}

function toolsFromAccessor(owner: any, name: string): unknown {
  if (typeof owner?.getAllTools !== 'function') return undefined;
  try {
    const info = toolFromRegistry(owner.getAllTools(), name);
    return info ? (resolveSubagentExternalToolDefinitionFromInfo(name, info) ?? info) : undefined;
  } catch {
    return undefined;
  }
}

export function resolveRegisteredToolDefinition(ctx: any, pi: any, name: string): unknown {
  return ctx?.pi?.getToolDefinition?.(name)
    ?? pi?.getToolDefinition?.(name)
    ?? ctx?.getToolDefinition?.(name)
    ?? toolsFromAccessor(ctx?.pi, name)
    ?? toolsFromAccessor(pi, name)
    ?? toolsFromAccessor(ctx, name)
    ?? toolFromRegistry(ctx?.pi?.tools, name)
    ?? toolFromRegistry(pi?.tools, name)
    ?? toolFromRegistry(ctx?.tools, name);
}

export type SubagentsPanelOpener = (taskId?: string) => Promise<void> | void;
type OwnedPanelOpener = { token: GenerationToken; opener: SubagentsPanelOpener };
let activePanelOpener: OwnedPanelOpener | undefined;
let lastPanelOpenTime = 0;
const LEGACY_PANEL_TOKEN = Symbol.for('pi-subagents-j0k3r.panel-opener.legacy');

export function registerSubagentsPanelOpener(token: GenerationToken, opener: SubagentsPanelOpener): () => void;
export function registerSubagentsPanelOpener(opener: SubagentsPanelOpener | undefined): () => void;
export function registerSubagentsPanelOpener(tokenOrOpener: GenerationToken | SubagentsPanelOpener | undefined, ownedOpener?: SubagentsPanelOpener): () => void {
  const token = typeof tokenOrOpener === 'symbol' ? tokenOrOpener : LEGACY_PANEL_TOKEN;
  const opener = typeof tokenOrOpener === 'function' ? tokenOrOpener : ownedOpener;
  if (!opener) {
    if (token === LEGACY_PANEL_TOKEN) activePanelOpener = undefined;
    return () => undefined;
  }
  activePanelOpener = { token, opener };
  lastPanelOpenTime = 0;
  return () => {
    if (activePanelOpener?.token === token) activePanelOpener = undefined;
  };
}

export function resetSubagentsPanelOpenerStateForTests(): void {
  lastPanelOpenTime = 0;
}

export function openSubagentsPanel(taskId?: string): void {
  const now = Date.now();
  if (now - lastPanelOpenTime < 600) return;
  lastPanelOpenTime = now;
  if (activePanelOpener) {
    void activePanelOpener.opener(taskId);
  }
}

export async function showSubagentsPanel(input: {
  resolver: RuntimeResolverV1;
  sessionId: string;
  token: GenerationToken;
  selectedTaskId?: string;
  setWidgetInputSuspended: (value: boolean) => void;
  setActivePanelCancelSelected: (fn: (() => void) | undefined) => void;
  setActivePanelRequestRender: (fn: (() => void) | undefined) => void;
}) {
  const { resolver, sessionId, token, selectedTaskId, setWidgetInputSuspended, setActivePanelCancelSelected, setActivePanelRequestRender } = input;
  const owned = () => {
    try {
      const resolution = resolver.resolveSession(sessionId);
      return resolution.link.token === token ? resolution : undefined;
    } catch {
      return undefined;
    }
  };
  const initial = owned();
  if (!initial) return;
  const cwd = initial.link.cwd;
  const initialCtx = initial.link.ctx as any;
  let refresh: NodeJS.Timeout | undefined;
  setWidgetInputSuspended(true);
  try {
    await initialCtx.ui?.custom?.(
      (tui: any, theme: any, _keybindings: any, done: () => void) => {
        setMouseTracking(tui, true);
        const config = readSubagentsConfig(cwd);
        const renderLogger = createSubagentsRenderLogger({ cwd, sessionId, config: config.render_debug });
        let nextRenderReason = 'initial';
        let renderCycle = 0;
        const close = () => {
          if (refresh) clearInterval(refresh);
          renderLogger.log({ event: 'panel_disposed' });
          setMouseTracking(tui, false);
          done();
        };
        const baseMatchesKey = createSubagentsPanelKeyMatcher(_keybindings);
        const panel = new SubagentsHistoryPanel(
          () => owned()?.manager.listSessionTasks(cwd, sessionId).slice(0, 100) ?? [],
          theme,
          close,
          (data: string, key: string) => {
            if (key !== 'detailCancel') return baseMatchesKey(data, key);
            const detailShortcut = config.detail_cancel_shortcut ?? 'x';
            return baseMatchesKey(data, detailShortcut)
              || baseMatchesKey(data, 'detailCancel')
              || (detailShortcut === 'ctrl+w' && _keybindings?.matches?.(data, 'tui.editor.deleteWordBackward'));
          },
          visibleWidth,
          truncateToWidth,
          {
            theme,
            tui,
            cwd,
            visibleWidth,
            truncateToWidth,
            getToolDefinition: (name: string) => {
              const current = owned();
              return current ? resolveRegisteredToolDefinition(current.link.ctx, current.link.pi, name) : undefined;
            },
            getMessageRenderer: (customType: string) => {
              const current = owned();
              const currentCtx = current?.link.ctx as any;
              return currentCtx?.pi?.getMessageRenderer?.(customType) ?? currentCtx?.pi?.customMessageRenderers?.get?.(customType) ?? currentCtx?.customMessageRenderers?.get?.(customType);
            },
            showImages: initialCtx.showImages,
            imageWidthCells: initialCtx.imageWidthCells,
          },
          () => Math.max(12, tui?.terminal?.rows ?? process.stdout.rows ?? 42),
          (id: string) => owned()?.manager.getTask(id, cwd),
          selectedTaskId,
          (id: string) => owned()?.manager.cancel(id, 'cancelled from subagents detail view'),
          config.detail_cancel_shortcut ?? 'x',
          {
            timeoutMs: config.timeout_ms,
            stallTimeoutMs: config.stall_timeout_ms,
            contextWindowForTask: (task: SubagentTask) => contextWindowForTask(owned()?.link.ctx, task),
          },
        );
        renderLogger.log({ event: 'panel_created' });
        renderLogger.log({ event: 'render_requested', reason: nextRenderReason });
        setActivePanelCancelSelected(() => () => panel.cancelSelectedActiveTask());
        setActivePanelRequestRender(() => () => {
          nextRenderReason = 'external';
          renderLogger.log({ event: 'render_requested', reason: nextRenderReason });
          tui.requestRender?.();
        });
        refresh = setInterval(() => {
          if (!owned()) {
            close();
            return;
          }
          nextRenderReason = 'interval';
          renderLogger.log({ event: 'render_requested', reason: nextRenderReason });
          tui.requestRender?.();
        }, 1000);
        return {
          render: (width: number) => {
            const reason = nextRenderReason;
            const currentRenderCycle = ++renderCycle;
            renderLogger.log({
              event: 'render_started',
              reason,
              renderCycle: currentRenderCycle,
              dimensions: {
                stdoutColumns: process.stdout.columns,
                stdoutRows: process.stdout.rows,
                renderWidth: width,
              },
            });
            const startedAt = process.hrtime.bigint();
            const lines = panel.render(width);
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            renderLogger.log({
              event: 'render_completed',
              reason,
              renderCycle: currentRenderCycle,
              durationMs,
              dimensions: {
                stdoutColumns: process.stdout.columns,
                stdoutRows: process.stdout.rows,
                renderWidth: width,
              },
              state: panel.getRenderDebugState(),
            });
            nextRenderReason = 'external';
            return lines;
          },
          invalidate: () => panel.invalidate(),
          handleMouse: (event: any) => {
            nextRenderReason = 'mouse';
            renderLogger.log({ event: 'render_requested', reason: nextRenderReason });
            const result = panel.handleMouse(event);
            if (result?.render !== false) tui.requestRender?.();
            return result;
          },
          handleInput: (data: string) => {
            renderLogger.log({ event: 'input_received', input: classifySubagentsPanelInput(data, baseMatchesKey) });
            nextRenderReason = 'input';
            renderLogger.log({ event: 'render_requested', reason: nextRenderReason });
            panel.handleInput(data);
            tui.requestRender?.();
          },
        };
      },
      { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } },
    );
  } finally {
    setActivePanelCancelSelected(undefined);
    setActivePanelRequestRender(undefined);
    setWidgetInputSuspended(false);
  }
}
