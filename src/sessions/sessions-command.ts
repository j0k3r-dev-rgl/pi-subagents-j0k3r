import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveSubagentsHistoryHome } from '../history.js';
import { loadPiSdkModule } from '../runner/pi-sdk-module.js';
import { SubagentSessionsSelector, type SessionSelectorKey } from './subagent-sessions-selector.js';
import { truncateToVisibleWidth, visibleWidth, truncateToWidth } from '../render/text-width.js';

/** Directory where the extension persists nested subagent Pi sessions. */
export function resolveNestedSessionsHome(): string {
  const home = path.join(resolveSubagentsHistoryHome(), 'sessions');
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try { chmodSync(home, 0o700); } catch {}
  } catch {}
  return home;
}

/** Best-effort debug log for the sessions selector. Append-only; safe to no-op. */

/** Semantic key -> Pi keybinding binding names + raw-byte fallbacks. */
const SESSION_KEY_BINDINGS: Record<SessionSelectorKey, string[]> = {
  up: ['tui.select.up', 'tui.editor.cursorUp'],
  down: ['tui.select.down', 'tui.editor.cursorDown'],
  pageUp: ['tui.select.pageUp', 'tui.editor.pageUp'],
  pageDown: ['tui.select.pageDown', 'tui.editor.pageDown'],
  home: ['tui.editor.cursorLineStart'],
  end: ['tui.editor.cursorLineEnd'],
  confirm: ['tui.select.confirm'],
  cancel: ['app.interrupt', 'tui.select.cancel'],
  scope: ['tui.input.tab'],
  toggleSort: ['app.session.toggleSort'],
  toggleNamed: ['app.session.toggleNamedFilter'],
  togglePath: ['app.session.togglePath'],
  delete: ['app.session.delete'],
  rename: ['app.session.rename'],
  view: [],
  backgroundRun: [],
  left: ['tui.editor.cursorLeft'],
  right: ['tui.editor.cursorRight'],
  deleteWord: ['tui.editor.deleteWordBackward'],
  clearLine: ['app.editor.deleteLine'],
};

const SESSION_KEY_RAW: Record<SessionSelectorKey, string[]> = {
  up: ['\u001b[A'],
  down: ['\u001b[B'],
  right: ['\u001b[C'],
  left: ['\u001b[D'],
  pageUp: ['\u001b[5~'],
  pageDown: ['\u001b[6~'],
  home: ['\u001b[H', '\u001b[1~', '\u001bOH'],
  end: ['\u001b[F', '\u001b[4~', '\u001bOF'],
  confirm: ['\r'],
  cancel: ['\u001b'],
  scope: ['\t'],
  toggleSort: ['\u0013'], // ctrl+s
  toggleNamed: ['\u000e'], // ctrl+n
  togglePath: ['\u0010'], // ctrl+p
  delete: ['\u0004'], // ctrl+d
  rename: ['\u0012'], // ctrl+r
  view: [' '], // space
  backgroundRun: ['\b', '\u001b[104;5u', '\u001b[8;5u'], // ctrl+h: legacy \b + CSI u (kitty: code 'h'=104, or BS code=8)
  clearLine: ['\u0015'], // ctrl+u
  deleteWord: ['\u0017'], // ctrl+w
};

export function createSessionSelectorKeyMatcher(keybindings?: { matches?: (data: string, keybinding: string) => boolean }) {
  return (data: string, key: SessionSelectorKey): boolean => {
    const bindings = SESSION_KEY_BINDINGS[key];
    if (bindings?.some((binding) => keybindings?.matches?.(data, binding))) return true;
    return SESSION_KEY_RAW[key]?.includes(data) ?? data === key;
  };
}

export interface SessionsCommandDeps {
  ctx: any;
  sdk?: () => Promise<any>;
  nestedSessionsDir?: string;
  /** Open the subagents history panel on a session (Space). Optional. */
  onViewSession?: (session: { path: string; cwd: string }) => Promise<void> | void;
  /** Continue a session in the background with a prompt collected in-selector
   * (Ctrl+H). Optional. The prompt is collected by the selector's prompt mode
   * (never via ctx.ui.input, which would orphan this selector's custom promise). */
  onBackgroundRunSession?: (session: { path: string; cwd: string }, prompt: string) => Promise<void> | void;
}

/**
 * Slash-command handler for `/subagents-sessions`.
 *
 * Opens a dedicated "Subagents Sessions" selector (Current Folder / All scope,
 * search, threaded/recent/fuzzy sort, name filter, delete) over the nested
 * subagent Pi sessions, and resumes the chosen one in the interactive session
 * via `ctx.switchSession(path)` — the same capability Pi's `/resume` uses.
 *
 * Resuming replaces the current main session with the chosen subagent session;
 * return to the parent session with `/resume`.
 */
