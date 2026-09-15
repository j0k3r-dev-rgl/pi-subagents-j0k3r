import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubagentManager } from '../src/manager.js';
import {
  SUBAGENTS_SERVICE_API_VERSION,
  createSubagentsService,
  getSubagentsService,
  publishSubagentsService,
  unpublishSubagentsService,
} from '../src/service.js';
import type { SubagentRunner } from '../src/types.js';

let tmp: string;
let oldAgentDir: string | undefined;
let oldHistoryDbPath: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-service-test-'));
  oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  oldHistoryDbPath = process.env.PI_SUBAGENTS_HISTORY_DB_PATH;
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'isolated-agent');
  // Point the global history DB into tmp; service tests inject an in-memory
  // history stub into the manager so no sqlite handle is ever opened.
  process.env.PI_SUBAGENTS_HISTORY_DB_PATH = path.join(tmp, 'global-agent', 'subagents-history.sqlite');
  fs.mkdirSync(path.join(tmp, '.pi', 'subagents'), { recursive: true });
  unpublishSubagentsService();
});

afterEach(() => {
  unpublishSubagentsService();
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldHistoryDbPath === undefined) delete process.env.PI_SUBAGENTS_HISTORY_DB_PATH;
  else process.env.PI_SUBAGENTS_HISTORY_DB_PATH = oldHistoryDbPath;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows sqlite/AV locks can make tmp removal flaky; the dir lives
    // under the OS temp area and is safe to leave behind.
  }
});

function writeAgent(name: string, tools = ['read']) {
  const toolsYaml = tools.map((tool) => `  - ${tool}`).join('\n');
  fs.writeFileSync(
    path.join(tmp, '.pi', 'subagents', `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} agent\ntools:\n${toolsYaml}\n---\n# ${name}\nhello\n`,
  );
}

/** In-memory history stub so service tests never open sqlite (Windows EPERM-safe). */
function memoryHistory() {
  const tasks = new Map<string, any>();
  return {
    listTasks: () => [...tasks.values()],
    getTask: (_cwd: string, id: string) => tasks.get(id),
    listTasksByStatus: () => [],
    listSessionTasks: () => [],
    upsertTask: (_cwd: string, task: any) => {
      tasks.set(task.id, { ...task });
    },
    addEvent: () => undefined,
  };
}

function mockRunner(delay = 0): SubagentRunner {
  return async ({ definition, task }) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return {
      result: `${definition.name} handled ${task}`,
      model: 'mock/model',
      fallback_used: false,
    };
  };
}

