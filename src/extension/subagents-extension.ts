import { readSubagentsConfig, subagentSourceWarnings } from '../config.js';
import { SubagentManager } from '../manager.js';
import { runSubagentModelsCommand } from '../model-profiles-ui.js';
import { renderSubagentCompletionMessage, sendSubagentCompletionMessage } from '../render/completion-message.js';
import { runSubagentsSessionsCommand } from '../sessions/sessions-command.js';
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
  const manager = new SubagentManager(undefined, undefined, (task, cwd) => {
    sendSubagentCompletionMessage(pi, task, cwd);
  });
  registerSubagentTools(pi, manager, process.cwd());

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
    manager.reconcileOrphanedTasks(cwd);
    for (const warning of subagentSourceWarnings(cwd)) ctx?.ui?.notify?.(warning, 'warning');
    if (typeof ctx?.ui?.setWidget !== 'function') return;
    widgetCtx = ctx;
    if (!installClaudeBackgroundWidget(ctx)) return;
    widgetTimer = setInterval(() => widgetRequestRender?.(), 250);
    widgetTimer.unref?.();
  });

  pi.on?.('session_shutdown', () => {
    manager.cancelRunning('Pi session shutdown');
    clearClaudeBackgroundWidget();
  });

  const historyPanelShortcut = readSubagentsConfig(process.cwd()).history_panel_shortcut ?? 'ctrl+,';
  pi.registerShortcut?.(historyPanelShortcut, {
    description: 'Show subagent history panel',
    handler: async (ctx: any) => {
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
    handler: async (ctx: any) => {
      const sent = triggerClaudeBackgroundHandoff();
      if (!sent) {
        ctx?.ui?.notify?.(
          'No running task-mode subagent to send to background. ctrl+h works only while a subagent runs in task mode.',
          'info',
        );
      }
    },
  });

  const viewSessionInPanel = async (ctx: any, session: { path: string; cwd: string }) => {
    const task = manager.findTaskByNestedSessionPath(session.path);
    await showSubagentsPanel({
      ctx: { ...ctx, pi },
      pi,
      manager,
      selectedTaskId: task?.id,
      scope: { cwd: session.cwd ?? ctx?.cwd, sessionId: task?.session_id },
      setWidgetInputSuspended: (value) => { widgetInputSuspended = value; },
      setActivePanelCancelSelected: (fn) => { activePanelCancelSelected = fn; },
      setActivePanelRequestRender: (fn) => { activePanelRequestRender = fn; },
    });
  };

  const resumeSession = async (ctx: any, session: { path: string; cwd: string }, prompt: string) => {
    const task = manager.findTaskByNestedSessionPath(session.path);
    if (!task) { ctx?.ui?.notify?.('No subagent task found for that session', 'warning'); return; }
    if (!prompt || !prompt.trim()) { ctx?.ui?.notify?.('Empty prompt, session not resumed', 'info'); return; }
    try {
      const result = await manager.continueTask(
        { task_id: task.id, prompt: prompt.trim(), mode: 'background', force: true },
        ctx,
      );
      ctx?.ui?.notify?.(`Subagent resumed (${(result.task_ids ?? []).join(', ') || 'no tasks'})`, 'info');
    } catch (err) {
      ctx?.ui?.notify?.(`Failed to resume: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const sessionsResumeShortcut = readSubagentsConfig(process.cwd()).sessions_resume_shortcut ?? 'ctrl+.';
  pi.registerShortcut?.(sessionsResumeShortcut, {
    description: 'Resume a subagent session in the interactive TUI',
    handler: async (ctx: any) => runSubagentsSessionsCommand({ ctx, onViewSession: (s) => viewSessionInPanel(ctx, s), onBackgroundRunSession: (s, prompt) => resumeSession(ctx, s, prompt) }),
  });

  pi.registerCommand?.('subagents-sessions', {
    description: 'Resume a subagent session in the interactive TUI',
    handler: async (_args: string, ctx: any) => runSubagentsSessionsCommand({ ctx, onViewSession: (s) => viewSessionInPanel(ctx, s), onBackgroundRunSession: (s, prompt) => resumeSession(ctx, s, prompt) }),
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
