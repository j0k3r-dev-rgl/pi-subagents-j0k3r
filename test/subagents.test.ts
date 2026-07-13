import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import extension from '../index.js';
import { buildPrompt } from '../src/runner.js';
import { runSubagentModelsCommand } from '../src/model-profiles-ui.js';
import { boundThreadSnapshot, isValidThreadSnapshot, renderThreadBody } from '../src/thread-view.js';
import { installSubagentTestEnv } from './helpers/subagent-test-helpers.js';

const env = installSubagentTestEnv();

describe('subagents smoke', () => {
  it('keeps root and deep import smoke reachable', () => {
    expect(typeof extension).toBe('function');
    expect(typeof runSubagentModelsCommand).toBe('function');
    expect(typeof buildPrompt).toBe('function');
  });

  it('validates and bounds v1 subagent thread snapshots safely', () => {
    const snapshot = {
      version: 1,
      source: 'events',
      items: [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello from assistant' }] } },
        { type: 'tool', name: 'read', status: 'completed', arguments: { path: 'README.md' }, result: { content: [{ type: 'text', text: 'file body' }], isError: false } },
        { type: 'bash', command: 'npm test', output: 'passed', status: 'completed', exitCode: 0 },
        { type: 'error', text: 'safe error row' },
      ],
    };

    expect(isValidThreadSnapshot(snapshot)).toBe(true);
    expect(renderThreadBody(snapshot as any, { visibleWidth: (text) => text.length, truncateToWidth: (text, width) => text.slice(0, width), cwd: env.tmp }).join('\n')).toContain('hello from assistant');
    expect(renderThreadBody(snapshot as any, { visibleWidth: (text) => text.length, truncateToWidth: (text, width) => text.slice(0, width), cwd: env.tmp }).join('\n')).toContain('read completed');

    const bounded = boundThreadSnapshot({ version: 1, source: 'events', items: [{ type: 'status', text: 'x'.repeat(5000) }] } as any, { textLimit: 32 });
    expect(bounded?.items[0]).toMatchObject({ type: 'status', text: expect.stringMatching(/…$/) });
    expect((bounded?.items[0] as any).text.length).toBeLessThanOrEqual(32);
  });

  it('subagent models command uses custom modal overlay and saves project-local dirty rows locally', async () => {
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents', 'analyst.md'), `---\nname: analyst\ndescription: analyst\nscope: project\n---\nbody`);
    const notifications: any[] = [];
    let capturedOptions: any;
    const custom = async (factory: any, options: any) => {
      capturedOptions = options;
      const done = () => undefined;
      factory({ requestRender: () => undefined }, {}, undefined, done);
      return { action: 'save', dirtyProfiles: { analyst: { model: { provider: 'openai', id: 'gpt-5.5' }, effort: 'high' } } };
    };
    const message = await runSubagentModelsCommand({
      cwd: env.tmp,
      modelRegistry: { getAvailable: async () => [{ provider: 'openai', id: 'gpt-5.5', label: 'gpt-5.5' }] },
      ui: { custom, notify: (...args: any[]) => notifications.push(args) },
    });

    expect(capturedOptions).toEqual({ overlay: true, overlayOptions: { anchor: 'center', width: '96%', maxHeight: '90%', minWidth: 96 } });
    expect(message).toBe(`Saved subagent model profiles to ${path.join(env.tmp, '.pi', 'subagents.json')}.`);
    expect(notifications).toEqual([[message, 'info']]);
  });

  it('builds a delegated user prompt without embedding subagent system instructions', () => {
    const prompt = buildPrompt({ name: 'analyst', description: 'analysis', filePath: '/tmp/analyst.md', instructions: 'SYSTEM ONLY', tools: ['read'] } as any, 'inspect the repo', undefined, ['read']);
    expect(prompt).toBe('## delegated task\ninspect the repo');
    expect(prompt).not.toContain('SYSTEM ONLY');
  });
});
