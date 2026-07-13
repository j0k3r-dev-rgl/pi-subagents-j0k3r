import { writeSubagentsDebugLog } from '../debug.js';
import { sanitizeInteractionTransportText } from '../interaction-channel.js';
import { boundThreadSnapshot } from '../thread-view.js';
import type { SubagentThreadItem, SubagentThreadSnapshot, SubagentToolItem, SubagentToolResultPayload } from '../types.js';

function shortJson(value: unknown, limit = 900): string {
  try {
    const text = JSON.stringify(value, (_key, val) => typeof val === 'string' && val.length > 300 ? `${val.slice(0, 300)}…` : val);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return '[unserializable]';
  }
}

const SNAPSHOT_TEXT_LIMIT = 4000;

function debugLog(cwd: string | undefined, scope: string, data: unknown): void {
  writeSubagentsDebugLog(cwd, scope, data);
}

function truncateSnapshotText(text: string | undefined, limit = SNAPSHOT_TEXT_LIMIT): string | undefined {
  if (text === undefined) return undefined;
  const sanitized = sanitizeInteractionTransportText(text);
  return sanitized.length > limit ? `${sanitized.slice(0, limit - 1)}…` : sanitized;
}

function eventToolCallId(event: any): string | undefined {
  return event?.toolCallId ?? event?.tool_call_id ?? event?.toolUseId ?? event?.id;
}

function resultTextFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : typeof record.data === 'string' ? record.data : '';
    })
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function resultPayload(result: unknown, isError = false): SubagentToolResultPayload {
  let text = '';
  let details: unknown;
  if (typeof result === 'string') text = result;
  else if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    details = record.details;
    const candidate = resultTextFromContent(record.content) ?? record.output ?? record.text ?? record.error ?? record.stderr ?? record.stdout;
    text = typeof candidate === 'string' ? candidate : shortJson(result, SNAPSHOT_TEXT_LIMIT);
  } else if (result !== undefined) text = String(result);
  const bounded = truncateSnapshotText(text, SNAPSHOT_TEXT_LIMIT) ?? '';
  return { content: bounded ? [{ type: 'text', text: bounded }] : [], details, isError, preview: bounded };
}

function isBashTool(name: string): boolean {
  return name === 'bash' || name === 'shell' || name === 'command' || name === 'exec';
}

