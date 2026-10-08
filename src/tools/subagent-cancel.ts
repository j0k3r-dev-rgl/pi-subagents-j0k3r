import { Type } from 'typebox';
import { resolveRuntimeManager } from '../runtime-registry.js';
import type { RuntimeManagerSourceV1 } from '../runtime-registry.js';
import { appendSubagentResumeGuidance, formatTask } from '../render/tools/formatting.js';
import { renderSubagentCancelCall, renderSubagentCancelResult } from '../render/tools/subagent-cancel.js';
import { compactTaskForToolResult } from './result-details.js';
import { ok, fail } from './tool-response.js';

export function createSubagentCancelTool(source: RuntimeManagerSourceV1) {
  return {
    name: 'subagent_cancel',
    label: 'Subagent Cancel',
    description: 'Cancel a running delegated subagent task.',
    parameters: Type.Object({ task_id: Type.String() }),
    renderShell: 'self',
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const { manager } = resolveRuntimeManager(source, ctx);
        const task = manager.cancel(params.task_id);
        return ok(appendSubagentResumeGuidance(formatTask(task), [task], ctx?.cwd ?? process.cwd()), { task: compactTaskForToolResult(task) });
      } catch (e) { return fail(e); }
    },
    renderCall: renderSubagentCancelCall,
    renderResult: renderSubagentCancelResult,
  };
}
