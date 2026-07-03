import { accessSync, constants, existsSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

const VIEWER_SCOPE = {
  CURRENT_SESSION: 'current-session',
  CURRENT_SESSION_UNAVAILABLE: 'current-session-unavailable',
} as const;

type ViewerScope = (typeof VIEWER_SCOPE)[keyof typeof VIEWER_SCOPE];

const LAUNCH_FAILURE_REASON = {
  KITTY_UNAVAILABLE: 'kitty-unavailable',
  VIEWER_MISSING: 'viewer-missing',
  SPAWN_FAILED: 'spawn-failed',
} as const;

const DEFAULT_IMMEDIATE_EXIT_MS = 250;

type LaunchFailureReason = (typeof LAUNCH_FAILURE_REASON)[keyof typeof LAUNCH_FAILURE_REASON];

const NODE_ENV_INJECTION_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_IMPORT',
  'NODE_PRELOAD',
  'NODE_REQUIRE',
  'NODE_LOADER',
  'NODE_CUSTOM_LOADER',
]);

const NODE_ENV_INJECTION_PATTERN = /^NODE_.*(?:IMPORT|PRELOAD|REQUIRE|LOADER)$/;

export type LaunchSubagentsTerminalViewerResult =
  | { ok: true }
  | { ok: false; reason: LaunchFailureReason; message: string };

export type BuildSubagentsTerminalViewerArgsOptions = {
  cwd: string;
  dbPath: string;
  viewerPath: string;
  sessionId?: string;
  refreshMs?: number;
  processExecPath?: string;
};

type AccessCheck = (file: string, mode?: number) => void;
type ExistsCheck = (file: string) => boolean;
type StatCheck = (file: string) => Pick<Stats, 'isFile'>;
type SpawnChild = Pick<ChildProcess, 'once' | 'unref'> & Partial<Pick<ChildProcess, 'off'>>;
type SpawnCheck = (command: string, args: string[], options: SpawnOptions) => SpawnChild;
type SpawnFailureResult = { ok: false; reason: typeof LAUNCH_FAILURE_REASON.SPAWN_FAILED; message: string };

export type LaunchSubagentsTerminalViewerOptions = BuildSubagentsTerminalViewerArgsOptions & {
  kittyExecutable?: string;
  env?: NodeJS.ProcessEnv;
  exists?: ExistsCheck;
  access?: AccessCheck;
  stat?: StatCheck;
  spawn?: SpawnCheck;
  onSpawnError?: (failure: { ok: false; reason: typeof LAUNCH_FAILURE_REASON.SPAWN_FAILED; message: string }) => void;
  immediateExitMs?: number;
};

function failure(reason: LaunchFailureReason, message: string): LaunchSubagentsTerminalViewerResult {
  return { ok: false, reason, message };
}

function spawnFailure(message: string): SpawnFailureResult {
  return { ok: false, reason: LAUNCH_FAILURE_REASON.SPAWN_FAILED, message };
}

function immediateExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
  if (typeof code === 'number') return `Failed to launch /subagents-terminal: Kitty exited immediately with code ${code}.`;
  if (signal) return `Failed to launch /subagents-terminal: Kitty exited immediately with signal ${signal}.`;
  return 'Failed to launch /subagents-terminal: Kitty exited immediately without an exit status.';
}

function waitForImmediateExitFailure(child: SpawnChild, immediateExitMs: number): Promise<SpawnFailureResult | undefined> {
  if (immediateExitMs <= 0 || typeof child.once !== 'function') return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      child.off?.('exit', onExit);
      child.off?.('close', onClose);
    };
    const finish = (result: SpawnFailureResult | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 && !signal) {
        finish(undefined);
        return;
      }
      finish(spawnFailure(immediateExitMessage(code, signal)));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => handleExit(code, signal);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => handleExit(code, signal);

    child.once('exit', onExit);
    child.once('close', onClose);
    timeout = setTimeout(() => finish(undefined), immediateExitMs);
  });
}

