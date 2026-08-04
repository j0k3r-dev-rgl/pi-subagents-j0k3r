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

  it('renders a dim history shortcut and command hint in the subagent_run title', () => {
    const manager = new SubagentManager(env.mockRunner());
    let runTool: any;
    const dim = vi.fn((_name: string, text: string) => text);
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const rendered = runTool.renderCall({ agent: 'analyst', mode: 'task' }, { fg: dim, bold: (text: string) => text }).render(200).join('\n');
    expect(rendered).toContain('subagent analyst (task)');
    expect(rendered).toContain('(ctrl+, or /subagents for details)');
    expect(dim).toHaveBeenCalledWith('dim', '(ctrl+, or /subagents for details)');
  });

  it('renders the effective subagent_run mode when invocation mode is omitted', () => {
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ default_mode: 'background' }));
    env.writeAgent('analyst');
    const previousCwd = process.cwd();
    process.chdir(env.tmp);
    try {
      const manager = new SubagentManager(env.mockRunner());
      let runTool: any;
      registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

      const configDefaultRendered = runTool.renderCall({ agent: 'analyst' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200).join('\n');
      expect(configDefaultRendered).toContain('subagent analyst (background)');

      fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents', 'reviewer.md'), `---\nname: reviewer\ndescription: reviewer agent\nsubagent_mode: task\ntools:\n  - read\n---\n# Agent`);
      const definitionOverrideRendered = runTool.renderCall({ agent: 'reviewer' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200).join('\n');
      expect(definitionOverrideRendered).toContain('subagent reviewer (task)');

      const explicitOverrideRendered = runTool.renderCall({ agent: 'analyst', mode: 'task' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200).join('\n');
      expect(explicitOverrideRendered).toContain('subagent analyst (task)');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('renders the configured history shortcut in the subagent_run title hint', () => {
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ history_panel_shortcut: 'ctrl+p' }));
    const previousCwd = process.cwd();
    process.chdir(env.tmp);
    try {
      const manager = new SubagentManager(env.mockRunner());
      let runTool: any;
      const dim = vi.fn((_name: string, text: string) => text);
      registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

      const rendered = runTool.renderCall({ agent: 'analyst', mode: 'task' }, { fg: dim, bold: (text: string) => text }).render(200).join('\n');
      expect(rendered).toContain('subagent analyst (task)');
      expect(rendered).toContain('(ctrl+p or /subagents for details)');
      expect(dim).toHaveBeenCalledWith('dim', '(ctrl+p or /subagents for details)');
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

  it('renders current-last foreground activity without clipping complete tool names', () => {
    const manager = new SubagentManager(env.mockRunner());
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const longToolName = 'workspace_graph_status_with_a_very_long_public_name';

    const rendered = runTool.renderResult({
      details: {
        frame: 0,
        tasks: [{
          agent: 'analyst',
          status: 'running',
          attempt: 1,
          effort: 'high',
          model: 'mock/model',
          last_activity: `running tool: ${longToolName}`,
          live_activity: {
            trail: [
              { kind: 'thinking', label: 'thinking' },
              { kind: 'streaming_response', label: 'streaming response' },
              { kind: 'tool_running', label: `running tool: ${longToolName}`, tool_names: [longToolName] },
            ],
            current: { kind: 'tool_running', label: `running tool: ${longToolName}`, tool_names: [longToolName] },
          },
        }],
      },
    }, { isPartial: true }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(30);
    const plain = rendered.map(env.stripAnsi);
    const normalized = plain.join('').replace(/\s+/g, ' ');

    expect(normalized).toContain('thinking');
    expect(normalized).toContain('streaming response');
    expect(normalized).toContain(longToolName);
    expect(normalized).not.toContain('…');
    expect(plain.every((line: string) => line.length <= 30)).toBe(true);
  });

  it('renders the effective continuation mode from explicit override, previous task state, and config fallback', async () => {
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ enable_continue: true, default_mode: 'background' }));
    env.writeAgent('analyst');
    const previousCwd = process.cwd();
    process.chdir(env.tmp);
    try {
      const manager = new SubagentManager(env.mockRunner());
      let continueTool: any;
      registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_continue') continueTool = tool; } }, manager);

      const backgroundTask = await manager.run({ agent: 'analyst', task: 'persist background mode', mode: 'background' }, { cwd: env.tmp });
      const backgroundRendered = continueTool.renderCall({ task_id: backgroundTask.task_ids[0], prompt: 'Resume the background attempt.' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200).join('\n');
      expect(backgroundRendered).toContain('subagent analyst (background)');

      const explicitTaskRendered = continueTool.renderCall({ task_id: backgroundTask.task_ids[0], prompt: 'Wait this time.', mode: 'task' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200).join('\n');
      expect(explicitTaskRendered).toContain('subagent analyst (task)');

      const taskTask = await manager.run({ agent: 'analyst', task: 'persist task mode', mode: 'task' }, { cwd: env.tmp });
      const explicitBackgroundRendered = continueTool.renderCall({ task_id: taskTask.task_ids[0], prompt: 'Resume in background.', mode: 'background' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200).join('\n');
      expect(explicitBackgroundRendered).toContain('subagent analyst (background)');

      const legacyTaskId = 'subtask_legacy_render_continue';
      const legacySessionPath = path.join(env.tmp, 'legacy-render-session.jsonl');
      fs.writeFileSync(legacySessionPath, '{"type":"session"}\n');
      // Use process.cwd() (not env.tmp) so the stored cwd matches what
      // continueTool.renderCall reads — on macOS env.tmp (/var/folders/...) and
      // process.cwd() (/private/var/...) differ by the /var symlink, and the
      // history store keys rows by the literal cwd string.
      (manager as any).history.upsertTask(process.cwd(), {
        id: legacyTaskId,
        agent: 'analyst',
        mode: 'legacy',
        status: 'completed',
        task: 'legacy task',
        created_at: new Date().toISOString(),
        nested_session_path: legacySessionPath,
        result: 'legacy result',
        attempt: 1,
      } as any);
      const legacyRendered = continueTool.renderCall({ task_id: legacyTaskId, prompt: 'Resume the legacy task.' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200).join('\n');
      expect(legacyRendered).toContain('subagent analyst (background)');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('renders a ctrl+h background hint in partial task-mode results', () => {
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
