#!/usr/bin/env node
import { existsSync as nodeExistsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VIEWER_SCOPE = {
  CURRENT_SESSION: 'current-session',
  CURRENT_SESSION_UNAVAILABLE: 'current-session-unavailable',
};

const STATE_KIND = {
  CURRENT_SESSION_UNAVAILABLE: 'current-session-unavailable',
  MISSING_HISTORY: 'missing-history',
  CURRENT_SESSION_PLACEHOLDER: 'current-session-placeholder',
};

function readOptionPairs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options.set(key, '');
      continue;
    }
    options.set(key, next);
    index += 1;
  }
  return options;
}

export function parseViewerArgs(argv = []) {
  const options = readOptionPairs(argv);
  const errors = [];
  const cwd = options.get('cwd') ?? '';
  const dbPath = options.get('db') ?? '';
  const scope = options.get('scope') ?? '';
  const sessionId = options.get('session-id') || undefined;
  const refreshValue = Number(options.get('refresh-ms') ?? '1000');
  const refreshMs = Number.isFinite(refreshValue) && refreshValue > 0 ? Math.trunc(refreshValue) : 1000;

  if (!cwd) errors.push('missing --cwd');
  if (!dbPath) errors.push('missing --db');
  if (scope !== VIEWER_SCOPE.CURRENT_SESSION && scope !== VIEWER_SCOPE.CURRENT_SESSION_UNAVAILABLE) {
    errors.push('missing or invalid --scope');
  }
  if (scope === VIEWER_SCOPE.CURRENT_SESSION && !sessionId) {
    errors.push('current-session scope requires --session-id');
  }

  return {
    errors,
    config: { cwd, dbPath, scope, sessionId, refreshMs },
  };
}

export function createInitialViewerState(config, io = {}) {
  if (config.scope === VIEWER_SCOPE.CURRENT_SESSION_UNAVAILABLE) {
    return {
      kind: STATE_KIND.CURRENT_SESSION_UNAVAILABLE,
      config,
    };
  }

  const existsSync = io.existsSync ?? nodeExistsSync;
  if (!existsSync(config.dbPath)) {
    return {
      kind: STATE_KIND.MISSING_HISTORY,
      config,
    };
  }

  return {
    kind: STATE_KIND.CURRENT_SESSION_PLACEHOLDER,
    config,
  };
}

function scopeLabel(config) {
  if (config.scope === VIEWER_SCOPE.CURRENT_SESSION && config.sessionId) return `current session ${config.sessionId}`;
  return 'current session unavailable';
}

export function renderViewerState(state) {
  const lines = [
    'Pi Subagents — read-only persisted history viewer',
    `scope: ${scopeLabel(state.config)}`,
    'READ-ONLY · persisted history · current session only · prompts/results may be visible in this window',
    '',
  ];

  if (state.kind === STATE_KIND.CURRENT_SESSION_UNAVAILABLE) {
    lines.push(
      'Current Pi session is unavailable.',
      'Fail-closed: persisted history was not queried.',
      'Use /subagents in the main Pi session for in-session viewing.',
    );
    return lines;
  }

  if (state.kind === STATE_KIND.MISSING_HISTORY) {
    lines.push(
      'No subagent history database found yet.',
      'The viewer did not create history files or tables.',
      `Refresh interval: ${state.config.refreshMs}ms`,
    );
    return lines;
  }

  lines.push(
    'Current-session history rendering is not available yet in this bootstrap.',
    'The read-only SQLite query layer is intentionally deferred to the next slice.',
    `Refresh interval: ${state.config.refreshMs}ms`,
  );
  return lines;
}

function shouldExitForInput(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  return text === 'q' || text === '\u001b' || text === '\u0003';
}

export function keepInteractiveViewerAlive(io = {}) {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin?.isTTY) return { interactive: false, stop() {} };

  let stopped = false;
  const setRawMode = (enabled) => {
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(enabled);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stdin.off?.('data', onData);
    stdin.off?.('close', stop);
    stdin.off?.('end', stop);
    setRawMode(false);
    stdin.pause?.();
  };
  const onData = (chunk) => {
    if (shouldExitForInput(chunk)) stop();
  };

  stdin.on?.('data', onData);
  stdin.once?.('close', stop);
  stdin.once?.('end', stop);
  setRawMode(true);
  stdin.resume?.();

  return { interactive: true, stop };
}

export function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const parsed = parseViewerArgs(argv);
  if (parsed.errors.length > 0) {
    stderr.write(`Invalid /subagents-terminal viewer arguments:\n${parsed.errors.map((error) => `- ${error}`).join('\n')}\n`);
    return 2;
  }
  const state = createInitialViewerState(parsed.config, io);
  stdout.write(`${renderViewerState(state).join('\n')}\n`);
  keepInteractiveViewerAlive(io);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runCli();
}
