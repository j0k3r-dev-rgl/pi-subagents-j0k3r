import { describe, expect, it, vi } from 'vitest';
import extension, { completionMessage, sendSubagentCompletionMessage } from '../../index.js';
import { installSubagentTestEnv } from '../helpers/subagent-test-helpers.js';

const env = installSubagentTestEnv();

describe('completion message render', () => {
  it('adds English resume instructions only to failed and cancelled completion messages', () => {
    for (const status of ['failed', 'cancelled']) {
      const message = completionMessage({ id: `subtask_${status}`, agent: 'analyst', status, error: `${status} result` });
      expect(message).toContain('can be resumed with `subagent_continue`');
      expect(message).toContain('Ask the user before resuming');
      expect(message).toContain('model and effort');
      expect(message).toContain('Never switch models automatically');
    }

    const completed = completionMessage({ id: 'subtask_completed', agent: 'analyst', status: 'completed', result: 'done' });
    expect(completed).not.toContain('subagent_continue');
    expect(completed).not.toContain('Ask the user before resuming');
  });

  it('registers a compact/expanded renderer for background subagent completion messages', () => {
    let renderer: any;
    extension({
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      registerMessageRenderer: (customType: string, value: any) => { if (customType === 'subagent-completion') renderer = value; },
    });
    const message = {
      customType: 'subagent-completion',
      content: 'full content for orchestrator to=functions.memory_get',
      details: {
        full_result: 'background final response to=functions.memory_get',
        task: { id: 'subtask_background_1', agent: 'analyst', status: 'completed' },
      },
    };

    const collapsed = env.stripAnsi(renderer(message, { expanded: false }, { fg: (_name: string, text: string) => text }).render(120).join('\n'));
    expect(collapsed).toContain('[subagent] analyst completed: subtask_background_1');
    expect(collapsed).toContain('ctrl+o to expand');
    expect(collapsed).not.toContain('to=functions.memory_get');

    const expanded = env.stripAnsi(renderer(message, { expanded: true }, { fg: (_name: string, text: string) => text }).render(120).join('\n'));
    expect(expanded).toContain('background final response to=functions.memory_get');
  });

  it('delivers background completion messages without triggering or waiting for a follow-up turn', () => {
    const sendMessage = vi.fn();
    sendSubagentCompletionMessage({ sendMessage }, {
      id: 'subtask_notify_1',
      agent: 'analyst',
      status: 'completed',
      mode: 'background',
      result: 'done while main agent continues',
      model: 'mock/model',
      effort: 'high',
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: 'steer' });
  });

  it('renders background completion messages with a distinct themed block background', () => {
    let renderer: any;
    extension({
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      registerMessageRenderer: (customType: string, value: any) => { if (customType === 'subagent-completion') renderer = value; },
    });
    const message = {
      customType: 'subagent-completion',
      content: 'compact visible content',
      details: {
        full_result: 'background response',
        task: { id: 'subtask_background_color', agent: 'discovery', status: 'completed' },
      },
    };
    const theme = {
      fg: (name: string, text: string) => `FG(${name}:${text})`,
      bg: (name: string, text: string) => `BG(${name}:${text})`,
    };

    const rendered = renderer(message, { expanded: false }, theme).render(90).join('\n');
    expect(rendered).toContain('BG(customMessageBg:');
    expect(rendered).toContain('FG(customMessageLabel:');
    expect(rendered).toContain('[subagent] discovery completed');
  });

  it('wraps expanded background completion responses instead of truncating them', () => {
    let renderer: any;
    extension({
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      registerMessageRenderer: (customType: string, value: any) => { if (customType === 'subagent-completion') renderer = value; },
    });
    const longResponse = 'Una herramienta de subagentes en background debería comportarse de forma claramente asíncrona para que el usuario pueda leer todo el texto sin cortes.';
    const message = {
      customType: 'subagent-completion',
      content: 'compact visible content',
      details: {
        full_result: longResponse,
        task: { id: 'subtask_background_wrap', agent: 'discovery', status: 'completed' },
      },
    };

    const rendered = env.stripAnsi(renderer(message, { expanded: true }, { fg: (_name: string, text: string) => text }).render(52).join('\n'));
    expect(rendered).toContain('[subagent] discovery completed:');
    expect(rendered).toContain('subtask_background_wrap');
    expect(rendered).toContain('response sent to the orchestrator');
    expect(rendered).toContain('Una herramienta de subagentes en background');
    expect(rendered).toContain('cortes.');
    expect(rendered).not.toContain('…');
  });

  it('includes only bounded structured error summaries in background completion details', () => {
    const sendMessage = vi.fn();
    sendSubagentCompletionMessage({ sendMessage }, {
      id: 'subtask_background_failure',
      agent: 'analyst',
      status: 'failed',
      mode: 'background',
      error: 'provider api error',
      model: 'mock/model',
      effort: 'high',
      error_metadata: {
        category: 'provider_api_error',
        message: 'Authorization: Bearer sk-fake-secret-token fake.user@example.com /tmp/fake-private.txt',
        partial_result_available: true,
        details: {
          provider_code: '429',
          auth_header: 'Authorization: Bearer sk-fake-secret-token',
          prompt: 'SYSTEM: hidden prompt body',
          file_path: '/tmp/fake-private.txt',
          nested_payload: JSON.stringify({ transcript: 'SECRET_FILE_BODY_DO_NOT_SHOW' }),
        },
        last_activity: 'USER: hidden prompt body /tmp/fake-private.txt',
        usage_at_failure: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5, contextTokens: 6, turns: 7 },
        task_id: 'subtask_background_failure',
        parent_session_id: 'parent-session-secret',
      },
    });

    const payload = sendMessage.mock.calls[0][0];
    expect(payload.details.full_result).toBe('provider api error');
    expect(payload.details.task.error).toBe('provider api error');
    expect(payload.details.task.error_metadata).toMatchObject({
      version: 1,
      category: 'provider_api_error',
      retryable: true,
      code: 'provider_api_error',
      partial_result_available: true,
      details: { provider_code: '429' },
    });
    expect(payload.details.task.error_metadata.message).toBeUndefined();
    expect(payload.details.task.error_metadata.last_activity).toBeUndefined();
    expect(payload.details.task.error_metadata.usage_at_failure).toBeUndefined();
    expect(payload.details.task.error_metadata.task_id).toBeUndefined();
    expect(payload.details.task.error_metadata.parent_session_id).toBeUndefined();
    const serialized = JSON.stringify(payload.details.task.error_metadata);
    expect(serialized).not.toContain('sk-fake-secret-token');
    expect(serialized).not.toContain('fake.user@example.com');
    expect(serialized).not.toContain('/tmp/fake-private.txt');
    expect(serialized).not.toContain('hidden prompt body');
    expect(serialized).not.toContain('SECRET_FILE_BODY_DO_NOT_SHOW');
  });
});