export async function runSubagentsSessionsCommand(deps: SessionsCommandDeps): Promise<void> {
  const { ctx } = deps;
  const loadSdk = deps.sdk ?? loadPiSdkModule;
  const nestedSessionsDir = deps.nestedSessionsDir ?? resolveNestedSessionsHome();

  const notify = (message: string, type: 'info' | 'warning' | 'error' = 'info'): void => {
    ctx?.ui?.notify?.(message, type);
  };

  const cwd: string = ctx?.cwd ?? process.cwd();

  if (typeof ctx?.ui?.custom !== 'function') {
    notify('Subagent sessions browser is only available in interactive (TUI) mode', 'warning');
    return;
  }


  let sdk: any;
  try {
    sdk = await loadSdk();
  } catch (err) {
    notify(`Could not load Pi SDK: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return;
  }
  const { SessionManager } = sdk;
  if (!SessionManager || typeof SessionManager.list !== 'function' || typeof SessionManager.listAll !== 'function') {
    notify('This Pi runtime does not provide SessionManager', 'warning');
    return;
  }

  const currentLoader = (onProgress?: (loaded: number, total: number) => void) =>
    Promise.resolve(SessionManager.list(cwd, nestedSessionsDir, onProgress));
  const allLoader = (onProgress?: (loaded: number, total: number) => void) =>
    Promise.resolve(SessionManager.listAll(nestedSessionsDir, onProgress));

  /** Resume / prompt happen AFTER the custom component unmounts: each selector
   * action passes its result through `done`, `ctx.ui.custom` resolves (which runs
   * pi's restoreEditor → setFocus(editor) → component.dispose()), and only then
   * do we act. Acting inline (fire-and-forget) would race the session reload /
   * native prompt against the custom-component teardown, and collecting the
   * prompt in-selector left pi-tui's previous frame visible over the list. */
  type CommandResult =
    | { kind: 'select'; path: string }
    | { kind: 'backgroundRun'; session: { path: string; cwd: string } }

  for (;;) {
    const result: CommandResult | undefined = await ctx.ui.custom(
      (tui: any, theme: any, keybindings: any, done: (result: CommandResult | undefined) => void) => {
        const selector = new SubagentSessionsSelector({
          theme,
          matchesKey: createSessionSelectorKeyMatcher(keybindings),
          visibleWidth,
          truncateToWidth,
          truncateVisible: truncateToVisibleWidth,
          currentSessionsLoader: currentLoader,
          allSessionsLoader: allLoader,
          onSelect: (sessionPath: string) => {
            done({ kind: 'select', path: sessionPath });
          },
          onCancel: () => {
            done(undefined);
          },
          onView: (session: { path: string; cwd: string }) => {
            // No done(): keep the sessions list underneath so closing the preview
            // returns to it. The panel opens as an overlay on top.
            void deps.onViewSession?.(session);
          },
          onBackgroundRun: (session: { path: string; cwd: string }) => {
            // Close the selector first (done). The native prompt is opened AFTER the
            // selector unmounts, so no second custom component is mounted on top of
            // this one and no in-selector overlay is left for pi-tui to fail to
            // clear. If the user cancels the native prompt (Esc), the loop below
            // reopens this list — Esc on the prompt returns to the list, not to pi.
            done({ kind: 'backgroundRun', session });
          },
              renameSession: async (sessionPath: string, name: string | undefined) => {
                SessionManager.open(sessionPath).appendSessionInfo((name ?? '').trim());
              },
          requestRender: () => tui?.requestRender?.(),
          maxVisible: (() => {
            const termRows = tui?.rows ?? process.stdout.rows ?? 24;
            // Rendered in place of the editor (like /resume), framed by top/bottom
            // borders + spacers (~12 chrome rows). Cap the visible window so the
            // selector + chat both fit.
            return Math.max(4, Math.min(10, termRows - 16));
          })(),
        });
        return selector;
      },
      { overlay: false },
    );

    if (!result) {
      // Esc on the list → exit to pi.
      break;
    }
    if (result.kind === 'select') {
      await resume(ctx, result.path);
      break; // resumed a session → done
    }
    if (result.kind === 'backgroundRun') {
      // The selector is fully unmounted by now (restoreEditor + dispose ran
      // before this line), so opening pi's native input is safe.
      const prompt = await ctx.ui.input?.('Resume subagent session', 'prompt to resume the session');
      if (prompt && prompt.trim()) {
        await deps.onBackgroundRunSession?.(result.session, prompt.trim());
        break; // resumed -> done
      }
      // Empty / cancelled prompt: loop and reopen the list so Esc returns to
      // the list instead of dropping the user to pi.
      continue;
    }
  }
}

async function resume(ctx: any, sessionPath: string): Promise<void> {
  if (typeof ctx.switchSession !== 'function') {
    ctx?.ui?.notify?.('This Pi runtime does not expose session resume (requires a newer Pi version)', 'warning');
    return;
  }
  if (!existsSync(sessionPath)) {
    ctx?.ui?.notify?.('Selected subagent session file is missing', 'warning');
    return;
  }
  try {
    const result = await ctx.switchSession(sessionPath);
    if (result?.cancelled) ctx?.ui?.notify?.('Subagent session resume cancelled', 'info');
  } catch (err) {
    ctx?.ui?.notify?.(`Failed to resume subagent session: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}
