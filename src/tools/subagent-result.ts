import { Type } from 'typebox';
import { resolveRuntimeManager } from '../runtime-registry.js';
import type { RuntimeManagerSourceV1 } from '../runtime-registry.js';
import { emptyComponent } from '../render/tools/components.js';
import { formatTask } from '../render/tools/formatting.js';
import { renderSubagentResult } from '../render/tools/subagent-result.js';
import { compactTaskForToolResult } from './result-details.js';
import { ok, fail } from './tool-response.js';

export function createSubagentResultTool(source: RuntimeManagerSourceV1) {
  return {
    name: 'subagent_result',
    label: 'Subagent Result',
    description: 'Read result for a delegated subagent task.',
    parameters: Type.Object({ task_id: Type.String() }),
    renderShell: 'self',
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const { manager } = resolveRuntimeManager(source, ctx);
        const task = manager.getTask(params.task_id, ctx?.cwd ?? process.cwd());
        if (!task) throw new Error('Subagent task not found');
        const fullResult = task.result ?? task.error ?? task.output_preview ?? formatTask(task);
        return ok(fullResult, { task: compactTaskForToolResult(task), full_result: fullResult });
      } catch (e) { return fail(e); }
    },
    renderCall: () => emptyComponent(),
    renderResult: renderSubagentResult,
  };
}
