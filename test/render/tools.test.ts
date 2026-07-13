import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../../src/manager.js';
import { registerSubagentTools } from '../../src/tools.js';
import { installSubagentTestEnv } from '../helpers/subagent-test-helpers.js';

const env = installSubagentTestEnv();

describe('tool render helpers', () => {
  it('renders agent, model, and effort as explicit labels in tool results', async () => {
    env.writeAgent('analyst');
    const manager = new SubagentManager(async () => ({ result: 'clear render', model: 'mock/model', effort: 'high', fallback_used: false }));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const result = await runTool.execute('1', { agent: 'analyst', task: 'render clearly', mode: 'task' }, undefined, undefined, { cwd: env.tmp });
    const rendered = runTool.renderResult(result, { isPartial: false }, { fg: (_name: string, text: string) => text }).render(200).join('\n');
    expect(rendered).toContain('agent: analyst');
    expect(rendered).toContain('model: mock/model');
    expect(rendered).toContain('effort: high');
  });

  it('renders a dim ctrl+, and command hint in the subagent_run title outside claude mode', () => {
    const manager = new SubagentManager(env.mockRunner());
    let runTool: any;
    const dim = vi.fn((_name: string, text: string) => text);
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const rendered = runTool.renderCall({ agent: 'analyst', mode: 'task' }, { fg: dim, bold: (text: string) => text }).render(200).join('\n');
    expect(rendered).toContain('subagent analyst (task)');
    expect(rendered).toContain('(ctrl+, or /subagents for details)');
    expect(dim).toHaveBeenCalledWith('dim', '(ctrl+, or /subagents for details)');
  });

  it('hides ctrl+, from the subagent_run title in claude mode', () => {
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'claude' }));
    const previousCwd = process.cwd();
    process.chdir(env.tmp);
    try {
      const manager = new SubagentManager(env.mockRunner());
      let runTool: any;
      const dim = vi.fn((_name: string, text: string) => text);
      registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

      const rendered = runTool.renderCall({ agent: 'analyst', mode: 'task' }, { fg: dim, bold: (text: string) => text }).render(200).join('\n');
      expect(rendered).toContain('subagent analyst (task)');
      expect(rendered).toContain('(/subagents for details)');
      expect(rendered).not.toContain('ctrl+,');
      expect(dim).toHaveBeenCalledWith('dim', '(/subagents for details)');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('keeps ansi-styled subagent_run title hints visible when visual width fits', () => {
    const manager = new SubagentManager(env.mockRunner());
    let runTool: any;
    const theme = {
      fg: (_name: string, text: string) => `\u001b[36m${text}\u001b[39m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    };
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const rendered = runTool.renderCall({ agent: 'discovery', mode: 'task' }, theme).render(80).join('\n');
    const plain = env.stripAnsi(rendered);
    expect(plain).toContain('subagent discovery (task)');
    expect(plain).toContain('(ctrl+, or /subagents for details)');
    expect(plain).not.toContain('�');
  });

  it('renders a ctrl+h background hint in partial claude task-mode results', () => {
    const manager = new SubagentManager(env.mockRunner());
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const rendered = runTool.renderResult({ details: { frame: 0, backgroundable: true, tasks: [{ agent: 'analyst', status: 'running', effort: 'high', model: 'mock/model', last_activity: 'working' }] } }, { isPartial: true }, { fg: (_name: string, text: string) => text }).render(200).join('\n');
    expect(rendered).toContain('ctrl+h to send to background');
  });

  it('renders completed subagent_run results as collapsed width-safe summaries without raw response text', () => {
    const manager = new SubagentManager(env.mockRunner());
    let runTool: any;
    const theme = {
      fg: (_name: string, text: string) => `\u001b[2m${text}\u001b[22m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    };
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const rawResponse = '{"id":"mem_j0k3r_j0k3r-pi_1782144305930_cc027e8afb154ba5"} to=functions.memory_get '.repeat(4);

    const renderedLines = runTool.renderResult({
      content: [{ type: 'text', text: `Completed 1 subagent task:\n${rawResponse}` }],
      details: {
        task: {
          id: 'subtask_sdd-verify_1782157254429_2b614a8e',
          agent: 'sdd-verify',
          mode: 'task',
          status: 'completed',
          task: 'verify',
          created_at: new Date().toISOString(),
          result: rawResponse,
          usage: { turns: 11, input: 87000, output: 6800, cacheRead: 574000, cost: 0.462, contextTokens: 79000 },
          model: 'openai-codex/gpt-5.4',
          effort: 'medium',
        },
      },
    }, { isPartial: false }, theme).render(60);
    const plain = renderedLines.map(env.stripAnsi);

    expect(plain.join('\n')).toContain('response: collapsed');
    expect(plain.join('\n')).toContain('/subagents');
    expect(plain.join('\n')).not.toContain('to=functions.memory_get');
    expect(plain.every((line: string) => line.length <= 60)).toBe(true);
  });
});
