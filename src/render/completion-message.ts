import { safeErrorMetadataDetails } from '../error-metadata.js';
import { wrapLineToWidth } from './text-width.js';

export function completionMessage(task: any): string {
  const result = task.result ?? task.error ?? task.output_preview ?? '(no result captured)';
  return [
    `Subagent ${task.agent} ${task.status}: ${task.id}`,
    '',
    'Read only this final response from the subagent. Do not reread the full execution transcript unless the user explicitly asks for debugging details.',
    '',
    '## response sent to the orchestrator',
    '',
    result,
  ].join('\n');
}

function safeCompletionErrorMetadata(task: any): Record<string, unknown> | undefined {
  if (!task?.error_metadata) return undefined;
  return safeErrorMetadataDetails(task.error_metadata as any);
}

export function sendSubagentCompletionMessage(pi: any, task: any): void {
  pi.sendMessage?.({
    customType: 'subagent-completion',
    content: completionMessage(task),
    display: true,
    details: {
      full_result: task.result ?? task.error ?? task.output_preview,
      task: {
        id: task.id,
        agent: task.agent,
        status: task.status,
        mode: task.mode,
        model: task.model,
        effort: task.effort,
        usage: task.usage,
        result: task.result,
        error: task.error,
        error_metadata: safeCompletionErrorMetadata(task),
      },
    },
  }, {
    triggerTurn: false,
    deliverAs: 'steer',
  });
}

export function renderSubagentCompletionMessage(message: any, options: any, theme: any) {
  const details = message.details ?? {};
  const task = details.task ?? details;
  const status = task.status ?? 'completed';
  const failed = status === 'failed' || status === 'cancelled';
  const expanded = Boolean(options?.expanded);
  const result = details.full_result ?? task.result ?? task.error ?? '';
  const title = `[subagent] ${task.agent ?? 'subagent'} ${status}: ${task.id ?? task.task_id ?? ''}`.trim();
  const sections: Array<{ text: string; style?: 'label' | 'status' | 'dim' | 'body' | 'heading' }> = [
    { text: title, style: 'label' },
    { text: `response: ${expanded ? 'expanded' : 'collapsed'}${expanded ? '' : ' · ctrl+o to expand'}`, style: expanded ? 'status' : 'dim' },
  ];
  if (expanded && result) {
    sections.push(
      { text: '─'.repeat(24), style: 'dim' },
      { text: 'response sent to the orchestrator', style: 'heading' },
      ...String(result).split('\n').map((line) => ({ text: line, style: 'body' as const })),
    );
  }
  const color = (section: { text: string; style?: 'label' | 'status' | 'dim' | 'body' | 'heading' }, text: string) => {
    if (section.style === 'label') return theme.fg?.(failed ? 'error' : 'customMessageLabel', text) ?? text;
    if (section.style === 'status') return theme.fg?.(failed ? 'error' : 'success', text) ?? text;
    if (section.style === 'dim') return theme.fg?.('dim', text) ?? text;
    if (section.style === 'heading') return theme.fg?.('toolTitle', text) ?? text;
    if (section.style === 'body') return theme.fg?.('customMessageText', text) ?? text;
    return text;
  };
  return {
    invalidate() {},
    render(width: number) {
      const blockWidth = Math.max(1, width);
      const contentWidth = Math.max(1, blockWidth - 2);
      return sections.flatMap((section) => wrapLineToWidth(section.text, contentWidth).map((line) => {
        const styled = color(section, line);
        const paddedVisibleWidth = Math.min(blockWidth, [...` ${line}`].length);
        const rightPadding = ' '.repeat(Math.max(0, blockWidth - paddedVisibleWidth));
        const padded = ` ${styled}${rightPadding}`;
        return theme.bg?.('customMessageBg', padded) ?? padded;
      }));
    },
  };
}
