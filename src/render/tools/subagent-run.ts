import { loadSubagents, readSubagentsConfig, resolveEffectiveSubagentMode } from '../config.js';
import type { SubagentMode, SubagentTask } from '../types.js';
import { textComponent, wrappedTextComponent } from './components.js';
import { collapsedResultHint, formatUsage, taskFinalText } from './formatting.js';
import { progressText } from './progress.js';
import { taskFromDetails } from '../result-details.js';

export function renderSubagentTaskCall(agent: string, mode: 'task' | 'background' | 'mixed', theme: any, detail?: string) {
  const historyShortcut = readSubagentsConfig(process.cwd()).history_panel_shortcut ?? 'ctrl+,';
  const detailsHint = `(${historyShortcut} or /subagents for details)`;
  const title = `${theme.fg?.('toolTitle', theme.bold?.('subagent ') ?? 'subagent ') ?? 'subagent '}${theme.fg?.('accent', agent) ?? agent}${theme.fg?.('dim', ` (${mode})`) ?? ` (${mode})`} ${theme.fg?.('dim', detailsHint) ?? detailsHint}`;
  return textComponent(detail ? `${title}\n${theme.fg?.('dim', detail) ?? detail}` : title);
}

function resolveRenderedSubagentRunMode(args: any, cwd: string): SubagentMode | 'mixed' {
  if (args.mode === 'task' || args.mode === 'background') return args.mode;
  const config = readSubagentsConfig(cwd);
  const definitions = new Map(loadSubagents(cwd).map((definition) => [definition.name, definition]));
  const names = args.agent ? [args.agent] : [];
  const modes = new Set(names.map((name: string) => resolveEffectiveSubagentMode({
    invocationMode: args.mode,
    definition: definitions.get(String(name).toLowerCase()),
    config,
  })));
  if (modes.size > 1) return 'mixed';
  const firstMode = modes.values().next().value as SubagentMode | undefined;
  return firstMode ?? resolveEffectiveSubagentMode({ invocationMode: args.mode, config });
}

export function renderSubagentRunCall(args: any, theme: any) {
  const cwd = process.cwd();
  const agent = args.agent ?? 'subagent';
  return renderSubagentTaskCall(agent, resolveRenderedSubagentRunMode(args, cwd), theme);
}

export function renderSubagentRunResult(result: any, { expanded, isPartial }: any, theme: any) {
  const task = taskFromDetails(result);
  if (isPartial) {
    const frame = result?.details?.frame ?? 0;
    const raw = task
      ? progressText([task], frame, { backgroundable: Boolean(result?.details?.backgroundable), backgroundShortcut: result?.details?.backgroundShortcut })
      : progressText([], frame, { backgroundable: Boolean(result?.details?.backgroundable), backgroundShortcut: result?.details?.backgroundShortcut });
    const lines = raw.split('\n');
    const activityCount = task?.live_activity?.trail?.length ?? 0;
    const activityStartIndex = 2;
    const currentActivityIndex = activityCount ? activityStartIndex + activityCount - 1 : -1;
    const styled = lines.map((line: string, index: number) => {
      if (index === 0) return theme.fg?.('warning', line) ?? line;
      if (index === currentActivityIndex) return theme.bold?.(theme.fg?.('accent', line) ?? line) ?? (theme.fg?.('accent', line) ?? line);
      return theme.fg?.('dim', line) ?? line;
    }).filter(Boolean).join('\n');
    return wrappedTextComponent(styled);
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
