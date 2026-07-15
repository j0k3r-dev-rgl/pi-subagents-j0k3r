import { describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../../src/manager.js';
import { registerSubagentTools } from '../../src/tools.js';
import { installSubagentTestEnv } from '../helpers/subagent-test-helpers.js';

const env = installSubagentTestEnv();

describe('subagent_continue tool', () => {
  it('registers an auditable continuation tool, preserves the task id, and warns that overrides require explicit user direction', async () => {
    env.writeAgent('analyst');
    const nestedSessionPath = `${env.tmp}/resume-session.jsonl`;
    await import('node:fs').then((fs) => fs.writeFileSync(nestedSessionPath, '{"type":"session"}\n'));
    const manager = new SubagentManager(async ({ continuation, nested_session_path, effectiveProfile, onActivity }) => {
      onActivity?.({ message: 'session ready', nested_session_path: nestedSessionPath } as any);
      return {
        result: continuation ? `continued: ${continuation.prompt}` : 'initial result',
        model: effectiveProfile?.model.label.replace(/^(?:profile|orchestrator): /, ''),
        effort: effectiveProfile?.effort.value,
        fallback_used: false,
        nested_session_path: nested_session_path ?? nestedSessionPath,
      } as any;
    });
    let continueTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_continue') continueTool = tool; } }, manager);

    const first = await manager.run({ agent: 'analyst', task: 'initial execution', mode: 'task' }, { cwd: env.tmp });
    const taskId = first.task_ids[0]!;
    const renderedCall = continueTool.renderCall(
      { task_id: taskId, prompt: 'Continue with the approved fix.' },
      { fg: (_name: string, text: string) => text, bold: (text: string) => text },
    ).render(160).join('\n');
    const result = await continueTool.execute('1', { task_id: taskId, prompt: 'Continue with the approved fix.' }, undefined, undefined, { cwd: env.tmp });

    expect(continueTool.description).toContain('explicit user decision');
    expect(continueTool.description).toContain('Never auto-switch models');
    expect(renderedCall).toContain('subagent analyst (task)');
    expect(renderedCall).toContain('(ctrl+, or /subagents for details)');
    expect(renderedCall).toContain(`continue · attempt: 2 · id: ${taskId}`);
    expect(renderedCall).not.toContain('continuation prompt:');
    expect(result.details.task.id).toBe(taskId);
    expect(result.details.task.attempt).toBe(2);
    expect(result.content[0].text).toContain('continued: Continue with the approved fix.');
    expect(result.content[0].text).not.toContain('subagent_continue');
    expect(result.content[0].text).not.toContain('Ask the user before resuming');
    const renderedResult = continueTool.renderResult(result, { expanded: false, isPartial: false }, { fg: (_name: string, text: string) => text }).render(160).join('\n');
    expect(renderedResult).toContain('agent: analyst · status: completed · attempt: 2');
    expect(renderedResult).toContain(`id: ${taskId}`);
  });

  it('streams the same live task-mode progress rendering as subagent_run before completion', async () => {
    env.writeAgent('analyst');
    const nestedSessionPath = `${env.tmp}/live-resume-session.jsonl`;
    await import('node:fs').then((fs) => fs.writeFileSync(nestedSessionPath, '{"type":"session"}\n'));
    const manager = new SubagentManager(async ({ continuation, onActivity }) => {
      onActivity?.({ message: 'nested session ready', nested_session_path: nestedSessionPath } as any);
      if (continuation) {
        onActivity?.({ message: 'reading package.json', thread_snapshot: env.statusSnapshot('reading package.json') } as any);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { result: 'live continuation done', model: 'mock/model', effort: 'high', fallback_used: false, nested_session_path: nestedSessionPath } as any;
      }
      return { result: 'initial result', model: 'mock/model', effort: 'high', fallback_used: false, nested_session_path: nestedSessionPath } as any;
    });
    let continueTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_continue') continueTool = tool; } }, manager);
    const ctx = { cwd: env.tmp, model: { provider: 'mock', id: 'model' }, thinkingLevel: 'high', ui: { onTerminalInput: vi.fn(() => () => undefined) } };
    const first = await manager.run({ agent: 'analyst', task: 'initial execution', mode: 'task' }, ctx);
    const updates: any[] = [];

    const result = await continueTool.execute(
      '1',
      { task_id: first.task_ids[0], prompt: 'Run the delayed live test.' },
      undefined,
      (update: any) => updates.push(update),
      ctx,
    );

    const activeUpdate = updates.find((update) => update.details?.tasks?.[0]?.status === 'running' && update.details.tasks[0].last_activity === 'reading package.json');
    expect(activeUpdate).toBeDefined();
    expect(activeUpdate.details.tasks[0]).toMatchObject({ agent: 'analyst', attempt: 2, model: 'mock/model', effort: 'high' });
    const partial = continueTool.renderResult(activeUpdate, { expanded: false, isPartial: true }, { fg: (_name: string, text: string) => text }).render(160).join('\n');
    expect(partial).toContain('agent: analyst');
    expect(partial).toContain('status: running');
    expect(partial).toContain('attempt: 2');
    expect(partial).toContain('reading package.json');
    expect(result.content[0].text).toContain('live continuation done');
  });

  it('supports double-escape cancellation while a continued task is running', async () => {
    env.writeAgent('analyst');
    const nestedSessionPath = `${env.tmp}/cancel-live-resume-session.jsonl`;
    await import('node:fs').then((fs) => fs.writeFileSync(nestedSessionPath, '{"type":"session"}\n'));
    const manager = new SubagentManager(async ({ continuation, signal, onActivity }) => {
      onActivity?.({ message: 'nested session ready', nested_session_path: nestedSessionPath } as any);
      if (!continuation) return { result: 'initial result', model: 'mock/model', fallback_used: false, nested_session_path: nestedSessionPath } as any;
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return { result: 'unreachable', model: 'mock/model', fallback_used: false, nested_session_path: nestedSessionPath } as any;
    });
    let continueTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_continue') continueTool = tool; } }, manager);
    const first = await manager.run({ agent: 'analyst', task: 'initial execution', mode: 'task' }, { cwd: env.tmp });
    let terminalHandler: ((data: string) => any) | undefined;
    const abort = vi.fn();
    const resultPromise = continueTool.execute(
      '1',
      { task_id: first.task_ids[0], prompt: 'Keep running until cancelled.' },
      undefined,
      vi.fn(),
      { cwd: env.tmp, abort, ui: { onTerminalInput: (handler: any) => { terminalHandler = handler; return () => undefined; }, notify: vi.fn() } },
    );
    await vi.waitFor(() => expect(manager.getTask(first.task_ids[0]!, env.tmp)?.status).toBe('running'));

    terminalHandler?.('\u001b');
    terminalHandler?.('\u001b');
    const result = await resultPromise;

    expect(abort).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cancelled by double escape');
    expect(result.content[0].text).toContain('can be resumed with `subagent_continue`');
    expect(manager.getTask(first.task_ids[0]!, env.tmp)?.status).toBe('cancelled');
  });

  it('supports ctrl+h background handoff for task-mode continuations in claude mode', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    env.writeAgent('analyst');
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'claude' }));
    const nestedSessionPath = `${env.tmp}/background-live-resume-session.jsonl`;
    fs.writeFileSync(nestedSessionPath, '{"type":"session"}\n');
    const manager = new SubagentManager(async ({ continuation, onActivity }) => {
      onActivity?.({ message: 'nested session ready', nested_session_path: nestedSessionPath } as any);
      if (continuation) await new Promise((resolve) => setTimeout(resolve, 60));
      return { result: continuation ? 'background continuation done' : 'initial result', model: 'mock/model', fallback_used: false, nested_session_path: nestedSessionPath } as any;
    });
    let continueTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_continue') continueTool = tool; } }, manager);
    const first = await manager.run({ agent: 'analyst', task: 'initial execution', mode: 'task' }, { cwd: env.tmp });
    const terminalHandlers: Array<(data: string) => any> = [];
    const resultPromise = continueTool.execute(
      '1',
      { task_id: first.task_ids[0], prompt: 'Continue in background.' },
      undefined,
      vi.fn(),
      { cwd: env.tmp, ui: { onTerminalInput: (handler: any) => { terminalHandlers.push(handler); return () => undefined; }, notify: vi.fn() } },
    );
    await vi.waitFor(() => expect(manager.getTask(first.task_ids[0]!, env.tmp)?.status).toBe('running'));

    for (const handler of terminalHandlers) handler('\u0008');
    const result = await resultPromise;

    expect(result.terminate).toBe(true);
    expect(result.content[0].text).toContain('Continued 1 subagent task(s) to background');
    expect(manager.getTask(first.task_ids[0]!, env.tmp)?.mode).toBe('background');
    await vi.waitFor(() => expect(manager.getTask(first.task_ids[0]!, env.tmp)?.status).toBe('completed'));
  });

  it('returns failed resumed attempts as errors with user-decision guidance', async () => {
    env.writeAgent('analyst');
    const nestedSessionPath = `${env.tmp}/failed-resume-session.jsonl`;
    await import('node:fs').then((fs) => fs.writeFileSync(nestedSessionPath, '{"type":"session"}\n'));
    let attempt = 0;
    const manager = new SubagentManager(async ({ onActivity }) => {
      attempt += 1;
      onActivity?.({ message: 'session ready', nested_session_path: nestedSessionPath } as any);
      if (attempt > 1) throw new Error('continued attempt failed');
      return { result: 'initial result', model: 'mock/model', fallback_used: false, nested_session_path: nestedSessionPath } as any;
    });
    let continueTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_continue') continueTool = tool; } }, manager);

    const first = await manager.run({ agent: 'analyst', task: 'initial execution', mode: 'task' }, { cwd: env.tmp });
    const result = await continueTool.execute('1', { task_id: first.task_ids[0], prompt: 'Try the next step.' }, undefined, undefined, { cwd: env.tmp });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('continued attempt failed');
    expect(result.content[0].text).toContain('can be resumed with `subagent_continue`');
    expect(result.content[0].text).toContain('Ask the user before resuming');
    expect(result.content[0].text).toContain('model and effort');
  });

  it('rejects legacy tasks without a valid persisted nested session file', async () => {
    const history = new (await import('../../src/history.js')).SubagentHistoryStore();
    history.upsertTask(env.tmp, {
      id: 'subtask_legacy_resume',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'legacy execution',
      created_at: new Date().toISOString(),
      nested_session_path: `${env.tmp}/missing-session.jsonl`,
      result: 'legacy result',
      attempt: 1,
    } as any);
    const manager = new SubagentManager(env.mockRunner(), history);
    let continueTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_continue') continueTool = tool; } }, manager);

    const result = await continueTool.execute('1', { task_id: 'subtask_legacy_resume', prompt: 'resume it' }, undefined, undefined, { cwd: env.tmp });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('missing or unreadable nested session file');
  });
});
