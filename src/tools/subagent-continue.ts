import { Type } from 'typebox';
import { readSubagentsConfig } from '../config.js';
import type { SubagentManager } from '../manager.js';
import type { SubagentTask } from '../types.js';
import { appendSubagentResumeGuidance, backgroundLaunchContent, formatTaskModeContent } from '../render/tools/formatting.js';
import { progressText } from '../render/tools/progress.js';
import { renderSubagentContinueCall, renderSubagentContinueResult } from '../render/tools/subagent-continue.js';
import { installBackgroundHandoffShortcut } from './background-handoff-state.js';
import { compactResultDetails, compactTaskForToolResult } from './result-details.js';
import { installDoubleEscapeCancel } from './subagent-run.js';
import { ok, fail } from './tool-response.js';

export function createSubagentContinueTool(manager: SubagentManager) {
  return {
    name: 'subagent_continue',
    label: 'Subagent Continue',
    description: 'Continue a completed, failed, or cancelled subagent task in its exact persisted nested Pi session. Overrides require an explicit user decision before you supply model or effort. Never auto-switch models.',
    promptSnippet: 'Continue an existing terminal subagent task under the same task_id. Use model/effort overrides only after the user explicitly chooses them.',
    parameters: Type.Object({
      task_id: Type.String(),
      prompt: Type.String(),
      model: Type.Optional(Type.String()),
      effort: Type.Optional(Type.Union([
        Type.Literal('off'),
        Type.Literal('minimal'),
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high'),
        Type.Literal('xhigh'),
      ])),
    }),
    async execute(_id: string, params: any, _signal: any, onUpdate: any, ctx: any) {
      let cancelledByDoubleEscape = false;
      let frame = 0;
      let active = true;
      let latestTasks: SubagentTask[] = [];
      const cwd = ctx?.cwd ?? process.cwd();
      const existing = manager.getTask(params.task_id, cwd);
      const isBackground = existing?.mode === 'background';
      const config = readSubagentsConfig(cwd);
      const canBackgroundInClaude = !isBackground && config.mode === 'claude';
      const backgroundShortcut = config.background_handoff_shortcut ?? 'ctrl+h';
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
        const continuePromise = manager.continueTask(params, ctx, _signal, isBackground ? undefined : (tasks) => { latestTasks = tasks; emit(); });
        const result = backgroundPromise ? await Promise.race([continuePromise, backgroundPromise]) : await continuePromise;
        if (cancelledByDoubleEscape) throw new Error('Subagent continuation cancelled by double escape');
        if (!('results' in result)) {
          const response = ok(backgroundLaunchContent(result.task_ids, 'Continued'), compactResultDetails(result as any));
          return isBackground ? response : { ...response, terminate: true };
        }
        const tasks = result.results ?? [];
        const text = formatTaskModeContent(tasks);
        const details = compactResultDetails({ task: tasks[0], ...result });
        return tasks.some((task) => task.status === 'failed' || task.status === 'cancelled')
          ? { ...fail(text), details }
          : ok(text, details);
      } catch (e) {
        if (!cancelledByDoubleEscape) return fail(e);
        const message = e instanceof Error ? e.message : String(e);
        return fail(appendSubagentResumeGuidance(message, latestTasks.length ? latestTasks : [{ status: 'cancelled' }]));
      } finally {
        active = false;
        if (interval) clearInterval(interval);
        uninstallCancel();
        uninstallBackground();
      }
    },
    renderCall: (args: any, theme: any) => renderSubagentContinueCall(args, theme, manager.getTask(args.task_id, process.cwd())),
    renderResult: renderSubagentContinueResult,
  };
}