describe('j0api cross-extension service contract (IMPL-001..002)', () => {
  it('exposes a stable V1 API version independent of the package version', () => {
    expect(SUBAGENTS_SERVICE_API_VERSION).toBe(1);
  });

  it('returns undefined when no compatible service is published', () => {
    expect(getSubagentsService()).toBeUndefined();
  });

  it('publishes a facade backed by the exact live manager and runs one task-mode task through it', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(mockRunner(), memoryHistory() as any);
    const service = createSubagentsService(manager);
    expect(service.apiVersion).toBe(1);

    publishSubagentsService(service);
    expect(getSubagentsService()).toBe(service);

    const ctx = { cwd: tmp, pi: { getTools: () => [] } };
    const run = await getSubagentsService()!.run({ agent: 'analyst', task: 'check scope' }, ctx);
    expect(run.status).toBe('completed');
    expect(run.agent).toBe('analyst');
    expect(run.result).toContain('analyst handled check scope');

    // Same-manager proof: the task is visible through the existing manager path.
    const viaManager = manager.getTask(run.id, tmp);
    expect(viaManager?.id).toBe(run.id);
    expect(viaManager?.status).toBe('completed');
  });

  it('is reachable through the package public entry point', async () => {
    const root = await import('../index.js');
    expect(root.SUBAGENTS_SERVICE_API_VERSION).toBe(1);
    expect(typeof root.getSubagentsService).toBe('function');
    expect(typeof root.publishSubagentsService).toBe('function');
    expect(typeof root.unpublishSubagentsService).toBe('function');
    expect(typeof root.createSubagentsService).toBe('function');
  });

  it('publishes on extension session_start and unpublishes only itself on session_shutdown', async () => {
    writeAgent('analyst');
    const handlers: Record<string, (...args: any[]) => void> = {};
    const tools: unknown[] = [];
    const pi = {
      registerTool: (tool: unknown) => {
        tools.push(tool);
      },
      on: (event: string, fn: (...args: any[]) => void) => {
        handlers[event] = fn;
      },
      registerMessageRenderer: () => undefined,
      registerShortcut: () => undefined,
      registerCommand: () => undefined,
    };
    const { default: subagentsExtension } = await import('../src/extension/subagents-extension.js');
    subagentsExtension(pi);
    expect(getSubagentsService()).toBeUndefined();

    handlers.session_start?.(undefined, { cwd: tmp });
    const published = getSubagentsService();
    expect(published?.apiVersion).toBe(1);

    // A stale instance cannot clear the active publication.
    const stale = createSubagentsService(new SubagentManager(mockRunner(), memoryHistory() as any));
    unpublishSubagentsService(stale);
    expect(getSubagentsService()).toBe(published);

    handlers.session_shutdown?.();
    expect(getSubagentsService()).toBeUndefined();

    // A new session re-publishes the same live-manager service (stable identity).
    handlers.session_start?.(undefined, { cwd: tmp });
    const republished = getSubagentsService();
    expect(republished).toBe(published);
    // A replaced instance (reload with a new manager) wins; tested above.
    handlers.session_shutdown?.();
    expect(getSubagentsService()).toBeUndefined();
  });

  it('exposes describeAgent through the package entry point', async () => {
    const root = await import('../index.js');
    writeAgent('analyst');
    const manager = new SubagentManager(mockRunner(), memoryHistory() as any);
    const service = root.createSubagentsService(manager);
    const descriptor = service.describeAgent('analyst', { cwd: tmp, pi: { getTools: () => [] } });
    expect(descriptor?.name).toBe('analyst');
    expect(descriptor?.effectiveTools).toContain('read');
    expect(service.describeAgent('missing-agent', { cwd: tmp })).toBeUndefined();
  });

  it('does not let a stale service instance clear a newer publication', () => {
    writeAgent('analyst');
    const first = createSubagentsService(new SubagentManager(mockRunner(), memoryHistory() as any));
    const second = createSubagentsService(new SubagentManager(mockRunner(), memoryHistory() as any));
    publishSubagentsService(first);
    publishSubagentsService(second);
    unpublishSubagentsService(first);
    expect(getSubagentsService()).toBe(second);
  });
});

