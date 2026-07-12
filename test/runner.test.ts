import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubagentStructuredError, classifyFallbackFailure, classifyThrownError, deriveErrorString, normalizeErrorMetadata } from '../src/error-metadata.js';
import type { SubagentDefinition, SubagentErrorMetadata, SubagentsConfig } from '../src/types.js';

describe('structured error metadata contract', () => {
  it('normalizes v1 metadata defaults, bounds, retryability, and redaction', () => {
    const secretLikeMessage = [
      'Bearer sk-fake-secret-token',
      'contact fake.user@example.com',
      'open /tmp/fake-private.txt',
      'prompt: summarize file contents SECRET_FILE_BODY',
    ].join(' | ');
    const metadata = normalizeErrorMetadata({
      category: 'provider_rate_limit',
      message: `${secretLikeMessage} ${'x'.repeat(1400)}`,
      source: {
        provider: 'openai',
        model: 'gpt-test',
        tool: `read_${'x'.repeat(400)}`,
        operation: `session.prompt.${'y'.repeat(400)}`,
      },
      details: {
        provider_code: 'rate_limit_429',
        auth_header: 'Authorization: Bearer sk-fake-secret-token',
        prompt: 'SYSTEM: fake prompt text',
        file_path: '/tmp/fake-private.txt',
        email: 'fake.user@example.com',
        body: `SECRET_FILE_BODY_${'z'.repeat(800)}`,
      },
      cause: {
        version: 1,
        category: 'unknown',
        message: 'nested cause',
        retryable: false,
        partial_result_available: false,
        cause: {
          version: 1,
          category: 'unknown',
          message: 'deep cause',
          retryable: false,
          partial_result_available: false,
          cause: {
            version: 1,
            category: 'unknown',
            message: 'too deep',
            retryable: false,
            partial_result_available: false,
          },
        },
      },
      attempts: [
        { version: 1, category: 'provider_api_error', message: 'primary', retryable: true, partial_result_available: false, role: 'primary' },
        { version: 1, category: 'provider_network_error', message: 'fallback', retryable: true, partial_result_available: false, role: 'fallback' },
        { version: 1, category: 'unknown', message: 'ignored', retryable: false, partial_result_available: false },
      ],
    });

    expect(metadata.version).toBe(1);
    expect(metadata.retryable).toBe(true);
    expect(metadata.message.length).toBeLessThanOrEqual(1024);
    expect(metadata.message).not.toContain('sk-fake-secret-token');
    expect(metadata.message).not.toContain('fake.user@example.com');
    expect(metadata.message).not.toContain('/tmp/fake-private.txt');
    expect(metadata.message).not.toContain('SECRET_FILE_BODY');
    expect(metadata.message).toContain('[redacted]');
    expect(metadata.source?.tool?.length ?? 0).toBeLessThanOrEqual(256);
    expect(metadata.source?.operation?.length ?? 0).toBeLessThanOrEqual(256);
    expect(Object.keys(metadata.details ?? {}).length).toBeLessThanOrEqual(16);
    expect(Object.values(metadata.details ?? {})).toEqual(expect.not.arrayContaining([
      expect.stringContaining('sk-fake-secret-token'),
      expect.stringContaining('fake.user@example.com'),
      expect.stringContaining('/tmp/fake-private.txt'),
      expect.stringContaining('SECRET_FILE_BODY'),
    ]));
    expect(metadata.attempts).toHaveLength(2);
    expect(metadata.attempts?.map((attempt) => attempt.role)).toEqual(['primary', 'fallback']);
    expect(metadata.cause?.cause?.cause).toBeUndefined();
  });

  it('preserves exact-string compatibility for legacy-facing derived errors', () => {
    expect(deriveErrorString(normalizeErrorMetadata({
      category: 'total_timeout',
      message: 'ignored',
      retryable: false,
      partial_result_available: false,
      details: { timeout_ms: '123' },
    }))).toBe('timed out after 123ms');

    expect(deriveErrorString(normalizeErrorMetadata({
      category: 'stall_timeout',
      message: 'ignored',
      retryable: false,
      partial_result_available: false,
      details: { stall_timeout_ms: '20' },
    }))).toBe('Subagent stalled for 20ms without final response.');

    expect(deriveErrorString(normalizeErrorMetadata({
      category: 'cancelled',
      message: 'ignored',
      retryable: false,
      partial_result_available: true,
      details: { cancel_reason: 'parent abort' },
    }))).toBe('Subagent cancelled: parent abort');
  });

  it('classifies conservative thrown errors and fallback attempts', () => {
    const auth = classifyThrownError(new Error('401 invalid api key Bearer sk-fake-secret-token'), {
      phase: 'runner_invoke',
      provider: 'openai',
      model: 'gpt-test',
    });
    expect(auth.category).toBe('provider_auth_error');
    expect(auth.retryable).toBe(false);
    expect(auth.message).not.toContain('sk-fake-secret-token');

    const malformed = classifyThrownError({ message: 'ECONNRESET fake.user@example.com' }, {
      phase: 'runner_invoke',
      provider: 'openai',
      model: 'gpt-test',
    });
    expect(malformed.category).toBe('malformed_thrown_value');
    expect(malformed.retryable).toBe(false);

    const fallback = classifyFallbackFailure(
      normalizeErrorMetadata({ category: 'provider_network_error', message: 'primary failure', retryable: true, partial_result_available: false, role: 'primary' }),
      normalizeErrorMetadata({ category: 'provider_rate_limit', message: 'fallback failure', retryable: true, partial_result_available: false, role: 'fallback' }),
    );
    expect(fallback.category).toBe('fallback_failed');
    expect(fallback.retryable).toBe(false);
    expect(fallback.attempts?.map((attempt) => attempt.role)).toEqual(['primary', 'fallback']);
  });

  it('wraps normalized metadata in SubagentStructuredError', () => {
    const metadata: SubagentErrorMetadata = normalizeErrorMetadata({
      category: 'unknown',
      message: 'plain failure',
      partial_result_available: false,
    });
    const error = new SubagentStructuredError(metadata);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(deriveErrorString(metadata));
    expect(error.error_metadata).toEqual(metadata);
  });
});

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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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
        const { publishInteractionRequest } = await import('../src/interaction-channel.js');
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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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

    const { sdkSubagentRunner } = await import('../src/runner.js');
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
      const { sdkSubagentRunner } = await import('../src/runner.js');
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

