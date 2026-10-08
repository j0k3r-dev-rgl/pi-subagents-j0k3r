import { readSubagentsConfig } from '../config.js';
import type { RuntimeManagerSourceV1 } from '../runtime-registry.js';
import { createSubagentListAgentsTool } from './subagent-list-agents.js';
import { createSubagentRunTool } from './subagent-run.js';
import { createSubagentContinueTool } from './subagent-continue.js';
import { createSubagentStatusTool } from './subagent-status.js';
import { createSubagentResultTool } from './subagent-result.js';
import { createSubagentListTasksTool } from './subagent-list-tasks.js';
import { createSubagentCancelTool } from './subagent-cancel.js';
import { createSubagentSendMessageTool } from './subagent-send-message.js';

export function registerSubagentTools(pi: any, source: RuntimeManagerSourceV1, cwd = process.cwd()): void {
  pi.registerTool(createSubagentListAgentsTool(source));
  pi.registerTool(createSubagentRunTool(source, 'resolve' in source ? undefined : pi));
  if (readSubagentsConfig(cwd).enable_continue) pi.registerTool(createSubagentContinueTool(source));
  pi.registerTool(createSubagentStatusTool(source));
  pi.registerTool(createSubagentResultTool(source));
  pi.registerTool(createSubagentListTasksTool(source));
  pi.registerTool(createSubagentCancelTool(source));
  pi.registerTool(createSubagentSendMessageTool(source));
}