describe('service hardening: snapshots, cancellation, lifecycle (IMPL-004)', () => {
  function serviceWith(runner: SubagentRunner) {
    const manager = new SubagentManager(runner, memoryHistory() as any);
    return { manager, service: createSubagentsService(manager) };
  }

  /** Runner that stains the task with every sensitive/internal field. */
  function stainingRunner(): SubagentRunner {
    return async ({ definition, task, onActivity }) => {
      onActivity?.({
        message: 'working',
        prompt: 'full delegated prompt',
        system_prompt: 'secret system prompt',
        transcript: 'full transcript',
        nested_session_path: '/private/session.jsonl',
        thread_snapshot: { version: 1, source: 'events', items: [] } as any,
      });
      return { result: `${definition.name} handled ${task}`, model: 'mock/model', fallback_used: false };
    };
  }

  it('exposes only admitted fields and returns by-value snapshots', async () => {
    writeAgent('analyst');
    const { manager, service } = serviceWith(stainingRunner());
    const ctx = { cwd: tmp, pi: { getTools: () => [] } };
    const run = await service.run({ agent: 'analyst', task: 'check scope' }, ctx);
    const forbidden = [
      'prompt', 'continuation_prompt', 'system_prompt', 'transcript',
      'thread_snapshot', 'nested_session_path', 'session_id', 'interaction_request',
      'live_activity', 'manager', 'controller',
    ];
    for (const field of forbidden) expect(run).not.toHaveProperty(field);
    expect(run).toMatchObject({ agent: 'analyst', status: 'completed' });
    expect(run.result).toContain('analyst handled check scope');
    // Mutation isolation: changing the snapshot never touches manager state.
    (run as any).result = 'mutated';
    if (run.usage) run.usage.input = 999999;
    const viaManager = manager.getTask(run.id, tmp)!;
    expect(viaManager.result).toContain('analyst handled check scope');
    if (viaManager.usage) expect(viaManager.usage.input).not.toBe(999999);
    // getTask returns the same admitted shape.
    const lookedUp = service.getTask(run.id, tmp)!;
    for (const field of forbidden) expect(lookedUp).not.toHaveProperty(field);
    expect(service.getTask('no-such-task', tmp)).toBeUndefined();
  });

  it('cancels running tasks through the same manager record', async () => {
    writeAgent('analyst');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: SubagentRunner = async ({ definition, task }) => {
      await gate;
      return { result: `${definition.name} handled ${task}`, model: 'mock/model', fallback_used: false };
    };
    const { manager, service } = serviceWith(runner);
    const ctx = { cwd: tmp, pi: { getTools: () => [] } };
    const pending = service.run({ agent: 'analyst', task: 'slow work' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const inFlight = manager.listTasks(tmp).find((task) => task.agent === 'analyst');
    expect(inFlight).toBeDefined();
    const cancelled = service.cancel(inFlight!.id, 'test cancel');
    // cancel() transitions running tasks through 'stopping' before settlement.
    expect(['cancelled', 'stopping']).toContain(cancelled?.status);
    release();
    await pending.catch(() => undefined);
    expect(manager.getTask(inFlight!.id, tmp)?.status).toBe('cancelled');
    expect(service.getTask(inFlight!.id, tmp)?.status).toBe('cancelled');
    expect(service.cancel('no-such-task')).toBeUndefined();
  });

  it('propagates caller AbortSignal to the live run', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ definition, task }) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { result: `${definition.name} handled ${task}`, model: 'mock/model', fallback_used: false };
    };
    const { manager, service } = serviceWith(runner);
    const ctx = { cwd: tmp, pi: { getTools: () => [] } };
    const controller = new AbortController();
    const pending = service.run({ agent: 'analyst', task: 'abort me' }, ctx, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow();
    const task = manager.listTasks(tmp).find((entry) => entry.agent === 'analyst');
    expect(['cancelled', 'stopping']).toContain(task?.status);
  });

  it('streams bounded update snapshots during a run', async () => {
    writeAgent('analyst');
    const { service } = serviceWith(mockRunner(30));
    const ctx = { cwd: tmp, pi: { getTools: () => [] } };
    const seen: string[] = [];
    const run = await service.run({ agent: 'analyst', task: 'watch me' }, ctx, {
      onUpdate: (tasks) => {
        for (const snapshot of tasks) {
          seen.push(snapshot.status);
          expect(snapshot).not.toHaveProperty('transcript');
        }
      },
    });
    expect(run.status).toBe('completed');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe('completed');
  });

  it('supports background launch without waiting and shares the manager record', async () => {
    writeAgent('analyst');
    let release!: (value: { result: string }) => void;
    const gate = new Promise<{ result: string }>((resolve) => {
      release = resolve;
    });
    const runner: SubagentRunner = async () => ({
      ...(await gate),
      model: 'mock/model',
      fallback_used: false as const,
    });
    const { manager, service } = serviceWith(runner);
    const ctx = { cwd: tmp, pi: { getTools: () => [] } };
    const launched = await service.run({ agent: 'analyst', task: 'bg work', mode: 'background' }, ctx);
    expect(['queued', 'running']).toContain(launched.status);
    expect(manager.getTask(launched.id, tmp)?.id).toBe(launched.id);
    release({ result: 'bg done' });
    let terminal;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      terminal = service.getTask(launched.id, tmp);
      if (terminal?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(terminal?.status).toBe('completed');
    expect(terminal?.result).toContain('bg done');
  });

  it('keeps a narrow surface: no claimed-outcome or manager access', () => {
    writeAgent('analyst');
    const service = createSubagentsService(new SubagentManager(mockRunner(), memoryHistory() as any));
    expect(Object.keys(service).sort()).toEqual(['apiVersion', 'cancel', 'describeAgent', 'getTask', 'run']);
  });
});