describe('subagent runner structured errors', () => {
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

  async function runStructuredSession(sessionFactory: () => any, overrides: { config?: SubagentsConfig; ctx?: any } = {}) {
    vi.resetModules();
    const createAgentSession = vi.fn(() => ({ session: sessionFactory() }));
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession,
    }));
    const { sdkSubagentRunner } = await import('../src/runner.js');
    return {
      createAgentSession,
      promise: sdkSubagentRunner({
        definition,
        task: 'classify structured runner failure',
        cwd: '/workspace',
        ctx: { model: { provider: 'current', id: 'fallback-model' }, ...overrides.ctx },
        config: overrides.config ?? config,
        signal: new AbortController().signal,
      }),
    };
  }

  it('classifies provider auth/rate/network/api errors, redacts secrets, and bounds metadata', async () => {
    const cases: Array<{ error: unknown; category: string }> = [
      { error: new Error(`401 invalid api key Bearer sk-secret-${'x'.repeat(60)}`), category: 'provider_auth_error' },
      { error: new Error('429 rate limit exceeded for quota bucket'), category: 'provider_rate_limit' },
      { error: new Error('ECONNRESET upstream connection reset'), category: 'provider_network_error' },
      { error: new Error('500 internal provider failure'), category: 'provider_api_error' },
    ];

    for (const testCase of cases) {
      const { promise } = await runStructuredSession(() => ({
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => { throw testCase.error; }),
        messages: [],
        dispose: vi.fn(async () => undefined),
      }), { ctx: { model: undefined } });
      await expect(promise).rejects.toMatchObject({
        error_metadata: expect.objectContaining({
          version: 1,
          category: 'unknown_fallback',
          attempts: [expect.objectContaining({ role: 'primary', category: testCase.category })],
        }),
      });
      await promise.catch((error) => {
        expect(error.error_metadata.message.length).toBeLessThanOrEqual(1024);
        expect(error.error_metadata.attempts).toHaveLength(1);
        expect(error.error_metadata.attempts[0].message).not.toContain('sk-secret-');
      });
    }
  });

  it('classifies assistant stopReason=error context overflow heuristics', async () => {
    const { promise } = await runStructuredSession(() => ({
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'maximum context length exceeded', content: [] }],
      dispose: vi.fn(async () => undefined),
    }), { ctx: { model: undefined } });

    await expect(promise).rejects.toMatchObject({
      error_metadata: expect.objectContaining({
        version: 1,
        category: 'unknown_fallback',
        attempts: [expect.objectContaining({ category: 'context_overflow', phase: 'assistant_final', role: 'primary' })],
      }),
    });
  });

  it('classifies malformed thrown values', async () => {
    const { promise } = await runStructuredSession(() => ({
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => { throw { problem: 'weird', message: 'opaque payload' }; }),
      messages: [],
      dispose: vi.fn(async () => undefined),
    }), { ctx: { model: undefined } });

    await expect(promise).rejects.toMatchObject({
      error_metadata: expect.objectContaining({
        version: 1,
        category: 'unknown_fallback',
        attempts: [expect.objectContaining({ category: 'malformed_thrown_value', role: 'primary' })],
      }),
    });
  });

  it('classifies stall timeout as terminal structured metadata', async () => {
    vi.useFakeTimers();
    try {
      let resolvePrompt: (() => void) | undefined;
      const { promise } = await runStructuredSession(() => ({
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => new Promise<void>((resolve) => { resolvePrompt = resolve; })),
        abort: vi.fn(async () => { resolvePrompt?.(); }),
        messages: [],
        dispose: vi.fn(async () => undefined),
      }), { config: { ...config, stall_timeout_ms: 20 }, ctx: { model: undefined } });
      const rejection = promise.catch((error) => error);
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(600);
      const error = await rejection;
      expect(error.error_metadata).toMatchObject({
        version: 1,
        category: 'unknown_fallback',
        attempts: [expect.objectContaining({ category: 'stall_timeout', phase: 'runner_session', role: 'primary' })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes empty response variants and tool failure vs recovery', async () => {
    const noTools = await runStructuredSession(() => ({
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      messages: [],
      dispose: vi.fn(async () => undefined),
    }), { ctx: { model: undefined } });
    await expect(noTools.promise).rejects.toMatchObject({
      error_metadata: expect.objectContaining({
        category: 'unknown_fallback',
        attempts: [expect.objectContaining({ category: 'empty_response_no_tools', role: 'primary' })],
      }),
    });

    let subscriberAfterTools: ((event: unknown) => void) | undefined;
    const afterTools = await runStructuredSession(() => ({
      subscribe: vi.fn((callback: (event: unknown) => void) => { subscriberAfterTools = callback; return vi.fn(); }),
      prompt: vi.fn(async () => {
        subscriberAfterTools?.({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'file' } });
        subscriberAfterTools?.({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'body' }] } });
      }),
      messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'file' } }] }],
      dispose: vi.fn(async () => undefined),
    }), { ctx: { model: undefined } });
    await expect(afterTools.promise).rejects.toMatchObject({
      error_metadata: expect.objectContaining({
        category: 'unknown_fallback',
        attempts: [expect.objectContaining({ category: 'empty_response_after_tools', role: 'primary' })],
      }),
    });

    let subscriberToolFailure: ((event: unknown) => void) | undefined;
    const toolFailure = await runStructuredSession(() => ({
      subscribe: vi.fn((callback: (event: unknown) => void) => { subscriberToolFailure = callback; return vi.fn(); }),
      prompt: vi.fn(async () => {
        subscriberToolFailure?.({ type: 'tool_execution_start', toolCallId: 'read-2', toolName: 'read', args: { path: 'secret.txt' } });
        subscriberToolFailure?.({ type: 'tool_execution_end', toolCallId: 'read-2', toolName: 'read', isError: true, result: { content: [{ type: 'text', text: 'Authorization: Bearer sk-hidden SECRET_FILE_BODY /tmp/private.txt' }] } });
      }),
      messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'read-2', name: 'read', arguments: { path: 'secret.txt' } }] }],
      dispose: vi.fn(async () => undefined),
    }), { ctx: { model: undefined } });
    await expect(toolFailure.promise).rejects.toMatchObject({
      error_metadata: expect.objectContaining({
        category: 'unknown_fallback',
        attempts: [expect.objectContaining({ category: 'tool_failure', phase: 'tool_execution', role: 'primary' })],
      }),
    });
    await toolFailure.promise.catch((error) => {
      expect(error.error_metadata.attempts).toHaveLength(1);
      expect(error.error_metadata.attempts[0].details?.tool_names).toContain('read');
      expect(JSON.stringify(error.error_metadata)).not.toContain('sk-hidden');
      expect(JSON.stringify(error.error_metadata)).not.toContain('SECRET_FILE_BODY');
      expect(JSON.stringify(error.error_metadata)).not.toContain('/tmp/private.txt');
    });

    let subscriberRecovered: ((event: unknown) => void) | undefined;
    const recovered = await runStructuredSession(() => ({
      subscribe: vi.fn((callback: (event: unknown) => void) => { subscriberRecovered = callback; return vi.fn(); }),
      prompt: vi.fn(async () => {
        subscriberRecovered?.({ type: 'tool_execution_start', toolCallId: 'read-3', toolName: 'read', args: { path: 'file' } });
        subscriberRecovered?.({ type: 'tool_execution_end', toolCallId: 'read-3', toolName: 'read', isError: true, result: { content: [{ type: 'text', text: 'tool failed' }] } });
      }),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'recovered final answer' }] }],
      dispose: vi.fn(async () => undefined),
    }));
    const recoveredResult = await recovered.promise;
    expect(recoveredResult.result).toBe('recovered final answer');
    expect(recoveredResult).not.toHaveProperty('error_metadata');
  });

  it('preserves primary and fallback failures in bounded attempts and clears terminal metadata on fallback success', async () => {
    vi.resetModules();
    const primaryModel = { provider: 'preferred', id: 'primary-model' };
    const fallbackModel = { provider: 'current', id: 'fallback-model' };
    const createAgentSession = vi.fn()
      .mockReturnValueOnce({ session: { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(async () => { throw new Error('ECONNRESET primary network failure'); }), messages: [], dispose: vi.fn(async () => undefined) } })
      .mockReturnValueOnce({ session: { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(async () => { throw new Error('429 fallback quota exceeded'); }), messages: [], dispose: vi.fn(async () => undefined) } })
      .mockReturnValueOnce({ session: { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(async () => { throw new Error('ECONNRESET primary network failure'); }), messages: [], dispose: vi.fn(async () => undefined) } })
      .mockReturnValueOnce({ session: { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(async () => undefined), messages: [{ role: 'assistant', content: [{ type: 'text', text: 'fallback recovered' }] }], dispose: vi.fn(async () => undefined) } });
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession,
    }));
    const { sdkSubagentRunner } = await import('../src/runner.js');
    const sliceConfig: SubagentsConfig = {
      ...config,
      model_profiles: { 'sdd-apply': { model: { provider: 'preferred', id: 'primary-model' } } },
    };
    const ctx = {
      model: fallbackModel,
      modelRegistry: { find: vi.fn((provider: string, id: string) => provider === 'preferred' && id === 'primary-model' ? primaryModel : undefined) },
      ui: { notify: vi.fn() },
    };

    const failedPromise = sdkSubagentRunner({
      definition,
      task: 'runner fallback failure',
      cwd: '/workspace',
      ctx,
      config: sliceConfig,
      signal: new AbortController().signal,
    });
    await expect(failedPromise).rejects.toMatchObject({
      error_metadata: expect.objectContaining({
        category: 'fallback_failed',
        attempts: [
          expect.objectContaining({ role: 'primary', category: 'provider_network_error' }),
          expect.objectContaining({ role: 'fallback', category: 'provider_rate_limit' }),
        ],
      }),
    });

    const recoveredResult = await sdkSubagentRunner({
      definition,
      task: 'runner fallback success',
      cwd: '/workspace',
      ctx,
      config: sliceConfig,
      signal: new AbortController().signal,
    });
    expect(recoveredResult).toMatchObject({ result: 'fallback recovered', fallback_used: true });
    expect(recoveredResult).not.toHaveProperty('error_metadata');
  });

  it('wraps a primary failure as unknown_fallback when current model matches preferred', async () => {
    vi.resetModules();
    const sharedModel = { provider: 'preferred', id: 'primary-model' };
    const createAgentSession = vi.fn()
      .mockReturnValueOnce({ session: { subscribe: vi.fn(() => vi.fn()), prompt: vi.fn(async () => { throw new Error('ECONNRESET primary network failure'); }), messages: [], dispose: vi.fn(async () => undefined) } });
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession,
    }));
    const { sdkSubagentRunner } = await import('../src/runner.js');
    const sliceConfig: SubagentsConfig = {
      ...config,
      model_profiles: { 'sdd-apply': { model: { provider: 'preferred', id: 'primary-model' } } },
    };

    const failedPromise = sdkSubagentRunner({
      definition,
      task: 'runner no distinct fallback failure',
      cwd: '/workspace',
      ctx: {
        model: sharedModel,
        modelRegistry: { find: vi.fn((provider: string, id: string) => provider === 'preferred' && id === 'primary-model' ? sharedModel : undefined) },
        ui: { notify: vi.fn() },
      },
      config: sliceConfig,
      signal: new AbortController().signal,
    });

    await expect(failedPromise).rejects.toMatchObject({
      error_metadata: expect.objectContaining({
        category: 'unknown_fallback',
        attempts: [expect.objectContaining({ role: 'primary', category: 'provider_network_error' })],
      }),
    });
    await failedPromise.catch((error) => {
      expect(error.error_metadata.attempts).toHaveLength(1);
      expect(error.error_metadata.attempts[0]).toMatchObject({
        role: 'primary',
        category: 'provider_network_error',
        source: expect.objectContaining({ model: 'preferred/primary-model' }),
      });
    });
  });
});

