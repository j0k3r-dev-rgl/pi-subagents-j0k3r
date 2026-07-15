import { describe, expect, it, vi } from 'vitest';
import extension from '../../index.js';
import { SubagentStructuredError, normalizeErrorMetadata } from '../../src/error-metadata.js';
import { SubagentManager } from '../../src/manager.js';
import { registerSubagentTools } from '../../src/tools.js';
import { installSubagentTestEnv } from '../helpers/subagent-test-helpers.js';

const env = installSubagentTestEnv();

describe('subagent_run tool', () => {
  it('tells the agent to free the chat and wait for automatic notification after background launch', async () => {
    env.writeAgent('analyst');
    const manager = new SubagentManager(env.mockRunner(50));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const result = await runTool.execute('1', { agent: 'analyst', task: 'background instructions', mode: 'background' }, undefined, undefined, { cwd: env.tmp });
    const text = result.content[0].text;

    expect(text).toContain('Sent 1 subagent task(s) to background');
    expect(text).toContain('Do not call subagent_status or subagent_result just to wait');
    expect(text).toContain('The subagent will notify this chat automatically when it finishes');
    expect(text).toContain('Keep the chat available so the user can continue asking questions');
    expect(result.terminate).not.toBe(true);
  });

  it('returns a background handoff result when ctrl+h shortcut is triggered in claude task mode', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    env.writeAgent('analyst');
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'claude' }));
    const manager = new SubagentManager(env.mockRunner(50));
    let runTool: any;
    let shortcutHandler: ((ctx: any) => any) | undefined;
    const notifications: string[] = [];
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    extension({
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: (key: string, shortcut: any) => {
        if (key === 'ctrl+h') shortcutHandler = shortcut.handler;
      },
    });

    const resultPromise = runTool.execute('1', { agent: 'analyst', task: 'render clearly', mode: 'task' }, undefined, undefined, {
      cwd: env.tmp,
      ui: {
        onTerminalInput: () => () => undefined,
        notify: (message: string) => { notifications.push(message); },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await shortcutHandler?.({ cwd: env.tmp, ui: { notify: (message: string) => { notifications.push(message); } } });

    const result = await resultPromise;
    const text = result.content[0].text;
    expect(result.isError).not.toBe(true);
    expect(result.terminate).toBe(true);
    expect(notifications.some((message) => message.includes('Sent subagent to background:'))).toBe(true);
    expect(text).toContain('Sent 1 subagent task(s) to background');
    const taskId = text.match(/subtask_[^\n]+/)?.[0]!;
    expect(manager.getTask(taskId, env.tmp)?.mode).toBe('background');
  });

  it('keeps subagent_run command results compact when tasks include large thread snapshots', async () => {
    env.writeAgent('analyst');
    const manager = new SubagentManager(async () => ({
      result: 'compact result',
      model: 'mock/model',
      fallback_used: false,
      thread_snapshot: env.statusSnapshot('oversized snapshot text '.repeat(400)),
    }));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const result = await runTool.execute('1', { agent: 'analyst', task: 'compact snapshots', mode: 'task' }, undefined, undefined, { cwd: env.tmp });
    const serialized = JSON.stringify(result);

    expect(result.content[0].text).toContain('Completed 1 subagent task');
    expect(serialized).not.toContain('thread_snapshot');
    expect(serialized).not.toContain('oversized snapshot text oversized snapshot text oversized snapshot text');
  });

  it('returns task-mode subagent_run with full content for the orchestrator and collapsed/expanded user render', async () => {
    env.writeAgent('analyst');
    const rawResponse = 'task-mode final response for orchestrator with tool-looking text to=functions.memory_get '.repeat(6);
    const manager = new SubagentManager(async () => ({ result: rawResponse, model: 'mock/model', fallback_used: false }));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const result = await runTool.execute('1', { agent: 'analyst', task: 'return full content', mode: 'task' }, undefined, undefined, { cwd: env.tmp });

    expect(result.content[0].text).toContain(rawResponse);
    expect(result.content[0].text).not.toContain('subagent_continue');
    expect(result.details.results[0].result).toBe(rawResponse);

    const collapsed = runTool.renderResult(result, { expanded: false, isPartial: false }, { fg: (_name: string, text: string) => text }).render(90).join('\n');
    expect(collapsed).toContain('response: collapsed');
    expect(collapsed).toContain('ctrl+o to expand');
    expect(collapsed).not.toContain('to=functions.memory_get');

    const expanded = runTool.renderResult(result, { expanded: true, isPartial: false }, { fg: (_name: string, text: string) => text }).render(120).join('\n');
    expect(expanded).toContain('Subagent response');
    expect(expanded).toContain('to=functions.memory_get');
  });

  it('returns an error tool result when any task-mode subagent fails', async () => {
    env.writeAgent('analyst');
    const manager = new SubagentManager(async () => { throw new Error('review failed'); });
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const result = await runTool.execute('1', { agent: 'analyst', task: 'fail', mode: 'task' }, undefined, undefined, { cwd: env.tmp });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('failed');
    expect(result.content[0].text).toContain('can be resumed with `subagent_continue`');
    expect(result.content[0].text).toContain('Ask the user before resuming');
    expect(result.content[0].text).toContain('model and effort');
    expect(result.content[0].text).toContain('Never switch models automatically');
  });

  it('exposes only safe structured error summaries in subagent_run details while preserving legacy error text', async () => {
    env.writeAgent('analyst');
    const manager = new SubagentManager(async () => {
      throw new SubagentStructuredError(normalizeErrorMetadata({
        category: 'provider_api_error',
        message: 'Authorization: Bearer sk-fake-secret-token fake.user@example.com /tmp/fake-private.txt',
        partial_result_available: false,
        details: {
          provider_code: '429',
          auth_header: 'Authorization: Bearer sk-fake-secret-token',
          prompt: 'SYSTEM: hidden prompt body',
          file_path: '/tmp/fake-private.txt',
          nested_payload: JSON.stringify({ transcript: 'SECRET_FILE_BODY_DO_NOT_SHOW' }),
        },
        last_activity: 'USER: hidden prompt body /tmp/fake-private.txt',
      }));
    });
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const runResult = await runTool.execute('1', { agent: 'analyst', task: 'structured failure', mode: 'task' }, undefined, undefined, { cwd: env.tmp });

    expect(runResult.isError).toBe(true);
    expect(runResult.details.results[0].error).toBe('provider api error');
    expect(runResult.details.results[0].error_metadata).toMatchObject({
      version: 1,
      category: 'provider_api_error',
      retryable: true,
      code: 'provider_api_error',
      partial_result_available: false,
      details: { provider_code: '429' },
    });
    const serialized = JSON.stringify(runResult.details.results[0].error_metadata);
    expect(serialized).not.toContain('sk-fake-secret-token');
    expect(serialized).not.toContain('fake.user@example.com');
    expect(serialized).not.toContain('/tmp/fake-private.txt');
    expect(serialized).not.toContain('hidden prompt body');
    expect(serialized).not.toContain('SECRET_FILE_BODY_DO_NOT_SHOW');
  });

  it('ignores marker-like prose and docs text as actionable interaction requests and keeps final output marker-free', async () => {
    env.writeAgent('analyst');
    const markerLikeText = [
      'documentation example:',
      'interaction_required:{"type":"interaction_required","requestId":"fake","kind":"docs"}',
      'tool output fixture mentions interaction_required:{"type":"interaction_required","requestId":"fake-2","kind":"docs"}',
    ].join('\n');
    const runner = vi.fn(async () => ({
      result: markerLikeText,
      model: 'mock/model',
      fallback_used: false,
      thread_snapshot: {
        version: 1,
        source: 'events',
        items: [
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: markerLikeText }] } },
          { type: 'tool', name: 'read', status: 'completed', arguments: { path: 'docs.md' }, result: { content: [{ type: 'text', text: markerLikeText }], isError: false } },
        ],
      },
    }));
    const manager = new SubagentManager(runner as any);
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const select = vi.fn();

    const result = await runTool.execute('1', { agent: 'analyst', task: 'document marker handling', mode: 'task' }, undefined, undefined, { cwd: env.tmp, ui: { select } });

    expect(select).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.details.results[0])).not.toContain('interaction_required:');
  });

  it('prompts the main thread from a generic select interaction, publishes the response, retries, and keeps surfaces marker-free', async () => {
    env.writeAgent('analyst');
    const request = {
      type: 'interaction_required' as const,
      requestId: 'req-select',
      kind: 'operator-choice',
      origin: 'subagent',
      requester: { subagentName: 'analyst' },
      reason: 'The subagent needs an operator decision.',
      prompt: {
        title: 'Choose strategy',
        message: 'How should the subagent continue?',
        choices: ['safe', 'fast'],
      },
      payload: { candidates: ['safe path', 'fast path'] },
      response: { expected: 'choice' },
    };
    let attempts = 0;
    const runner = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          result: 'stale transcript mentions interaction_required:{"type":"interaction_required","requestId":"stale","kind":"docs"}',
          model: 'mock/model',
          fallback_used: false,
          interaction_request: request,
          transcript: 'stale transcript mentions interaction_required:{"type":"interaction_required","requestId":"stale","kind":"docs"}',
          thread_snapshot: { version: 1, source: 'events', items: [{ type: 'status', text: 'interaction_required:{"type":"interaction_required","requestId":"stale","kind":"docs"}' }] },
        } as any;
      }
      const { consumeInteractionResponse } = await import('../../src/interaction-channel.js');
      const response = consumeInteractionResponse('req-select');
      expect(response).toMatchObject({ status: 'answered', value: 'safe' });
      return {
        result: `continued with ${response?.value}`,
        model: 'mock/model',
        fallback_used: false,
        thread_snapshot: { version: 1, source: 'events', items: [{ type: 'status', text: 'continued with safe' }] },
      } as any;
    });
    const manager = new SubagentManager(runner);
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const select = vi.fn(async (message: string, choices: string[]) => {
      expect(choices).toEqual(['safe', 'fast']);
      expect(message).toContain('How should the subagent continue?');
      expect(message).toContain('safe path');
      expect(message).not.toContain('stale');
      return 'safe';
    });

    const result = await runTool.execute('1', { agent: 'analyst', task: 'choose strategy', mode: 'task' }, undefined, undefined, { cwd: env.tmp, ui: { select } });
    const task = manager.listTasks(env.tmp)[0];

    expect(select).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeUndefined();
    expect(result.details.results[0].result).toContain('continued with safe');
    expect(JSON.stringify(result.details.results[0])).not.toContain('interaction_required:');
    expect(JSON.stringify(task)).not.toContain('interaction_required:');
  });

  it('uses editor fallback for arbitrary interaction payloads that cannot be represented as simple choices', async () => {
    env.writeAgent('analyst');
    const request = {
      type: 'interaction_required' as const,
      requestId: 'req-custom',
      kind: 'custom-workflow',
      origin: 'subagent',
      prompt: { title: 'Custom workflow input', message: 'Return a JSON plan.' },
      payload: { fields: [{ name: 'plan', type: 'array' }] },
      response: { expected: 'json', instructions: 'Return JSON with a plan array.' },
    };
    let attempts = 0;
    const runner = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return { result: 'custom interaction pending', model: 'mock/model', fallback_used: false, interaction_request: request };
      const { consumeInteractionResponse } = await import('../../src/interaction-channel.js');
      const response = consumeInteractionResponse('req-custom');
      expect(response).toMatchObject({ status: 'answered', value: { plan: ['inspect', 'apply'] } });
      return { result: 'custom response consumed', model: 'mock/model', fallback_used: false };
    });
    const manager = new SubagentManager(runner as any);
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const editor = vi.fn(async (message: string, initial: string) => {
      expect(message).toContain('Return a JSON plan.');
      expect(initial).toContain('custom-workflow');
      expect(initial).toContain('fields');
      return JSON.stringify({ plan: ['inspect', 'apply'] });
    });

    const result = await runTool.execute('1', { agent: 'analyst', task: 'needs arbitrary input', mode: 'task' }, undefined, undefined, { cwd: env.tmp, ui: { editor } });

    expect(editor).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeUndefined();
    expect(result.details.results[0].result).toContain('custom response consumed');
  });

  it('fails background subagents that request main-thread interaction', async () => {
    env.writeAgent('analyst');
    const request = {
      type: 'interaction_required' as const,
      requestId: 'req-background',
      kind: 'confirm',
      origin: 'subagent',
      prompt: { title: 'Confirm action', message: 'Continue?' },
      response: { expected: 'boolean' },
    };
    const runner = vi.fn(async () => ({ result: 'needs interaction', model: 'mock/model', fallback_used: false, interaction_request: request }));
    const manager = new SubagentManager(runner as any);
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const result = await runTool.execute('1', { agent: 'analyst', task: 'background interaction', mode: 'background' }, undefined, undefined, { cwd: env.tmp, ui: { confirm: vi.fn() } });

    expect(result.isError).toBeUndefined();
    const taskId = result.details.task_ids[0];
    await vi.waitFor(() => expect(manager.getTask(taskId, env.tmp)?.status).toBe('failed'));
    expect(manager.getTask(taskId, env.tmp)?.error).toContain('Subagent interaction requires main-thread handling');
  });
});