describe('research consumer integration (IMPL-006)', () => {
  const RESEARCH_TOOLS = ['read', 'web_search', 'source_check', 'fetch_content', 'aft_search'];

  async function loadRealSdkRunner(captured: { tools?: string[] }) {
    const { vi } = await import('vitest');
    vi.resetModules();
    const session = {
      prompt: async () => undefined,
      messages: [{ role: 'assistant', content: 'research findings' }],
      dispose: async () => undefined,
    };
    const createAgentSession = vi.fn((options: any) => {
      captured.tools = options.tools;
      return { session };
    });
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      DefaultResourceLoader: class {
        reload() {
          return Promise.resolve({});
        }
      },
      getAgentDir: () => tmp,
      createAgentSession,
    }));
    const { sdkSubagentRunner } = await import('../src/runner.js');
    return sdkSubagentRunner;
  }

  it('runs a read-only researcher with active external tools and exact descriptor parity', async () => {
    writeAgent('followup-research', RESEARCH_TOOLS);
    const captured: { tools?: string[] } = {};
    const sdkRunner = await loadRealSdkRunner(captured);
    const manager = new SubagentManager(sdkRunner as SubagentRunner, memoryHistory() as any);
    const service = createSubagentsService(manager);
    const ctx = {
      cwd: tmp,
      model: { provider: 'test', id: 'model' },
      pi: { getTools: () => [...RESEARCH_TOOLS, 'write', 'edit', 'bash'] },
    };
    // Unallowlisted mutating tools never appear, even though active.
    expect(service.describeAgent('followup-research', ctx)?.effectiveTools).toEqual(RESEARCH_TOOLS);
    const run = await service.run({ agent: 'followup-research', task: 'summarize the topic' }, ctx);
    expect(run.status).toBe('completed');
    expect(run.result).toContain('research findings');
    // The child received exactly the described allowlist: parity, not drift.
    expect(captured.tools).toEqual(service.describeAgent('followup-research', ctx)?.effectiveTools);
  });

  it('drops inactive tools from both descriptor and child, and cannot reach write on demand', async () => {
    writeAgent('followup-research', RESEARCH_TOOLS);
    const captured: { tools?: string[] } = {};
    const sdkRunner = await loadRealSdkRunner(captured);
    const manager = new SubagentManager(sdkRunner as SubagentRunner, memoryHistory() as any);
    const service = createSubagentsService(manager);
    const ctx = {
      cwd: tmp,
      model: { provider: 'test', id: 'model' },
      pi: { getTools: () => ['read', 'write', 'edit'] },
    };
    expect(service.describeAgent('followup-research', ctx)?.effectiveTools).toEqual(['read']);
    const run = await service.run({ agent: 'followup-research', task: 'edit the file with the write tool' }, ctx);
    expect(run.status).toBe('completed');
    expect(captured.tools).toEqual(['read']);
    expect(captured.tools).not.toContain('write');
  });

  it('keeps task-mode direct runs parent-silent and falls back cleanly when unsupported', async () => {
    writeAgent('followup-research', ['read', 'web_search']);
    const parentCalls: string[] = [];
    const ctx = {
      cwd: tmp,
      pi: { getTools: () => ['read', 'web_search'] },
      sendMessage: () => {
        parentCalls.push('sendMessage');
      },
      sendUserMessage: () => {
        parentCalls.push('sendUserMessage');
      },
      appendEntry: () => {
        parentCalls.push('appendEntry');
      },
      ui: {
        notify: () => {
          parentCalls.push('notify');
        },
      },
    };
    const service = createSubagentsService(new SubagentManager(mockRunner(), memoryHistory() as any));
    const run = await service.run({ agent: 'followup-research', task: 'summarize quietly' }, ctx);
    expect(run.status).toBe('completed');
    expect(parentCalls).toEqual([]);
    // Missing service/agent/capability surfaces as a clean fallback, never a crash.
    const missing = service.describeAgent('no-such-agent', ctx);
    const outcome = missing ? { supported: true as const } : { supported: false as const };
    expect(outcome).toEqual({ supported: false });
  });
});

