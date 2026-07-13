import { readSubagentsConfig, subagentSourceWarnings } from '../config.js';
import { SubagentManager } from '../manager.js';
import { runSubagentModelsCommand } from '../model-profiles-ui.js';
import { renderSubagentCompletionMessage, sendSubagentCompletionMessage } from '../render/completion-message.js';
import { registerSubagentTools, triggerClaudeBackgroundHandoff } from '../tools.js';
import { ClaudeBackgroundWidget, ClaudeBackgroundWidgetState } from '../ui/background-widget.js';
import { showSubagentsPanel } from '../ui/panel-overlay.js';

function currentSessionId(ctx: any): string | undefined {
  const direct = ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const file = ctx?.sessionManager?.getSessionFile?.();
  return typeof file === 'string' && file.length > 0 ? file : undefined;
}

export default function subagentsExtension(pi: any): void {
  pi.registerMessageRenderer?.('subagent-completion', renderSubagentCompletionMessage);
  const manager = new SubagentManager(undefined, undefined, (task) => {
    sendSubagentCompletionMessage(pi, task);
  });
  registerSubagentTools(pi, manager);

  let widgetTimer: NodeJS.Timeout | undefined;
  let widgetCtx: any;
  let widgetRequestRender: (() => void) | undefined;
  let removeTerminalInputListener: (() => void) | undefined;
  let widgetState: ClaudeBackgroundWidgetState | undefined;
  let widgetInputSuspended = false;
  let activePanelCancelSelected: (() => void) | undefined;
  let activePanelRequestRender: (() => void) | undefined;

  const installClaudeBackgroundWidget = (ctx: any): boolean => {
    if (typeof ctx?.ui?.setWidget !== 'function') return false;
    const cwd = ctx?.cwd ?? process.cwd();
    const config = readSubagentsConfig(cwd);
    if (config.mode !== 'claude') {
      ctx.ui.setWidget('subagents-claude-background', undefined);
      return false;
    }
    const sessionId = currentSessionId(ctx);
    widgetState = new ClaudeBackgroundWidgetState(
      () => manager.listSessionTasks(cwd, sessionId).slice(0, 100),
      () => widgetRequestRender?.(),
    );
    if (typeof ctx?.ui?.onTerminalInput === 'function') {
      removeTerminalInputListener = ctx.ui.onTerminalInput((data: string) => {
        if (widgetInputSuspended) return undefined;
        const result = widgetState?.handleTerminalInput(data);
        if (result?.action?.type === 'open-task' && widgetCtx) void showSubagentsPanel({
          ctx: widgetCtx,
          pi,
          manager,
          selectedTaskId: result.action.taskId,
          setWidgetInputSuspended: (value) => { widgetInputSuspended = value; },
          setActivePanelCancelSelected: (fn) => { activePanelCancelSelected = fn; },
          setActivePanelRequestRender: (fn) => { activePanelRequestRender = fn; },
        });
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
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = undefined;
    widgetRequestRender = undefined;
    removeTerminalInputListener?.();
    removeTerminalInputListener = undefined;
    widgetState = undefined;
    widgetInputSuspended = false;
    widgetCtx?.ui?.setWidget?.('subagents-claude-background', undefined);
    widgetCtx = undefined;
  };

  pi.on?.('session_start', (_event: unknown, ctx: any) => {
    clearClaudeBackgroundWidget();
    const cwd = ctx?.cwd ?? process.cwd();
    for (const warning of subagentSourceWarnings(cwd)) ctx?.ui?.notify?.(warning, 'warning');
    if (typeof ctx?.ui?.setWidget !== 'function') return;
    widgetCtx = ctx;
    if (!installClaudeBackgroundWidget(ctx)) return;
    widgetTimer = setInterval(() => widgetRequestRender?.(), 250);
    widgetTimer.unref?.();
  });

  pi.on?.('session_shutdown', () => {
    clearClaudeBackgroundWidget();
  });

  const historyPanelShortcut = readSubagentsConfig(process.cwd()).history_panel_shortcut ?? 'ctrl+,';
  pi.registerShortcut?.(historyPanelShortcut, {
    description: 'Show subagent history panel',
    handler: async (ctx: any) => {
      const cwd = ctx?.cwd ?? process.cwd();
      if (readSubagentsConfig(cwd).mode === 'claude') return;
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
    description: 'Send running claude subagent task to background',
    handler: async (ctx: any) => {
      const cwd = ctx?.cwd ?? process.cwd();
      if (readSubagentsConfig(cwd).mode !== 'claude') return;
      triggerClaudeBackgroundHandoff();
    },
  });

  pi.registerCommand?.('subagents', {
    description: 'Show subagent history panel',
    handler: async (_args: string, ctx: any) => showSubagentsPanel({
      ctx: { ...ctx, pi },
      pi,
      manager,
      setWidgetInputSuspended: (value) => { widgetInputSuspended = value; },
      setActivePanelCancelSelected: (fn) => { activePanelCancelSelected = fn; },
      setActivePanelRequestRender: (fn) => { activePanelRequestRender = fn; },
    }),
  });

  pi.registerCommand?.('subagent-models', {
    description: 'Configure subagent and SDD phase model profiles',
    handler: async (_args: string, ctx: any) => runSubagentModelsCommand({ ...ctx, pi }),
  });
}
