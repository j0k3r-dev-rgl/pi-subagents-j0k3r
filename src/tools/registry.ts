import type { SubagentManager } from '../manager.js';
import { createSubagentListAgentsTool } from './subagent-list-agents.js';
import { createSubagentRunTool } from './subagent-run.js';
import { createSubagentContinueTool } from './subagent-continue.js';
import { createSubagentStatusTool } from './subagent-status.js';
import { createSubagentResultTool } from './subagent-result.js';
import { createSubagentListTasksTool } from './subagent-list-tasks.js';
import { createSubagentCancelTool } from './subagent-cancel.js';

export function registerSubagentTools(pi: any, manager: SubagentManager): void {
  pi.registerTool(createSubagentListAgentsTool(manager));
  pi.registerTool(createSubagentRunTool(manager, pi));
  pi.registerTool(createSubagentContinueTool(manager));
  pi.registerTool(createSubagentStatusTool(manager));
  pi.registerTool(createSubagentResultTool(manager));
  pi.registerTool(createSubagentListTasksTool(manager));
  pi.registerTool(createSubagentCancelTool(manager));
}
