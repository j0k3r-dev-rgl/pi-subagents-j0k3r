import type { SubagentTask } from '../types.js';

export const SUBAGENT_RESUME_GUIDANCE = [
  '## optional resume',
  'This task can be resumed with `subagent_continue` by sending a continuation prompt with the same `task_id`.',
  'Ask the user before resuming. The user may keep the currently configured model and effort or explicitly choose a different model, effort, or both for the next attempt.',
  "Do not resume or override the model or effort without the user's explicit decision. Never switch models automatically.",
].join('\n');

export function appendSubagentResumeGuidance(text: string, tasks: Array<Pick<SubagentTask, 'status'>>): string {
  return tasks.some((task) => task.status === 'failed' || task.status === 'cancelled')
    ? `${text}\n\n${SUBAGENT_RESUME_GUIDANCE}`
    : text;
}

export function clip(text: string | undefined, limit = 240): string {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(task: SubagentTask): string {
  const usage = task.usage;
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  return parts.join(' ');
}

export function modelEffortLine(task: SubagentTask): string {
  return [`model: ${task.model ?? 'default/current'}`, `effort: ${task.effort ?? 'default/current'}`].join(' · ');
}

export function formatTask(task: SubagentTask): string {
  const when = task.last_activity_at ?? task.started_at ?? task.created_at;
  const usage = formatUsage(task);
  const lines = [
    `agent: ${task.agent} · status: ${task.status} · attempt: ${task.attempt ?? 1} · id: ${task.id}`,
    modelEffortLine(task),
    usage ? `usage: ${usage}` : undefined,
    `last: ${task.last_activity ?? 'n/a'}${when ? ` at ${when}` : ''}`,
  ].filter(Boolean) as string[];
  const preview = clip(task.output_preview ?? task.result ?? task.error);
  if (preview) lines.push(`preview: ${preview}`);
  return lines.join('\n');
}

function formatTaskListItem(task: SubagentTask): string {
  const when = task.last_activity_at ?? task.started_at ?? task.created_at;
  const usage = formatUsage(task);
  const lines = [
    `agent: ${task.agent} · status: ${task.status} · attempt: ${task.attempt ?? 1} · id: ${task.id}`,
    modelEffortLine(task),
    usage ? `usage: ${usage}` : undefined,
    `last: ${task.last_activity ?? 'n/a'}${when ? ` at ${when}` : ''}`,
    (task.result || task.error || task.output_preview) ? `preview: collapsed · use subagent_result ${task.id}` : undefined,
  ].filter(Boolean) as string[];
  return lines.join('\n');
}

function formatTaskListRow(task: SubagentTask): string {
  const usage = formatUsage(task);
  return [
    `agent: ${task.agent} · status: ${task.status} · attempt: ${task.attempt ?? 1} · id: ${task.id}`,
    usage ? `usage: ${usage}` : undefined,
  ].filter(Boolean).join(' · ');
}

export function formatTaskListSummary(tasks: SubagentTask[]): string {
  if (!tasks.length) return 'Listed 0 subagent task(s).';
  const mostRecent = tasks[0]!;
  return [
    `Listed ${tasks.length} subagent task(s).`,
    `Most recent: ${mostRecent.agent} · ${mostRecent.status} · ${mostRecent.id}${mostRecent.task ? ` · task: ${clip(mostRecent.task, 80)}` : ''}`,
    'List view: collapsed · ctrl+o to expand',
  ].join('\n');
}

export function formatTaskListRender(tasks: SubagentTask[], expanded: boolean): string {
  if (!tasks.length) return 'Listed 0 subagent task(s).';
  if (expanded) return `Listed ${tasks.length} subagent task(s):\n\n${tasks.map(formatTaskListItem).join('\n\n')}`;
  const visible = tasks.slice(0, 5);
  const hidden = tasks.length - visible.length;
  return [
    `Listed ${tasks.length} subagent task(s).`,
    'List view: collapsed · ctrl+o to expand',
    '',
    ...visible.map(formatTaskListRow),
    hidden > 0 ? `… ${hidden} more task(s) hidden` : undefined,
  ].filter(Boolean).join('\n');
}

export function collapsedResultHint(task: SubagentTask | undefined, failed: boolean): string {
  if (!task) return failed ? 'result: collapsed · ctrl+o to expand' : 'response: collapsed · ctrl+o to expand';
  const label = failed ? 'error' : 'response';
  return `${label}: collapsed · ctrl+o to expand · /subagents or subagent_result ${task.id}`;
}

export function taskFinalText(task: SubagentTask | undefined, result?: any): string {
  if (typeof result?.details?.full_result === 'string') return result.details.full_result;
  return task?.result ?? task?.error ?? task?.output_preview ?? '';
}

export function formatTaskModeContent(tasks: SubagentTask[]): string {
  const content = [
    `Completed ${tasks.length} subagent task(s):`,
    ...tasks.map((task) => {
      const finalText = taskFinalText(task);
      return [
        formatTask(task),
        finalText ? `\n# response from ${task.agent} (${task.id})\n${finalText}` : undefined,
      ].filter(Boolean).join('\n');
    }),
  ].join('\n\n');
  return appendSubagentResumeGuidance(content, tasks);
}

export function backgroundLaunchContent(taskIds: string[], verb = 'Sent'): string {
  return [
    `${verb} ${taskIds.length} subagent task(s) to background:`,
    taskIds.join('\n'),
    '',
    'Background behavior:',
    '- Do not call subagent_status or subagent_result just to wait.',
    '- The subagent will notify this chat automatically when it finishes.',
    '- Keep the chat available so the user can continue asking questions while it runs.',
  ].join('\n');
}
