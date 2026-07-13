import { Type } from 'typebox';
import type { SubagentManager } from '../manager.js';
import { formatTask } from '../render/tools/formatting.js';
import { compactTaskForToolResult } from './result-details.js';
import { ok, fail } from './tool-response.js';

export function createSubagentCancelTool(manager: SubagentManager) {
  return {
    name: 'subagent_cancel',
    label: 'Subagent Cancel',
    description: 'Cancel a running delegated subagent task.',
    parameters: Type.Object({ task_id: Type.String() }),
    async execute(_id: string, params: any) {
      try { const task = manager.cancel(params.task_id); return ok(formatTask(task), { task: compactTaskForToolResult(task) }); } catch (e) { return fail(e); }
    },
  };
}
