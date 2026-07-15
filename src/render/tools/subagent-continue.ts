import type { SubagentTask } from '../types.js';
import { renderSubagentRunResult, renderSubagentTaskCall } from './subagent-run.js';

export function renderSubagentContinueCall(args: any, theme: any, task?: SubagentTask) {
  const attempt = task ? (task.attempt ?? 1) + 1 : 'next';
  const detail = `continue · attempt: ${attempt} · id: ${args.task_id ?? 'unknown'}`;
  return renderSubagentTaskCall(task?.agent ?? 'continue', 'task', theme, detail);
}

export function renderSubagentContinueResult(result: any, options: any, theme: any) {
  return renderSubagentRunResult(result, options, theme);
}
