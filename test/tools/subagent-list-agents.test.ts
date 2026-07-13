import { describe, expect, it } from 'vitest';
import { SubagentManager } from '../../src/manager.js';
import { registerSubagentTools } from '../../src/tools.js';
import { installSubagentTestEnv } from '../helpers/subagent-test-helpers.js';

const env = installSubagentTestEnv();

describe('subagent_list_agents tool', () => {
  it('registers and lists agent-facing tools only', async () => {
    env.writeAgent('analyst');
    const registered: Record<string, any> = {};
    registerSubagentTools({ registerTool: (tool: any) => { registered[tool.name] = tool; } }, new SubagentManager(env.mockRunner() as any));

    expect(Object.keys(registered)).toEqual([
      'subagent_list_agents',
      'subagent_run',
      'subagent_status',
      'subagent_result',
      'subagent_list_tasks',
      'subagent_cancel',
    ]);

    const result = await registered.subagent_list_agents.execute('1', {}, undefined, undefined, { cwd: env.tmp });
    expect(result.content[0].text).toBe('Found 1 subagent(s).');
    expect(result.details.agents).toHaveLength(1);
    expect(result.details.agents[0]).toMatchObject({ name: 'analyst' });
  });
});
