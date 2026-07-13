import { Type } from 'typebox';
import type { SubagentManager } from '../manager.js';
import { ok, fail } from './tool-response.js';

export function createSubagentListAgentsTool(manager: SubagentManager) {
  return {
    name: 'subagent_list_agents',
    label: 'Subagent List Agents',
    description: 'List available markdown-defined subagents for delegation.',
    promptSnippet: 'List available subagents loaded from global/project agents and subagents markdown directories.',
    parameters: Type.Object({}),
    async execute(_id: string, _params: any, _signal: any, _onUpdate: any, ctx: any) {
      try { const agents = manager.listAgents(ctx?.cwd ?? process.cwd()); return ok(`Found ${agents.length} subagent(s).`, { agents }); } catch (e) { return fail(e); }
    },
  };
}
