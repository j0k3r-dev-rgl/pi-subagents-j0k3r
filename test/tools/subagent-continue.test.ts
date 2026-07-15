import { describe, expect, it } from 'vitest';
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
    const result = await continueTool.execute('1', { task_id: taskId, prompt: 'Continue with the approved fix.' }, undefined, undefined, { cwd: env.tmp });

    expect(continueTool.description).toContain('explicit user decision');
    expect(continueTool.description).toContain('Never auto-switch models');
    expect(continueTool.renderCall({ task_id: taskId, prompt: 'Continue with the approved fix.' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(120).join('\n')).toContain('Continue with the approved fix.');
    expect(result.details.task.id).toBe(taskId);
    expect(result.details.task.attempt).toBe(2);
    expect(result.content[0].text).toContain('continued: Continue with the approved fix.');
    expect(result.content[0].text).not.toContain('subagent_continue');
    expect(result.content[0].text).not.toContain('Ask the user before resuming');
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
