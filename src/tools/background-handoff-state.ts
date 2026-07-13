import { readSubagentsConfig } from '../config.js';
import type { SubagentManager } from '../manager.js';
import type { SubagentTask } from '../types.js';

const activeClaudeBackgroundHandoffs = new Set<() => SubagentTask[]>();

function sendTasksToBackground(
  ctx: any,
  manager: SubagentManager,
  getTaskIds: () => string[],
  onBackground: (tasks: SubagentTask[]) => void,
): SubagentTask[] {
  const backgrounded = manager.sendToBackground(getTaskIds());
  if (!backgrounded.length) return [];
  ctx?.ui?.notify?.(
    backgrounded.length === 1 ? `Sent subagent to background: ${backgrounded[0]!.id}` : `Sent ${backgrounded.length} subagent task(s) to background.`,
    'info',
  );
  onBackground(backgrounded);
  return backgrounded;
}

export function triggerClaudeBackgroundHandoff(): boolean {
  for (const handoff of [...activeClaudeBackgroundHandoffs]) {
    if (handoff().length) return true;
  }
  return false;
}

function ctrlShortcutToTerminalInput(shortcut: string): string | undefined {
  const match = shortcut.trim().toLowerCase().match(/^ctrl\+([a-z])$/);
  if (!match) return undefined;
  const code = match[1]!.charCodeAt(0) - 96;
  return code >= 1 && code <= 26 ? String.fromCharCode(code) : undefined;
}

export function installBackgroundHandoffShortcut(
  ctx: any,
  manager: SubagentManager,
  getTaskIds: () => string[],
  onBackground: (tasks: SubagentTask[]) => void,
): () => void {
  const shortcut = readSubagentsConfig(ctx?.cwd ?? process.cwd()).background_handoff_shortcut ?? 'ctrl+h';
  const terminalInput = ctrlShortcutToTerminalInput(shortcut);
  const handoff = () => sendTasksToBackground(ctx, manager, getTaskIds, onBackground);
  activeClaudeBackgroundHandoffs.add(handoff);
  const unsubscribe = terminalInput ? ctx?.ui?.onTerminalInput?.((data: string) => {
    if (data !== terminalInput) return undefined;
    return handoff().length ? { consume: true } : undefined;
  }) : undefined;
  return () => {
    activeClaudeBackgroundHandoffs.delete(handoff);
    if (typeof unsubscribe === 'function') unsubscribe();
  };
}