describe('describeAgent policy-aligned capabilities (IMPL-003)', () => {
  function serviceFor() {
    return createSubagentsService(new SubagentManager(mockRunner(), memoryHistory() as any));
  }

  it('keeps allowlisted active tools, drops inactive extension tools, and blocks subagent_*', () => {
    writeAgent('researcher', ['read', 'web_search', 'subagent_run']);
    const service = serviceFor();
    // subagent_run is stripped at definition load; unallowlisted edit never appears.
    const active = service.describeAgent('researcher', {
      cwd: tmp,
      pi: { getTools: () => ['read', 'web_search', 'edit'] },
    });
    expect(active?.declaredTools).toEqual(['read', 'web_search']);
    expect(active?.effectiveTools).toEqual(['read', 'web_search']);
    // Declared-but-inactive extension tools are not reported.
    const inactive = service.describeAgent('researcher', {
      cwd: tmp,
      pi: { getTools: () => ['read'] },
    });
    expect(inactive?.effectiveTools).toEqual(['read']);
  });

  it('expands wildcards against active tools only', () => {
    writeAgent('scout', ['web_*', 'read']);
    const descriptor = serviceFor().describeAgent('scout', {
      cwd: tmp,
      pi: { getTools: () => ['web_search', 'web_fetch', 'edit'] },
    });
    expect(descriptor?.effectiveTools).toEqual(['web_search', 'web_fetch', 'read']);
  });

  it('resolves loader defaults for definitions without a tools key', () => {
    fs.writeFileSync(
      path.join(tmp, '.pi', 'subagents', 'plain.md'),
      '---\nname: plain\ndescription: plain agent\n---\n# plain\n',
    );
    const descriptor = serviceFor().describeAgent('plain', {
      cwd: tmp,
      pi: { getTools: () => ['read'] },
    });
    // Missing tools key falls back to loader defaults; Pi core tools are kept.
    expect(descriptor?.declaredTools).toEqual(['read', 'memory_context', 'memory_search', 'memory_recall', 'memory_get']);
    expect(descriptor?.effectiveTools).toEqual(descriptor?.declaredTools);
  });

  it('ignores publications with an incompatible api version', () => {
    publishSubagentsService({ apiVersion: 2 } as any);
    expect(getSubagentsService()).toBeUndefined();
    unpublishSubagentsService();
  });

  it('falls back to config defaults through the same shared resolver', async () => {
    const { resolveEffectiveTools } = await import('../src/capabilities.js');
    const { readSubagentsConfig } = await import('../src/config.js');
    const config = readSubagentsConfig(tmp);
    const ctx = { cwd: tmp, pi: { getTools: () => ['read'] } };
    expect(resolveEffectiveTools({ definition: { tools: [] }, config, ctx })).toEqual(
      resolveEffectiveTools({ definition: { tools: config.default_tools }, config, ctx }),
    );
  });

  it('shares one resolution implementation with the SDK runner (drift tripwire)', () => {
    const runnerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'runner', 'sdk-runner.ts'), 'utf8');
    expect(runnerSource).toContain('resolveEffectiveTools');
    expect(runnerSource).not.toContain('function activeToolNames');
  });

  it('grants no tool/model overrides: extra caller fields cannot widen the child allowlist', async () => {
    writeAgent('researcher', ['read', 'web_search']);
    const service = serviceFor();
    const ctx = { cwd: tmp, pi: { getTools: () => ['read', 'web_search', 'write', 'edit'] } };
    expect(service.describeAgent('researcher', ctx)?.effectiveTools).toEqual(['read', 'web_search']);
    const run = await service.run(
      { agent: 'researcher', task: 'edit the file', tools: ['write', 'edit'] } as any,
      ctx,
    );
    expect(run.status).toBe('completed');
    expect(service.describeAgent('researcher', ctx)?.effectiveTools).not.toContain('write');
  });
});
