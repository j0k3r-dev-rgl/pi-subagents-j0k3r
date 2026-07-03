import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadViewerModule() {
  return import(pathToFileURL(path.join(process.cwd(), 'bin/subagents-terminal-viewer.mjs')).href);
}

describe('subagents terminal viewer bootstrap', () => {
  it('parses fail-closed no-session scope and renders without touching history', async () => {
    const viewer = await loadViewerModule();
    const parsed = viewer.parseViewerArgs([
      '--cwd', '/tmp/project with spaces',
      '--db', '/tmp/history.sqlite',
      '--scope', 'current-session-unavailable',
      '--refresh-ms', '1000',
    ]);
    const existsSync = vi.fn(() => { throw new Error('DB existence should not be checked without a session'); });

    const state = viewer.createInitialViewerState(parsed.config, { existsSync });
    const rendered = viewer.renderViewerState(state).join('\n');

    expect(parsed.errors).toEqual([]);
    expect(state.kind).toBe('current-session-unavailable');
    expect(existsSync).not.toHaveBeenCalled();
    expect(rendered).toContain('Current Pi session is unavailable');
    expect(rendered).toContain('persisted history was not queried');
    expect(rendered).toContain('Use /subagents in the main Pi session');
    expect(rendered).toContain('READ-ONLY');
    expect(rendered).not.toContain('cwd-only');
  });

  it('requires session id for current-session scope instead of falling back to cwd history', async () => {
    const viewer = await loadViewerModule();
    const parsed = viewer.parseViewerArgs([
      '--cwd', '/tmp/project',
      '--db', '/tmp/history.sqlite',
      '--scope', 'current-session',
      '--refresh-ms', '1000',
    ]);

    expect(parsed.errors).toContain('current-session scope requires --session-id');
  });

  it('renders a read-only missing-history state without creating the database', async () => {
    const viewer = await loadViewerModule();
    const parsed = viewer.parseViewerArgs([
      '--cwd', '/tmp/project',
      '--db', '/tmp/missing-history.sqlite',
      '--scope', 'current-session',
      '--session-id', 'session-1',
      '--refresh-ms', '1000',
    ]);
    const existsSync = vi.fn(() => false);

    const state = viewer.createInitialViewerState(parsed.config, { existsSync });
    const rendered = viewer.renderViewerState(state).join('\n');

    expect(parsed.errors).toEqual([]);
    expect(existsSync).toHaveBeenCalledWith('/tmp/missing-history.sqlite');
    expect(state.kind).toBe('missing-history');
    expect(rendered).toContain('No subagent history database found yet');
    expect(rendered).toContain('current session session-1');
    expect(rendered).toContain('READ-ONLY');
  });

  it('renders a current-session bootstrap placeholder without broadening scope', async () => {
    const viewer = await loadViewerModule();
    const parsed = viewer.parseViewerArgs([
      '--cwd', '/tmp/project',
      '--db', '/tmp/existing-history.sqlite',
      '--scope', 'current-session',
      '--session-id', 'session-2',
      '--refresh-ms', '1500',
    ]);

    const state = viewer.createInitialViewerState(parsed.config, { existsSync: () => true });
    const rendered = viewer.renderViewerState(state).join('\n');

    expect(state.kind).toBe('current-session-placeholder');
    expect(rendered).toContain('current session session-2');
    expect(rendered).toContain('Current-session history rendering is not available yet');
    expect(rendered).not.toContain('same-cwd');
  });

  it('keeps an interactive TTY viewer alive until q, escape, or ctrl+c exits', async () => {
    const viewer = await loadViewerModule();
    const exitInputs = ['q', '\u001b', '\u0003'];
    expect(exitInputs).toHaveLength(3);

    for (const input of exitInputs) {
      const stdoutWrites: string[] = [];
      const stdin = new EventEmitter() as EventEmitter & {
        isTTY: boolean;
        setRawMode: ReturnType<typeof vi.fn>;
        resume: ReturnType<typeof vi.fn>;
        pause: ReturnType<typeof vi.fn>;
      };
      stdin.isTTY = true;
      stdin.setRawMode = vi.fn();
      stdin.resume = vi.fn();
      stdin.pause = vi.fn();

      const exitCode = viewer.runCli([
        '--cwd', '/tmp/project',
        '--db', '/tmp/history.sqlite',
        '--scope', 'current-session-unavailable',
        '--refresh-ms', '1000',
      ], {
        stdin,
        stdout: { write: (text: string) => { stdoutWrites.push(text); return true; } },
        stderr: { write: vi.fn() },
      });

      expect(exitCode).toBe(0);
      expect(stdoutWrites.join('')).toContain('Pi Subagents');
      expect(stdin.setRawMode).toHaveBeenCalledWith(true);
      expect(stdin.resume).toHaveBeenCalledTimes(1);
      expect(stdin.listenerCount('data')).toBe(1);

      stdin.emit('data', Buffer.from(input));

      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(stdin.pause).toHaveBeenCalledTimes(1);
      expect(stdin.listenerCount('data')).toBe(0);
    }
  });

  it('does not exit for arrow, page, home, or end escape sequences', async () => {
    const viewer = await loadViewerModule();
    const navigationInputs = ['\u001b[A', '\u001b[B', '\u001b[5~', '\u001b[6~', '\u001b[H', '\u001b[F'];
    expect(navigationInputs).toHaveLength(6);

    for (const input of navigationInputs) {
      const stdin = new EventEmitter() as EventEmitter & {
        isTTY: boolean;
        setRawMode: ReturnType<typeof vi.fn>;
        resume: ReturnType<typeof vi.fn>;
        pause: ReturnType<typeof vi.fn>;
      };
      stdin.isTTY = true;
      stdin.setRawMode = vi.fn();
      stdin.resume = vi.fn();
      stdin.pause = vi.fn();

      const keepalive = viewer.keepInteractiveViewerAlive({ stdin });
      expect(keepalive.interactive).toBe(true);
      expect(stdin.listenerCount('data')).toBe(1);

      stdin.emit('data', Buffer.from(input));

      expect(stdin.listenerCount('data')).toBe(1);
      expect(stdin.pause).not.toHaveBeenCalled();
      expect(stdin.setRawMode).not.toHaveBeenLastCalledWith(false);

      stdin.emit('data', Buffer.from('\u001b'));

      expect(stdin.listenerCount('data')).toBe(0);
      expect(stdin.pause).toHaveBeenCalledTimes(1);
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    }
  });

  it('cleans up interactive keepalive when stdin closes', async () => {
    const viewer = await loadViewerModule();
    const stdin = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    stdin.isTTY = true;
    stdin.setRawMode = vi.fn();
    stdin.resume = vi.fn();
    stdin.pause = vi.fn();

    const exitCode = viewer.runCli([
      '--cwd', '/tmp/project',
      '--db', '/tmp/history.sqlite',
      '--scope', 'current-session-unavailable',
    ], {
      stdin,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    expect(exitCode).toBe(0);
    expect(stdin.listenerCount('close')).toBe(1);

    stdin.emit('close');

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.pause).toHaveBeenCalledTimes(1);
    expect(stdin.listenerCount('close')).toBe(0);
  });
});
