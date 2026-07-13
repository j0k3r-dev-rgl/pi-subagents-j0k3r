import { truncateToWidth } from '../render/text-width.js';
import type { SubagentTask } from '../types.js';

type ClaudeBackgroundWidgetEntry = {
  key: string;
  line: string;
};

type ClaudeBackgroundTerminalAction =
  | { type: 'focus-editor' }
  | { type: 'open-task'; taskId: string };

type ClaudeBackgroundTerminalInputResult = {
  consume?: boolean;
  data?: string;
  action?: ClaudeBackgroundTerminalAction;
} | undefined;

function matchesKey(data: string, key: string): boolean {
  const keys: Record<string, string[]> = {
    escape: ['\u001b'],
    q: ['q', 'Q'],
    up: ['\u001b[A'],
    down: ['\u001b[B'],
    right: ['\u001b[C'],
    left: ['\u001b[D'],
  };
  return keys[key]?.includes(data) ?? data === key;
}

function clip(text: string | undefined, limit = 120): string {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized;
}

function isActiveBackgroundTask(task: SubagentTask): boolean {
  return task.mode === 'background' && (task.status === 'queued' || task.status === 'running');
}

function buildClaudeBackgroundWidgetEntries(tasks: SubagentTask[]): ClaudeBackgroundWidgetEntry[] {
  const active = tasks.filter(isActiveBackgroundTask);
  if (!active.length) return [];
  return [
    { key: 'main', line: 'main' },
    ...active.map((task) => ({ key: task.id, line: `${task.agent} ${clip(task.last_activity ?? task.task ?? task.id)}` })),
  ];
}

function coerceClaudeBackgroundSelection(entries: ClaudeBackgroundWidgetEntry[], selectedKey: string | undefined): string {
  if (!entries.length) return 'main';
  return entries.some((entry) => entry.key === selectedKey) ? selectedKey! : entries[0]!.key;
}

export function moveClaudeBackgroundWidgetSelection(tasks: SubagentTask[], selectedKey: string | undefined, direction: 'up' | 'down'): string {
  const entries = buildClaudeBackgroundWidgetEntries(tasks);
  if (!entries.length) return 'main';
  const current = coerceClaudeBackgroundSelection(entries, selectedKey);
  const index = entries.findIndex((entry) => entry.key === current);
  const nextIndex = direction === 'down'
    ? Math.min(index + 1, entries.length - 1)
    : Math.max(index - 1, 0);
  return entries[nextIndex]?.key ?? current;
}

export function renderClaudeBackgroundWidgetLines(tasks: SubagentTask[], selectedKey?: string): string[] | undefined {
  const entries = buildClaudeBackgroundWidgetEntries(tasks);
  if (!entries.length) return undefined;
  const current = selectedKey === undefined ? undefined : coerceClaudeBackgroundSelection(entries, selectedKey);
  return entries.map((entry) => `${entry.key === current ? '●' : '○'} ${entry.line}`);
}

export class ClaudeBackgroundWidgetState {
  private selectedKey = 'main';
  private navigationActive = false;

  constructor(
    private getTasks: () => SubagentTask[],
    private onChange?: () => void,
  ) {}

  getSelectedKey(): string {
    this.selectedKey = coerceClaudeBackgroundSelection(buildClaudeBackgroundWidgetEntries(this.getTasks()), this.selectedKey);
    return this.selectedKey;
  }

  renderLines(): string[] {
    return renderClaudeBackgroundWidgetLines(this.getTasks(), this.navigationActive ? this.getSelectedKey() : undefined) ?? [];
  }

  handleWidgetInput(data: string): void {
    this.handleTerminalInput(data);
  }

  handleTerminalInput(data: string): ClaudeBackgroundTerminalInputResult {
    const tasks = this.getTasks();
    if (!tasks.some(isActiveBackgroundTask)) {
      if (this.navigationActive || this.selectedKey !== 'main') {
        this.selectedKey = 'main';
        this.navigationActive = false;
        this.onChange?.();
      }
      return undefined;
    }

    if (matchesKey(data, 'down')) {
      this.navigationActive = true;
      const next = moveClaudeBackgroundWidgetSelection(tasks, this.getSelectedKey(), 'down');
      if (next !== this.selectedKey) {
        this.selectedKey = next;
        this.onChange?.();
      }
      return { consume: true };
    }

    if (matchesKey(data, 'up')) {
      if (!this.navigationActive) return undefined;
      if (this.getSelectedKey() === 'main') {
        this.navigationActive = false;
        this.onChange?.();
        return { consume: true };
      }
      const next = moveClaudeBackgroundWidgetSelection(tasks, this.selectedKey, 'up');
      if (next !== this.selectedKey) {
        this.selectedKey = next;
        this.onChange?.();
      }
      return { consume: true };
    }

    if (this.navigationActive && (data === '\r' || data === '\n')) {
      const selectedKey = this.getSelectedKey();
      this.navigationActive = false;
      this.onChange?.();
      if (selectedKey === 'main') return { consume: true, action: { type: 'focus-editor' } };
      return { consume: true, action: { type: 'open-task', taskId: selectedKey } };
    }

    if (this.navigationActive && (matchesKey(data, 'left') || matchesKey(data, 'right') || matchesKey(data, 'escape'))) {
      this.navigationActive = false;
      this.onChange?.();
      return { consume: true, action: { type: 'focus-editor' } };
    }

    if (this.navigationActive) return { consume: true };
    return undefined;
  }
}

export class ClaudeBackgroundWidget {
  constructor(
    private state: ClaudeBackgroundWidgetState,
    private theme: any,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return this.state.renderLines().map((line) => truncateToWidth(this.decorate(line), width));
  }

  handleInput(data: string): void {
    this.state.handleWidgetInput(data);
  }

  private decorate(line: string): string {
    if (!line.startsWith('● ')) return line;
    return this.theme?.fg?.('warning', this.theme?.bold?.(line) ?? line) ?? line;
  }
}
