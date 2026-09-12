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

  it('renders a dim history shortcut and command hint in expanded subagent results and returns empty tool call lines to avoid separate outer text', () => {
    const manager = new SubagentManager(env.mockRunner());
    let runTool: any;
    const dim = vi.fn((_name: string, text: string) => text);
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const callLines = runTool.renderCall({ agent: 'analyst', mode: 'task' }, { fg: dim, bold: (text: string) => text }).render(200);
    expect(callLines).toHaveLength(0);

    const dummyResult = { details: { task: { id: '1', agent: 'analyst', status: 'completed', attempt: 1, model: 'mock/model', effort: 'medium' } } };
    const expanded = runTool.renderResult(dummyResult, { expanded: true, isPartial: false }, { fg: dim, bold: (text: string) => text }).render(200).join('\n');
    expect(expanded).toContain('(ctrl+, or /subagents for details)');
    expect(dim).toHaveBeenCalledWith('dim', '(ctrl+, or /subagents for details)');
  });

  it('renders the effective subagent_run mode in execution title and returns empty tool call lines', () => {
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ default_mode: 'background' }));
    env.writeAgent('analyst');
    const previousCwd = process.cwd();
    process.chdir(env.tmp);
    try {
      const manager = new SubagentManager(env.mockRunner());
      let runTool: any;
      registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

      const callLines = runTool.renderCall({ agent: 'analyst' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200);
      expect(callLines).toHaveLength(0);

      const bgResult = {
        details: {
          mode: 'background',
          task: { id: 't1', agent: 'analyst', status: 'running', mode: 'background', model: 'mock/model', effort: 'high' },
        },
      };
      const renderedBg = runTool.renderResult(bgResult, { expanded: false, isPartial: false }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200).join('\n');
      expect(renderedBg).toContain('running (background)');

      const taskResult = {
        details: {
          mode: 'task',
          task: { id: 't2', agent: 'analyst', status: 'running', mode: 'task', model: 'mock/model', effort: 'high' },
        },
      };
      const renderedTask = runTool.renderResult(taskResult, { expanded: false, isPartial: false }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200).join('\n');
      expect(renderedTask).toContain('subagent · analyst · running');
      expect(renderedTask).not.toContain('running (background)');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('renders the configured history shortcut in expanded subagent results', () => {
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ history_panel_shortcut: 'ctrl+p' }));
    const previousCwd = process.cwd();
    process.chdir(env.tmp);
    try {
      const manager = new SubagentManager(env.mockRunner());
      let runTool: any;
      const dim = vi.fn((_name: string, text: string) => text);
      registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

      const dummyResult = { details: { task: { id: '1', agent: 'analyst', status: 'completed', attempt: 1, model: 'mock/model', effort: 'medium' } } };
      const rendered = runTool.renderResult(dummyResult, { expanded: true, isPartial: false }, { fg: dim, bold: (text: string) => text }).render(200).join('\n');
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

    const dummyResult = { details: { task: { id: '1', agent: 'discovery', status: 'completed', attempt: 1, model: 'mock/model', effort: 'medium' } } };
    const rendered = runTool.renderResult(dummyResult, { expanded: true, isPartial: false }, theme).render(80).join('\n');
    const plain = env.stripAnsi(rendered);
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
    const bodyContent = plain.slice(1, -1).map((line: string) => line.replace(/^[┌│└]\s*|\s*[┐│┘]$/g, '').trim()).join(' ');
    const unwrappedWord = plain.map((line: string) => line.replace(/^[┌│└]\s*|\s*[┐│┘]$/g, '')).filter((line: string) => line.includes('_')).join('');

    expect(bodyContent).toContain('thinking');
    expect(bodyContent).toContain('streaming response');
    expect(unwrappedWord).toContain(longToolName);
    expect(bodyContent).not.toContain('…');
    expect(plain.every((line: string) => [...line].length <= 30)).toBe(true);
    expect(plain.some((line: string) => line.includes('┌'))).toBe(true);
    expect(plain.some((line: string) => line.includes('│'))).toBe(true);
    expect(plain.some((line: string) => line.includes('└'))).toBe(true);
  });

  it('renders the effective continuation mode from explicit override, previous task state, and config fallback', async () => {
    const { resolveContinuationEffectiveMode } = await import('../../src/continuation-mode.js');
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ enable_continue: true, default_mode: 'background' }));
    env.writeAgent('analyst');
    const previousCwd = process.cwd();
    process.chdir(env.tmp);
    try {
      const manager = new SubagentManager(env.mockRunner());
      let continueTool: any;
      registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_continue') continueTool = tool; } }, manager);

      const backgroundTask = await manager.run({ agent: 'analyst', task: 'persist background mode', mode: 'background' }, { cwd: env.tmp });
      const bgTaskObj = manager.getTask(backgroundTask.task_ids[0]!, env.tmp);
      expect(resolveContinuationEffectiveMode({ previousTask: bgTaskObj, config: { default_mode: 'background' } })).toBe('background');

      expect(resolveContinuationEffectiveMode({ explicitMode: 'task', previousTask: bgTaskObj, config: { default_mode: 'background' } })).toBe('task');

      const taskTask = await manager.run({ agent: 'analyst', task: 'persist task mode', mode: 'task' }, { cwd: env.tmp });
      const taskTaskObj = manager.getTask(taskTask.task_ids[0]!, env.tmp);
      expect(resolveContinuationEffectiveMode({ explicitMode: 'background', previousTask: taskTaskObj, config: { default_mode: 'background' } })).toBe('background');

      const legacyTaskId = 'subtask_legacy_render_continue';
      const legacySessionPath = path.join(env.tmp, 'legacy-render-session.jsonl');
      fs.writeFileSync(legacySessionPath, '{"type":"session"}\n');
      (manager as any).history.upsertTask(env.tmp, {
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
      const legacyTaskObj = manager.getTask(legacyTaskId, env.tmp);
      expect(resolveContinuationEffectiveMode({ previousTask: legacyTaskObj, config: { default_mode: 'background' } })).toBe('background');

      // Call lines return 0 lines to avoid separate text outside frame
      const callLines = continueTool.renderCall({ task_id: legacyTaskId, prompt: 'Resume the legacy task.' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(200);
      expect(callLines).toHaveLength(0);
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

    expect(plain.join('\n')).toContain('subagent: sdd-verify');
    expect(plain.join('\n')).toContain('ctrl+o to expand');
    expect(plain.join('\n')).not.toContain('id: subtask_');
    expect(plain.join('\n')).not.toContain('to=functions.memory_get');
    expect(plain.every((line: string) => [...line].length <= 60)).toBe(true);
  });

  it('renders tool calls, progress, and results with boxed frames and zero background fills', async () => {
    env.writeAgent('analyst');
    const manager = new SubagentManager(async () => ({ result: 'completed response', model: 'mock/model', effort: 'high', fallback_used: false }));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    // Call rendering (empty, zero lines, zero background fills to avoid duplicate stacked cards or text outside frame)
    const callLines = runTool.renderCall({ agent: 'analyst', mode: 'task' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(80);
    expect(callLines).toHaveLength(0);
    expect(callLines.join('\n')).not.toContain('\x1b[4');

    // Result rendering (single framed box with integrated title)
    const result = await runTool.execute('1', { agent: 'analyst', task: 'render cleanly', mode: 'task' }, undefined, undefined, { cwd: env.tmp });
    const resultLines = runTool.renderResult(result, { isPartial: false }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(80);
    expect(resultLines[0]).toContain('┌─');
    expect(resultLines[0]).toContain('┐');
    expect(resultLines[0]).toContain('󰣇');
    expect(resultLines.some((l: string) => l.includes('│'))).toBe(true);
    expect(resultLines.at(-1)).toContain('└');
    expect(resultLines.at(-1)).toContain('┘');
    expect(resultLines.join('\n')).not.toContain('\x1b[4');

    // Direct renderSubagentResult (single framed box with integrated title)
    const { renderSubagentResult } = await import('../../src/render/tools/subagent-result.js');
    const directLines = renderSubagentResult(result, { expanded: false }, { fg: (_name: string, text: string) => text }).render(80);
    expect(directLines[0]).toContain('┌─');
    expect(directLines[0]).toContain('┐');
    expect(directLines[0]).toContain('󰣇');
    expect(directLines.some((l: string) => l.includes('│'))).toBe(true);
    expect(directLines.at(-1)).toContain('└');
    expect(directLines.at(-1)).toContain('┘');
    expect(directLines.join('\n')).not.toContain('\x1b[4');
  });

  it('renders active subagent running state as a single framed box with integrated top-border title and Arch icon', () => {
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, new SubagentManager(env.mockRunner()));

    const activePartial = {
      details: {
        frame: 0,
        tasks: [{
          agent: 'sdd-verify',
          status: 'running',
          attempt: 1,
          effort: 'medium',
          model: 'mock/model',
          task: 'verify the implementation',
        }],
      },
    };

    const lines = runTool.renderResult(activePartial, { isPartial: true }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(80);
    expect(lines[0]).toMatch(/^┌─+ .+subagent · sdd-verify · running ─+┐$/);
    expect(lines[0]).toContain('󰣇');
    expect(lines.some((l: string) => l.includes('│'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^└─+┘$/);
    expect(lines.join('\n')).not.toContain('\x1b[4');
  });

  it('renders background running execution state as a single framed box with (background) integrated in top-border title', async () => {
    env.writeAgent('sdd-verify');
    const manager = new SubagentManager(env.mockRunner());
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const bgResult = {
      details: {
        mode: 'background',
        task_ids: ['subtask_123'],
        task: {
          id: 'subtask_123',
          agent: 'sdd-verify',
          status: 'running',
          mode: 'background',
          model: 'mock/model',
          effort: 'medium',
          task: 'verify task',
        },
      },
    };

    // Call rendering produces 0 lines (no text outside the frame)
    const callLines = runTool.renderCall({ agent: 'sdd-verify', mode: 'background' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(80);
    expect(callLines).toHaveLength(0);
    expect(callLines.join('\n')).toBe('');

    const lines = runTool.renderResult(bgResult, { expanded: false, isPartial: false }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(80);
    expect(lines[0]).toMatch(/^┌─+ .+subagent · sdd-verify · running \(background\) ─+┐$/);
    expect(lines[0]).toContain('󰣇');
    expect(lines[1]).toContain('subagent: sdd-verify');
    expect(lines[1]).toContain('status: running');
    expect(lines[2]).toContain('ctrl+o to expand');
    expect(lines.at(-1)).toMatch(/^└─+┘$/);
    expect(lines.join('\n')).not.toContain('\x1b[4');
  });

  it('produces one transparent single frame for background running execution with all info inside and zero project-owned background escapes', async () => {
    env.writeAgent('sdd-verify');
    const manager = new SubagentManager(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { result: 'verified', model: 'cliproxyapi/j0k3r/gemini-3.8-flash-high', effort: 'medium', fallback_used: false };
    });
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const result = await runTool.execute('1', {
      agent: 'sdd-verify',
      task: 'verify the implementation',
      mode: 'background',
    }, undefined, undefined, { cwd: env.tmp });

    // 1. Tool call produces zero lines outside the frame
    const callLines = runTool.renderCall({ agent: 'sdd-verify', mode: 'background' }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(120);
    expect(callLines).toHaveLength(0);
    expect(callLines.join('\n')).toBe('');

    // 2. Result is one single framed card with integrated title
    const resultLines = runTool.renderResult(result, { expanded: false, isPartial: false }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).render(120);
    expect(resultLines[0]).toContain('┌─');
    expect(resultLines[0]).toContain('┐');
    expect(resultLines[0]).toContain('󰣇');
    expect(resultLines[0]).toContain('subagent · sdd-verify · running (background)');

    // Interior lines:
    expect(resultLines[1]).toContain('subagent: sdd-verify');
    expect(resultLines[1]).toContain('status: running');
    expect(resultLines[2]).toContain('ctrl+o to expand');
    expect(resultLines.at(-1)).toContain('└');
    expect(resultLines.at(-1)).toContain('┘');

    // 3. No project-owned background fills or ANSI background color escapes
    const renderedFull = resultLines.join('\n');
    expect(renderedFull).not.toContain('\x1b[4');

    // 4. Raw task IDs remain hidden in visible UI and preserved in structured details
    const rawTaskId = result.details.task_ids[0];
    expect(rawTaskId).toMatch(/^subtask_sdd-verify_/);
    expect(env.stripAnsi(renderedFull)).not.toContain(rawTaskId);
    expect(env.stripAnsi(renderedFull)).not.toContain('id: subtask_');
  });

  it('renders friendly display_name in titles and hides raw task IDs from visible output', async () => {
    env.writeAgent('analyst');
    const manager = new SubagentManager(async () => ({ result: 'audited codebase', model: 'mock/model', fallback_used: false }));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    // 1. With display_name
    const withNameResult = await runTool.execute('1', {
      agent: 'analyst',
      task: 'audit security',
      display_name: 'Security Audit Pass',
      mode: 'task',
    }, undefined, undefined, { cwd: env.tmp });
    const renderedWithName = env.stripAnsi(runTool.renderResult(withNameResult, { expanded: false }, { fg: (_name: string, text: string) => text }).render(120).join('\n'));
    expect(renderedWithName).toContain('Security Audit Pass');
    expect(renderedWithName).toContain('subagent: analyst');
    expect(renderedWithName).toContain('ctrl+o to expand');
    expect(renderedWithName).not.toContain('id: subtask_');
    expect(renderedWithName).not.toContain('subtask_analyst_');

    // 2. Without display_name (deterministic fallback)
    const withoutNameResult = await runTool.execute('2', {
      agent: 'analyst',
      task: 'inspect dependencies',
      mode: 'task',
    }, undefined, undefined, { cwd: env.tmp });
    const renderedWithoutName = env.stripAnsi(runTool.renderResult(withoutNameResult, { expanded: false }, { fg: (_name: string, text: string) => text }).render(120).join('\n'));
    expect(renderedWithoutName).toContain('analyst · inspect dependencies');
    expect(renderedWithoutName).toContain('subagent: analyst');
    expect(renderedWithoutName).toContain('ctrl+o to expand');
    expect(renderedWithoutName).not.toContain('id: subtask_');
    expect(renderedWithoutName).not.toContain('subtask_analyst_');
  });

  it('renders result and response sections only when actual non-whitespace response text exists', async () => {
    const { renderSubagentResult } = await import('../../src/render/tools/subagent-result.js');
    const theme = { fg: (_name: string, text: string) => text };

    // Case 1: Empty string result
    const emptyResult = {
      details: {
        task: {
          id: 'subtask_empty_res',
          agent: 'analyst',
          status: 'completed',
          result: '',
          output_preview: 'some activity preview',
        },
      },
    };
    const renderedEmpty = env.stripAnsi(renderSubagentResult(emptyResult, { expanded: true }, theme).render(100).join('\n'));
    expect(renderedEmpty).not.toContain('Subagent response');
    expect(renderedEmpty).not.toContain('Subagent result ·');
    expect(renderedEmpty).toContain('Subagent ·');

    // Case 2: Whitespace-only result
    const whitespaceResult = {
      details: {
        task: {
          id: 'subtask_ws_res',
          agent: 'analyst',
          status: 'completed',
          result: '   \n  \t  ',
        },
      },
    };
    const renderedWs = env.stripAnsi(renderSubagentResult(whitespaceResult, { expanded: true }, theme).render(100).join('\n'));
    expect(renderedWs).not.toContain('Subagent response');
    expect(renderedWs).not.toContain('Subagent result ·');
    expect(renderedWs).toContain('Subagent ·');

    // Case 3: Undefined result (e.g. running or failed without response)
    const runningTask = {
      details: {
        task: {
          id: 'subtask_running_res',
          agent: 'analyst',
          status: 'running',
          output_preview: 'in progress',
        },
      },
    };
    const renderedRunning = env.stripAnsi(renderSubagentResult(runningTask, { expanded: false }, theme).render(100).join('\n'));
    expect(renderedRunning).not.toContain('Subagent result ·');
    expect(renderedRunning).not.toContain('response:');
    expect(renderedRunning).toContain('Subagent ·');

    // Case 4: Error-only task
    const failedTask = {
      details: {
        task: {
          id: 'subtask_failed_no_res',
          agent: 'analyst',
          status: 'failed',
          error: 'fatal crash occurred',
        },
      },
    };
    const renderedFailed = env.stripAnsi(renderSubagentResult(failedTask, { expanded: true }, theme).render(100).join('\n'));
    expect(renderedFailed).not.toContain('Subagent response');
    expect(renderedFailed).toContain('Subagent error');
    expect(renderedFailed).toContain('fatal crash occurred');

    // Case 5: Valid non-whitespace response
    const validTask = {
      details: {
        task: {
          id: 'subtask_valid_res',
          agent: 'analyst',
          status: 'completed',
          result: 'All unit tests passed with 100% coverage.',
        },
      },
    };
    const renderedValid = env.stripAnsi(renderSubagentResult(validTask, { expanded: true }, theme).render(100).join('\n'));
    expect(renderedValid).toContain('Subagent result ·');
    expect(renderedValid).toContain('Subagent response');
    expect(renderedValid).toContain('All unit tests passed with 100% coverage.');
  });
});
