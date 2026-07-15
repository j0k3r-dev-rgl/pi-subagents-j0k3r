import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import extension, { ClaudeBackgroundWidget, ClaudeBackgroundWidgetState, completionMessage, createSubagentsPanelKeyMatcher, moveClaudeBackgroundWidgetSelection, renderClaudeBackgroundWidgetLines, resolveRegisteredToolDefinition, sendSubagentCompletionMessage } from '../index.js';
import { loadSubagents, parseFrontmatter, readSubagentsConfig, resetGlobalSubagentModelProfileField, saveGlobalSubagentModelProfile, subagentSourceWarnings } from '../src/config.js';
import { resolveEffectiveSubagentProfile } from '../src/profile-resolver.js';
import { buildPrompt, ThreadSnapshotBuilder } from '../src/runner.js';
import { SubagentStructuredError, deriveErrorString, normalizeErrorMetadata, parseErrorMetadata, safeErrorMetadataDetails, serializeErrorMetadata } from '../src/error-metadata.js';
import { applyDirtyProfileEdit, buildModelProfileRows, buildNoChangesModelProfilesMessage, buildNonTuiModelProfilesMessage, commitStagedModelProfiles, createSubagentModelProfilesModal, globalSubagentsConfigPath, groupAvailableModelsByProvider, runSubagentModelsCommand, stageModelProfileEdit } from '../src/model-profiles-ui.js';
import { resolveSubagentHistoryDbPath, resolveSubagentsHistoryHome, SubagentHistoryStore } from '../src/history.js';
import { isSubagentsDebugEnabled, writeSubagentsDebugLog } from '../src/debug.js';
import { createSubagentsRenderLogger, DEFAULT_RENDER_DEBUG_LOG_PATH } from '../src/render-debug.js';
import { SubagentManager } from '../src/manager.js';
import { registerSubagentTools } from '../src/tools.js';
import { SubagentsHistoryPanel } from '../src/ui.js';
import { boundThreadSnapshot, isValidThreadSnapshot, registerSubagentRuntimeToolDefinition, renderThreadBody, resetPiComponentCacheForTests } from '../src/thread-view.js';
import type { EffectiveSubagentProfile, SubagentErrorMetadata, SubagentModelProfiles, SubagentRunner, SubagentTask } from '../src/types.js';

const require = createRequire(import.meta.url);

let tmp: string;
let oldAgentDir: string | undefined;
let oldHistoryDbPath: string | undefined;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-test-'));
  oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  oldHistoryDbPath = process.env.PI_SUBAGENTS_HISTORY_DB_PATH;
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'isolated-agent');
  process.env.PI_SUBAGENTS_HISTORY_DB_PATH = path.join(tmp, 'global-agent', 'subagents-history.sqlite');
  fs.mkdirSync(path.join(tmp, '.pi', 'subagents'), { recursive: true });
});
afterEach(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldHistoryDbPath === undefined) delete process.env.PI_SUBAGENTS_HISTORY_DB_PATH;
  else process.env.PI_SUBAGENTS_HISTORY_DB_PATH = oldHistoryDbPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeAgent(name: string, body = '# Agent\nhello') {
  fs.writeFileSync(path.join(tmp, '.pi', 'subagents', `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\ntools:\n  - read\n  - memory_search\n---\n${body}`);
}

function mockRunner(delay = 0): SubagentRunner {
  return async ({ definition, task }) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return { result: `${definition.name} handled ${task}`, model: 'mock/model', fallback_used: false };
  };
}

function statusSnapshot(text: string) {
  return { version: 1 as const, source: 'events' as const, items: [{ type: 'status' as const, text }] };
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\][^\u001b]*(?:\u001b\\|\u0007)/g, '');
}

function renderText(snapshot: unknown, overrides: Partial<Parameters<typeof renderThreadBody>[1]> = {}): string {
  const context = {
    cwd: tmp,
    visibleWidth: (text: string) => stripAnsi(text).length,
    truncateToWidth: (text: string, width: number) => text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text,
    ...overrides,
  };
  return stripAnsi(renderThreadBody(snapshot, context).join('\n')).replace(/\s+/g, ' ').trim();
}

function withAgentDir<T>(agentDir: string, run: () => T): T {
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return run();
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}

