import { describe, expect, it, vi } from 'vitest';
import type { SubagentDefinition, SubagentsConfig } from '../../src/types.js';

describe('subagent runner provider inheritance', () => {
  const definition: SubagentDefinition = {
    name: 'gentle-ai-explore',
    description: 'explorer',
    filePath: '/tmp/gentle-ai-explore.md',
    instructions: 'return a concise result',
    tools: ['read'],
  };
  const config: SubagentsConfig = {
    timeout_ms: 10_000,
    stall_timeout_ms: 10_000,
    max_concurrency: 1,
    default_tools: ['read'],
    model_profiles: { 'gentle-ai-explore': { model: { provider: 'claude-bridge', id: 'claude-sonnet-5' } } },
  };
  const model = { provider: 'claude-bridge', id: 'claude-sonnet-5' };

  async function run(options: { nestedHasProvider?: boolean; parent: Record<string, unknown> }) {
    vi.resetModules();
    const calls: string[] = [];
    const nestedRuntime = {
      getProvider: vi.fn(() => (options.nestedHasProvider ? { id: 'claude-bridge' } : undefined)),
      registerProvider: vi.fn(() => { calls.push('registerProvider'); }),
      registerNativeProvider: vi.fn(() => { calls.push('registerNativeProvider'); }),
    };
    const session = {
      modelRuntime: nestedRuntime,
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => {
        calls.push('prompt');
        throw new Error('stop after prompt');
      }),
      messages: [],
      dispose: vi.fn(async () => undefined),
    };
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: vi.fn(() => ({ session })),
    }));
    const { sdkSubagentRunner } = await import('../../src/runner.js');
    const ctx = {
      model: { provider: 'current', id: 'parent-model' },
      modelRegistry: {
        find: vi.fn((provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined)),
        ...options.parent,
      },
    };
    await sdkSubagentRunner({
      definition,
      task: 'inherit provider',
      cwd: '/workspace',
      ctx,
      config,
      signal: new AbortController().signal,
    }).catch(() => undefined);
    return { calls, nestedRuntime };
  }

  it('registers the parent provider config before prompting when the nested runtime lacks it', async () => {
    const providerConfig = { baseUrl: 'claude-bridge', apiKey: 'not-used', api: 'claude-bridge' };
    const { calls, nestedRuntime } = await run({
      parent: {
        getRegisteredNativeProvider: vi.fn(() => undefined),
        getRegisteredProviderConfig: vi.fn(() => providerConfig),
      },
    });
    expect(nestedRuntime.registerProvider).toHaveBeenCalledWith('claude-bridge', providerConfig);
    expect(calls.indexOf('registerProvider')).toBeLessThan(calls.indexOf('prompt'));
  });

  it('prefers the parent native provider when one is registered', async () => {
    const nativeProvider = { id: 'claude-bridge' };
    const { nestedRuntime } = await run({
      parent: {
        getRegisteredNativeProvider: vi.fn(() => nativeProvider),
        getRegisteredProviderConfig: vi.fn(() => ({ api: 'claude-bridge' })),
      },
    });
    expect(nestedRuntime.registerNativeProvider).toHaveBeenCalledWith(nativeProvider);
    expect(nestedRuntime.registerProvider).not.toHaveBeenCalled();
  });

  it('leaves providers the nested runtime already has untouched', async () => {
    const { nestedRuntime } = await run({
      nestedHasProvider: true,
      parent: {
        getRegisteredNativeProvider: vi.fn(() => ({ id: 'claude-bridge' })),
        getRegisteredProviderConfig: vi.fn(() => ({ api: 'claude-bridge' })),
      },
    });
    expect(nestedRuntime.registerNativeProvider).not.toHaveBeenCalled();
    expect(nestedRuntime.registerProvider).not.toHaveBeenCalled();
  });
});