function canAccess(file: string, mode: number, access: AccessCheck): boolean {
  try {
    access(file, mode);
    return true;
  } catch {
    return false;
  }
}

function isRegularFile(file: string, stat: StatCheck): boolean {
  try {
    return stat(file).isFile();
  } catch {
    return false;
  }
}

function usableAbsoluteExecutable(candidate: string, exists: ExistsCheck, access: AccessCheck, stat: StatCheck): string | undefined {
  const normalized = path.normalize(candidate);
  return exists(normalized) && isRegularFile(normalized, stat) && canAccess(normalized, constants.X_OK, access) ? normalized : undefined;
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv, exists: ExistsCheck, access: AccessCheck, stat: StatCheck): string | undefined {
  if (path.isAbsolute(command)) return usableAbsoluteExecutable(command, exists, access, stat);
  if (command.includes(path.sep)) return undefined;

  const pathValue = env.PATH ?? '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    const executable = usableAbsoluteExecutable(candidate, exists, access, stat);
    if (executable) return executable;
  }
  return undefined;
}

export function scrubViewerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (NODE_ENV_INJECTION_KEYS.has(key) || NODE_ENV_INJECTION_PATTERN.test(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

function viewerScope(sessionId: string | undefined): ViewerScope {
  return sessionId ? VIEWER_SCOPE.CURRENT_SESSION : VIEWER_SCOPE.CURRENT_SESSION_UNAVAILABLE;
}

export function buildSubagentsTerminalViewerArgs(options: BuildSubagentsTerminalViewerArgsOptions): string[] {
  const refreshMs = options.refreshMs ?? 1000;
  const args = [
    '--class', 'pi-subagents-terminal-viewer',
    '--title', 'Pi Subagents',
    '--detach',
    '--directory', options.cwd,
    options.processExecPath ?? process.execPath,
    options.viewerPath,
    '--cwd', options.cwd,
    '--db', options.dbPath,
    '--scope', viewerScope(options.sessionId),
  ];
  if (options.sessionId) args.push('--session-id', options.sessionId);
  args.push('--refresh-ms', String(refreshMs));
  return args;
}

export async function launchSubagentsTerminalViewer(options: LaunchSubagentsTerminalViewerOptions): Promise<LaunchSubagentsTerminalViewerResult> {
  const exists = options.exists ?? existsSync;
  const access = options.access ?? accessSync;
  const stat = options.stat ?? statSync;
  const spawn = options.spawn ?? nodeSpawn;
  const env = options.env ?? process.env;

  if (!path.isAbsolute(options.viewerPath) || !exists(options.viewerPath) || !canAccess(options.viewerPath, constants.R_OK, access)) {
    return failure(
      LAUNCH_FAILURE_REASON.VIEWER_MISSING,
      'Subagents terminal viewer runtime is missing from the package. Reinstall or run package verification.',
    );
  }

  const kitty = resolveExecutable(options.kittyExecutable ?? 'kitty', env, exists, access, stat);
  if (!kitty) {
    return failure(
      LAUNCH_FAILURE_REASON.KITTY_UNAVAILABLE,
      'Kitty is required for /subagents-terminal in V1. Install Kitty or use /subagents inside Pi.',
    );
  }

  try {
    const child = spawn(kitty, buildSubagentsTerminalViewerArgs(options), {
      cwd: options.cwd,
      shell: false,
      stdio: 'ignore',
      detached: true,
      env: scrubViewerEnv(env),
    });
    child.once?.('error', (error: Error) => {
      options.onSpawnError?.(spawnFailure(`Failed to launch /subagents-terminal: ${error.message}`));
    });
    const immediateExitFailure = await waitForImmediateExitFailure(child, options.immediateExitMs ?? DEFAULT_IMMEDIATE_EXIT_MS);
    if (immediateExitFailure) return immediateExitFailure;
    child.unref?.();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return spawnFailure(`Failed to launch /subagents-terminal: ${message}`);
  }
}
