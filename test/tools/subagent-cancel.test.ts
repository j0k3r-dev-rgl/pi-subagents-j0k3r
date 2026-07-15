import { describe, expect, it } from 'vitest';
import { SubagentManager } from '../../src/manager.js';
import { registerSubagentTools } from '../../src/tools.js';
import { installSubagentTestEnv } from '../helpers/subagent-test-helpers.js';

const env = installSubagentTestEnv();

describe('subagent_cancel tool', () => {
  it('cancels a delegated task and returns compact task details', async () => {
    env.writeAgent('analyst');
    const manager = new SubagentManager(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { result: 'late result', model: 'mock/model', fallback_used: false };
    });
    let runTool: any;
    let cancelTool: any;
    registerSubagentTools({ registerTool: (tool: any) => {
      if (tool.name === 'subagent_run') runTool = tool;
      if (tool.name === 'subagent_cancel') cancelTool = tool;
    } }, manager);

    const launched = await runTool.execute('1', { agent: 'analyst', task: 'cancel me', mode: 'background' }, undefined, undefined, { cwd: env.tmp });
    const taskId = launched.details.task_ids[0];
    const cancelled = await cancelTool.execute('2', { task_id: taskId }, undefined, undefined, { cwd: env.tmp });

    expect(cancelled.content[0].text).toContain('cancelled');
    expect(cancelled.content[0].text).toContain('can be resumed with `subagent_continue`');
    expect(cancelled.content[0].text).toContain('Ask the user before resuming');
    expect(cancelled.content[0].text).toContain('model and effort');
    expect(cancelled.details.task).toMatchObject({ id: taskId, status: 'cancelled', task: 'cancel me' });
  });

  it('returns an error result when the task does not exist', async () => {
    const manager = new SubagentManager(env.mockRunner());
    let cancelTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_cancel') cancelTool = tool; } }, manager);

    const result = await cancelTool.execute('1', { task_id: 'missing-task' }, undefined, undefined, { cwd: env.tmp });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('missing-task');
  });
});
