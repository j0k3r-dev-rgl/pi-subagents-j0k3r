import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubagentStructuredError, classifyFallbackFailure, classifyThrownError, deriveErrorString, normalizeErrorMetadata } from '../../src/error-metadata.js';
import type { SubagentDefinition, SubagentErrorMetadata, SubagentsConfig } from '../../src/types.js';

describe('subagent runner interaction-required bridge', () => {
  it('uses a lean isolated resource loader with subagent markdown as system prompt', async () => {
    vi.resetModules();
    let delegatedPrompt = '';
    const session = {
      systemPrompt: '# Analyst\nSYSTEM_SENTINEL',
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async (prompt: string) => { delegatedPrompt = prompt; }),
      messages: [{ role: 'assistant', content: 'lean done' }],
      dispose: vi.fn(async () => undefined),
    };
    const createAgentSession = vi.fn(() => ({ session }));
    const inMemory = vi.fn(() => ({ kind: 'memory-session' }));
    const loaderInstances: any[] = [];
    class DefaultResourceLoader {
      options: any;
      reload = vi.fn(async () => undefined);
      constructor(options: any) { this.options = options; loaderInstances.push(this); }
    }
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      DefaultResourceLoader,
      getAgentDir: () => '/agent-dir',
      SessionManager: { inMemory },
      createAgentSession,
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const definition: SubagentDefinition = {
      name: 'analyst',
      description: 'analysis',
      filePath: '/tmp/analyst.md',
      instructions: '# Analyst\nSYSTEM_SENTINEL',
      tools: ['read'],
    };
    const config: SubagentsConfig = {
      timeout_ms: 10_000,
      stall_timeout_ms: 10_000,
      max_concurrency: 1,
      default_tools: ['read'],
      model_profiles: {},
      session_resources: 'lean',
    };
    const activities: any[] = [];

    const result = await sdkSubagentRunner({
      definition,
      task: 'lean startup',
      cwd: '/workspace',
      ctx: { model: { provider: 'test', id: 'model' } },
      config,
      signal: new AbortController().signal,
      onActivity: (activity) => activities.push(activity),
    });

    expect(result.result).toBe('lean done');
    expect(loaderInstances).toHaveLength(1);
    expect(loaderInstances[0].reload).toHaveBeenCalledTimes(1);
    expect(loaderInstances[0].options).toMatchObject({ cwd: '/workspace', agentDir: '/agent-dir', noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: '# Analyst\nSYSTEM_SENTINEL' });
    expect(typeof loaderInstances[0].options.extensionsOverride).toBe('function');
    expect(inMemory).toHaveBeenCalledWith('/workspace');
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ resourceLoader: loaderInstances[0], cwd: '/workspace', tools: ['read'] }));
    expect(delegatedPrompt).toBe('## delegated task\nlean startup');
    expect(delegatedPrompt).not.toContain('SYSTEM_SENTINEL');
    expect(activities.some((activity) => activity.system_prompt === '# Analyst\nSYSTEM_SENTINEL')).toBe(true);
  });

  it('filters subagent extension hooks to tools and tool-safety events only', async () => {
    vi.resetModules();
    const loaderInstances: any[] = [];
    class DefaultResourceLoader {
      options: any;
      reload = vi.fn(async () => undefined);
      constructor(options: any) { this.options = options; loaderInstances.push(this); }
    }
    const session = { systemPrompt: 'system', subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(async () => undefined), messages: [{ role: 'assistant', content: 'ok' }], dispose: vi.fn(async () => undefined) };
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      DefaultResourceLoader,
      getAgentDir: () => '/agent-dir',
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    await sdkSubagentRunner({
      definition: { name: 'analyst', description: 'analysis', filePath: '/tmp/analyst.md', instructions: 'system', tools: ['read'] },
      task: 'ping',
      cwd: '/workspace',
      ctx: { model: { provider: 'test', id: 'model' } },
      config: { timeout_ms: 10_000, stall_timeout_ms: 10_000, max_concurrency: 1, default_tools: ['read'], model_profiles: {}, session_resources: 'lean' },
      signal: new AbortController().signal,
    });

    const beforeAgentStart = vi.fn();
    const toolCall = vi.fn();
    const tool = { name: 'memory_search' };
    const filtered = loaderInstances[0].options.extensionsOverride({
      runtime: { keep: true },
      errors: [],
      extensions: [{
        path: 'memory',
        resolvedPath: 'memory',
        sourceInfo: {},
        handlers: new Map<string, any[]>([
          ['before_agent_start', [beforeAgentStart]],
          ['context', [vi.fn()]],
          ['tool_call', [toolCall]],
          ['user_bash', [vi.fn()]],
          ['message_update', [vi.fn()]],
        ]),
        tools: new Map([['memory_search', tool]]),
        messageRenderers: new Map([['memory-context', vi.fn()]]),
        commands: new Map([['memory', vi.fn()]]),
        flags: new Map([['flag', {}]]),
        shortcuts: new Map([['ctrl+x', {}]]),
      }],
    });

    const extension = filtered.extensions[0];
    expect(extension.tools.get('memory_search')).toBe(tool);
    expect(extension.handlers.has('before_agent_start')).toBe(false);
    expect(extension.handlers.has('context')).toBe(false);
    expect(extension.handlers.has('message_update')).toBe(false);
    expect(extension.handlers.get('tool_call')).toEqual([toolCall]);
    expect(extension.handlers.has('user_bash')).toBe(true);
    expect(extension.commands.size).toBe(0);
    expect(extension.flags.size).toBe(0);
    expect(extension.shortcuts.size).toBe(0);
  });

  it('preserves structured interaction requests from nested tool failures while keeping result surfaces marker-free', async () => {
    vi.resetModules();
    const payload = {
      type: 'interaction_required',
      requestId: 'req-subagent-read',
      tool: 'read',
      action: 'read',
      origin: 'subagent',
      requester: { subagentName: 'sdd-apply', taskId: '2.10' },
      reason: 'Outside-workspace read requires approval.',
      reasonCode: 'outside_workspace_read_approval_required',
      riskLevel: 'medium',
      prompt: {
        title: 'Interaction required for read',
        message: 'Outside-workspace read requires approval.',
        choices: ['Allow once', 'Allow for session', 'Allow for project', 'Deny'],
        safeTarget: '/tmp/outside.txt',
      },
    };
    const structuredToolResult = {
      block: true,
      reason: 'Interaction response must be collected by the main thread.',
      details: {
        interactionRequest: {
          handle: 'perm_test_handle',
          payload,
          createdAt: new Date().toISOString(),
        },
      },
    };
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'tool_execution_start', toolName: 'read', args: { path: '../outside.txt' } });
        subscriber?.({
          type: 'tool_execution_end',
          toolName: 'read',
          isError: true,
          result: structuredToolResult,
        });
      }),
      messages: [{ role: 'assistant', content: 'I could not complete the read.' }],
      dispose: vi.fn(async () => undefined),
    };

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const definition: SubagentDefinition = {
      name: 'sdd-apply',
      description: 'implementation executor',
      filePath: '/tmp/sdd-apply.md',
      instructions: 'return a concise result',
      tools: ['read'],
    };
    const config: SubagentsConfig = {
      timeout_ms: 10_000,
      stall_timeout_ms: 10_000,
      max_concurrency: 1,
      default_tools: ['read'],
      model_profiles: {},
    };
    const activities: Array<{ transcript?: string; output?: string; message: string }> = [];
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-runner-interaction-'));
    try {
      const result = await sdkSubagentRunner({
        definition,
        task: 'read outside workspace',
        cwd,
        ctx: { model: { provider: 'test', id: 'model' } },
        config,
        signal: new AbortController().signal,
        onActivity: (activity) => activities.push(activity),
      });

      expect(result.result).not.toContain('interaction_required:');
      expect(result.interaction_request).toEqual(expect.objectContaining({ requestId: 'req-subagent-read', tool: 'read' }));
      expect(activities.map((activity) => activity.transcript ?? activity.output ?? '').join('\n')).not.toContain('interaction_required:');
      expect(session.prompt).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('extracts interaction requests from nested Pi tool result details', async () => {
    vi.resetModules();
    const payload = {
      type: 'interaction_required',
      requestId: 'req-nested-details',
      tool: 'read',
      action: 'read',
      origin: 'subagent',
      reasonCode: 'outside_workspace_read_requires_approval',
      prompt: { title: 'Interaction required', message: 'Outside-workspace read requires approval.' },
    };
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({
          type: 'tool_execution_end',
          toolName: 'read',
          isError: true,
          result: {
            content: [{ type: 'text', text: 'Interaction response must be collected by the main thread.' }],
            details: {
              block: true,
              reason: 'Interaction response must be collected by the main thread.',
              details: {
                interactionRequest: { handle: 'perm_nested_details', payload, createdAt: new Date().toISOString() },
              },
            },
          },
        });
      }),
      messages: [{ role: 'assistant', content: 'blocked' }],
      dispose: vi.fn(async () => undefined),
    };

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const result = await sdkSubagentRunner({
      definition: { name: 'discovery', description: 'discovery', filePath: '/tmp/discovery.md', instructions: 'try read', tools: ['read'] },
      task: 'read outside workspace',
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-nested-interaction-')),
      ctx: { model: { provider: 'test', id: 'model' } },
      config: { timeout_ms: 10_000, stall_timeout_ms: 10_000, max_concurrency: 1, default_tools: ['read'], model_profiles: {} },
      signal: new AbortController().signal,
    });

    expect(result.interaction_request).toEqual(expect.objectContaining({ requestId: 'req-nested-details' }));
    expect(result.result).not.toContain('interaction_required:');
  });

  it('recovers stripped interaction payloads from the shared channel when Pi drops tool result details', async () => {
    vi.resetModules();
    const payload = {
      type: 'interaction_required',
      requestId: 'req-channel-fallback',
      tool: 'read',
      action: 'read',
      origin: 'subagent',
      reasonCode: 'outside_workspace_read_requires_approval',
      prompt: { title: 'Interaction required', message: 'Outside-workspace read requires approval.' },
    };
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        const { publishInteractionRequest } = await import('../../src/interaction-channel.js');
        publishInteractionRequest(payload as any);
        subscriber?.({
          type: 'tool_execution_end',
          toolName: 'read',
          isError: true,
          result: {
            content: [{ type: 'text', text: 'Interaction response must be collected by the main thread.' }],
            details: {},
          },
        });
      }),
      messages: [{ role: 'assistant', content: 'blocked' }],
      dispose: vi.fn(async () => undefined),
    };

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const result = await sdkSubagentRunner({
      definition: { name: 'discovery', description: 'discovery', filePath: '/tmp/discovery.md', instructions: 'try read', tools: ['read'] },
      task: 'read outside workspace',
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-channel-fallback-')),
      ctx: { model: { provider: 'test', id: 'model' } },
      config: { timeout_ms: 10_000, stall_timeout_ms: 10_000, max_concurrency: 1, default_tools: ['read'], model_profiles: {} },
      signal: new AbortController().signal,
    });

    expect(result.interaction_request).toEqual(expect.objectContaining({ requestId: 'req-channel-fallback' }));
    expect(result.result).not.toContain('interaction_required:');
  });

  it('passes profile model and effort to nested SDK sessions and reports them', async () => {
    vi.resetModules();
    const session = {
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      messages: [{ role: 'assistant', content: 'done' }],
      dispose: vi.fn(async () => undefined),
    };
    const createAgentSession = vi.fn(() => ({ session }));

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession,
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const definition: SubagentDefinition = {
      name: 'sdd-apply',
      description: 'apply executor',
      filePath: '/tmp/sdd-apply.md',
      instructions: 'return a concise result',
      tools: ['read'],
    };
    const config: SubagentsConfig = {
      timeout_ms: 10_000,
      stall_timeout_ms: 10_000,
      max_concurrency: 1,
      default_tools: ['read'],
      model_profiles: { 'sdd-apply': { model: { provider: 'profile', id: 'model' }, effort: 'xhigh' } },
    };
    const profileModel = { provider: 'profile', id: 'model' };

    const result = await sdkSubagentRunner({
      definition,
      task: 'apply work',
      cwd: '/workspace',
      ctx: {
        model: { provider: 'orchestrator', id: 'model' },
        modelRegistry: { find: vi.fn((provider: string, id: string) => provider === 'profile' && id === 'model' ? profileModel : undefined) },
        pi: { getThinkingLevel: () => 'low' },
      },
      config,
      signal: new AbortController().signal,
    });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model: profileModel, thinkingLevel: 'xhigh' }));
    expect(result).toMatchObject({ model: 'profile/model', effort: 'xhigh', fallback_used: false });
  });

  it('inherits missing profile fields from the remaining fallback chain', async () => {
    vi.resetModules();
    const session = {
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      messages: [{ role: 'assistant', content: 'done' }],
      dispose: vi.fn(async () => undefined),
    };
    const createAgentSession = vi.fn(() => ({ session }));

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession,
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const definition: SubagentDefinition = {
      name: 'sdd-design',
      description: 'design executor',
      filePath: '/tmp/sdd-design.md',
      instructions: 'return a concise result',
      model: { provider: 'frontmatter', id: 'model' },
      tools: ['read'],
    };
    const config: SubagentsConfig = {
      timeout_ms: 10_000,
      stall_timeout_ms: 10_000,
      max_concurrency: 1,
      default_tools: ['read'],
      model_profiles: { 'sdd-design': { effort: 'high' } },
    };
    const frontmatterModel = { provider: 'frontmatter', id: 'model' };

    await sdkSubagentRunner({
      definition,
      task: 'design work',
      cwd: '/workspace',
      ctx: { modelRegistry: { find: vi.fn(() => frontmatterModel) }, model: { provider: 'orchestrator', id: 'model' }, thinkingLevel: 'low' },
      config,
      signal: new AbortController().signal,
    });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model: frontmatterModel, thinkingLevel: 'high' }));
  });

  it('keeps no-profile default-config and orchestrator-inherited behavior unchanged', async () => {
    vi.resetModules();
    const session = {
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      messages: [{ role: 'assistant', content: 'done' }],
      dispose: vi.fn(async () => undefined),
    };
    const createAgentSession = vi.fn(() => ({ session }));

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession,
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const definition: SubagentDefinition = {
      name: 'reviewer',
      description: 'reviewer executor',
      filePath: '/tmp/reviewer.md',
      instructions: 'return a concise result',
      tools: ['read'],
    };
    const defaultModel = { provider: 'default', id: 'model' };
    const config: SubagentsConfig = {
      default_model: { provider: 'default', id: 'model' },
      default_effort: 'medium',
      timeout_ms: 10_000,
      stall_timeout_ms: 10_000,
      max_concurrency: 1,
      default_tools: ['read'],
      model_profiles: {},
    };

    await sdkSubagentRunner({
      definition,
      task: 'review work',
      cwd: '/workspace',
      ctx: { modelRegistry: { find: vi.fn(() => defaultModel) }, model: { provider: 'orchestrator', id: 'model' }, thinkingLevel: 'low' },
      config,
      signal: new AbortController().signal,
    });

    expect(createAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: defaultModel, thinkingLevel: 'medium' }));

    createAgentSession.mockClear();
    await sdkSubagentRunner({
      definition,
      task: 'review work',
      cwd: '/workspace',
      ctx: { model: { provider: 'orchestrator', id: 'model' }, thinkingLevel: 'low' },
      config: { ...config, default_model: undefined, default_effort: undefined },
      signal: new AbortController().signal,
    });

    expect(createAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({ model: { provider: 'orchestrator', id: 'model' }, thinkingLevel: 'low' }));
  });

  it('reports unresolved profile models with the subagent name and selected model', async () => {
    vi.resetModules();
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(),
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    await expect(sdkSubagentRunner({
      definition: { name: 'sdd-apply', description: 'apply executor', filePath: '/tmp/sdd-apply.md', instructions: 'return a concise result', tools: ['read'] },
      task: 'apply work',
      cwd: '/workspace',
      ctx: { modelRegistry: { find: vi.fn(() => undefined) }, model: { provider: 'orchestrator', id: 'model' } },
      config: { timeout_ms: 10_000, stall_timeout_ms: 10_000, max_concurrency: 1, default_tools: ['read'], model_profiles: { 'sdd-apply': { model: { provider: 'missing', id: 'model' } } } },
      signal: new AbortController().signal,
    })).rejects.toThrow('Subagent sdd-apply could not resolve selected model missing/model');
  });

  it('passes the resolved thinking effort to nested SDK sessions and reports it', async () => {
    vi.resetModules();
    const session = {
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      messages: [{ role: 'assistant', content: 'done' }],
      dispose: vi.fn(async () => undefined),
    };
    const createAgentSession = vi.fn(() => ({ session }));

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession,
    }));

    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const definition: SubagentDefinition = {
      name: 'sdd-design',
      description: 'design executor',
      filePath: '/tmp/sdd-design.md',
      instructions: 'return a concise result',
      effort: 'high',
      tools: ['read'],
    };
    const config: SubagentsConfig = {
      timeout_ms: 10_000,
      stall_timeout_ms: 10_000,
      max_concurrency: 1,
      default_tools: ['read'],
      model_profiles: {},
    };

    const result = await sdkSubagentRunner({
      definition,
      task: 'design work',
      cwd: '/workspace',
      ctx: { model: { provider: 'test', id: 'model' }, pi: { getThinkingLevel: () => 'low' } },
      config,
      signal: new AbortController().signal,
    });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'high' }));
    expect(result.effort).toBe('high');
  });

  it('registers nested SDK sessions as subagent interaction requesters while the prompt runs', async () => {
    vi.resetModules();
    const registryKey = Symbol.for('pi.subagents.interactionSessions');
    const holder = globalThis as Record<symbol, unknown>;
    const previousRegistry = holder[registryKey];
    let metadataDuringPrompt: unknown;
    const session = {
      sessionManager: { getSessionId: () => 'nested-session-1' },
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => {
        const registry = holder[registryKey] as Map<string, unknown> | undefined;
        metadataDuringPrompt = registry?.get('nested-session-1');
      }),
      messages: [{ role: 'assistant', content: 'done' }],
      dispose: vi.fn(async () => undefined),
    };

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));

    try {
      const { sdkSubagentRunner } = await import('../../src/runner.js');
      const definition: SubagentDefinition = {
        name: 'sdd-verify',
        description: 'verification executor',
        filePath: '/tmp/sdd-verify.md',
        instructions: 'return a concise result',
        tools: ['read'],
      };
      const config: SubagentsConfig = {
        timeout_ms: 10_000,
        stall_timeout_ms: 10_000,
        max_concurrency: 1,
        default_tools: ['read'],
        model_profiles: {},
      };

      await sdkSubagentRunner({
        definition,
        task: 'read /etc/hosts',
        taskId: 'task_sdd-verify_123',
        cwd: '/workspace',
        ctx: { model: { provider: 'test', id: 'model' }, sessionManager: { getSessionId: () => 'parent-pi-session' } },
        config,
        signal: new AbortController().signal,
      });

      expect(metadataDuringPrompt).toEqual({
        origin: 'subagent',
        requester: { subagentName: 'sdd-verify', description: 'verification executor', taskId: 'task_sdd-verify_123' },
        parent: { piSessionId: 'parent-pi-session' },
      });
      expect((holder[registryKey] as Map<string, unknown> | undefined)?.has('nested-session-1')).toBe(false);
    } finally {
      if (previousRegistry === undefined) delete holder[registryKey];
      else holder[registryKey] = previousRegistry;
    }
  });
});
