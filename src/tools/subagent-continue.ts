import { Type } from 'typebox';
import type { SubagentManager } from '../manager.js';
import { backgroundLaunchContent, formatTaskModeContent } from '../render/tools/formatting.js';
import { renderSubagentContinueCall, renderSubagentContinueResult } from '../render/tools/subagent-continue.js';
import { compactResultDetails } from './result-details.js';
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
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const result = await manager.continueTask(params, ctx);
        if (!('results' in result)) return ok(backgroundLaunchContent(result.task_ids, 'Continued'), compactResultDetails(result as any));
        const tasks = result.results ?? [];
        const text = formatTaskModeContent(tasks);
        const details = compactResultDetails({ task: tasks[0], ...result });
        return tasks.some((task) => task.status === 'failed' || task.status === 'cancelled')
          ? { ...fail(text), details }
          : ok(text, details);
      } catch (e) {
        return fail(e);
      }
    },
    renderCall: renderSubagentContinueCall,
    renderResult: renderSubagentContinueResult,
  };
}
