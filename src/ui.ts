import { isValidThreadSnapshot, renderThreadBody } from './thread-view.js';
import type { SubagentTask, SubagentThreadRenderContext, SubagentThreadSnapshot, UsageStats } from './types.js';

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

function formatUsage(usage?: UsageStats): string {
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

export class SubagentsHistoryPanel {
  private selected = 0;
  private scroll = 0;
  private followTail = true;
  private lastMaxScroll = 0;
  private toolOutputExpanded = false;
  private hydratedTasks = new Map<string, { signature: string; task: SubagentTask }>();
  private bodyCache = new Map<string, string[]>();
  private lastRenderDebugState?: {
    configuredMaxLines: number;
    renderWidth: number;
    renderedLineCount: number;
    bodyHeight: number;
    maxVisibleWidth: number;
    widthViolationCount: number;
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
  ) {}

  invalidate(): void {}

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
    if (this.matchesKey(data, 'detailCancel')) {
      this.cancelSelectedActiveTask();
      return;
    }
    const wheel = mouseWheelDelta(data);
    if (wheel === -1) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.followTail = false;
      return;
    }
    if (wheel === 1) {
      this.scroll += 1;
      this.followTail = this.scroll >= this.lastMaxScroll;
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
    };
  }

  render(width: number): string[] {
    const w = Math.max(40, width);
    const bodyWidth = w;
    const configuredMaxLines = typeof this.maxLinesProvider === 'function' ? this.maxLinesProvider() : this.maxLinesProvider;
    const maxLines = Math.max(12, Math.floor(Number.isFinite(configuredMaxLines) ? configuredMaxLines : 42));
    const th = this.theme;
    const accent = (s: string) => th?.fg?.('accent', s) ?? s;
    const dim = (s: string) => th?.fg?.('dim', s) ?? s;
    const warn = (s: string) => th?.fg?.('warning', s) ?? s;
    const ok = (s: string) => th?.fg?.('success', s) ?? s;
    const err = (s: string) => th?.fg?.('error', s) ?? s;
    const title = (s: string) => th?.fg?.('toolTitle', th?.bold?.(s) ?? s) ?? s;
    const line = (s = '') => fitsWidth(s, bodyWidth, this.visibleWidth) ? s : this.truncateToWidth(s, bodyWidth);
    const divider = dim('─'.repeat(bodyWidth));
    const status = (task: SubagentTask) => task.status === 'completed' ? ok(task.status) : task.status === 'failed' ? err(task.status) : task.status === 'cancelled' ? warn(task.status) : accent(task.status);

    const lines: string[] = [];
    lines.push(line(`${title('subagents')} ${dim('session execution flow')} ${dim(`· ←/→ executions · ↑/↓ scroll · pgup/pgdn · ctrl+o expand · ${this.detailCancelShortcut} cancel active · esc/q close`)}`));
    lines.push(divider);

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
    const usage = formatUsage(task.usage);
    lines.push(line(`${accent(`${this.selected + 1}/${tasks.length}`)}  ${dim('agent:')} ${accent(task.agent)}  ${dim('status:')} ${status(task)}  ${dim('effort:')} ${accent(task.effort ?? 'default/current')}`));
    lines.push(line(`${dim('model:')} ${task.model ?? 'default/current'}  ${dim('id:')} ${task.id}  ${dim('duration:')} ${fmtDuration(task)}`));
    if (usage) lines.push(line(`${dim('usage:')} ${usage}`));
    lines.push(line(`${dim('last:')} ${task.last_activity ?? 'n/a'} ${dim(task.last_activity_at ?? '')}`));
    lines.push(line(`${dim('task:')} ${clip(task.task, bodyWidth - 6)}`));
    lines.push(this.taskStrip(bodyWidth));
    lines.push(divider);

    const structuredBody = isValidThreadSnapshot(task.thread_snapshot);
    const bodyLines = this.bodyLinesFor(task, bodyWidth);
    // Pi components already return width-bounded visual lines. Do not re-wrap or
    // restyle structured thread snapshots, otherwise component spacing, borders,
    // ANSI styling, and tool differentiation collapse into plain text.
    const wrapped = structuredBody ? bodyLines : this.wrap(bodyLines.join('\n'), bodyWidth);
    const bodyHeight = Math.max(5, maxLines - lines.length - 2);
    const maxScroll = Math.max(0, wrapped.length - bodyHeight);
    if (this.followTail || (this.lastMaxScroll > 0 && this.scroll >= this.lastMaxScroll)) this.scroll = maxScroll;
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    this.lastMaxScroll = maxScroll;
    const visible = wrapped.slice(this.scroll, this.scroll + bodyHeight);
    for (const raw of visible) lines.push(structuredBody ? line(raw) : this.renderFlowLine(raw, bodyWidth));

    while (lines.length < maxLines - 1) lines.push('');
    const position = wrapped.length > bodyHeight ? ` ${this.scroll + 1}-${Math.min(wrapped.length, this.scroll + bodyHeight)}/${wrapped.length}` : '';
    lines.push(line(`${dim('─'.repeat(Math.max(0, bodyWidth - position.length)))}${dim(position)}`));
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
      const raw = `${index === this.selected ? '●' : '○'} ${task.agent}:${task.status}${task.effort ? ` effort:${task.effort}` : ''}`;
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
      const padded = this.padToWidth(raw, width);
      return th?.bg?.('toolPendingBg', th?.fg?.('toolTitle', padded) ?? padded) ?? padded;
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
      const clipped = this.truncateToWidth(raw, width);
      const text = th?.bold?.(clipped) ?? clipped;
      return th?.fg?.('mdHeading', text) ?? text;
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
    return [this.taskSignature(task), width, this.toolOutputExpanded ? 'expanded' : 'collapsed'].join('|');
  }

  private bodyLinesFor(task: SubagentTask, width: number): string[] {
    const cacheKey = this.bodyCacheKey(task, width);
    const cached = this.bodyCache.get(cacheKey);
    if (cached) return cached;
    let lines: string[];
    if (isValidThreadSnapshot(task.thread_snapshot)) {
      const rendered = renderThreadBody(task.thread_snapshot, {
        ...this.renderContext,
        theme: this.renderContext.theme ?? this.theme,
        cwd: this.renderContext.cwd ?? process.cwd(),
        taskId: task.id,
        visibleWidth: this.renderContext.visibleWidth ?? this.visibleWidth,
        truncateToWidth: this.renderContext.truncateToWidth ?? this.truncateToWidth,
        renderWidth: width,
        toolOutputExpanded: this.toolOutputExpanded,
      });
      lines = rendered.length ? rendered : [''];
      if ((task.status === 'failed' || task.status === 'cancelled') && task.error && !hasEquivalentSnapshotError(task.thread_snapshot, task.error)) {
        lines = [...lines, '', '# error', task.error];
      }
    } else {
      lines = [this.executionFlowFor(task)];
    }
    this.bodyCache.set(cacheKey, lines);
    if (this.bodyCache.size > 50) {
      const oldest = this.bodyCache.keys().next().value;
      if (oldest !== undefined) this.bodyCache.delete(oldest);
    }
    return lines;
  }

  private executionFlowFor(task: SubagentTask): string {
    const usage = formatUsage(task.usage);
    const parts = [
      `agent: ${task.agent} · status: ${task.status} · effort: ${task.effort ?? 'default/current'}`,
      `model: ${task.model ?? 'default/current'}${usage ? ` · usage: ${usage}` : ''}`,
      '',
      `Preparing for response`,
      '',
      task.prompt ? ['# delegated task', this.extractPromptTail(task.prompt)].join('\n') : ['# delegated task', task.task].join('\n'),
      task.context ? ['', '# context', task.context].join('\n') : undefined,
      usage ? ['', '# usage', usage].join('\n') : undefined,
      task.transcript ? ['', '# execution', this.cleanTranscript(task.transcript)].join('\n') : undefined,
      task.error ? ['', '# error', task.error].join('\n') : undefined,
      task.result ? ['', '# response sent to orchestrator', task.result].join('\n') : undefined,
      !task.transcript && !task.result && !task.error ? ['', '# activity', `${task.last_activity ?? 'queued'}${task.output_preview ? `\n${task.output_preview}` : ''}`].join('\n') : undefined,
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
