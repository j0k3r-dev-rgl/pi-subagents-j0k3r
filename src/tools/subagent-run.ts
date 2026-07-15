import { Type } from 'typebox';
import { readSubagentsConfig } from '../config.js';
import type { SubagentManager } from '../manager.js';
import type { SubagentTask } from '../types.js';
import { appendSubagentResumeGuidance, formatTask, backgroundLaunchContent, formatTaskModeContent } from '../render/tools/formatting.js';
import { progressText } from '../render/tools/progress.js';
import { renderSubagentRunCall, renderSubagentRunResult } from '../render/tools/subagent-run.js';
import { installBackgroundHandoffShortcut } from './background-handoff-state.js';
import { compactResultDetails, compactTaskForToolResult } from './result-details.js';
import { ok, fail } from './tool-response.js';

export function installDoubleEscapeCancel(ctx: any, manager: SubagentManager, onCancel: () => void): () => void {
  let lastEscapeAt = 0;
  const unsubscribe = ctx?.ui?.onTerminalInput?.((data: string) => {
    if (data !== '\u001b') return undefined;
    const now = Date.now();
    const isDoubleEscape = now - lastEscapeAt <= 600;
    lastEscapeAt = now;
    if (!isDoubleEscape) return { consume: true };
    onCancel();
    const cancelled = manager.cancelRunning('cancelled by double escape');
    ctx?.abort?.();
    ctx?.ui?.notify?.(
      cancelled.length ? `Cancelled ${cancelled.length} subagent task(s).` : 'Requested subagent/main cancellation.',
      'warning',
    );
    lastEscapeAt = 0;
    return { consume: true };
  });
  return typeof unsubscribe === 'function' ? unsubscribe : () => {};
}

export function createSubagentRunTool(manager: SubagentManager, pi: any) {
  return {
    name: 'subagent_run',
    label: 'Subagent Run',
    description: 'Delegate a task to one or more markdown-defined subagents. Use mode=task to wait; use mode=background to free the chat and wait for the automatic completion notification.',
    promptSnippet: 'Delegate analysis/review/test/design tasks to subagents. Supports one or many agents, task or background mode.',
    parameters: Type.Object({
      agent: Type.Optional(Type.String()),
      agents: Type.Optional(Type.Array(Type.String())),
      task: Type.String(),
      context: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Union([Type.Literal('task'), Type.Literal('background')])),
    }),
    async execute(_id: string, params: any, _signal: any, onUpdate: any, ctx: any) {
      let cancelledByDoubleEscape = false;
      let frame = 0;
      let active = true;
      let latestTasks: SubagentTask[] = [];
      const isBackground = params.mode === 'background';
      const subagentsConfig = readSubagentsConfig(ctx?.cwd ?? process.cwd());
      const canBackgroundInClaude = !isBackground && subagentsConfig.mode === 'claude';
      const backgroundShortcut = subagentsConfig.background_handoff_shortcut ?? 'ctrl+h';
      let resolveBackground: ((value: { mode: 'background'; task_ids: string[] }) => void) | undefined;
      const backgroundPromise = canBackgroundInClaude
        ? new Promise<{ mode: 'background'; task_ids: string[] }>((resolve) => { resolveBackground = resolve; })
        : undefined;
      const emit = () => {
        if (!active || isBackground) return;
        try {
          onUpdate?.({
            content: [{ type: 'text', text: progressText(latestTasks, frame, { backgroundable: canBackgroundInClaude, backgroundShortcut }) }],
            details: { tasks: latestTasks.map(compactTaskForToolResult), frame: frame++, backgroundable: canBackgroundInClaude, backgroundShortcut },
          });
        } catch {
          active = false;
        }
      };
      const interval = isBackground ? undefined : setInterval(emit, 500);
      const uninstallCancel = isBackground ? () => {} : installDoubleEscapeCancel(ctx, manager, () => { cancelledByDoubleEscape = true; });
      const uninstallBackground = canBackgroundInClaude
        ? installBackgroundHandoffShortcut(ctx, manager, () => latestTasks.map((task) => task.id), (tasks) => {
          active = false;
          resolveBackground?.({ mode: 'background', task_ids: tasks.map((task) => task.id) });
        })
        : () => {};
      try {
        emit();
        const runPromise = manager.run(params, { ...ctx, pi }, _signal, isBackground ? undefined : (tasks) => { latestTasks = tasks; emit(); });
        const result = backgroundPromise ? await Promise.race([runPromise, backgroundPromise]) : await runPromise;
        if (cancelledByDoubleEscape) throw new Error('Subagent run cancelled by double escape');
        if (!('results' in result)) {
          const details = compactResultDetails(result as any);
          const response = ok(backgroundLaunchContent(result.task_ids, 'Sent'), details);
          return isBackground ? response : { ...response, terminate: true };
        }
        const failedTasks = (result.results ?? []).filter((task) => task.status === 'failed' || task.status === 'cancelled');
        const text = result.mode === 'background'
          ? backgroundLaunchContent(result.task_ids, 'Started')
          : formatTaskModeContent(result.results ?? []);
        const details = compactResultDetails(result as any);
        const failureText = appendSubagentResumeGuidance(
          `${failedTasks.length} subagent task(s) failed or were cancelled.\n\n${failedTasks.map(formatTask).join('\n\n')}`,
          failedTasks,
        );
        return failedTasks.length ? { ...fail(failureText), details } : ok(text, details);
      } catch (e) {
        if (!cancelledByDoubleEscape) return fail(e);
        const message = e instanceof Error ? e.message : String(e);
        return fail(appendSubagentResumeGuidance(message, latestTasks.length ? latestTasks : [{ status: 'cancelled' }]));
      }
      finally {
        active = false;
        if (interval) clearInterval(interval);
        uninstallCancel();
        uninstallBackground();
      }
    },
    renderCall: renderSubagentRunCall,
    renderResult: renderSubagentRunResult,
  };
}
