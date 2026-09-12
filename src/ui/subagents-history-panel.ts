import { isValidThreadSnapshot, renderThreadBody } from '../thread-view.js';
import type { SubagentTask, SubagentThreadRenderContext, SubagentThreadSnapshot, UsageStats } from '../types.js';
import { formatTaskLabel } from '../render/tools/formatting.js';
import {
  ARCH_ICON,
  BOX_CHARS,
  CYAN,
  CYBER_SEPARATOR,
  VIOLET,
  electricBorder,
  themeAccent,
  themeBold,
  themeDim,
  themeError,
  themeFg,
  themeStatus,
  themeSuccess,
  themeTitle,
  themeWarning,
} from './theme.js';

function clip(text: string | undefined, limit: number): string {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized;
}

function fmtDuration(task: SubagentTask): string {
  const start = task.started_at ? Date.parse(task.started_at) : Date.parse(task.created_at);
  const end = task.ended_at ? Date.parse(task.ended_at) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return `${seconds}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatTimeout(milliseconds: number | undefined): string | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds === undefined || milliseconds <= 0) return undefined;
  let seconds = Math.max(1, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', seconds ? `${seconds}s` : ''].filter(Boolean).join('');
}

function formatUsage(usage?: UsageStats, contextWindow?: number): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens) {
    let context = `ctx:${formatTokens(usage.contextTokens)}`;
    if (Number.isFinite(contextWindow) && contextWindow !== undefined && contextWindow > 0) {
      const percentage = (usage.contextTokens / contextWindow) * 100;
      const formatted = Number.isInteger(percentage) ? percentage.toFixed(0) : percentage.toFixed(1);
      context += ` (${formatted}%)`;
    }
    parts.push(context);
  }
  return parts.join(' ');
}

type SubagentsHistoryPanelDisplayOptions = {
  timeoutMs?: number;
  stallTimeoutMs?: number;
  contextWindowForTask?: (task: SubagentTask) => number | undefined;
};

const TERMINAL_ESCAPE_RE = /\u001b\][^\u001b\u0007]*(?:\u001b\\|\u0007)|\u001b\[[0-?]*[ -/]*[@-~]/g;

function terminalVisibleWidth(text: string): number {
  return [...text.replace(TERMINAL_ESCAPE_RE, '')].length;
}

function fitsWidth(text: string, width: number, visibleWidth: (text: string) => number): boolean {
  try {
    if (visibleWidth(text) <= width) return true;
  } catch {}
  return terminalVisibleWidth(text) <= width;
}

function mouseWheelDelta(data: string): -1 | 1 | undefined {
  const sgr = data.match(/^\u001b\[<(\d+);\d+;\d+M$/);
  const urxvt = data.match(/^\u001b\[(\d+);\d+;\d+M$/);
  const button = sgr || urxvt ? Number((sgr ?? urxvt)![1]) : data.startsWith('\u001b[M') && data.length >= 6 ? data.charCodeAt(3) - 32 : undefined;
  if (button === undefined || !Number.isFinite(button) || (button & 64) === 0) return undefined;
  return (button & 1) === 0 ? -1 : 1;
}

function isMouseClickInput(data: string): { isClick: boolean; row?: number } {
  // SGR mouse tracking: \u001b[<button;col;rowM
  const sgr = data.match(/^\u001b\[<(\d+);(\d+);(\d+)M$/);
  if (sgr) {
    const button = Number(sgr[1]);
    const row = Number(sgr[3]) - 1; // 1-based row in terminal to 0-based
    if (button === 0) return { isClick: true, row };
  }
  const urxvt = data.match(/^\u001b\[(\d+);(\d+);(\d+)M$/);
  if (urxvt) {
    const button = Number(urxvt[1]);
    const row = Number(urxvt[3]) - 1;
    if (button === 0) return { isClick: true, row };
  }
  if (data.startsWith('\u001b[M') && data.length >= 6) {
    const button = data.charCodeAt(3) - 32;
    const row = data.charCodeAt(5) - 32 - 1;
    if ((button & 64) === 0 && (button & 3) === 0) return { isClick: true, row };
  }
  return { isClick: false };
}

function normalizeTerminalErrorText(text: string | undefined): string {
  return text?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

function hasEquivalentSnapshotError(snapshot: SubagentThreadSnapshot, errorText: string): boolean {
  const normalized = normalizeTerminalErrorText(errorText);
  if (!normalized) return false;
  return snapshot.items.some((item) => {
    if (item.type === 'error') return normalizeTerminalErrorText(item.text) === normalized;
    if (item.type === 'assistant') return normalizeTerminalErrorText(item.message.errorMessage) === normalized;
    return false;
  });
}

function snapshotHasActiveTools(snapshot: SubagentThreadSnapshot | undefined): boolean {
  if (!snapshot?.items?.length) return false;
  return snapshot.items.some((item) => (item.type === 'tool' && ['pending', 'running', 'partial'].includes(item.status))
    || (item.type === 'bash' && (item.status === undefined || item.status === 'running')));
}

export class SubagentsHistoryPanel {
  private selected = 0;
  private scroll = 0;
  private followTail = true;
  private lastMaxScroll = 0;
  private toolOutputExpanded = false;
  private hideThinkingBlock = false;
  private hydratedTasks = new Map<string, { signature: string; task: SubagentTask }>();
  private bodyCache = new Map<string, Array<{ text: string; taskId?: string }>>();
  private rowTaskMap = new Map<number, string>();
  private lastRenderDebugState?: {
    configuredMaxLines: number;
    renderWidth: number;
    renderedLineCount: number;
    bodyHeight: number;
    maxVisibleWidth: number;
    widthViolationCount: number;
    clickableRowCount?: number;
  };

  constructor(
    private tasksProvider: SubagentTask[] | (() => SubagentTask[]),
    private theme: any,
    private done: () => void,
    private matchesKey: (data: string, key: string) => boolean,
    private visibleWidth: (text: string) => number,
    private truncateToWidth: (text: string, width: number) => string,
    private renderContext: Partial<SubagentThreadRenderContext> = {},
    private maxLinesProvider: number | (() => number) = 42,
    private taskResolver?: (id: string) => SubagentTask | undefined,
    private initialSelectedTaskId?: string,
    private cancelSelectedTask?: (id: string) => void,
    private detailCancelShortcut = 'x',
    private displayOptions: SubagentsHistoryPanelDisplayOptions = {},
  ) {}

  invalidate(): void {
    this.bodyCache.clear();
    this.hydratedTasks.clear();
    this.rowTaskMap.clear();
  }

  handleMouse(event: {
    type?: string;
    button?: string;
    row?: number;
    y?: number;
    x?: number;
    col?: number;
    wheelDelta?: number;
  }): { handled: true; focus?: boolean; render?: boolean } | undefined {
    if (event.type === 'wheel') {
      const delta = Number(event.wheelDelta ?? 0);
      if (!Number.isFinite(delta) || delta === 0) return undefined;
      if (delta < 0) this.scrollBy(-1);
      else this.scrollBy(1);
      return { handled: true, render: true };
    }
    const isLeftClick = event.type === 'press' || event.type === 'click' || (!event.type && event.button === 'left');
    if (!isLeftClick) return undefined;

    const row = event.row ?? event.y;
    if (typeof row === 'number' && Number.isFinite(row)) {
      const targetTaskId = this.rowTaskMap.get(row);
      if (targetTaskId) {
        const tasks = this.tasks();
        const targetIndex = tasks.findIndex((t) => t.id === targetTaskId);
        if (targetIndex >= 0) {
          this.selected = targetIndex;
          this.scroll = 0;
          this.followTail = true;
          return { handled: true, focus: true, render: true };
        }
      }
      return { handled: true, focus: true };
    }
    return undefined;
  }

  handleInput(data: string): void {
    const tasks = this.tasks();
    if (this.matchesKey(data, 'escape') || this.matchesKey(data, 'ctrl+c') || this.matchesKey(data, 'q')) {
      this.done();
      return;
    }
    if (this.matchesKey(data, 'ctrl+o') || data === '\u000f') {
      this.toolOutputExpanded = !this.toolOutputExpanded;
      return;
    }
    if (this.matchesKey(data, 'ctrl+t') || data === '\u0014') {
      this.hideThinkingBlock = !this.hideThinkingBlock;
      return;
    }
    if (this.matchesKey(data, 'detailCancel')) {
      this.cancelSelectedActiveTask();
      return;
    }
    const wheel = mouseWheelDelta(data);
    if (wheel === -1) {
      this.scrollBy(-1);
      return;
    }
    if (wheel === 1) {
      this.scrollBy(1);
      return;
    }
    const mouseClick = isMouseClickInput(data);
    if (mouseClick.isClick && typeof mouseClick.row === 'number') {
      this.handleMouse({ type: 'click', row: mouseClick.row });
      return;
    }
    if (this.matchesKey(data, 'right')) {
      this.selected = Math.min(tasks.length - 1, this.selected + 1);
      this.scroll = 0;
      this.followTail = true;
    }
    if (this.matchesKey(data, 'left')) {
      this.selected = Math.max(0, this.selected - 1);
      this.scroll = 0;
      this.followTail = true;
    }
    if (this.matchesKey(data, 'down')) {
      this.scroll += 1;
      this.followTail = this.scroll >= this.lastMaxScroll;
    }
    if (this.matchesKey(data, 'up')) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.followTail = false;
    }
    if (this.matchesKey(data, 'pageDown')) {
      this.scroll += 12;
      this.followTail = this.scroll >= this.lastMaxScroll;
    }
    if (this.matchesKey(data, 'pageUp')) {
      this.scroll = Math.max(0, this.scroll - 12);
      this.followTail = false;
    }
    if (this.matchesKey(data, 'home')) {
      this.scroll = 0;
      this.followTail = false;
    }
    if (this.matchesKey(data, 'end')) {
      this.scroll = Number.MAX_SAFE_INTEGER;
      this.followTail = true;
    }
  }

  private scrollBy(delta: number): void {
    if (delta < 0) {
      this.scroll = Math.max(0, this.scroll + delta);
      this.followTail = false;
      return;
    }
    if (delta > 0) {
      this.scroll += delta;
      this.followTail = this.scroll >= this.lastMaxScroll;
    }
  }

  getRenderDebugState(): {
    taskCount: number;
    selectedIndex: number;
    selectedStatus?: string;
    scrollOffset: number;
    followTail: boolean;
    hasUsage: boolean;
    configuredMaxLines?: number;
    renderWidth?: number;
    renderedLineCount?: number;
    bodyHeight?: number;
    maxVisibleWidth?: number;
    widthViolationCount?: number;
    clickableRowCount?: number;
  } {
    const tasks = this.tasks();
    const task = tasks[this.selected];
    return {
      taskCount: tasks.length,
      selectedIndex: task ? this.selected : -1,
      selectedStatus: task?.status,
      scrollOffset: this.scroll,
      followTail: this.followTail,
      hasUsage: Boolean(task?.usage),
      configuredMaxLines: this.lastRenderDebugState?.configuredMaxLines,
      renderWidth: this.lastRenderDebugState?.renderWidth,
      renderedLineCount: this.lastRenderDebugState?.renderedLineCount,
      bodyHeight: this.lastRenderDebugState?.bodyHeight,
      maxVisibleWidth: this.lastRenderDebugState?.maxVisibleWidth,
      widthViolationCount: this.lastRenderDebugState?.widthViolationCount,
      clickableRowCount: this.rowTaskMap.size,
    };
  }

  render(width: number): string[] {
    const w = Math.max(40, width);
    const bodyWidth = w;
    const configuredMaxLines = typeof this.maxLinesProvider === 'function' ? this.maxLinesProvider() : this.maxLinesProvider;
    const maxLines = Math.max(12, Math.floor(Number.isFinite(configuredMaxLines) ? configuredMaxLines : 42));
    const th = this.theme;
    const accent = (s: string) => themeAccent(th, s);
    const dim = (s: string) => themeDim(th, s);
    const warn = (s: string) => themeWarning(th, s);
    const ok = (s: string) => themeSuccess(th, s);
    const err = (s: string) => themeError(th, s);
    const title = (s: string) => themeTitle(th, s);
    const line = (s = '') => fitsWidth(s, bodyWidth, this.visibleWidth) ? s : this.truncateToWidth(s, bodyWidth);
    const border = (text: string) => themeFg(th, 'accent', text, CYAN);
    const divider = line(border(BOX_CHARS.horizontal.repeat(bodyWidth)));
    const sep = ` ${themeFg(th, 'accent', CYBER_SEPARATOR, VIOLET)} `;
    const status = (task: SubagentTask) => themeStatus(th, task.status);

    const lines: string[] = [];
    const archPrefix = themeFg(th, 'accent', ARCH_ICON, CYAN);
    lines.push(line(`${archPrefix} ${title('subagents')} ${dim('flow')} ${dim(`· ←/→ exec · ↑/↓ scroll · pgup/dn · ctrl+o expand · ctrl+t thinking · ${this.detailCancelShortcut} cancel active · esc/q close`)}`));
    const topFrame = line(border(BOX_CHARS.topLeft + BOX_CHARS.horizontal.repeat(Math.max(0, bodyWidth - 2)) + BOX_CHARS.topRight));
    lines.push(topFrame);

    const tasks = this.tasks();
    if (this.initialSelectedTaskId) {
      const initialIndex = tasks.findIndex((entry) => entry.id === this.initialSelectedTaskId);
      if (initialIndex >= 0) this.selected = initialIndex;
      this.initialSelectedTaskId = undefined;
    }
    if (this.selected >= tasks.length) this.selected = Math.max(0, tasks.length - 1);

    if (!tasks.length) {
      lines.push(line(dim('No subagent tasks recorded in this session yet.')));
      while (lines.length < maxLines) lines.push('');
      const lineWidths = lines.map((entry) => {
        try {
          return this.visibleWidth(entry);
        } catch {
          return terminalVisibleWidth(entry);
        }
      });
      this.lastRenderDebugState = {
        configuredMaxLines: maxLines,
        renderWidth: bodyWidth,
        renderedLineCount: lines.length,
        bodyHeight: Math.max(0, maxLines - 3),
        maxVisibleWidth: lineWidths.reduce((max, value) => Math.max(max, value), 0),
        widthViolationCount: lineWidths.filter((value) => value > bodyWidth).length,
      };
      return lines;
    }

    const task = this.resolveTaskForBody(tasks[this.selected]!);
    let contextWindow: number | undefined;
    try { contextWindow = this.displayOptions.contextWindowForTask?.(task); } catch {}
    const usage = formatUsage(task.usage, contextWindow);
    const timeout = formatTimeout(this.displayOptions.timeoutMs);
    const stallTimeout = formatTimeout(this.displayOptions.stallTimeoutMs);
    const cancelHint = (task.status === 'queued' || task.status === 'running') && this.detailCancelShortcut
      ? ` ${dim(`(${this.detailCancelShortcut} cancel)`)}`
      : '';
    const timeoutHint = timeout ? ` ${dim(`(timeout ${timeout})`)}` : '';
    const stallHint = stallTimeout ? ` ${dim(`(stall ${stallTimeout})`)}` : '';
    const lastActivity = [task.last_activity ?? 'n/a', task.last_activity_at ? dim(task.last_activity_at) : ''].filter(Boolean).join(' ');
    const displayName = task.display_name?.trim();
    lines.push(line(`${accent(`${this.selected + 1}/${tasks.length}`)}${sep}${dim('subagent:')} ${accent(task.agent)}${sep}${dim('status:')} ${status(task)}${sep}${dim('attempt:')} ${accent(String(task.attempt ?? 1))}${sep}${dim('effort:')} ${accent(task.effort ?? 'default/current')}${cancelHint}`));
    lines.push(line(`${dim('model:')} ${task.model ?? 'default/current'}${displayName ? `${sep}${dim('name:')} ${accent(displayName)}` : ''}${sep}${dim('duration:')} ${fmtDuration(task)}${timeoutHint}`));
    if (usage) lines.push(line(`${dim('usage:')} ${usage}`));
    lines.push(line(`${dim('last:')} ${lastActivity}${stallHint}`));
    lines.push(line(`${dim('task:')} ${clip(task.task, bodyWidth - 6)}`));
    lines.push(this.taskStrip(bodyWidth));
    lines.push(divider);

    const headerCount = lines.length;
    const structuredBody = isValidThreadSnapshot(task.thread_snapshot);
    const bodyEntries = this.bodyEntriesFor(task, bodyWidth);
    // Pi components already return width-bounded visual lines. Do not re-wrap or
    // restyle structured thread snapshots, otherwise component spacing, borders,
    // ANSI styling, and tool differentiation collapse into plain text.
    const wrappedEntries = structuredBody ? bodyEntries : this.wrapWithTaskIds(bodyEntries, bodyWidth);
    const bodyHeight = Math.max(5, maxLines - headerCount - 2);
    const maxScroll = Math.max(0, wrappedEntries.length - bodyHeight);
    if (this.followTail || (this.lastMaxScroll > 0 && this.scroll >= this.lastMaxScroll)) this.scroll = maxScroll;
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    this.lastMaxScroll = maxScroll;
    const visible = wrappedEntries.slice(this.scroll, this.scroll + bodyHeight);

    this.rowTaskMap.clear();
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]!;
      const terminalRow = headerCount + i;
      if (entry.taskId) {
        this.rowTaskMap.set(terminalRow, entry.taskId);
      }
      lines.push(structuredBody ? line(entry.text) : this.renderFlowLine(entry.text, bodyWidth));
    }

    while (lines.length < maxLines - 1) lines.push('');
    const position = wrappedEntries.length > bodyHeight ? ` ${this.scroll + 1}-${Math.min(wrappedEntries.length, this.scroll + bodyHeight)}/${wrappedEntries.length} ` : '';
    const bottomFrame = bodyWidth >= position.length + 2
      ? line(`${border(BOX_CHARS.bottomLeft + BOX_CHARS.horizontal.repeat(Math.max(0, bodyWidth - position.length - 2)))}${dim(position)}${border(BOX_CHARS.bottomRight)}`)
      : line(`${dim('─'.repeat(Math.max(0, bodyWidth - position.length)))}${dim(position)}`);
    lines.push(bottomFrame);
    const lineWidths = lines.map((entry) => {
      try {
        return this.visibleWidth(entry);
      } catch {
        return terminalVisibleWidth(entry);
      }
    });
    this.lastRenderDebugState = {
      configuredMaxLines: maxLines,
      renderWidth: bodyWidth,
      renderedLineCount: lines.length,
      bodyHeight,
      maxVisibleWidth: lineWidths.reduce((max, value) => Math.max(max, value), 0),
      widthViolationCount: lineWidths.filter((value) => value > bodyWidth).length,
    };
    return lines;
  }

  cancelSelectedActiveTask(): void {
    const task = this.tasks()[this.selected];
    if (task && (task.status === 'queued' || task.status === 'running')) this.cancelSelectedTask?.(task.id);
  }

  private taskStrip(width: number): string {
    const tasks = this.tasks();
    const dim = (s: string) => this.theme?.fg?.('dim', s) ?? s;
    const selected = (s: string) => this.theme?.fg?.('warning', s) ?? s;
    const chip = (index: number): { raw: string; styled: string } => {
      const task = tasks[index]!;
      const raw = `${index === this.selected ? '●' : '○'} ${task.agent}:${task.status}${task.attempt ? ` attempt:${task.attempt}` : ''}${task.effort ? ` effort:${task.effort}` : ''}`;
      return { raw, styled: index === this.selected ? selected(raw) : dim(raw) };
    };
    const selectedChip = chip(this.selected);
    let start = this.selected;
    let end = this.selected + 1;
    let raw = selectedChip.raw;
    while (start > 0 || end < tasks.length) {
      const preferLeft = this.selected - start <= end - this.selected - 1;
      const nextIndex = preferLeft && start > 0 ? start - 1 : end < tasks.length ? end : start > 0 ? start - 1 : -1;
      if (nextIndex < 0) break;
      const next = chip(nextIndex).raw;
      const candidate = nextIndex < start ? `${next}  ${raw}` : `${raw}  ${next}`;
      const prefix = `executions ${Math.min(start, nextIndex) + 1}-${Math.max(end, nextIndex + 1)}/${tasks.length}  `;
      const leftIndicator = Math.min(start, nextIndex) > 0 ? '‹ ' : '';
      const rightIndicator = Math.max(end, nextIndex + 1) < tasks.length ? ' ›' : '';
      if (this.visibleWidth(`${prefix}${leftIndicator}${candidate}${rightIndicator}`) > width) break;
      raw = candidate;
      start = Math.min(start, nextIndex);
      end = Math.max(end, nextIndex + 1);
    }
    const styledChips: string[] = [];
    for (let i = start; i < end; i++) styledChips.push(chip(i).styled);
    const prefix = dim(`executions ${start + 1}-${end}/${tasks.length}`);
    const leftIndicator = start > 0 ? `${dim('‹')} ` : '';
    const rightIndicator = end < tasks.length ? ` ${dim('›')}` : '';
    return `${prefix}  ${leftIndicator}${styledChips.join('  ')}${rightIndicator}`;
  }

  private tasks(): SubagentTask[] {
    return typeof this.tasksProvider === 'function' ? this.tasksProvider() : this.tasksProvider;
  }

  private renderFlowLine(raw: string, width: number): string {
    const th = this.theme;
    if (raw.startsWith('Preparing for response') || /^\*\*.+\*\*$/.test(raw)) {
      const clipped = this.truncateToWidth(raw, width);
      const text = th?.bold?.(clipped) ?? clipped;
      return th?.fg?.('dim', text) ?? text;
    }
    if (this.isToolLikeLine(raw)) {
      const border = (t: string) => themeFg(th, 'accent', t, CYAN);
      const prefix = border(`${BOX_CHARS.vertical} `);
      const maxTextWidth = Math.max(0, width - 2);
      const clipped = this.truncateToWidth(raw, maxTextWidth);
      const text = th?.fg?.('toolTitle', clipped) ?? clipped;
      return `${prefix}${text}`;
    }
    if (raw.startsWith('done') || raw.startsWith('completed')) {
      const clipped = this.truncateToWidth(raw, width);
      return th?.fg?.('success', clipped) ?? clipped;
    }
    if (raw.startsWith('failed') || raw.startsWith('error')) {
      const clipped = this.truncateToWidth(raw, width);
      return th?.fg?.('error', clipped) ?? clipped;
    }
    if (raw.startsWith('# ') || raw.startsWith('## ') || raw.startsWith('### ')) {
      const border = (t: string) => themeFg(th, 'accent', t, CYAN);
      const titleText = raw.replace(/^#+\s*/, '');
      const heading = th?.bold?.(th?.fg?.('mdHeading', titleText) ?? titleText) ?? titleText;
      const leftFrame = `${border(BOX_CHARS.topLeft + BOX_CHARS.horizontal + ' ')}${heading} `;
      const leftVisWidth = this.visibleWidth(leftFrame);
      const rightCorner = border(BOX_CHARS.topRight);
      const rightVisWidth = this.visibleWidth(rightCorner);
      const filler = Math.max(0, width - leftVisWidth - rightVisWidth);
      const framed = `${leftFrame}${border(BOX_CHARS.horizontal.repeat(filler))}${rightCorner}`;
      return fitsWidth(framed, width, this.visibleWidth) ? framed : this.truncateToWidth(framed, width);
    }
    if (raw.startsWith('  ')) {
      const clipped = this.truncateToWidth(raw, width);
      return th?.fg?.('dim', clipped) ?? clipped;
    }
    return this.truncateToWidth(raw, width);
  }

  private taskSignature(task: SubagentTask): string {
    const snapshot = task.thread_snapshot;
    return [task.id, task.status, task.last_activity_at ?? '', task.ended_at ?? '', snapshot?.updated_at ?? '', snapshot?.items?.length ?? 0].join('|');
  }

  private resolveTaskForBody(task: SubagentTask): SubagentTask {
    if (task.thread_snapshot || !this.taskResolver) return task;
    const signature = this.taskSignature(task);
    const cached = this.hydratedTasks.get(task.id);
    if (cached?.signature === signature) return cached.task;
    const hydrated = this.taskResolver(task.id) ?? task;
    this.hydratedTasks.set(task.id, { signature, task: hydrated });
    return hydrated;
  }

  private bodyCacheKey(task: SubagentTask, width: number): string {
    return [this.taskSignature(task), width, this.toolOutputExpanded ? 'expanded' : 'collapsed', this.hideThinkingBlock ? 'thinking-hidden' : 'thinking-visible'].join('|');
  }

  private resolveTaskIdFromSnapshotItem(item: any, tasks: SubagentTask[]): string | undefined {
    if (!item) return undefined;
    const directId = item.taskId ?? item.task_id ?? item.subagentTaskId ?? item.subtaskId;
    if (typeof directId === 'string' && directId.trim()) return directId.trim();

    const details = item.result?.details;
    if (details) {
      if (typeof details.task?.id === 'string' && details.task.id.trim()) return details.task.id.trim();
      if (typeof details.task_id === 'string' && details.task_id.trim()) return details.task_id.trim();
      if (typeof details.taskId === 'string' && details.taskId.trim()) return details.taskId.trim();
      if (Array.isArray(details.tasks) && details.tasks[0]?.id) return String(details.tasks[0].id).trim();
      if (Array.isArray(details.task_ids) && details.task_ids[0]) return String(details.task_ids[0]).trim();
    }

    const resultTaskId = item.result?.task_id ?? item.result?.taskId ?? item.result?.task?.id;
    if (typeof resultTaskId === 'string' && resultTaskId.trim()) return resultTaskId.trim();

    const argsTaskId = item.arguments?.task_id ?? item.arguments?.taskId ?? item.arguments?.task?.id;
    if (typeof argsTaskId === 'string' && argsTaskId.trim()) return argsTaskId.trim();

    const toolName = typeof item.name === 'string' ? item.name : '';
    const isSubagentTool = toolName === 'subagent_run' || toolName === 'subagent_continue' || toolName === 'subagent' || toolName.startsWith('subagent');

    if (isSubagentTool || item.type === 'subagent') {
      const agentCandidate = item.arguments?.agent ?? item.arguments?.name;
      if (typeof agentCandidate === 'string' && agentCandidate.trim()) {
        const found = tasks.find((t) => t.id === agentCandidate || t.agent === agentCandidate || t.display_name === agentCandidate);
        if (found) return found.id;
      }
      const taskCandidate = item.arguments?.task;
      if (typeof taskCandidate === 'string' && taskCandidate.trim()) {
        const found = tasks.find((t) => t.task === taskCandidate || t.display_name === taskCandidate);
        if (found) return found.id;
      }
    }

    return undefined;
  }

  private resolveTaskIdFromFlowLine(line: string, tasks: SubagentTask[]): { cleanLine: string; taskId?: string } {
    const trimmed = line.trim();
    if (!trimmed) return { cleanLine: line };

    if (
      trimmed.startsWith('subagent:') ||
      trimmed.startsWith('model:') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('Preparing for response') ||
      trimmed.startsWith('done') ||
      trimmed.startsWith('completed') ||
      trimmed.startsWith('failed') ||
      trimmed.startsWith('error')
    ) {
      return { cleanLine: line };
    }

    let cleanLine = line;
    let taskId: string | undefined;

    const rawIdMatch = line.match(/\b(subtask_[a-zA-Z0-9_-]+)\b/);
    if (rawIdMatch) {
      taskId = rawIdMatch[1];
      cleanLine = cleanLine
        .replace(/\s*[\(\[]?subtask_[a-zA-Z0-9_-]+[\)\]]?/g, '')
        .replace(/\s{2,}/g, ' ')
        .trimEnd();
    }

    if (!taskId) {
      if (trimmed === 'main') {
        const found = tasks.find((t) => t.id === 'main' || t.agent === 'main');
        if (found) taskId = found.id;
      }

      const subagentMatch = trimmed.match(/^subagent\s+([^\s:]+)/);
      if (subagentMatch) {
        const agentName = subagentMatch[1]!;
        const found = tasks.find((t) => t.id === agentName || t.agent === agentName || t.display_name === agentName);
        if (found) taskId = found.id;
      }

      const bulletMatch = trimmed.match(/^(?:󰣇|●|○)\s+([^\s:]+)/);
      if (bulletMatch) {
        const agentName = bulletMatch[1]!;
        const found = tasks.find((t) => t.id === agentName || t.agent === agentName || t.display_name === agentName);
        if (found) taskId = found.id;
      }

      if (!taskId) {
        for (const t of tasks) {
          if (t.agent && (trimmed.startsWith(`${t.agent} `) || trimmed.startsWith(`${t.agent}:`) || trimmed === t.agent)) {
            taskId = t.id;
            break;
          }
          if (t.display_name && (trimmed.startsWith(`${t.display_name} `) || trimmed.startsWith(`${t.display_name}:`) || trimmed === t.display_name)) {
            taskId = t.id;
            break;
          }
        }
      }
    }

    return { cleanLine, taskId };
  }

  private wrapWithTaskIds(
    entries: Array<{ text: string; taskId?: string }>,
    width: number,
  ): Array<{ text: string; taskId?: string }> {
    const out: Array<{ text: string; taskId?: string }> = [];
    for (const entry of entries) {
      const wrappedTexts = this.wrap(entry.text, width);
      for (const text of wrappedTexts) {
        out.push({ text, taskId: entry.taskId });
      }
    }
    return out;
  }

  private executionFlowEntriesFor(task: SubagentTask): Array<{ text: string; taskId?: string }> {
    const rawFlow = this.executionFlowFor(task);
    const rawLines = rawFlow.split('\n');
    const tasks = this.tasks();
    return rawLines.map((line) => {
      const { cleanLine, taskId } = this.resolveTaskIdFromFlowLine(line, tasks);
      return { text: cleanLine, taskId };
    });
  }

  private bodyEntriesFor(task: SubagentTask, width: number): Array<{ text: string; taskId?: string }> {
    const activeSnapshot = isValidThreadSnapshot(task.thread_snapshot) ? task.thread_snapshot : undefined;
    const allowCache = !snapshotHasActiveTools(activeSnapshot);
    const cacheKey = this.bodyCacheKey(task, width);
    if (allowCache) {
      const cached = this.bodyCache.get(cacheKey);
      if (cached) return cached;
    }
    let entries: Array<{ text: string; taskId?: string }>;
    if (activeSnapshot) {
      const context = {
        ...this.renderContext,
        theme: this.renderContext.theme ?? this.theme,
        cwd: this.renderContext.cwd ?? process.cwd(),
        taskId: task.id,
        visibleWidth: this.renderContext.visibleWidth ?? this.visibleWidth,
        truncateToWidth: this.renderContext.truncateToWidth ?? this.truncateToWidth,
        renderWidth: width,
        toolOutputExpanded: this.toolOutputExpanded,
        hideThinkingBlock: this.hideThinkingBlock,
      };
      const rendered = renderThreadBody(activeSnapshot, context);
      const rawLines = rendered.length ? rendered : [''];
      const knownTasks = this.tasks();

      if (activeSnapshot.items.length <= 1) {
        const taskId = activeSnapshot.items[0]
          ? this.resolveTaskIdFromSnapshotItem(activeSnapshot.items[0], knownTasks)
          : undefined;
        entries = rawLines.map((text) => {
          const resolved = taskId ? { cleanLine: text, taskId } : this.resolveTaskIdFromFlowLine(text, knownTasks);
          return { text: resolved.cleanLine, taskId: resolved.taskId };
        });
      } else {
        const itemSlices: Array<{ lines: string[]; taskId?: string }> = [];
        for (const item of activeSnapshot.items) {
          const itemLines = renderThreadBody({ ...activeSnapshot, items: [item] }, context);
          const taskId = this.resolveTaskIdFromSnapshotItem(item, knownTasks);
          itemSlices.push({ lines: itemLines, taskId });
        }
        const flatLines = itemSlices.flatMap((s) => s.lines);
        if (flatLines.length === rawLines.length && flatLines.join('\n') === rawLines.join('\n')) {
          entries = itemSlices.flatMap((s) => s.lines.map((text) => {
            const resolved = s.taskId ? { cleanLine: text, taskId: s.taskId } : this.resolveTaskIdFromFlowLine(text, knownTasks);
            return { text: resolved.cleanLine, taskId: resolved.taskId };
          }));
        } else {
          entries = rawLines.map((lineText) => {
            const resolved = this.resolveTaskIdFromFlowLine(lineText, knownTasks);
            return { text: resolved.cleanLine, taskId: resolved.taskId };
          });
        }
      }

      if ((task.status === 'failed' || task.status === 'cancelled') && task.error && !hasEquivalentSnapshotError(activeSnapshot, task.error)) {
        entries.push({ text: '' }, { text: '# error' }, { text: task.error });
      }
    } else {
      entries = this.executionFlowEntriesFor(task);
    }
    if (!allowCache) return entries;
    this.bodyCache.set(cacheKey, entries);
    if (this.bodyCache.size > 50) {
      const oldest = this.bodyCache.keys().next().value;
      if (oldest !== undefined) this.bodyCache.delete(oldest);
    }
    return entries;
  }

  private bodyLinesFor(task: SubagentTask, width: number): string[] {
    return this.bodyEntriesFor(task, width).map((entry) => entry.text);
  }

  private executionFlowFor(task: SubagentTask): string {
    const usage = formatUsage(task.usage);
    const hasResp = typeof task.result === 'string' && task.result.trim().length > 0;
    const parts = [
      `subagent: ${task.agent} · status: ${task.status} · attempt: ${task.attempt ?? 1} · effort: ${task.effort ?? 'default/current'}`,
      `model: ${task.model ?? 'default/current'}${usage ? ` · usage: ${usage}` : ''}`,
      '',
      hasResp ? 'Preparing for response' : undefined,
      hasResp ? '' : undefined,
      task.prompt ? ['# delegated task', this.extractPromptTail(task.prompt)].join('\n') : ['# delegated task', task.task].join('\n'),
      task.context ? ['', '# context', task.context].join('\n') : undefined,
      task.continuation_prompt ? ['', '# continuation prompt', task.continuation_prompt].join('\n') : undefined,
      usage ? ['', '# usage', usage].join('\n') : undefined,
      task.transcript ? ['', '# execution', this.cleanTranscript(task.transcript)].join('\n') : undefined,
      task.error ? ['', '# error', task.error].join('\n') : undefined,
      hasResp ? ['', '# response sent to orchestrator', task.result].join('\n') : undefined,
      !task.transcript && !hasResp && !task.error ? ['', '# activity', `${task.last_activity ?? 'queued'}${task.output_preview ? `\n${task.output_preview}` : ''}`].join('\n') : undefined,
    ].filter(Boolean);
    return parts.join('\n').trim();
  }

  private cleanTranscript(transcript: string): string {
    return transcript
      .replace(/^# orchestrator prompt[\s\S]*?## delegated task\n/m, '')
      .replace(/\n# final assistant text[\s\S]*$/m, '')
      .replace(/\n# response sent to orchestrator[\s\S]*$/m, '')
      .split('\n')
      .filter((line) => !this.isNoiseLine(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private isToolLikeLine(raw: string): boolean {
    return raw.startsWith('subagent ') || raw.startsWith('memory_') || raw.startsWith('read ') || raw.startsWith('bash ') || raw.startsWith('edit ') || raw.startsWith('write ') || raw.startsWith('tool ');
  }

  private isNoiseLine(raw: string): boolean {
    const line = raw.trim();
    if (!line) return false;
    if (['agent_start', 'message_start', 'message_update', 'message_end', 'turn_start', 'turn_end'].includes(line)) return true;
    if (/^\{.*\}$/.test(line)) return true;
    return false;
  }

  private padToWidth(text: string, width: number): string {
    const clipped = this.truncateToWidth(text, width);
    return `${clipped}${' '.repeat(Math.max(0, width - this.visibleWidth(clipped)))}`;
  }

  private extractPromptTail(prompt: string): string {
    const marker = '## delegated task';
    const index = prompt.lastIndexOf(marker);
    if (index >= 0) return prompt.slice(index + marker.length).trim();
    return prompt.trim();
  }

  private wrap(text: string, width: number): string[] {
    const out: string[] = [];
    for (const raw of text.replace(/\t/g, '  ').split('\n')) {
      if (!raw) {
        out.push('');
        continue;
      }
      const indent = raw.match(/^\s*/)?.[0] ?? '';
      const words = raw.trimEnd().split(/\s+/);
      let line = indent && words.length ? indent + words.shift() : (words.shift() ?? '');
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (this.visibleWidth(next) <= width) {
          line = next;
          continue;
        }
        if (line) out.push(line);
        if (this.visibleWidth(word) > width) {
          let rest = word;
          while (this.visibleWidth(rest) > width) {
            let cut = Math.max(1, width);
            while (cut > 1 && this.visibleWidth(rest.slice(0, cut)) > width) cut--;
            out.push(rest.slice(0, cut));
            rest = rest.slice(cut);
          }
          line = rest;
        } else {
          line = indent + word;
        }
      }
      if (line) out.push(line);
    }
    return out;
  }
}
