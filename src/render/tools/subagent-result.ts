import { textComponent } from './components.js';
import { collapsedResultHint, formatUsage, modelEffortLine, taskFinalText } from './formatting.js';
import { taskFromDetails } from '../result-details.js';

export function renderSubagentResult(result: any, { expanded }: any, theme: any) {
  const task = taskFromDetails(result);
  const failed = result?.isError || task?.status === 'failed' || task?.status === 'cancelled';
  if (!task) return textComponent(theme.fg?.(failed ? 'error' : 'dim', result?.content?.[0]?.text ?? '') ?? (result?.content?.[0]?.text ?? ''));
  const status = failed ? (theme.fg?.('error', task.status) ?? task.status) : (theme.fg?.('success', task.status) ?? task.status);
  const usage = formatUsage(task);
  const summary = [
    `Subagent result: ${theme.fg?.('accent', task.agent) ?? task.agent} · status: ${status} · id: ${task.id}`,
    theme.fg?.('dim', modelEffortLine(task)) ?? modelEffortLine(task),
    usage ? (theme.fg?.('dim', `usage: ${usage}`) ?? `usage: ${usage}`) : undefined,
  ].filter(Boolean).join('\n');
  const finalText = taskFinalText(task, result);
  const body = expanded && finalText
    ? `${summary}\n${theme.fg?.('toolTitle', 'Subagent response') ?? 'Subagent response'}\n${finalText}`
    : `${summary}\n${theme.fg?.('dim', collapsedResultHint(task, failed)) ?? collapsedResultHint(task, failed)}`;
  return textComponent(body);
}
