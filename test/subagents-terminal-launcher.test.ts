import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import {
  buildSubagentsTerminalViewerArgs,
  launchSubagentsTerminalViewer,
  scrubViewerEnv,
  type LaunchSubagentsTerminalViewerOptions,
  type LaunchSubagentsTerminalViewerResult,
} from '../src/terminal-launcher.js';

const cwd = '/tmp/pi project; rm -rf nope';
const dbPath = '/tmp/pi data/subagents "history".sqlite';
const viewerPath = '/tmp/pi package/bin/subagents-terminal-viewer.mjs';
const kittyPath = '/usr/bin/kitty';
const nodePath = '/usr/bin/node';

type FailureResult = Extract<LaunchSubagentsTerminalViewerResult, { ok: false }>;

function expectFailure(result: LaunchSubagentsTerminalViewerResult): asserts result is FailureResult {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected launcher failure');
}

const regularFileStat: NonNullable<LaunchSubagentsTerminalViewerOptions['stat']> = () => ({ isFile: () => true });

describe('subagents terminal launcher', () => {
  it('builds Kitty argv as data and keeps shell execution disabled', () => {
    const args = buildSubagentsTerminalViewerArgs({
      cwd,
      dbPath,
      viewerPath,
      sessionId: 'session "quoted"; $(bad)',
      refreshMs: 2500,
      processExecPath: nodePath,
    });

    expect(args).toEqual([
      '--class', 'pi-subagents-terminal-viewer',
      '--title', 'Pi Subagents',
      '--detach',
      '--directory', cwd,
      nodePath,
      viewerPath,
      '--cwd', cwd,
      '--db', dbPath,
      '--scope', 'current-session',
      '--session-id', 'session "quoted"; $(bad)',
      '--refresh-ms', '2500',
    ]);
    expect(args).toContain(cwd);
    expect(args).toContain(dbPath);
    expect(args).toContain('session "quoted"; $(bad)');
  });

  it('spawns Kitty non-blocking with process.execPath, scrubbed env, and child unref', async () => {
    const unref = vi.fn();
    const spawnCalls: Array<[string, string[], SpawnOptions]> = [];
    const spawn: NonNullable<LaunchSubagentsTerminalViewerOptions['spawn']> = (command, args, options) => {
      spawnCalls.push([command, args, options]);
      return { unref, once: vi.fn() } as ReturnType<NonNullable<LaunchSubagentsTerminalViewerOptions['spawn']>>;
    };

    const result = await launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      sessionId: 'session-1',
      refreshMs: 1000,
      immediateExitMs: 0,
      kittyExecutable: kittyPath,
      processExecPath: nodePath,
      env: {
        PATH: '/usr/bin',
        NODE_OPTIONS: '--import ./evil.mjs --require ./evil.cjs',
        NODE_PATH: '/tmp/evil-node-path',
        NODE_EXTRA_IMPORT: './evil.mjs',
        NODE_PRELOAD: './evil.cjs',
        NODE_LOADER: './evil-loader.mjs',
        SAFE_VALUE: 'kept',
      },
      exists: (file) => file === viewerPath || file === kittyPath,
      access: () => undefined,
      stat: regularFileStat,
      spawn,
    });

    expect(result).toEqual({ ok: true });
    expect(spawnCalls).toHaveLength(1);
    const [command, args, spawnOptions] = spawnCalls[0]!;
    expect(command).toBe(kittyPath);
    expect(args).toEqual(buildSubagentsTerminalViewerArgs({ cwd, dbPath, viewerPath, sessionId: 'session-1', refreshMs: 1000, processExecPath: nodePath }));
    expect(spawnOptions).toMatchObject({ cwd, shell: false, stdio: 'ignore', detached: true });
    expect(spawnOptions.env).toMatchObject({ PATH: '/usr/bin', SAFE_VALUE: 'kept' });
    expect(spawnOptions.env?.NODE_OPTIONS).toBeUndefined();
    expect(spawnOptions.env?.NODE_PATH).toBeUndefined();
    expect(spawnOptions.env?.NODE_EXTRA_IMPORT).toBeUndefined();
    expect(spawnOptions.env?.NODE_PRELOAD).toBeUndefined();
    expect(spawnOptions.env?.NODE_LOADER).toBeUndefined();
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('passes fail-closed current-session-unavailable scope when no session id exists', () => {
    const args = buildSubagentsTerminalViewerArgs({
      cwd,
      dbPath,
      viewerPath,
      refreshMs: 1000,
      processExecPath: nodePath,
    });

    expect(args).toContain('--scope');
    expect(args[args.indexOf('--scope') + 1]).toBe('current-session-unavailable');
    expect(args).not.toContain('--session-id');
  });

  it('skips relative PATH entries before resolving Kitty from an absolute PATH directory', async () => {
    const spawnCalls: Array<[string, string[], SpawnOptions]> = [];
    const result = await launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      processExecPath: nodePath,
      immediateExitMs: 0,
      env: { PATH: `.${path.delimiter}/usr/bin` },
      exists: (file) => file === viewerPath || file === 'kitty' || file === kittyPath,
      access: () => undefined,
      stat: regularFileStat,
      spawn: (command, args, options) => {
        spawnCalls.push([command, args, options]);
        return { unref: vi.fn(), once: vi.fn() } as ReturnType<NonNullable<LaunchSubagentsTerminalViewerOptions['spawn']>>;
      },
    });

    expect(result).toEqual({ ok: true });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]).toBe(kittyPath);
  });

  it('skips empty PATH segments instead of resolving Kitty from the current directory', async () => {
    const spawnCalls: Array<[string, string[], SpawnOptions]> = [];
    const result = await launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      processExecPath: nodePath,
      immediateExitMs: 0,
      env: { PATH: `${path.delimiter}/usr/bin` },
      exists: (file) => file === viewerPath || file === 'kitty' || file === kittyPath,
      access: () => undefined,
      stat: regularFileStat,
      spawn: (command, args, options) => {
        spawnCalls.push([command, args, options]);
        return { unref: vi.fn(), once: vi.fn() } as ReturnType<NonNullable<LaunchSubagentsTerminalViewerOptions['spawn']>>;
      },
    });

    expect(result).toEqual({ ok: true });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]).toBe(kittyPath);
  });

  it('skips executable directories on PATH before resolving Kitty from a regular executable file', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'pi-kitty-path-'));

    try {
      const configDirectory = path.join(tempRoot, '.config');
      const directoryKitty = path.join(configDirectory, 'kitty');
      const binDirectory = path.join(tempRoot, 'bin');
      const realKittyPath = path.join(binDirectory, 'kitty');
      const realViewerPath = path.join(tempRoot, 'subagents-terminal-viewer.mjs');
      const spawnCalls: Array<[string, string[], SpawnOptions]> = [];

      mkdirSync(directoryKitty, { recursive: true });
      mkdirSync(binDirectory, { recursive: true });
      writeFileSync(realKittyPath, '#!/bin/sh\nexit 0\n');
      chmodSync(realKittyPath, 0o755);
      writeFileSync(realViewerPath, '');

      const result = await launchSubagentsTerminalViewer({
        cwd: tempRoot,
        dbPath,
        viewerPath: realViewerPath,
        processExecPath: nodePath,
        immediateExitMs: 0,
        env: { PATH: `${configDirectory}${path.delimiter}${binDirectory}` },
        spawn: (command, args, options) => {
          spawnCalls.push([command, args, options]);
          return { unref: vi.fn(), once: vi.fn() } as ReturnType<NonNullable<LaunchSubagentsTerminalViewerOptions['spawn']>>;
        },
      });

      expect(result).toEqual({ ok: true });
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.[0]).toBe(realKittyPath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects custom absolute Kitty executable paths that point to directories before spawning', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'pi-kitty-custom-'));

    try {
      const directoryKitty = path.join(tempRoot, 'kitty');
      const realViewerPath = path.join(tempRoot, 'subagents-terminal-viewer.mjs');
      const spawn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() } as ReturnType<NonNullable<LaunchSubagentsTerminalViewerOptions['spawn']>>));

      mkdirSync(directoryKitty, { recursive: true });
      writeFileSync(realViewerPath, '');

      const result = await launchSubagentsTerminalViewer({
        cwd: tempRoot,
        dbPath,
        viewerPath: realViewerPath,
        kittyExecutable: directoryKitty,
        processExecPath: nodePath,
        immediateExitMs: 0,
        spawn,
      });

      expectFailure(result);
      expect(result).toMatchObject({ reason: 'kitty-unavailable' });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects relative custom Kitty executable paths before spawning', async () => {
    const spawn = vi.fn();
    const result = await launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      kittyExecutable: path.join('tools', 'kitty'),
      processExecPath: nodePath,
      immediateExitMs: 0,
      exists: () => true,
      access: () => undefined,
      spawn,
    });

    expectFailure(result);
    expect(result).toMatchObject({ reason: 'kitty-unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns structured failures for missing or unexecutable Kitty without spawning', async () => {
    const spawn = vi.fn();
    const result = await launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      kittyExecutable: kittyPath,
      processExecPath: nodePath,
      immediateExitMs: 0,
      exists: (file) => file === viewerPath || file === kittyPath,
      access: (file) => {
        if (file === kittyPath) throw new Error('not executable');
      },
      stat: regularFileStat,
      spawn,
    });

    expectFailure(result);
    expect(result).toMatchObject({ reason: 'kitty-unavailable' });
    expect(result.message).toContain('Kitty is required');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns structured failures for a missing packaged viewer path', async () => {
    const result = await launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      kittyExecutable: kittyPath,
      processExecPath: nodePath,
      immediateExitMs: 0,
      exists: (file) => file === kittyPath,
      access: () => undefined,
      spawn: vi.fn(),
    });

    expectFailure(result);
    expect(result).toMatchObject({ reason: 'viewer-missing' });
    expect(result.message).toContain('viewer runtime is missing');
  });

  it('returns structured failures for synchronous spawn failures', async () => {
    const result = await launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      kittyExecutable: kittyPath,
      processExecPath: nodePath,
      immediateExitMs: 0,
      exists: () => true,
      access: () => undefined,
      stat: regularFileStat,
      spawn: () => { throw new Error('spawn exploded'); },
    });

    expectFailure(result);
    expect(result).toMatchObject({ reason: 'spawn-failed' });
    expect(result.message).toContain('spawn exploded');
  });

  it('returns a structured failure when Kitty exits non-zero during the immediate launch window', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    const resultPromise = launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      kittyExecutable: kittyPath,
      processExecPath: nodePath,
      immediateExitMs: 25,
      exists: () => true,
      access: () => undefined,
      stat: regularFileStat,
      spawn: (() => child as unknown as ReturnType<NonNullable<LaunchSubagentsTerminalViewerOptions['spawn']>>),
    });

    queueMicrotask(() => child.emit('exit', 1, null));
    const result = await resultPromise;

    expectFailure(result);
    expect(result).toMatchObject({ reason: 'spawn-failed' });
    expect(result.message).toContain('Kitty exited immediately with code 1');
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('treats an immediate zero exit from detached Kitty as a successful launch', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    const resultPromise = launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      kittyExecutable: kittyPath,
      processExecPath: nodePath,
      immediateExitMs: 25,
      exists: () => true,
      access: () => undefined,
      stat: regularFileStat,
      spawn: (() => child as unknown as ReturnType<NonNullable<LaunchSubagentsTerminalViewerOptions['spawn']>>),
    });

    queueMicrotask(() => child.emit('close', 0, null));
    const result = await resultPromise;

    expect(result).toEqual({ ok: true });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('reports immediate child process launch errors through the async error hook', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const onSpawnError = vi.fn();

    const result = await launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath,
      kittyExecutable: kittyPath,
      processExecPath: nodePath,
      immediateExitMs: 0,
      exists: () => true,
      access: () => undefined,
      stat: regularFileStat,
      spawn: (() => child as unknown as ReturnType<NonNullable<LaunchSubagentsTerminalViewerOptions['spawn']>>),
      onSpawnError,
    });

    child.emit('error', new Error('ENOENT after spawn'));

    expect(result).toEqual({ ok: true });
    expect(onSpawnError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'spawn-failed', message: expect.stringContaining('ENOENT after spawn') }));
  });

  it('scrubs Node runtime injection variables without mutating the parent env object', () => {
    const env = { PATH: '/bin', NODE_OPTIONS: '--loader ./bad.mjs', NODE_PATH: '/bad', NODE_CUSTOM_LOADER: 'bad', KEEP_ME: 'yes' };
    const scrubbed = scrubViewerEnv(env);

    expect(scrubbed).toEqual({ PATH: '/bin', KEEP_ME: 'yes' });
    expect(env.NODE_OPTIONS).toBe('--loader ./bad.mjs');
  });

  it('rejects relative viewer paths before spawning', async () => {
    const result = await launchSubagentsTerminalViewer({
      cwd,
      dbPath,
      viewerPath: path.join('bin', 'subagents-terminal-viewer.mjs'),
      kittyExecutable: kittyPath,
      processExecPath: nodePath,
      immediateExitMs: 0,
      exists: () => true,
      access: () => undefined,
      spawn: vi.fn(),
    });

    expectFailure(result);
    expect(result).toMatchObject({ reason: 'viewer-missing' });
  });
});