function parseRawToolJson(text: string): { keys: string[]; kind: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed || !((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return undefined;
    return { kind: Array.isArray(parsed) ? 'array' : 'object', keys: Array.isArray(parsed) ? [] : Object.keys(parsed).slice(0, 20) };
  } catch {
    return undefined;
  }
}

function formatToolCall(name: string, args: any): string {
  const input = args ?? {};
  if (name === 'read') {
    const file = input.path ?? input.file_path ?? input.file ?? '';
    const offset = input.offset ?? 1;
    const limit = input.limit;
    const range = limit ? `:${offset}-${offset + limit - 1}` : offset && offset !== 1 ? `:${offset}` : '';
    return `read ${file}${range}`.trim();
  }
  if (name === 'bash') return `bash ${String(input.command ?? '').split('\n')[0] ?? ''}`.trim();
  if (name === 'edit') return `edit ${input.path ?? input.file_path ?? ''}`.trim();
  if (name === 'write') return `write ${input.path ?? input.file_path ?? ''}`.trim();
  if (name.startsWith('memory_')) return name;
  return `${name} ${shortJson(input)}`.trim();
}

export class ThreadSnapshotBuilder {
  private cwd?: string;
  private readonly createdAt = new Date().toISOString();
  private readonly items: SubagentThreadItem[] = [];
  private readonly toolIndex = new Map<string, number>();
  private streamingAssistantSequence = 0;

  constructor(prompt?: string, context?: string, cwd?: string) {
    this.cwd = cwd;
    if (prompt?.trim()) this.items.push({ type: 'user', id: 'delegated-prompt', label: 'delegated_task', text: truncateSnapshotText(prompt) ?? '' });
    if (context?.trim()) this.items.push({ type: 'user', id: 'delegated-context', label: 'context', text: truncateSnapshotText(context) ?? '' });
  }

  update(event: any): void {
    const now = new Date().toISOString();
    const messageEvent = event?.assistantMessageEvent;
    const textDelta = event?.type === 'message_update' && messageEvent?.type !== 'thinking_delta'
      ? typeof messageEvent?.delta === 'string'
        ? messageEvent.delta
        : messageEvent?.type === 'text_delta' && typeof messageEvent.delta === 'string'
          ? messageEvent.delta
          : undefined
      : undefined;
    const thinkingDelta = event?.type === 'message_update' && messageEvent?.type === 'thinking_delta' && typeof messageEvent.delta === 'string'
      ? messageEvent.delta
      : undefined;
    if (textDelta !== undefined || thinkingDelta !== undefined) {
      this.appendAssistantDelta(textDelta, thinkingDelta);
      return;
    }
    if (event?.type === 'tool_execution_start') {
      const name = event.toolName ?? event.name ?? 'tool';
      const tool_call_id = eventToolCallId(event);
      this.dropTrailingRawToolJson(name, tool_call_id);
      if (isBashTool(name)) {
        const command = String((event.args ?? event.input ?? {}).command ?? formatToolCall(name, event.args ?? event.input ?? {}));
        const item: any = { type: 'bash', id: tool_call_id, tool_call_id, command: truncateSnapshotText(command) ?? '', status: 'running' };
        this.toolIndex.set(tool_call_id ?? `item-${this.items.length}`, this.items.length);
        this.items.push(item);
        return;
      }
      const item: SubagentToolItem = { type: 'tool', id: tool_call_id, tool_call_id, name, arguments: event.args ?? event.input ?? {}, status: 'running', started_at: now };
      this.toolIndex.set(tool_call_id ?? `item-${this.items.length}`, this.items.length);
      this.items.push(item);
      return;
    }
    if (event?.type === 'tool_execution_update') {
      const id = eventToolCallId(event);
      const index = id ? this.toolIndex.get(id) : undefined;
      if (index === undefined) return;
      const item: any = this.items[index];
      const payload = resultPayload(event.partialResult, false);
      if (item.type === 'bash') item.output = truncateSnapshotText([item.output, payload.preview].filter(Boolean).join('\n'));
      else if (item.type === 'tool') item.result = payload;
      if (item.type === 'tool') item.status = 'partial';
      return;
    }
    if (event?.type === 'tool_execution_end') {
      const id = eventToolCallId(event);
      const name = event.toolName ?? event.name ?? 'tool';
      const index = id ? this.toolIndex.get(id) : undefined;
      const payload = resultPayload(event.result ?? event.output ?? event.error, Boolean(event.isError));
      if (index === undefined) {
        this.items.push({ type: 'tool_result', id, tool_call_id: id, name, result: payload });
        return;
      }
      const item: any = this.items[index];
      if (item.type === 'bash') {
        const result = event.result && typeof event.result === 'object' ? event.result as Record<string, unknown> : {};
        const output = payload.preview ?? '';
        item.output = truncateSnapshotText(output);
        item.truncated = typeof output === 'string' && output.endsWith('…');
        item.exitCode = typeof result.exitCode === 'number' ? result.exitCode : undefined;
        item.status = event.isError ? 'failed' : 'completed';
      } else if (item.type === 'tool') {
        item.status = event.isError ? 'failed' : 'completed';
        item.result = payload;
        item.ended_at = now;
      }
    }
  }

  snapshot(source: SubagentThreadSnapshot['source'] = 'events'): SubagentThreadSnapshot | undefined {
    return boundThreadSnapshot({ version: 1, created_at: this.createdAt, updated_at: new Date().toISOString(), source, items: this.items }, { textLimit: SNAPSHOT_TEXT_LIMIT });
  }

  finalize(messages: any[]): SubagentThreadSnapshot | undefined {
    const messageItems = assistantItemsFromMessages(messages);
    const initialItems: SubagentThreadItem[] = this.items.filter((item) => item.type === 'user');
    const finalMessagesAlreadyHaveThinking = messageItems.some((item) => item.type === 'assistant' && item.message.content.some((part) => part.type === 'thinking'));
    const eventItems = this.items
      .filter((item) => item.type !== 'user')
      .map((item) => this.finalizeEventItem(item, messageItems.length > 0, finalMessagesAlreadyHaveThinking))
      .filter((item): item is SubagentThreadItem => Boolean(item));
    const items: SubagentThreadItem[] = [...initialItems, ...(messageItems.length ? interleaveMessagesWithToolRows(messageItems, eventItems) : eventItems)];
    const source = messageItems.length && eventItems.length ? 'mixed' : messageItems.length ? 'session_messages' : 'events';
    return boundThreadSnapshot({ version: 1, created_at: this.createdAt, updated_at: new Date().toISOString(), source, items }, { textLimit: SNAPSHOT_TEXT_LIMIT });
  }

  private dropTrailingRawToolJson(toolName?: string, toolCallId?: string): void {
    const item = this.items.at(-1) as SubagentThreadItem | undefined;
    if (item?.type !== 'assistant' || !item.id?.startsWith('streaming-assistant-')) return;
    const textParts = item.message.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
    const hasNonText = item.message.content.some((part) => part.type !== 'text');
    if (hasNonText || !textParts.length) return;
    const text = textParts.map((part) => part.text).join('');
    const parsed = parseRawToolJson(text);
    if (!parsed) return;

    this.items.pop();
    debugLog(this.cwd, 'live_raw_tool_json_dropped', { toolName, toolCallId, jsonKind: parsed.kind, keys: parsed.keys, textLength: text.length });
  }

  private appendAssistantDelta(textDelta?: string, thinkingDelta?: string): void {
    let item = this.items.at(-1) as SubagentThreadItem | undefined;
    if (item?.type !== 'assistant' || !item.id?.startsWith('streaming-assistant-')) {
      item = { type: 'assistant', id: `streaming-assistant-${++this.streamingAssistantSequence}`, message: { role: 'assistant', content: [] } };
      this.items.push(item);
    }
    const content = item.message.content as any[];
    if (thinkingDelta) {
      let thinkingPart = content.find((part) => part.type === 'thinking');
      if (!thinkingPart) {
        thinkingPart = { type: 'thinking', text: '', thinking: '' };
        const firstText = content.findIndex((part) => part.type === 'text');
        if (firstText >= 0) content.splice(firstText, 0, thinkingPart);
        else content.push(thinkingPart);
      }
      const thinking = truncateSnapshotText(`${thinkingPart.thinking ?? thinkingPart.text ?? ''}${thinkingDelta}`) ?? '';
      thinkingPart.text = thinking;
      thinkingPart.thinking = thinking;
    }
    if (textDelta) {
      let textPart = content.find((part) => part.type === 'text');
      if (!textPart) {
        textPart = { type: 'text', text: '' };
        content.push(textPart);
      }
      textPart.text = truncateSnapshotText(`${textPart.text ?? ''}${textDelta}`) ?? '';
    }
  }

  private finalizeEventItem(item: SubagentThreadItem, hasFinalMessages: boolean, finalMessagesAlreadyHaveThinking: boolean): SubagentThreadItem | undefined {
    if (item.type !== 'assistant' || !item.id?.startsWith('streaming-assistant-')) return item;
    if (!hasFinalMessages) return item;
    if (finalMessagesAlreadyHaveThinking) return undefined;
    const thinkingContent = item.message.content
      .filter((part): part is { type: 'thinking'; text?: string; thinking?: string } => part.type === 'thinking' && Boolean((part.thinking ?? part.text)?.trim()))
      .map((part) => ({ type: 'thinking' as const, text: truncateSnapshotText(part.text), thinking: truncateSnapshotText(part.thinking ?? part.text) }));
    return thinkingContent.length ? { ...item, message: { ...item.message, content: thinkingContent } } : undefined;
  }
}

function assistantToolCallIds(item: SubagentThreadItem): Set<string> {
  const ids = new Set<string>();
  if (item.type !== 'assistant') return ids;
  for (const part of item.message.content) if (part.type === 'toolCall') ids.add(part.id);
  return ids;
}

function toolRowId(item: SubagentThreadItem): string | undefined {
  if (item.type === 'tool' || item.type === 'tool_result') return item.tool_call_id ?? item.id;
  if (item.type === 'bash') return item.tool_call_id ?? item.id;
  return undefined;
}

function interleaveMessagesWithToolRows(messageItems: SubagentThreadItem[], eventItems: SubagentThreadItem[]): SubagentThreadItem[] {
  const used = new Set<number>();
  const ordered: SubagentThreadItem[] = [];
  const deferredMessages: SubagentThreadItem[] = [];
  for (const messageItem of messageItems) {
    const ids = assistantToolCallIds(messageItem);
    if (!ids.size) {
      deferredMessages.push(messageItem);
      continue;
    }
    for (let index = 0; index < eventItems.length; index++) {
      if (used.has(index)) continue;
      const id = toolRowId(eventItems[index]!);
      if (id && ids.has(id)) break;
      ordered.push(eventItems[index]!);
      used.add(index);
    }
    ordered.push(messageItem);
    for (let index = 0; index < eventItems.length; index++) {
      if (used.has(index)) continue;
      const id = toolRowId(eventItems[index]!);
      if (id && ids.has(id)) {
        ordered.push(eventItems[index]!);
        used.add(index);
      }
    }
  }
  for (let index = 0; index < eventItems.length; index++) if (!used.has(index)) ordered.push(eventItems[index]!);
  ordered.push(...deferredMessages);
  return ordered;
}

function assistantItemsFromMessages(messages: any[]): SubagentThreadItem[] {
  const items: SubagentThreadItem[] = [];
  for (const msg of messages) {
    if (msg?.role !== 'assistant') continue;
    if (typeof msg.content === 'string') {
      if (msg.content.trim()) items.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: truncateSnapshotText(msg.content) ?? '' }], usage: msg.usage } });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    const content = msg.content.flatMap((part: any) => {
      if (part?.type === 'text' && typeof part.text === 'string') return [{ type: 'text' as const, text: truncateSnapshotText(part.text) ?? '' }];
      if (part?.type === 'thinking') {
        const thinking = typeof part.thinking === 'string' ? part.thinking : typeof part.text === 'string' ? part.text : '';
        return thinking ? [{ type: 'thinking' as const, text: truncateSnapshotText(thinking), thinking: truncateSnapshotText(thinking) }] : [];
      }
      if ((part?.type === 'toolCall' || part?.type === 'tool_call') && typeof part.name === 'string') return [{ type: 'toolCall' as const, id: String(part.id ?? part.toolCallId ?? part.tool_call_id ?? part.name), name: part.name, arguments: part.arguments ?? part.args ?? part.input ?? {} }];
      return [];
    });
    if (content.length) items.push({ type: 'assistant', id: msg.id, message: { role: 'assistant', content, stopReason: msg.stopReason, errorMessage: msg.errorMessage, usage: msg.usage } });
  }
  return items;
}
