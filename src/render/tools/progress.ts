import type { SubagentTask } from '../types.js';
import { clip, formatUsage } from './formatting.js';

export function progressText(tasks: SubagentTask[], frame = 0, options: { backgroundable?: boolean; backgroundShortcut?: string } = {}): string {
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][frame % 10];
  const active = tasks.find((task) => task.status === 'running') ?? tasks[0];
  if (!active) return `${spinner} Starting subagent…`;
  const usage = formatUsage(active);
  return [
    `${spinner} agent: ${active.agent} · status: ${active.status} · attempt: ${active.attempt ?? 1} · effort: ${active.effort ?? 'default/current'}`,
    `↳ model: ${active.model ?? 'starting'}${usage ? ` · usage: ${usage}` : ''}`,
    `↳ ${clip(active.last_activity ?? active.task ?? active.id, 160)}`,
    options.backgroundable ? `↳ ${options.backgroundShortcut ?? 'ctrl+h'} to send to background` : undefined,
  ].filter(Boolean).join('\n');
}
