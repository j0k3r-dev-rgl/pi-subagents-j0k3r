import { readSubagentsConfig, subagentSourceWarnings } from '../config.js';
import { SubagentManager } from '../manager.js';
import { runSubagentModelsCommand } from '../model-profiles-ui.js';
import { renderSubagentCompletionMessage } from '../render/completion-message.js';
import {
  beginClosing,
  bindSessionGeneration,
  enqueueOrDeliverTerminal,
  getRuntimeResolver,
  markReloading,
  ownsGeneration,
  sessionIdFromContext,
} from '../runtime-registry.js';
import type { RuntimeEntryV1 } from '../runtime-registry.js';
import { registerSubagentTools, triggerClaudeBackgroundHandoff } from '../tools.js';
import { ClaudeBackgroundWidget, ClaudeBackgroundWidgetState } from '../ui/background-widget.js';
import { preloadPiComponentsForSubagentRendering, registerSubagentExternalToolDefinition } from '../thread-view.js';
import { registerSubagentsPanelOpener, showSubagentsPanel } from '../ui/panel-overlay.js';

export default function subagentsExtension(pi: any): void {
  const generationToken = Symbol('pi-subagents-generation');
  const resolver = getRuntimeResolver();
  let boundEntry: RuntimeEntryV1 | undefined;
  let boundSessionId: string | undefined;

  const originalRegisterTool = typeof pi.registerTool === 'function' ? pi.registerTool.bind(pi) : undefined;
  if (originalRegisterTool) {
    pi.registerTool = (tool: any) => {
      registerSubagentExternalToolDefinition(tool?.name, tool);
      return originalRegisterTool(tool);
    };
  }
  pi.registerMessageRenderer?.('subagent-completion', renderSubagentCompletionMessage);
  registerSubagentTools(pi, resolver, process.cwd());

  const widgetInputSuspensions = new Set<string>();
  const setWidgetInputSuspended = (reason: string, active: boolean): void => {
    if (active) widgetInputSuspensions.add(reason);
    else widgetInputSuspensions.delete(reason);
  };
  let widgetCtx: any;
  let widgetRequestRender: (() => void) | undefined;
  let removeTerminalInputListener: (() => void) | undefined;
  let removeTaskUpdateListener: (() => void) | undefined;
  let widgetState: ClaudeBackgroundWidgetState | undefined;
  let activePanelCancelSelected: (() => void) | undefined;
  let activePanelRequestRender: (() => void) | undefined;
  let removePanelOpener: (() => void) | undefined;

  const stillOwnsBoundGeneration = (): boolean => Boolean(
    boundEntry && boundSessionId && ownsGeneration(boundEntry, boundSessionId, generationToken),
  );

  const panelCallbacks = {
    setWidgetInputSuspended: (value: boolean) => { setWidgetInputSuspended('panel', value); },
    setActivePanelCancelSelected: (fn: (() => void) | undefined) => { activePanelCancelSelected = fn; },
    setActivePanelRequestRender: (fn: (() => void) | undefined) => { activePanelRequestRender = fn; },
  };

  const openPanel = async (sessionId: string, taskId?: string): Promise<void> => {
    await preloadPiComponentsForSubagentRendering();
    if (!stillOwnsBoundGeneration()) return;
    await showSubagentsPanel({ resolver, sessionId, token: generationToken, selectedTaskId: taskId, ...panelCallbacks });
  };

  const clearClaudeBackgroundWidget = (): void => {
    widgetRequestRender = undefined;
    removeTaskUpdateListener?.();
    removeTaskUpdateListener = undefined;
    removeTerminalInputListener?.();
    removeTerminalInputListener = undefined;
    widgetState = undefined;
    widgetInputSuspensions.clear();
    widgetCtx?.ui?.setWidget?.('subagents-claude-background', undefined);
    widgetCtx = undefined;
  };

  const clearOwnedUi = (): void => {
    removePanelOpener?.();
    removePanelOpener = undefined;
    clearClaudeBackgroundWidget();
    activePanelCancelSelected = undefined;
    activePanelRequestRender = undefined;
  };

  const installClaudeBackgroundWidget = (ctx: any, entry: RuntimeEntryV1): boolean => {
    if (typeof ctx?.ui?.setWidget !== 'function') return false;
    const cwd = ctx?.cwd ?? process.cwd();
    const sessionId = entry.sessionId;
    widgetState = new ClaudeBackgroundWidgetState(
      () => {
        try { return resolver.resolveSession(sessionId).manager.listActiveSessionTasks(cwd, sessionId); }
        catch { return []; }
      },
      () => widgetRequestRender?.(),
    );
    removeTaskUpdateListener = entry.manager.onTaskUpdate(() => widgetRequestRender?.());
    if (typeof ctx?.ui?.onTerminalInput === 'function') {
      removeTerminalInputListener = ctx.ui.onTerminalInput((data: string) => {
        if (!stillOwnsBoundGeneration() || widgetInputSuspensions.size > 0) return undefined;
        const current = resolver.resolveSession(sessionId);
        const currentCtx = current.link.ctx as any;
        const editorText = typeof currentCtx?.ui?.getEditorText === 'function' ? String(currentCtx.ui.getEditorText() ?? '') : '';
        const result = widgetState?.handleTerminalInput(data, { allowActivate: !editorText.trim() });
        if (result?.action?.type === 'open-task') void openPanel(sessionId, result.action.taskId);
        return result;
      });
    }
    ctx.ui.setWidget('subagents-claude-background', (tui: any, theme: any) => {
      widgetRequestRender = () => tui?.requestRender?.();
      return new ClaudeBackgroundWidget(widgetState!, theme);
    }, { placement: 'belowEditor' });
    return true;
  };

  pi.on?.('session_start', (_event: unknown, ctx: any) => {
    const sessionId = sessionIdFromContext(ctx);
    const cwd = ctx?.cwd ?? process.cwd();
    let createdEntry: RuntimeEntryV1 | undefined;
    const binding = bindSessionGeneration({
      sessionId,
      token: generationToken,
      pi,
      ctx,
      cwd,
      createManager: (access) => new SubagentManager(
        undefined,
        undefined,
        (task, taskCwd) => {
          if (createdEntry) enqueueOrDeliverTerminal(createdEntry, task, taskCwd);
        },
        undefined,
        access,
      ),
    });
    createdEntry = binding.entry;
    boundEntry = binding.entry;
    boundSessionId = sessionId;
    if (binding.created) binding.entry.manager.reconcileOrphanedTasks(cwd);
    for (const warning of subagentSourceWarnings(cwd)) ctx?.ui?.notify?.(warning, 'warning');
    widgetCtx = ctx;
    removePanelOpener = registerSubagentsPanelOpener(generationToken, (taskId?: string) => openPanel(sessionId, taskId));
    void preloadPiComponentsForSubagentRendering();
    installClaudeBackgroundWidget(ctx, binding.entry);
  });

  pi.on?.('session_shutdown', (event: { reason?: unknown } | undefined, ctx: any) => {
    const sessionId = sessionIdFromContext(ctx);
    const entry = boundEntry;
    if (!entry || boundSessionId !== sessionId || !ownsGeneration(entry, sessionId, generationToken)) return undefined;
    const reason = typeof event?.reason === 'string' && event.reason.length > 0 ? event.reason : 'unknown';
    if (reason === 'reload') {
      if (markReloading(entry, sessionId, generationToken)) clearOwnedUi();
      return undefined;
    }
    const closePromise = beginClosing(entry, sessionId, generationToken, reason);
    clearOwnedUi();
    return closePromise;
  });

  const historyPanelShortcut = readSubagentsConfig(process.cwd()).history_panel_shortcut ?? 'ctrl+,';
  pi.registerShortcut?.(historyPanelShortcut, {
    description: 'Show subagent history panel',
    handler: async (ctx: any) => openPanel(sessionIdFromContext(ctx)),
  });

  const detailCancelShortcut = readSubagentsConfig(process.cwd()).detail_cancel_shortcut ?? 'x';
  if (detailCancelShortcut.startsWith('ctrl+')) {
    pi.registerShortcut?.(detailCancelShortcut, {
      description: 'Cancel selected running subagent from the active subagents detail panel',
      handler: async () => {
        activePanelCancelSelected?.();
        activePanelRequestRender?.();
      },
    });
  }

  const backgroundHandoffShortcut = readSubagentsConfig(process.cwd()).background_handoff_shortcut ?? 'ctrl+h';
  pi.registerShortcut?.(backgroundHandoffShortcut, {
    description: 'Send running subagent task to background',
    handler: async () => { triggerClaudeBackgroundHandoff(); },
  });

  pi.registerCommand?.('subagents', {
    description: 'Show subagent history panel',
    handler: async (_args: string, ctx: any) => openPanel(sessionIdFromContext(ctx)),
  });

  pi.registerCommand?.('subagent-models', {
    description: 'Configure subagent and SDD phase model profiles',
    handler: async (_args: string, ctx: any) => {
      const { link } = resolver.resolve(ctx);
      return runSubagentModelsCommand({ ...ctx, pi: link.pi });
    },
  });
}