function readJsonl(file: string): any[] {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

describe('manager and history integration', () => {
  it('runs one subagent as task and exposes the active effort', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(mockRunner());
    const result = await manager.run({ agent: 'analyst', task: 'check scope', mode: 'task' }, { cwd: tmp, pi: { getThinkingLevel: () => 'high' } });
    expect(result.results?.[0].status).toBe('completed');
    expect(result.results?.[0].result).toContain('analyst handled check scope');
    expect(result.results?.[0].effort).toBe('high');
  });

  it('resolves task metadata before running and passes the same effective profile to the runner', async () => {
    writeAgent('analyst');
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({
      model_profiles: { analyst: { model: 'profile/model', effort: 'xhigh' } },
    }));
    const seenUpdates: SubagentTask[][] = [];
    let runnerProfile: EffectiveSubagentProfile | undefined;
    const runner: SubagentRunner = async ({ effectiveProfile }) => {
      runnerProfile = effectiveProfile;
      return { result: 'profiled result', model: effectiveProfile?.model.label.replace(/^profile: /, ''), effort: effectiveProfile?.effort.value, fallback_used: false };
    };
    const manager = new SubagentManager(runner);

    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let result!: Awaited<ReturnType<SubagentManager['run']>>;
    try {
      result = await manager.run(
        { agent: 'analyst', task: 'profiled work', mode: 'task' },
        { cwd: tmp, model: { provider: 'orchestrator', id: 'model' }, thinkingLevel: 'low' },
        undefined,
        (tasks) => seenUpdates.push(tasks.map((task) => ({ ...task }))),
      );
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }

    const queued = seenUpdates.flat().find((task) => task.status === 'queued');
    expect(queued).toMatchObject({ model: 'profile/model', effort: 'xhigh', model_source: 'profile', effort_source: 'profile' });
    expect(runnerProfile).toMatchObject({
      agent: 'analyst',
      model: { value: { provider: 'profile', id: 'model' }, source: 'profile', label: 'profile: profile/model' },
      effort: { value: 'xhigh', source: 'profile', label: 'profile: xhigh' },
    });
    expect(result.results?.[0]).toMatchObject({ model: 'profile/model', effort: 'xhigh', model_source: 'profile', effort_source: 'profile' });
  });

  it('runs multiple subagents in one task call', async () => {
    writeAgent('analyst');
    writeAgent('reviewer');
    const manager = new SubagentManager(mockRunner());
    const result = await manager.run({ agents: ['analyst', 'reviewer'], task: 'review plan', mode: 'task' }, { cwd: tmp });
    expect(result.task_ids.length).toBe(2);
    expect(result.results?.map((r) => r.agent).sort()).toEqual(['analyst', 'reviewer']);
  });

  it('loads subagent markdown definitions only once per multi-agent run', async () => {
    writeAgent('a');
    writeAgent('b');
    writeAgent('c');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const manager = new SubagentManager(mockRunner());

    await manager.run({ agents: ['a', 'b', 'c'], task: 'single discovery pass', mode: 'task' }, { cwd: tmp });

    const markdownReads = readSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((file) => file.startsWith(path.join(tmp, '.pi', 'subagents')) && file.endsWith('.md'));
    expect(markdownReads).toHaveLength(3);
    readSpy.mockRestore();
  });

  it('enforces configured max concurrency within one run and across concurrent runs', async () => {
    writeAgent('a');
    writeAgent('b');
    writeAgent('c');
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 1 }));
    let running = 0;
    let maxRunning = 0;
    const runner: SubagentRunner = async ({ definition }) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { result: `${definition.name} done`, model: 'mock/model', fallback_used: false };
    };
    const manager = new SubagentManager(runner);
    await Promise.all([
      manager.run({ agents: ['a', 'b'], task: 'limited one', mode: 'task' }, { cwd: tmp }),
      manager.run({ agent: 'c', task: 'limited two', mode: 'task' }, { cwd: tmp }),
    ]);
    expect(maxRunning).toBe(1);
  });

  it('derives manager error text compatibly and enriches structured failure metadata eagerly', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ onActivity }) => {
      onActivity?.({
        message: 'streaming response',
        output: 'partial answer before failure',
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 14, turns: 1 },
      });
      throw new SubagentStructuredError(normalizeErrorMetadata({
        category: 'provider_rate_limit',
        message: 'provider said rate limit exceeded',
        retryable: true,
        phase: 'runner_invoke',
        partial_result_available: false,
      }));
    };
    const manager = new SubagentManager(runner);

    const result = await manager.run({ agent: 'analyst', task: 'structured failure', mode: 'task' }, { cwd: tmp, sessionId: 'parent-session-123' });

    expect(result.results?.[0].status).toBe('failed');
    expect(result.results?.[0].error).toBe('provider rate limit');
    expect(result.results?.[0].error_metadata).toMatchObject({
      version: 1,
      category: 'provider_rate_limit',
      retryable: true,
      usage_at_failure: { input: 10, output: 4, contextTokens: 14, turns: 1 },
      last_activity: 'streaming response',
      partial_result_available: true,
      parent_session_id: 'parent-session-123',
    });
    expect(result.results?.[0].error_metadata?.task_id).toBe(result.results?.[0].id);
    expect(result.results?.[0].error_metadata?.message).toBe('provider said rate limit exceeded');
  });

  it('classifies manager total timeout ownership compatibly and preserves structured metadata', async () => {
    writeAgent('analyst');
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ timeout_ms: 20 }));
    const runner: SubagentRunner = async () => new Promise(() => {});
    const manager = new SubagentManager(runner);
    const result = await manager.run({ agent: 'analyst', task: 'timeout', mode: 'task' }, { cwd: tmp, sessionId: 'timeout-parent' });

    expect(result.results?.[0].status).toBe('failed');
    expect(result.results?.[0].error).toBe('timed out after 20ms');
    expect(result.results?.[0].error_metadata).toMatchObject({
      version: 1,
      category: 'total_timeout',
      phase: 'manager',
      retryable: false,
      partial_result_available: false,
      parent_session_id: 'timeout-parent',
      details: { timeout_ms: '20' },
    });
  });

  it('waits for timed-out runner cleanup before continuing the same task id', async () => {
    writeAgent('analyst');
    const nestedSessionPath = path.join(tmp, 'timeout-session.jsonl');
    fs.writeFileSync(nestedSessionPath, '{"type":"session"}\n');
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ timeout_ms: 20 }));
    let allowCleanup = false;
    let cleanupFinished = false;
    let reopenedBeforeCleanup = false;
    const runner = vi.fn<SubagentRunner>(async ({ continuation, signal, onActivity }) => {
      if (continuation) {
        reopenedBeforeCleanup = !cleanupFinished;
        return {
          result: 'continued after timeout cleanup',
          model: 'mock/model',
          fallback_used: false,
          nested_session_path: nestedSessionPath,
        } as any;
      }
      onActivity?.({ message: 'nested session ready', nested_session_path: nestedSessionPath } as any);
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const waitForCleanup = () => {
            if (!allowCleanup) return setTimeout(waitForCleanup, 5);
            cleanupFinished = true;
            reject(new Error('Subagent was aborted'));
          };
          waitForCleanup();
        }, { once: true });
      });
    });
    const manager = new SubagentManager(runner);

    const initial = await manager.run({ agent: 'analyst', task: 'timeout continuation', mode: 'task' }, { cwd: tmp });
    const taskId = initial.task_ids[0]!;
    const continuePromise = manager.continueTask({ task_id: taskId, prompt: 'Resume after timeout.' }, { cwd: tmp });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runner).toHaveBeenCalledTimes(1);
    allowCleanup = true;

    const continued = await continuePromise;
    expect(reopenedBeforeCleanup).toBe(false);
    expect(continued.results?.[0]).toMatchObject({
      id: taskId,
      status: 'completed',
      attempt: 2,
      result: 'continued after timeout cleanup',
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('keeps exact-string compatibility for plain and malformed legacy manager failures while attaching metadata', async () => {
    writeAgent('analyst');
    const plainManager = new SubagentManager(async () => { throw new Error('legacy plain failure'); });
    const malformedManager = new SubagentManager(async () => { throw { reason: 'legacy malformed failure' }; });

    const plain = await plainManager.run({ agent: 'analyst', task: 'plain fail', mode: 'task' }, { cwd: tmp });
    const malformed = await malformedManager.run({ agent: 'analyst', task: 'malformed fail', mode: 'task' }, { cwd: tmp });

    expect(plain.results?.[0].error).toBe('legacy plain failure');
    expect(plain.results?.[0].error_metadata).toMatchObject({ category: 'provider_api_error', message: 'legacy plain failure' });
    expect(malformed.results?.[0].error).toBe('[object Object]');
    expect(malformed.results?.[0].error_metadata).toMatchObject({ category: 'malformed_thrown_value', message: '[object Object]' });
  });

  it('marks tasks failed when a runner returns no final response text', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ onActivity }) => {
      onActivity?.({ message: 'collected final response', output: '{"path":"not-a-final-answer.md"}' });
      return { result: '', model: 'mock/model', fallback_used: false };
    };
    const manager = new SubagentManager(runner);

    const result = await manager.run({ agent: 'analyst', task: 'empty final response', mode: 'task' }, { cwd: tmp });

    expect(result.results?.[0].status).toBe('failed');
    expect(result.results?.[0].error).toMatch(/final response/i);
    expect(result.results?.[0].result).toBeUndefined();
    expect(result.results?.[0].output_preview).toContain('not-a-final-answer');
  });

  it('starts background tasks and keeps notification compact while completion message carries full response', async () => {
    writeAgent('analyst');
    const notifications: string[] = [];
    const manager = new SubagentManager(mockRunner(20));
    const result = await manager.run({ agent: 'analyst', task: 'background work', mode: 'background' }, { cwd: tmp, ui: { notify: (msg: string) => notifications.push(msg) } });
    expect(result.results).toBeUndefined();
    const id = result.task_ids[0];
    expect(manager.getTask(id)?.status).toMatch(/queued|running/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const completed = manager.getTask(id);
    expect(completed?.status).toBe('completed');
    expect(notifications.some((n) => n.includes('completed'))).toBe(true);
    const message = completionMessage(completed);
    expect(message).toContain('Read only this final response');
    expect(message).toContain('analyst handled background work');
  });

  it('can move a running task-mode subagent to background and notify on completion', async () => {
    writeAgent('analyst');
    const notifications: string[] = [];
    const manager = new SubagentManager(mockRunner(20));
    const runPromise = manager.run({ agent: 'analyst', task: 'task work', mode: 'task' }, { cwd: tmp, ui: { notify: (msg: string) => notifications.push(msg) } });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const running = manager.listTasks(tmp).find((task) => task.task === 'task work');
    expect(running?.mode).toBe('task');

    const backgrounded = manager.sendToBackground([running!.id]);
    expect(backgrounded.map((task) => task.id)).toEqual([running!.id]);
    expect(manager.getTask(running!.id)?.mode).toBe('background');

    const result = await runPromise;
    expect(result.results?.[0]?.status).toBe('completed');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(notifications.some((n) => n.includes('completed'))).toBe(true);
  });

  it('records manager cancel metadata and avoids double terminal records for explicit user cancellation', async () => {
    writeAgent('analyst');
    const persisted: Array<{ status: string; error?: string }> = [];
    const history = {
      upsertTask(_cwd: string, task: SubagentTask) { persisted.push({ status: task.status, error: task.error }); },
      addEvent() {},
      listTasks() { return []; },
      listSessionTasks() { return []; },
      getTask() { return undefined; },
    };
    const runner: SubagentRunner = async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Subagent was aborted')), { once: true });
    });
    const manager = new SubagentManager(runner, history as any);
    const result = await manager.run({ agent: 'analyst', task: 'slow work', mode: 'background' }, { cwd: tmp, sessionId: 'cancel-parent' });
    const task = manager.cancel(result.task_ids[0], 'user request');

    expect(task.status).toBe('cancelled');
    expect(task.error).toBe('Subagent cancelled: user request');
    expect(task.error_metadata).toMatchObject({
      version: 1,
      category: 'cancelled',
      phase: 'user',
      partial_result_available: false,
      parent_session_id: 'cancel-parent',
      details: { cancel_reason: 'user request' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(persisted.filter((entry) => entry.status === 'cancelled')).toHaveLength(1);
    expect(persisted.filter((entry) => entry.status === 'failed')).toHaveLength(0);
  });

  it('waits for cancelled runner cleanup before continuing the same nested session', async () => {
    writeAgent('analyst');
    const nestedSessionPath = path.join(tmp, 'cancel-session.jsonl');
    fs.writeFileSync(nestedSessionPath, '{"type":"session"}\n');
    let allowCleanup = false;
    let cleanupFinished = false;
    let reopenedBeforeCleanup = false;
    const runner = vi.fn<SubagentRunner>(async ({ continuation, signal, onActivity }) => {
      if (continuation) {
        reopenedBeforeCleanup = !cleanupFinished;
        return {
          result: 'continued after cancel cleanup',
          model: 'mock/model',
          fallback_used: false,
          nested_session_path: nestedSessionPath,
        } as any;
      }
      onActivity?.({ message: 'nested session ready', nested_session_path: nestedSessionPath } as any);
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const waitForCleanup = () => {
            if (!allowCleanup) return setTimeout(waitForCleanup, 5);
            cleanupFinished = true;
            reject(new Error('Subagent was aborted'));
          };
          waitForCleanup();
        }, { once: true });
      });
    });
    const manager = new SubagentManager(runner);

    const initial = await manager.run({ agent: 'analyst', task: 'cancel continuation', mode: 'background' }, { cwd: tmp });
    const taskId = initial.task_ids[0]!;
    manager.cancel(taskId, 'user request');
    const continuePromise = manager.continueTask({ task_id: taskId, prompt: 'Resume after cancellation.' }, { cwd: tmp });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runner).toHaveBeenCalledTimes(1);
    allowCleanup = true;

    await continuePromise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reopenedBeforeCleanup).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(manager.getTask(taskId)?.attempt).toBe(2);
  });

  it('records manager cancel metadata for parent abort with compatible wording', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Subagent was aborted')), { once: true });
    });
    const manager = new SubagentManager(runner);
    const controller = new AbortController();
    const runPromise = manager.run({ agent: 'analyst', task: 'slow work', mode: 'background' }, { cwd: tmp, sessionId: 'parent-session-456' }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await runPromise;
    const task = manager.getTask(result.task_ids[0]);

    expect(task?.status).toBe('cancelled');
    expect(task?.error).toBe('Subagent cancelled: parent abort');
    expect(task?.error_metadata).toMatchObject({
      version: 1,
      category: 'cancelled',
      phase: 'manager',
      parent_session_id: 'parent-session-456',
      details: { cancel_reason: 'parent abort' },
    });
  });

  it('cleans up queued cancellations and lets later tasks run', async () => {
    writeAgent('a');
    writeAgent('b');
    writeAgent('c');
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 1 }));
    const manager = new SubagentManager(mockRunner(30));
    const result = await manager.run({ agents: ['a', 'b', 'c'], task: 'queue', mode: 'background' }, { cwd: tmp });
    const cancelled = manager.cancel(result.task_ids[1]);
    expect(cancelled.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(manager.getTask(result.task_ids[0])?.status).toBe('completed');
    expect(manager.getTask(result.task_ids[2])?.status).toBe('completed');
  });

  it('throttles noisy activity persistence and update notifications while always flushing terminal state', async () => {
    vi.useFakeTimers();
    writeAgent('analyst');
    const persisted: Array<{ task: SubagentTask; activity: string }> = [];
    const events: Array<{ task: SubagentTask; activity: string }> = [];
    const history = {
      upsertTask(_cwd: string, task: SubagentTask) { persisted.push({ task: { ...task }, activity: task.last_activity ?? '' }); },
      addEvent(_cwd: string, task: SubagentTask, activity: string) { events.push({ task: { ...task }, activity }); },
      listTasks() { return []; },
      listSessionTasks() { return []; },
      getTask() { return undefined; },
    };
    const runner: SubagentRunner = async ({ onActivity }) => {
      for (let index = 0; index < 20; index += 1) onActivity?.({ message: 'streaming response', output: `chunk ${index}` });
      return { result: 'final review', model: 'mock/model', fallback_used: false };
    };
    const updates: SubagentTask[][] = [];
    const manager = new SubagentManager(runner, history as any);

    const resultPromise = manager.run({ agent: 'analyst', task: 'inspect', mode: 'task' }, { cwd: tmp }, undefined, (tasks) => updates.push(tasks.map((task) => ({ ...task }))));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.results?.[0].status).toBe('completed');
    expect(events.map((entry) => entry.activity)).toContain('queued');
    expect(events.map((entry) => entry.activity)).toContain('started');
    expect(events.map((entry) => entry.activity)).toContain('completed');
    expect(events.length).toBeLessThan(10);
    expect(updates.length).toBeLessThan(10);
    expect(persisted.at(-1)?.task).toMatchObject({ status: 'completed', result: 'final review', output_preview: 'final review' });
  });

  it('tracks latest activity and partial output while running', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ onActivity }) => {
      onActivity?.({ message: 'reading docs' });
      onActivity?.({ message: 'streaming response', output: 'found current architecture notes' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { result: 'final review', model: 'mock/model', fallback_used: false };
    };
    const manager = new SubagentManager(runner);
    const result = await manager.run({ agent: 'analyst', task: 'inspect', mode: 'background' }, { cwd: tmp });
    const running = manager.getTask(result.task_ids[0]);
    expect(running?.last_activity).toBe('streaming response');
    expect(running?.output_preview).toContain('architecture notes');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const completed = manager.getTask(result.task_ids[0]);
    expect(completed?.last_activity).toBe('completed');
    expect(completed?.output_preview).toBe('final review');
  });

  it('persists subagent system prompts separately from delegated user prompts', () => {
    const history = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_system_prompt_history',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'ping',
      prompt: '## delegated task\nping',
      system_prompt: '# Analyst\nSYSTEM_ONLY',
      created_at: new Date().toISOString(),
      result: 'pong',
    } as any;

    history.upsertTask(tmp, task);
    const persisted = history.getTask(tmp, task.id);

    expect(persisted?.prompt).toBe('## delegated task\nping');
    expect(persisted?.system_prompt).toBe('# Analyst\nSYSTEM_ONLY');
    expect(persisted?.prompt).not.toContain('SYSTEM_ONLY');
  });

  it('persists nullable structured error metadata and category across history reopen', () => {
    const history = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_error_metadata_history',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'persist structured failure',
      created_at: new Date().toISOString(),
      error: 'Subagent cancelled: user request',
      error_metadata: normalizeErrorMetadata({
        category: 'cancelled',
        message: 'Subagent cancelled: user request',
        partial_result_available: false,
        details: { cancel_reason: 'user request', raw_payload: 'Authorization: Bearer sk-fake-secret-token' },
      }),
    } as any;

    history.upsertTask(tmp, task);

    const { DatabaseSync } = require('node:sqlite') as any;
    const db = new DatabaseSync(resolveSubagentHistoryDbPath());
    const columns = db.prepare('PRAGMA table_info(subagent_tasks)').all() as Array<{ name: string; notnull: number }>;
    expect(columns.find((column) => column.name === 'error_metadata_json')?.notnull).toBe(0);
    expect(columns.find((column) => column.name === 'error_category')?.notnull).toBe(0);

    const row = db.prepare('SELECT error, error_metadata_json, error_category FROM subagent_tasks WHERE id = ?').all(task.id)[0] as any;
    expect(row.error).toBe('Subagent cancelled: user request');
    expect(row.error_category).toBe('cancelled');
    expect(row.error_metadata_json).toContain('cancelled');
    expect(row.error_metadata_json).not.toContain('sk-fake-secret-token');

    const reopened = new SubagentHistoryStore().getTask(tmp, task.id);
    expect(reopened?.error).toBe('Subagent cancelled: user request');
    expect(reopened?.error_metadata?.category).toBe('cancelled');
    expect(reopened?.error_metadata?.details?.raw_payload).toContain('[redacted]');
  });

  it('adds nullable error columns idempotently without backfilling legacy rows and preserves exact legacy error strings', () => {
    const { DatabaseSync } = require('node:sqlite') as any;
    fs.mkdirSync(path.dirname(resolveSubagentHistoryDbPath()), { recursive: true });
    const db = new DatabaseSync(resolveSubagentHistoryDbPath());
    db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_tasks (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        agent TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL,
        session_id TEXT,
        started_at TEXT,
        ended_at TEXT,
        last_activity_at TEXT,
        last_activity TEXT,
        output_preview TEXT,
        prompt TEXT,
        system_prompt TEXT,
        transcript TEXT,
        usage_input INTEGER,
        usage_output INTEGER,
        usage_cache_read INTEGER,
        usage_cache_write INTEGER,
        usage_cost REAL,
        usage_context_tokens INTEGER,
        usage_turns INTEGER,
        model TEXT,
        effort TEXT,
        model_source TEXT,
        effort_source TEXT,
        fallback_used INTEGER,
        error TEXT,
        result TEXT,
        thread_snapshot_json TEXT
      );
    `);
    db.prepare(`
      INSERT INTO subagent_tasks (
        id, cwd, agent, mode, status, task, created_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'subtask_legacy_error_only',
      tmp,
      'analyst',
      'task',
      'failed',
      'legacy history row',
      new Date().toISOString(),
      'legacy plain error  with  exact   spacing',
    );

    const reopenedStore = new SubagentHistoryStore();
    const legacy = reopenedStore.getTask(tmp, 'subtask_legacy_error_only');
    expect(legacy?.error).toBe('legacy plain error  with  exact   spacing');
    expect(legacy?.error_metadata).toBeUndefined();

    const migratedColumns = db.prepare('PRAGMA table_info(subagent_tasks)').all() as Array<{ name: string; notnull: number }>;
    expect(migratedColumns.find((column) => column.name === 'error_metadata_json')?.notnull).toBe(0);
    expect(migratedColumns.find((column) => column.name === 'error_category')?.notnull).toBe(0);

    const row = db.prepare('SELECT error_metadata_json, error_category FROM subagent_tasks WHERE id = ?').all('subtask_legacy_error_only')[0] as any;
    expect(row.error_metadata_json).toBeNull();
    expect(row.error_category).toBeNull();

    reopenedStore.upsertTask(tmp, {
      id: 'subtask_no_error_metadata',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'no metadata needed',
      created_at: new Date().toISOString(),
      result: 'ok',
    } as any);
    const currentRow = db.prepare('SELECT error_metadata_json, error_category FROM subagent_tasks WHERE id = ?').all('subtask_no_error_metadata')[0] as any;
    expect(currentRow.error_metadata_json).toBeNull();
    expect(currentRow.error_category).toBeNull();
  });

  it('migrates legacy subagent_task_attempts tables additively and preserves existing rows across reopen', () => {
    const { DatabaseSync } = require('node:sqlite') as any;
    fs.mkdirSync(path.dirname(resolveSubagentHistoryDbPath()), { recursive: true });
    const db = new DatabaseSync(resolveSubagentHistoryDbPath());
    db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_tasks (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        agent TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL,
        session_id TEXT,
        started_at TEXT,
        ended_at TEXT,
        last_activity_at TEXT,
        last_activity TEXT,
        output_preview TEXT,
        prompt TEXT,
        system_prompt TEXT,
        transcript TEXT,
        usage_input INTEGER,
        usage_output INTEGER,
        usage_cache_read INTEGER,
        usage_cache_write INTEGER,
        usage_cost REAL,
        usage_context_tokens INTEGER,
        usage_turns INTEGER,
        model TEXT,
        effort TEXT,
        model_source TEXT,
        effort_source TEXT,
        fallback_used INTEGER,
        error TEXT,
        result TEXT,
        thread_snapshot_json TEXT,
        continued_from TEXT,
        root_task_id TEXT
      );
      CREATE TABLE IF NOT EXISTS subagent_task_attempts (
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        cwd TEXT,
        status TEXT,
        result TEXT,
        PRIMARY KEY (task_id, attempt)
      );
    `);
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO subagent_tasks (id, cwd, agent, mode, status, task, created_at, result, continued_from, root_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-attempt-task', tmp, 'analyst', 'task', 'completed', 'legacy work', createdAt, 'legacy projection', null, 'legacy-attempt-task',
    );
    db.prepare('INSERT INTO subagent_task_attempts (task_id, attempt, cwd, status, result) VALUES (?, ?, ?, ?, ?)').run(
      'legacy-attempt-task', 1, tmp, 'completed', 'legacy attempt result',
    );

    const store = new SubagentHistoryStore();
    expect(store.listTaskAttempts(tmp, 'legacy-attempt-task').map((attempt) => ({ attempt: attempt.attempt, result: attempt.result }))).toEqual([
      { attempt: 1, result: 'legacy attempt result' },
    ]);

    store.upsertTask(tmp, {
      id: 'legacy-attempt-task',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'legacy work',
      created_at: createdAt,
      attempt: 2,
      result: 'continued attempt result',
    } as any);

    const columns = db.prepare('PRAGMA table_info(subagent_task_attempts)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'agent',
      'mode',
      'task',
      'created_at',
      'nested_session_path',
      'continuation_prompt',
      'system_prompt',
      'error_metadata_json',
      'error_category',
      'thread_snapshot_json',
    ]));

    const reopened = new SubagentHistoryStore();
    expect(reopened.listTaskAttempts(tmp, 'legacy-attempt-task').map((attempt) => ({ attempt: attempt.attempt, result: attempt.result }))).toEqual([
      { attempt: 1, result: 'legacy attempt result' },
      { attempt: 2, result: 'continued attempt result' },
    ]);
    expect(reopened.getTask(tmp, 'legacy-attempt-task')).toMatchObject({ attempt: 2, result: 'continued attempt result' });
  });

  it('ignores malformed persisted error metadata json safely while preserving legacy error text', () => {
    const history = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_malformed_error_metadata',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'malformed metadata row',
      created_at: new Date().toISOString(),
      error: 'legacy malformed metadata error',
    } as any;
    history.upsertTask(tmp, task);

    const { DatabaseSync } = require('node:sqlite') as any;
    const db = new DatabaseSync(resolveSubagentHistoryDbPath());
    db.prepare('UPDATE subagent_tasks SET error_metadata_json = ?, error_category = ? WHERE id = ?').run('{bad json', 'provider_api_error', task.id);

    const loaded = history.getTask(tmp, task.id);
    expect(loaded?.error).toBe('legacy malformed metadata error');
    expect(loaded?.error_metadata).toBeUndefined();
  });

  it('never lets error metadata serialization failure escape history upsertTask', () => {
    const history = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_unserializable_error_metadata',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'unserializable metadata',
      created_at: new Date().toISOString(),
      error: 'legacy serialization-safe error',
      error_metadata: {
        category: 'provider_api_error',
        message: 'should fail closed',
        partial_result_available: false,
        details: { broken: 1n as any },
      } as any,
    } as any;

    expect(() => history.upsertTask(tmp, task)).not.toThrow();
    const persisted = history.getTask(tmp, task.id);
    expect(persisted?.error).toBe('legacy serialization-safe error');
    expect(persisted?.error_metadata?.category).toBe('serialization_failure');
    expect(deriveErrorString(persisted?.error_metadata!)).toBe('Subagent error metadata could not be serialized safely.');
  });

  it('keeps current-session listing available when sqlite history is temporarily busy', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
    const history = {
      listSessionTasks: vi.fn()
        .mockReturnValueOnce([{ id: 'persisted_cached', agent: 'analyst', mode: 'task', status: 'completed', task: 'cached', created_at: '2026-01-01T00:00:00.000Z', session_id: 'session-current' }])
        .mockImplementationOnce(() => { throw busy; }),
      listTasks() { return []; },
      getTask() { return undefined; },
      upsertTask() {},
      addEvent() {},
    };
    const manager = new SubagentManager(mockRunner(), history as any);

    vi.useFakeTimers();
    try {
      expect(manager.listSessionTasks(tmp, 'session-current').map((task) => task.id)).toEqual(['persisted_cached']);
      vi.advanceTimersByTime(1600);
      let lockedResult: SubagentTask[] = [];
      expect(() => { lockedResult = manager.listSessionTasks(tmp, 'session-current'); }).not.toThrow();
      expect(lockedResult.map((task) => task.id)).toEqual(['persisted_cached']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists persisted current-session tasks after manager reload while excluding other sessions', () => {
    const history = new SubagentHistoryStore();
    const sessionTask: SubagentTask = {
      id: 'subtask_session_current',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'current session task',
      created_at: new Date().toISOString(),
      session_id: 'session-current',
      result: 'current result',
    } as any;
    const otherTask: SubagentTask = {
      ...sessionTask,
      id: 'subtask_session_other',
      task: 'other session task',
      session_id: 'session-other',
    } as any;
    history.upsertTask(tmp, sessionTask);
    history.upsertTask(tmp, otherTask);

    const manager = new SubagentManager(mockRunner(), history);
    const listed = manager.listSessionTasks(tmp, 'session-current');

    expect(listed.map((task) => task.id)).toContain('subtask_session_current');
    expect(listed.map((task) => task.id)).not.toContain('subtask_session_other');
  });

  it('resolves sqlite history under global data storage like memory, not the project .pi directory', () => {
    expect(resolveSubagentsHistoryHome({ XDG_DATA_HOME: '/xdg' } as any)).toBe(path.join('/xdg', 'pi', 'subagents'));
    expect(resolveSubagentHistoryDbPath({ XDG_DATA_HOME: '/xdg' } as any)).toBe(path.join('/xdg', 'pi', 'subagents', 'subagents-history.sqlite'));
    expect(resolveSubagentHistoryDbPath({ PI_SUBAGENTS_HISTORY_DB_PATH: '/custom/history.sqlite' } as any)).toBe('/custom/history.sqlite');
    expect(resolveSubagentsHistoryHome({ PI_SUBAGENTS_HISTORY_HOME: '/custom/home' } as any)).toBe('/custom/home');

    const store = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_global_history_1',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'global history location',
      created_at: new Date().toISOString(),
      result: 'stored globally',
    } as any;

    store.upsertTask(tmp, task);

    expect(resolveSubagentHistoryDbPath()).toBe(path.join(tmp, 'global-agent', 'subagents-history.sqlite'));
    expect(fs.existsSync(path.join(tmp, 'global-agent', 'subagents-history.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.pi', 'subagents-history.sqlite'))).toBe(false);
    expect(store.getTask(tmp, task.id)?.result).toBe('stored globally');
  });

  it('moves a continued stable task to the front of activity-ordered listings, including after history reload', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ taskId, task, continuation, nested_session_path, onActivity }) => {
      const sessionPath = nested_session_path ?? path.join(tmp, `${taskId}.jsonl`);
      if (!fs.existsSync(sessionPath)) fs.writeFileSync(sessionPath, '{"type":"session"}\n');
      onActivity?.({ message: 'nested session ready', nested_session_path: sessionPath } as any);
      return { result: continuation ? `continued ${task}` : `completed ${task}`, model: 'mock/model', fallback_used: false, nested_session_path: sessionPath } as any;
    };
    const manager = new SubagentManager(runner);
    const session = { cwd: tmp, sessionId: 'session-activity-order' };
    const taskIds: string[] = [];
    for (const task of ['apply first', 'review second', 'verify third', 'discovery fourth']) {
      const result = await manager.run({ agent: 'analyst', task, mode: 'task' }, session);
      taskIds.push(result.task_ids[0]!);
    }

    expect(manager.listSessionTasks(tmp, session.sessionId).map((task) => task.id)).toEqual([...taskIds].reverse());

    await manager.continueTask({ task_id: taskIds[0]!, prompt: 'Resume the first apply.' }, session);

    expect(manager.listSessionTasks(tmp, session.sessionId).map((task) => task.id)).toEqual([taskIds[0], taskIds[3], taskIds[2], taskIds[1]]);
    expect(manager.listTasks(tmp).map((task) => task.id)).toEqual([taskIds[0], taskIds[3], taskIds[2], taskIds[1]]);

    const freshManager = new SubagentManager(runner);
    expect(freshManager.listSessionTasks(tmp, session.sessionId).map((task) => task.id)).toEqual([taskIds[0], taskIds[3], taskIds[2], taskIds[1]]);
    expect(freshManager.listTasks(tmp).map((task) => task.id)).toEqual([taskIds[0], taskIds[3], taskIds[2], taskIds[1]]);
  });

  it('uses the same binary id tie-break order in memory and after sqlite reload', () => {
    const history = new SubagentHistoryStore();
    const timestamp = '2026-07-15T12:00:00.000Z';
    const hyphenTask: SubagentTask = {
      id: 'subtask_a-b_same',
      agent: 'a-b',
      mode: 'task',
      status: 'completed',
      task: 'hyphen task',
      created_at: timestamp,
      last_activity_at: timestamp,
      session_id: 'session-binary-tie',
      result: 'hyphen result',
    } as any;
    const underscoreTask: SubagentTask = {
      ...hyphenTask,
      id: 'subtask_a_b_same',
      agent: 'a_b',
      task: 'underscore task',
      result: 'underscore result',
    };
    history.upsertTask(tmp, hyphenTask);
    history.upsertTask(tmp, underscoreTask);

    const manager = new SubagentManager(mockRunner(), history);
    for (const task of [hyphenTask, underscoreTask]) {
      (manager as any).tasks.set(task.id, task);
      (manager as any).taskCwds.set(task.id, tmp);
    }
    const expected = [underscoreTask.id, hyphenTask.id];

    expect(manager.listTasks(tmp).map((task) => task.id)).toEqual(expected);
    expect(manager.listSessionTasks(tmp, 'session-binary-tie').map((task) => task.id)).toEqual(expected);

    const freshManager = new SubagentManager(mockRunner(), history);
    expect(freshManager.listTasks(tmp).map((task) => task.id)).toEqual(expected);
    expect(freshManager.listSessionTasks(tmp, 'session-binary-tie').map((task) => task.id)).toEqual(expected);
  });

  it('retrieves completed tasks from sqlite history when not in memory', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(mockRunner());
    const result = await manager.run({ agent: 'analyst', task: 'persisted work', mode: 'task' }, { cwd: tmp });
    const id = result.task_ids[0];
    const freshManager = new SubagentManager(mockRunner());
    const persisted = freshManager.getTask(id, tmp);
    expect(persisted?.status).toBe('completed');
    expect(persisted?.result).toContain('analyst handled persisted work');
    expect(freshManager.listSessionTasks(tmp)).toEqual([]);
  });

  it('copies activity and final thread snapshots onto tasks and persists final snapshots through history reload', async () => {
    writeAgent('analyst');
    const activitySnapshot = statusSnapshot('activity snapshot from runner');
    const finalSnapshot = statusSnapshot('final snapshot from runner');
    const seenUpdates: SubagentTask[][] = [];
    const runner: SubagentRunner = async ({ onActivity }) => {
      onActivity?.({ message: 'snapshot activity', thread_snapshot: activitySnapshot });
      return { result: 'snapshot result', model: 'mock/model', fallback_used: false, thread_snapshot: finalSnapshot };
    };
    const manager = new SubagentManager(runner);

    const result = await manager.run(
      { agent: 'analyst', task: 'persist snapshots', mode: 'task' },
      { cwd: tmp },
      undefined,
      (tasks) => seenUpdates.push(tasks.map((task) => ({ ...task }))),
    );

    expect(seenUpdates.flat().some((task) => task.thread_snapshot?.items[0]?.type === 'status' && task.thread_snapshot.items[0].text === 'activity snapshot from runner')).toBe(true);
    expect(result.results?.[0].thread_snapshot).toEqual(finalSnapshot);

    const freshManager = new SubagentManager(mockRunner());
    const persisted = freshManager.getTask(result.task_ids[0], tmp);
    expect(persisted?.thread_snapshot).toEqual(finalSnapshot);
  });

  it('can list session history without parsing thread snapshots and hydrate them on demand', () => {
    const store = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_lazy_history_1',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'lazy history snapshot',
      created_at: new Date().toISOString(),
      session_id: 'session-lazy',
      thread_snapshot: statusSnapshot('lazy snapshot body'),
    } as any;
    store.upsertTask(tmp, task);

    const listed = store.listSessionTasks(tmp, 'session-lazy', 100, { includeSnapshots: false });
    expect(listed).toHaveLength(1);
    expect(listed[0].thread_snapshot).toBeUndefined();

    const hydrated = store.getTask(tmp, task.id);
    expect(hydrated?.thread_snapshot).toEqual(statusSnapshot('lazy snapshot body'));
  });

  it('persists only bounded valid thread snapshots and ignores corrupt history snapshot JSON', () => {
    const store = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_history_snapshot_1',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'history snapshot',
      created_at: new Date().toISOString(),
      transcript: 'legacy transcript survives corrupt snapshots',
      result: 'legacy result survives corrupt snapshots',
      thread_snapshot: statusSnapshot('x'.repeat(5000)),
    };

    store.upsertTask(tmp, task);
    const bounded = store.getTask(tmp, task.id)?.thread_snapshot;
    expect(bounded?.items[0]).toMatchObject({ type: 'status', text: expect.stringMatching(/…$/) });
    expect((bounded?.items[0] as any).text.length).toBeLessThanOrEqual(4000);

    const { DatabaseSync } = require('node:sqlite') as any;
    const db = new DatabaseSync(resolveSubagentHistoryDbPath());
    // Old history data may be deleted/reset; v1 deliberately does not migrate flat transcripts into snapshots.
    db.prepare('UPDATE subagent_tasks SET thread_snapshot_json = ? WHERE id = ?').run('{not valid json', task.id);
    const corruptLoaded = store.getTask(tmp, task.id);
    expect(corruptLoaded?.thread_snapshot).toBeUndefined();
    expect(corruptLoaded?.transcript).toContain('legacy transcript survives corrupt snapshots');

    db.prepare('UPDATE subagent_tasks SET thread_snapshot_json = ? WHERE id = ?').run(JSON.stringify({ version: 1, source: 'events', items: [{ type: 'future', text: 'ignored' }] }), task.id);
    const invalidLoaded = store.getTask(tmp, task.id);
    expect(invalidLoaded?.thread_snapshot).toBeUndefined();
    expect(invalidLoaded?.result).toContain('legacy result survives corrupt snapshots');
  });

  it('persists subagent usage stats and effort for display', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async () => ({
      result: 'usage-aware result',
      model: 'mock/model',
      effort: 'xhigh',
      fallback_used: false,
      usage: { input: 1200, output: 300, cacheRead: 40, cacheWrite: 5, cost: 0.01, contextTokens: 1545, turns: 1 },
    });
    const manager = new SubagentManager(runner);
    const result = await manager.run({ agent: 'analyst', task: 'measure usage', mode: 'task' }, { cwd: tmp });
    const id = result.task_ids[0];
    const freshManager = new SubagentManager(mockRunner());
    const persisted = freshManager.getTask(id, tmp);
    expect(persisted?.usage).toEqual({ input: 1200, output: 300, cacheRead: 40, cacheWrite: 5, cost: 0.01, contextTokens: 1545, turns: 1 });
    expect(persisted?.effort).toBe('xhigh');
  });

  it('persists effective model and effort source metadata for rendering', async () => {
    writeAgent('analyst');
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ model_profiles: { analyst: { effort: 'high' } } }));
    const manager = new SubagentManager(async ({ effectiveProfile }) => ({
      result: 'source-aware result',
      model: effectiveProfile?.model.label.replace(/^orchestrator: /, ''),
      effort: effectiveProfile?.effort.value,
      fallback_used: false,
    }));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let result!: Awaited<ReturnType<SubagentManager['run']>>;
    try {
      result = await manager.run({ agent: 'analyst', task: 'source metadata', mode: 'task' }, { cwd: tmp, model: { provider: 'mock', id: 'model' } });
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }
    const freshManager = new SubagentManager(mockRunner());
    const persisted = freshManager.getTask(result.task_ids[0], tmp);
    expect(persisted).toMatchObject({ model: 'mock/model', effort: 'high', model_source: 'orchestrator', effort_source: 'profile' });
  });

  it('continues a completed task under the same task id, reuses the nested session, and persists attempts across reloads', async () => {
    writeAgent('analyst');
    const nestedSessionPath = path.join(tmp, 'nested-session.jsonl');
    fs.writeFileSync(nestedSessionPath, '{"type":"session"}\n');
    const runner = vi.fn<SubagentRunner>(async ({ effectiveProfile, nested_session_path, continuation, onActivity }) => {
      onActivity?.({
        message: 'runner session ready',
        nested_session_path: nestedSessionPath,
        thread_snapshot: continuation
          ? { version: 1, source: 'events', items: [{ type: 'user', label: 'continuation', text: continuation.prompt }] }
          : undefined,
      } as any);
      return {
        result: continuation ? `continued with ${continuation.prompt}` : 'initial result',
        model: effectiveProfile?.model.label.replace(/^(?:profile|orchestrator): /, ''),
        effort: effectiveProfile?.effort.value,
        fallback_used: false,
        nested_session_path: nestedSessionPath,
      } as any;
    });
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ model_profiles: { analyst: { model: 'profile/default', effort: 'medium' } } }));
    const manager = new SubagentManager(runner);

    const initial = await manager.run({ agent: 'analyst', task: 'initial delegated work', mode: 'task' }, { cwd: tmp });
    const taskId = initial.task_ids[0]!;
    const continued = await manager.continueTask({ task_id: taskId, prompt: 'Please continue with the fix.' }, { cwd: tmp });

    expect(continued.task_ids).toEqual([taskId]);
    expect(continued.results?.[0]).toMatchObject({
      id: taskId,
      status: 'completed',
      attempt: 2,
      nested_session_path: nestedSessionPath,
      continuation_prompt: 'Please continue with the fix.',
      result: 'continued with Please continue with the fix.',
      model: 'profile/default',
      effort: 'medium',
    });
    expect(runner).toHaveBeenNthCalledWith(1, expect.objectContaining({ nested_session_path: undefined, continuation: undefined }));
    expect(runner).toHaveBeenNthCalledWith(2, expect.objectContaining({
      taskId,
      nested_session_path: nestedSessionPath,
      continuation: expect.objectContaining({ prompt: 'Please continue with the fix.', attempt: 2 }),
    }));

    const freshHistory = new SubagentHistoryStore();
    expect(freshHistory.getTask(tmp, taskId)).toMatchObject({ attempt: 2, nested_session_path: nestedSessionPath, continuation_prompt: 'Please continue with the fix.' });
    expect(freshHistory.listTaskAttempts(tmp, taskId).map((attempt) => ({ attempt: attempt.attempt, result: attempt.result }))).toEqual([
      { attempt: 1, result: 'initial result' },
      { attempt: 2, result: 'continued with Please continue with the fix.' },
    ]);
  });

  it('re-resolves configured profiles for continuation overrides without mutating project config and rejects non-terminal continuations', async () => {
    writeAgent('analyst');
    const nestedSessionPath = path.join(tmp, 'resume-session.jsonl');
    fs.writeFileSync(nestedSessionPath, '{"type":"session"}\n');
    const runner = vi.fn<SubagentRunner>(async ({ effectiveProfile, nested_session_path, continuation, signal }) => {
      if (!continuation) {
        return await new Promise((resolve) => setTimeout(() => resolve({
          result: 'initial complete',
          model: 'mock/initial',
          effort: 'low',
          fallback_used: false,
          nested_session_path: nestedSessionPath,
        } as any), 30));
      }
      return {
        result: 'continued with override',
        model: effectiveProfile?.model.label.replace(/^(?:profile|orchestrator): /, ''),
        effort: effectiveProfile?.effort.value,
        fallback_used: false,
        nested_session_path: nested_session_path,
      } as any;
    });
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ model_profiles: { analyst: { model: 'profile/after', effort: 'high' } } }));
    const manager = new SubagentManager(runner);

    const initial = await manager.run({ agent: 'analyst', task: 'first pass', mode: 'task' }, { cwd: tmp });
    const taskId = initial.task_ids[0]!;
    const configBefore = fs.readFileSync(path.join(tmp, '.pi', 'subagents.json'), 'utf8');
    const continued = await manager.continueTask({ task_id: taskId, prompt: 'Continue with a different effort.', model: 'override/custom', effort: 'xhigh' }, { cwd: tmp });

    expect(continued.results?.[0]).toMatchObject({ model: 'override/custom', effort: 'xhigh', model_source: 'orchestrator', effort_source: 'orchestrator', attempt: 2 });
    expect(fs.readFileSync(path.join(tmp, '.pi', 'subagents.json'), 'utf8')).toBe(configBefore);

    const runningManager = new SubagentManager(runner);
    const background = await runningManager.run({ agent: 'analyst', task: 'still running', mode: 'background' }, { cwd: tmp });
    await expect(runningManager.continueTask({ task_id: background.task_ids[0]!, prompt: 'should fail' }, { cwd: tmp })).rejects.toThrow('Only completed, failed, or cancelled subagent tasks can continue.');
  });

});
