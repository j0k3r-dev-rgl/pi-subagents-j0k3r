import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubagentStructuredError, classifyFallbackFailure, classifyThrownError, deriveErrorString, normalizeErrorMetadata } from '../../src/error-metadata.js';
import type { SubagentDefinition, SubagentErrorMetadata, SubagentsConfig } from '../../src/types.js';

describe('subagent runner thread snapshots', () => {
  const definition: SubagentDefinition = {
    name: 'sdd-apply',
    description: 'implementation executor',
    filePath: '/tmp/sdd-apply.md',
    instructions: 'return a concise result',
    tools: ['bash', 'memory_search', 'custom_tool'],
  };
  const config: SubagentsConfig = {
    timeout_ms: 10_000,
    stall_timeout_ms: 10_000,
    max_concurrency: 1,
    default_tools: ['bash', 'memory_search', 'custom_tool'],
    model_profiles: {},
  };

  async function runWithSession(session: any, cwd = '/workspace') {
    vi.resetModules();
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));
    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const activities: any[] = [];
    const result = await sdkSubagentRunner({
      definition,
      task: 'capture a thread snapshot',
      cwd,
      ctx: { model: { provider: 'test', id: 'model' } },
      config,
      signal: new AbortController().signal,
      onActivity: (activity) => activities.push(activity),
    });
    return { result, activities };
  }

  it('emits and returns bounded snapshots for assistant text, paired bash output, tool errors, and custom fallback tools without changing result or usage', async () => {
    const largeOutput = 'x'.repeat(6000);
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'streamed ' } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'printf hello' } });
        subscriber?.({ type: 'tool_execution_update', toolCallId: 'bash-1', toolName: 'bash', partialResult: { output: 'hello\n' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'bash-1', toolName: 'bash', isError: false, result: { output: largeOutput, exitCode: 0 } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'mem-1', toolName: 'memory_search', args: { query: 'prior decisions' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'mem-1', toolName: 'memory_search', isError: true, result: { content: [{ type: 'text', text: 'memory unavailable' }] } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'custom-1', toolName: 'custom_tool', args: { value: 42 } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'custom-1', toolName: 'custom_tool', isError: false, result: { text: 'custom result' } });
      }),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }],
      dispose: vi.fn(async () => undefined),
    };

    const { result, activities } = await runWithSession(session);

    expect(result.result).toBe('final answer');
    expect(result.usage).toMatchObject({ input: 0, output: 0, turns: 0 });
    expect(activities.some((activity) => activity.thread_snapshot?.items?.length > 0)).toBe(true);
    expect(result.thread_snapshot).toMatchObject({ version: 1, source: 'mixed' });
    expect(result.thread_snapshot?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [expect.objectContaining({ type: 'text', text: 'final answer' })] }) }),
      expect.objectContaining({ type: 'bash', tool_call_id: 'bash-1', command: 'printf hello', status: 'completed' }),
      expect.objectContaining({ type: 'tool', tool_call_id: 'mem-1', name: 'memory_search', status: 'failed', result: expect.objectContaining({ isError: true, preview: expect.stringContaining('memory unavailable') }) }),
      expect.objectContaining({ type: 'tool', tool_call_id: 'custom-1', name: 'custom_tool', status: 'completed', result: expect.objectContaining({ preview: expect.stringContaining('custom result') }) }),
    ]));
    const bashItem = result.thread_snapshot?.items.find((item: any) => item.type === 'bash') as any;
    expect(bashItem.output.length).toBeLessThan(4500);
    expect(bashItem.truncated).toBe(true);
  });

  it('fails stalled tool sessions instead of returning streamed tool-call json as the final result', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    let subscriber: ((event: unknown) => void) | undefined;
    let resolvePrompt: (() => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{"path":"openspec/changes/websearch-extension/spec.md"}' } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'openspec/changes/websearch-extension/spec.md' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'spec body' }] } });
        return new Promise<void>((resolve) => { resolvePrompt = resolve; });
      }),
      abort: vi.fn(async () => { resolvePrompt?.(); }),
      messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'openspec/changes/websearch-extension/spec.md' } }] }],
      dispose: vi.fn(async () => undefined),
    };
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));

    try {
      const { sdkSubagentRunner } = await import('../../src/runner.js');
      const promise = sdkSubagentRunner({
        definition,
        task: 'apply work that stalls after tools',
        cwd: '/workspace',
        ctx: { model: { provider: 'test', id: 'model' } },
        config: { ...config, stall_timeout_ms: 20 },
        signal: new AbortController().signal,
      });
      const rejection = promise.then(
        () => undefined,
        (error) => error,
      );

      await vi.dynamicImportSettled();
      expect(session.prompt).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(600);
      const error = await rejection;
      expect(error).toBeInstanceOf(Error);
      expect(error.error_metadata).toMatchObject({
        category: 'unknown_fallback',
        attempts: [expect.objectContaining({ category: 'stall_timeout', phase: 'runner_session', role: 'primary' })],
      });
      expect(session.abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps toolcall deltas out of live assistant text while preserving native tool rows', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const calls = [
      { id: 'graph-1', name: 'workspace_graph_status', args: {} },
      { id: 'bash-1', name: 'bash', args: { command: 'ls -la', timeout: 10 } },
    ];
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Starting codebase inventory' } });
        for (const call of calls) {
          subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } });
          subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: JSON.stringify(call.args) } });
          subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end' } });
        }
        for (const call of calls) {
          subscriber?.({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.args });
          subscriber?.({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, isError: false, result: { content: [{ type: 'text', text: 'done' }] } });
        }
      }),
      messages: [{ role: 'assistant', content: [
        { type: 'thinking', thinking: 'Starting codebase inventory' },
        ...calls.map((call) => ({ type: 'toolCall', id: call.id, name: call.name, arguments: call.args })),
        { type: 'text', text: 'final answer' },
      ] }],
      dispose: vi.fn(async () => undefined),
    };

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-runner-json-'));
    fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.pi', 'subagents.json'), JSON.stringify({ debug: true }));
    try {
      const { result, activities } = await runWithSession(session, cwd);
      expect(activities.filter((activity) => activity.message === 'streaming response')).toHaveLength(0);
      const afterToolStart = activities.find((activity) => activity.message?.startsWith('workspace_graph_status'));
      const assistantContent = afterToolStart?.thread_snapshot?.items
        .filter((item: any) => item.type === 'assistant')
        .flatMap((item: any) => item.message.content.map((part: any) => part.text ?? part.thinking ?? ''))
        .join('\n') ?? '';
      expect(assistantContent).toContain('Starting codebase inventory');
      expect(assistantContent).not.toContain('{"command"');
      expect(afterToolStart?.transcript).not.toContain('{"command"');
      expect(result.thread_snapshot?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool', name: 'workspace_graph_status', arguments: {} }),
        expect.objectContaining({ type: 'bash', command: 'ls -la', status: 'completed' }),
      ]));
      const log = fs.readFileSync(path.join(cwd, '.pi', 'subagents-debug.log'), 'utf8');
      expect(log).toContain('"assistantEventType":"toolcall_delta"');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('interleaves final session tool-call messages with matching tool rows before final assistant text', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'AGENTS.md' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: '# Agent Guide' }] } });
      }),
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'AGENTS.md' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'final after tools' }] },
      ],
      dispose: vi.fn(async () => undefined),
    };

    const { result } = await runWithSession(session);
    const labels = result.thread_snapshot?.items.map((item: any) => item.type === 'assistant'
      ? `assistant:${item.message.content.map((part: any) => part.type === 'toolCall' ? `toolCall:${part.name}` : part.text).join('|')}`
      : `${item.type}:${item.name}`);

    expect(labels).toEqual(['user:undefined', 'assistant:toolCall:read', 'tool:read', 'assistant:final after tools']);
    expect(result.thread_snapshot?.items[0]).toMatchObject({ type: 'user', label: 'delegated_task' });
    expect(JSON.stringify(result.thread_snapshot)).toContain('# Agent Guide');
  });

  it('persists streamed model thinking in sequence with tool rows in the final thread snapshot', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'first reasoning before reading' } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'AGENTS.md' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: '# Agent Guide' }] } });
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'second reasoning after reading' } });
      }),
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'AGENTS.md' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'final answer after sequential thinking' }] },
      ],
      dispose: vi.fn(async () => undefined),
    };

    const { result } = await runWithSession(session);
    const labels = result.thread_snapshot?.items.map((item: any) => {
      if (item.type === 'assistant') return `assistant:${item.message.content.map((part: any) => part.type === 'thinking' ? `thinking:${part.thinking}` : part.type === 'toolCall' ? `toolCall:${part.name}` : `text:${part.text}`).join('|')}`;
      if (item.type === 'tool') return `tool:${item.name}`;
      return `${item.type}:${item.label}`;
    });

    expect(labels).toEqual([
      'user:delegated_task',
      'assistant:thinking:first reasoning before reading',
      'assistant:toolCall:read',
      'tool:read',
      'assistant:thinking:second reasoning after reading',
      'assistant:text:final answer after sequential thinking',
    ]);
  });

  it('preserves streamed model thinking in the final thread snapshot when final messages omit it', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking through the file plan' } });
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'draft text that should not replace final' } });
      }),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final answer after thinking' }] }],
      dispose: vi.fn(async () => undefined),
    };

    const { result, activities } = await runWithSession(session);

    expect(activities.find((activity) => activity.message === 'streaming thinking')?.thread_snapshot?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [expect.objectContaining({ type: 'thinking', thinking: expect.stringContaining('thinking through the file plan') })] }) }),
    ]));
    expect(result.result).toBe('final answer after thinking');
    expect(result.thread_snapshot?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [expect.objectContaining({ type: 'thinking', thinking: expect.stringContaining('thinking through the file plan') })] }) }),
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [expect.objectContaining({ type: 'text', text: 'final answer after thinking' })] }) }),
    ]));
    expect(JSON.stringify(result.thread_snapshot)).not.toContain('draft text that should not replace final');
  });

  it('finalizes assistant text from session messages when available while preserving streamed activity snapshots', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'draft text' } });
      }),
      messages: [{ role: 'assistant', content: 'final from messages' }],
      dispose: vi.fn(async () => undefined),
    };

    const { result, activities } = await runWithSession(session);

    expect(activities.find((activity) => activity.message === 'streaming response')?.thread_snapshot?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant' }),
    ]));
    expect(result.result).toBe('final from messages');
    expect(result.thread_snapshot?.source).toBe('session_messages');
    expect(JSON.stringify(result.thread_snapshot)).toContain('final from messages');
  });
});
