import { readSubagentsConfig, subagentSourceWarnings } from '../config.js';
import { SubagentManager } from '../manager.js';
import { runSubagentModelsCommand } from '../model-profiles-ui.js';
import { renderSubagentCompletionMessage, sendSubagentCompletionMessage } from '../render/completion-message.js';
import { registerSubagentTools, triggerClaudeBackgroundHandoff } from '../tools.js';
import { ClaudeBackgroundWidget, ClaudeBackgroundWidgetState } from '../ui/background-widget.js';
import { preloadPiComponentsForSubagentRendering, registerSubagentExternalToolDefinition } from '../thread-view.js';
import { showSubagentsPanel } from '../ui/panel-overlay.js';

function currentSessionId(ctx: any): string | undefined {
  const direct = ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const file = ctx?.sessionManager?.getSessionFile?.();
  return typeof file === 'string' && file.length > 0 ? file : undefined;
}

export default function subagentsExtension(pi: any): void {
  const originalRegisterTool = typeof pi.registerTool === 'function' ? pi.registerTool.bind(pi) : undefined;
  if (originalRegisterTool) {
    pi.registerTool = (tool: any) => {
      registerSubagentExternalToolDefinition(tool?.name, tool);
      return originalRegisterTool(tool);
    };
  }
  pi.registerMessageRenderer?.('subagent-completion', renderSubagentCompletionMessage);
  const manager = new SubagentManager(undefined, undefined, (task, cwd) => {
    sendSubagentCompletionMessage(pi, task, cwd);
  });
  registerSubagentTools(pi, manager, process.cwd());

  let widgetCtx: any;
  let widgetRequestRender: (() => void) | undefined;
  let removeTerminalInputListener: (() => void) | undefined;
  let removeTaskUpdateListener: (() => void) | undefined;
  let widgetState: ClaudeBackgroundWidgetState | undefined;
  let widgetInputSuspended = false;
  let activePanelCancelSelected: (() => void) | undefined;
  let activePanelRequestRender: (() => void) | undefined;

  const installClaudeBackgroundWidget = (ctx: any): boolean => {
    if (typeof ctx?.ui?.setWidget !== 'function') return false;
    const cwd = ctx?.cwd ?? process.cwd();
    const sessionId = currentSessionId(ctx);
    widgetState = new ClaudeBackgroundWidgetState(
      () => manager.listActiveSessionTasks(cwd, sessionId),
      () => widgetRequestRender?.(),
    );
    removeTaskUpdateListener = manager.onTaskUpdate(() => widgetRequestRender?.());
    if (typeof ctx?.ui?.onTerminalInput === 'function') {
      removeTerminalInputListener = ctx.ui.onTerminalInput((data: string) => {
        if (widgetInputSuspended) return undefined;
        const result = widgetState?.handleTerminalInput(data);
        if (result?.action?.type === 'open-task' && widgetCtx) {
          const selectedTaskId = result.action.taskId;
          void (async () => {
            await preloadPiComponentsForSubagentRendering();
            await showSubagentsPanel({
              ctx: widgetCtx,
              pi,
              manager,
              selectedTaskId,
              setWidgetInputSuspended: (value) => { widgetInputSuspended = value; },
              setActivePanelCancelSelected: (fn) => { activePanelCancelSelected = fn; },
              setActivePanelRequestRender: (fn) => { activePanelRequestRender = fn; },
            });
          })();
        }
        return result;
      });
    }
    ctx.ui.setWidget('subagents-claude-background', (tui: any, theme: any) => {
      widgetRequestRender = () => tui?.requestRender?.();
      return new ClaudeBackgroundWidget(widgetState!, theme);
    }, { placement: 'belowEditor' });
    return true;
  };

  const clearClaudeBackgroundWidget = () => {
    widgetRequestRender = undefined;
    removeTaskUpdateListener?.();
    removeTaskUpdateListener = undefined;
    removeTerminalInputListener?.();
    removeTerminalInputListener = undefined;
    widgetState = undefined;
    widgetInputSuspended = false;
    widgetCtx?.ui?.setWidget?.('subagents-claude-background', undefined);
    widgetCtx = undefined;
  };

  pi.on?.('session_start', (_event: unknown, ctx: any) => {
    void preloadPiComponentsForSubagentRendering();
    clearClaudeBackgroundWidget();
    const cwd = ctx?.cwd ?? process.cwd();
    manager.reconcileOrphanedTasks(cwd);
    for (const warning of subagentSourceWarnings(cwd)) ctx?.ui?.notify?.(warning, 'warning');
    if (typeof ctx?.ui?.setWidget !== 'function') return;
    widgetCtx = ctx;
    if (!installClaudeBackgroundWidget(ctx)) return;
  });

  pi.on?.('session_shutdown', () => {
    manager.cancelRunning('Pi session shutdown');
    clearClaudeBackgroundWidget();
  });

  const historyPanelShortcut = readSubagentsConfig(process.cwd()).history_panel_shortcut ?? 'ctrl+,';
  pi.registerShortcut?.(historyPanelShortcut, {
    description: 'Show subagent history panel',
    handler: async (ctx: any) => {
      await preloadPiComponentsForSubagentRendering();
      await showSubagentsPanel({
        ctx,
        pi,
        manager,
        setWidgetInputSuspended: (value) => { widgetInputSuspended = value; },
        setActivePanelCancelSelected: (fn) => { activePanelCancelSelected = fn; },
        setActivePanelRequestRender: (fn) => { activePanelRequestRender = fn; },
      });
    },
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
    handler: async () => {
      triggerClaudeBackgroundHandoff();
    },
  });

  pi.registerCommand?.('subagents', {
    description: 'Show subagent history panel',
    handler: async (_args: string, ctx: any) => {
      await preloadPiComponentsForSubagentRendering();
      return showSubagentsPanel({
        ctx: { ...ctx, pi },
        pi,
        manager,
        setWidgetInputSuspended: (value) => { widgetInputSuspended = value; },
        setActivePanelCancelSelected: (fn) => { activePanelCancelSelected = fn; },
        setActivePanelRequestRender: (fn) => { activePanelRequestRender = fn; },
      });
    },
  });

  pi.registerCommand?.('subagent-models', {
    description: 'Configure subagent and SDD phase model profiles',
    handler: async (_args: string, ctx: any) => runSubagentModelsCommand({ ...ctx, pi }),
  });
}
