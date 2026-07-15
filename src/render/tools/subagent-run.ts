import { readSubagentsConfig } from '../config.js';
import type { SubagentTask } from '../types.js';
import { textComponent } from './components.js';
import { collapsedResultHint, formatUsage, taskFinalText } from './formatting.js';
import { progressText } from './progress.js';
import { taskFromDetails } from '../result-details.js';

export function renderSubagentRunCall(args: any, theme: any) {
  const agents = args.agents?.length ? args.agents.join(', ') : args.agent ?? 'subagent';
  const mode = args.mode ?? 'task';
  const uiMode = readSubagentsConfig(process.cwd()).mode;
  const detailsHint = uiMode === 'claude' ? '(/subagents for details)' : '(ctrl+, or /subagents for details)';
  const text = `${theme.fg?.('toolTitle', theme.bold?.('subagent ') ?? 'subagent ') ?? 'subagent '}${theme.fg?.('accent', agents) ?? agents}${theme.fg?.('dim', ` (${mode})`) ?? ` (${mode})`} ${theme.fg?.('dim', detailsHint) ?? detailsHint}`;
  return textComponent(text);
}

export function renderSubagentRunResult(result: any, { expanded, isPartial }: any, theme: any) {
  const task = taskFromDetails(result);
  if (isPartial) {
    const frame = result?.details?.frame ?? 0;
    const raw = task
      ? progressText([task], frame, { backgroundable: Boolean(result?.details?.backgroundable), backgroundShortcut: result?.details?.backgroundShortcut })
      : progressText([], frame, { backgroundable: Boolean(result?.details?.backgroundable), backgroundShortcut: result?.details?.backgroundShortcut });
    const lines = raw.split('\n');
    const styled = lines.map((line: string, index: number) => (
      index === 0
        ? (theme.fg?.('warning', line) ?? line)
        : (theme.fg?.('dim', line) ?? line)
    )).filter(Boolean).join('\n');
    return textComponent(styled);
  }
  const failed = result?.isError || task?.status === 'failed' || task?.status === 'cancelled';
  const status = failed ? (theme.fg?.('error', task?.status ?? 'failed') ?? (task?.status ?? 'failed')) : (theme.fg?.('success', task?.status ?? 'done') ?? (task?.status ?? 'done'));
  const usage = task ? formatUsage(task as SubagentTask) : '';
  const summary = task
    ? [
      `agent: ${theme.fg?.('accent', task.agent) ?? task.agent} · status: ${status} · attempt: ${theme.fg?.('accent', String(task.attempt ?? 1)) ?? String(task.attempt ?? 1)} · effort: ${theme.fg?.('accent', task.effort ?? 'default/current') ?? (task.effort ?? 'default/current')}`,
      `${theme.fg?.('dim', `model: ${task.model ?? 'default/current'} · id: ${task.id}`) ?? `model: ${task.model ?? 'default/current'} · id: ${task.id}`}${usage ? `\n${theme.fg?.('dim', `usage: ${usage}`) ?? `usage: ${usage}`}` : ''}`,
    ].join('\n')
    : status;
  const hint = collapsedResultHint(task, failed);
  const finalText = taskFinalText(task, result);
  const body = expanded && finalText
    ? `${summary}\n${theme.fg?.('toolTitle', 'Subagent response') ?? 'Subagent response'}\n${finalText}`
    : `${summary}\n${theme.fg?.('dim', hint) ?? hint}`;
  return textComponent(body);
}
