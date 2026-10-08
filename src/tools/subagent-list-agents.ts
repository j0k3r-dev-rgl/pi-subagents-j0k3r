import { Type } from 'typebox';
import { resolveRuntimeManager } from '../runtime-registry.js';
import type { RuntimeManagerSourceV1 } from '../runtime-registry.js';
import { emptyComponent } from '../render/tools/components.js';
import { formatSubagentList, renderSubagentListResult } from '../render/tools/subagent-list-agents.js';
import { ok, fail } from './tool-response.js';

export function createSubagentListAgentsTool(source: RuntimeManagerSourceV1) {
  return {
    name: 'subagent_list_agents',
    label: 'Subagent List Agents',
    description: 'List available markdown-defined subagents for delegation.',
    promptSnippet: 'List available subagents loaded from global/project agents and subagents markdown directories.',
    parameters: Type.Object({}),
    async execute(_id: string, _params: any, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const { manager } = resolveRuntimeManager(source, ctx);
        const agents = manager.listAgents(ctx?.cwd ?? process.cwd(), ctx);
        return ok(formatSubagentList(agents, true), { agents });
      } catch (e) {
        return fail(e);
      }
    },
    renderShell: 'self',
    renderCall: () => emptyComponent(),
    renderResult: renderSubagentListResult,
  };
}