describe('subagent runner thread snapshots', () => {
  const definition: SubagentDefinition = {
    name: 'sdd-apply',
    description: 'implementation executor',
    filePath: '/tmp/sdd-apply.md',
    instructions: 'return a concise result',
    tools: ['bash', 'memory_search', 'custom_tool'],
  };
  const config: SubagentsConfig = {
    timeout_ms: 10_000,
    stall_timeout_ms: 10_000,
    max_concurrency: 1,
    default_tools: ['bash', 'memory_search', 'custom_tool'],
    model_profiles: {},
  };

  async function runWithSession(session: any, cwd = '/workspace') {
    vi.resetModules();
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));
    const { sdkSubagentRunner } = await import('../src/runner.js');
    const activities: any[] = [];
    const result = await sdkSubagentRunner({
      definition,
      task: 'capture a thread snapshot',
      cwd,
      ctx: { model: { provider: 'test', id: 'model' } },
      config,
      signal: new AbortController().signal,
      onActivity: (activity) => activities.push(activity),
    });
    return { result, activities };
  }

  it('emits and returns bounded snapshots for assistant text, paired bash output, tool errors, and custom fallback tools without changing result or usage', async () => {
    const largeOutput = 'x'.repeat(6000);
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { delta: 'streamed ' } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'printf hello' } });
        subscriber?.({ type: 'tool_execution_update', toolCallId: 'bash-1', toolName: 'bash', partialResult: { output: 'hello\n' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'bash-1', toolName: 'bash', isError: false, result: { output: largeOutput, exitCode: 0 } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'mem-1', toolName: 'memory_search', args: { query: 'prior decisions' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'mem-1', toolName: 'memory_search', isError: true, result: { content: [{ type: 'text', text: 'memory unavailable' }] } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'custom-1', toolName: 'custom_tool', args: { value: 42 } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'custom-1', toolName: 'custom_tool', isError: false, result: { text: 'custom result' } });
      }),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }],
      dispose: vi.fn(async () => undefined),
    };

    const { result, activities } = await runWithSession(session);

    expect(result.result).toBe('final answer');
    expect(result.usage).toMatchObject({ input: 0, output: 0, turns: 0 });
    expect(activities.some((activity) => activity.thread_snapshot?.items?.length > 0)).toBe(true);
    expect(result.thread_snapshot).toMatchObject({ version: 1, source: 'mixed' });
    expect(result.thread_snapshot?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [expect.objectContaining({ type: 'text', text: 'final answer' })] }) }),
      expect.objectContaining({ type: 'bash', tool_call_id: 'bash-1', command: 'printf hello', status: 'completed' }),
      expect.objectContaining({ type: 'tool', tool_call_id: 'mem-1', name: 'memory_search', status: 'failed', result: expect.objectContaining({ isError: true, preview: expect.stringContaining('memory unavailable') }) }),
      expect.objectContaining({ type: 'tool', tool_call_id: 'custom-1', name: 'custom_tool', status: 'completed', result: expect.objectContaining({ preview: expect.stringContaining('custom result') }) }),
    ]));
    const bashItem = result.thread_snapshot?.items.find((item: any) => item.type === 'bash') as any;
    expect(bashItem.output.length).toBeLessThan(4500);
    expect(bashItem.truncated).toBe(true);
  });

  it('fails stalled tool sessions instead of returning streamed tool-call json as the final result', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    let subscriber: ((event: unknown) => void) | undefined;
    let resolvePrompt: (() => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { delta: '{"path":"openspec/changes/websearch-extension/spec.md"}' } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'openspec/changes/websearch-extension/spec.md' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'spec body' }] } });
        return new Promise<void>((resolve) => { resolvePrompt = resolve; });
      }),
      abort: vi.fn(async () => { resolvePrompt?.(); }),
      messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'openspec/changes/websearch-extension/spec.md' } }] }],
      dispose: vi.fn(async () => undefined),
    };
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));

    try {
      const { sdkSubagentRunner } = await import('../src/runner.js');
      const promise = sdkSubagentRunner({
        definition,
        task: 'apply work that stalls after tools',
        cwd: '/workspace',
        ctx: { model: { provider: 'test', id: 'model' } },
        config: { ...config, stall_timeout_ms: 20 },
        signal: new AbortController().signal,
      });
      const rejection = promise.then(
        () => undefined,
        (error) => error,
      );

      await vi.dynamicImportSettled();
      expect(session.prompt).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(600);
      const error = await rejection;
      expect(error).toBeInstanceOf(Error);
      expect(error.error_metadata).toMatchObject({
        category: 'unknown_fallback',
        attempts: [expect.objectContaining({ category: 'stall_timeout', phase: 'runner_session', role: 'primary' })],
      });
      expect(session.abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs when streamed raw tool-call json is dropped from live thread snapshots', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { delta: '{"query":"subagent renderer raw tool json","limit":3}' } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'mem-1', toolName: 'memory_search', args: { query: 'subagent renderer raw tool json', limit: 3 } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'mem-1', toolName: 'memory_search', isError: false, result: { content: [{ type: 'text', text: 'Found 3 memory result(s).' }] } });
      }),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }],
      dispose: vi.fn(async () => undefined),
    };

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-runner-json-'));
    fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.pi', 'subagents.json'), JSON.stringify({ debug: true }));
    try {
      const { activities } = await runWithSession(session, cwd);
      const afterToolStart = activities.find((activity) => activity.message === 'memory_search');
      expect(afterToolStart?.thread_snapshot).toBeDefined();
      const visibleAssistantText = afterToolStart?.thread_snapshot?.items
        .filter((item: any) => item.type === 'assistant')
        .flatMap((item: any) => item.message.content.map((part: any) => part.text ?? part.thinking ?? ''))
        .join('\n') ?? '';
      expect(visibleAssistantText).not.toContain('{"query"');
      expect(afterToolStart?.thread_snapshot?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool', name: 'memory_search', status: 'running', arguments: expect.objectContaining({ query: 'subagent renderer raw tool json' }) }),
      ]));
      const log = fs.readFileSync(path.join(cwd, '.pi', 'subagents-debug.log'), 'utf8');
      expect(log).toContain('live_raw_tool_json_dropped');
      expect(log).toContain('memory_search');
      expect(log).toContain('query');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('interleaves final session tool-call messages with matching tool rows before final assistant text', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'AGENTS.md' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: '# Agent Guide' }] } });
      }),
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'AGENTS.md' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'final after tools' }] },
      ],
      dispose: vi.fn(async () => undefined),
    };

    const { result } = await runWithSession(session);
    const labels = result.thread_snapshot?.items.map((item: any) => item.type === 'assistant'
      ? `assistant:${item.message.content.map((part: any) => part.type === 'toolCall' ? `toolCall:${part.name}` : part.text).join('|')}`
      : `${item.type}:${item.name}`);

    expect(labels).toEqual(['user:undefined', 'assistant:toolCall:read', 'tool:read', 'assistant:final after tools']);
    expect(result.thread_snapshot?.items[0]).toMatchObject({ type: 'user', label: 'delegated_task' });
    expect(JSON.stringify(result.thread_snapshot)).toContain('# Agent Guide');
  });

  it('persists streamed model thinking in sequence with tool rows in the final thread snapshot', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'first reasoning before reading' } });
        subscriber?.({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'AGENTS.md' } });
        subscriber?.({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: '# Agent Guide' }] } });
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'second reasoning after reading' } });
      }),
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'AGENTS.md' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'final answer after sequential thinking' }] },
      ],
      dispose: vi.fn(async () => undefined),
    };

    const { result } = await runWithSession(session);
    const labels = result.thread_snapshot?.items.map((item: any) => {
      if (item.type === 'assistant') return `assistant:${item.message.content.map((part: any) => part.type === 'thinking' ? `thinking:${part.thinking}` : part.type === 'toolCall' ? `toolCall:${part.name}` : `text:${part.text}`).join('|')}`;
      if (item.type === 'tool') return `tool:${item.name}`;
      return `${item.type}:${item.label}`;
    });

    expect(labels).toEqual([
      'user:delegated_task',
      'assistant:thinking:first reasoning before reading',
      'assistant:toolCall:read',
      'tool:read',
      'assistant:thinking:second reasoning after reading',
      'assistant:text:final answer after sequential thinking',
    ]);
  });

  it('preserves streamed model thinking in the final thread snapshot when final messages omit it', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking through the file plan' } });
        subscriber?.({ type: 'message_update', assistantMessageEvent: { delta: 'draft text that should not replace final' } });
      }),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final answer after thinking' }] }],
      dispose: vi.fn(async () => undefined),
    };

    const { result, activities } = await runWithSession(session);

    expect(activities.find((activity) => activity.message === 'streaming thinking')?.thread_snapshot?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [expect.objectContaining({ type: 'thinking', thinking: expect.stringContaining('thinking through the file plan') })] }) }),
    ]));
    expect(result.result).toBe('final answer after thinking');
    expect(result.thread_snapshot?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [expect.objectContaining({ type: 'thinking', thinking: expect.stringContaining('thinking through the file plan') })] }) }),
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [expect.objectContaining({ type: 'text', text: 'final answer after thinking' })] }) }),
    ]));
    expect(JSON.stringify(result.thread_snapshot)).not.toContain('draft text that should not replace final');
  });

  it('finalizes assistant text from session messages when available while preserving streamed activity snapshots', async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscriber = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: 'message_update', assistantMessageEvent: { delta: 'draft text' } });
      }),
      messages: [{ role: 'assistant', content: 'final from messages' }],
      dispose: vi.fn(async () => undefined),
    };

    const { result, activities } = await runWithSession(session);

    expect(activities.find((activity) => activity.message === 'streaming response')?.thread_snapshot?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant' }),
    ]));
    expect(result.result).toBe('final from messages');
    expect(result.thread_snapshot?.source).toBe('session_messages');
    expect(JSON.stringify(result.thread_snapshot)).toContain('final from messages');
  });
});
