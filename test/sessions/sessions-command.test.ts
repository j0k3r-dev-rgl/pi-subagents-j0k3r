import { describe, it, expect, vi } from 'vitest';
import { createSessionSelectorKeyMatcher, resolveNestedSessionsHome, runSubagentsSessionsCommand } from '../../src/sessions/sessions-command.js';

// `resume()` reads the session path with existsSync from node:fs. Override only
// existsSync so the lifecycle tests can drive the factory without real files,
// while mkdirSync/chmodSync (used by resolveNestedSessionsHome) stay real.
vi.mock('node:fs', async (importActual) => {
	const actual = await importActual() as typeof import('node:fs');
	return { ...actual, existsSync: () => true };
});

describe('createSessionSelectorKeyMatcher (raw-byte fallbacks)', () => {
	const m = createSessionSelectorKeyMatcher();
	it('matches scope/confirm/cancel via raw bytes', () => {
		expect(m('\t', 'scope')).toBe(true);
		expect(m('\r', 'confirm')).toBe(true);
		expect(m('\u001b', 'cancel')).toBe(true);
	});
	it('matches ctrl+s / ctrl+n / ctrl+d toggles', () => {
		expect(m('\u0013', 'toggleSort')).toBe(true);
		expect(m('\u000e', 'toggleNamed')).toBe(true);
		expect(m('\u0004', 'delete')).toBe(true);
	});
	it('matches arrow navigation', () => {
		expect(m('\u001b[A', 'up')).toBe(true);
		expect(m('\u001b[B', 'down')).toBe(true);
		expect(m('\u001b[5~', 'pageUp')).toBe(true);
		expect(m('\u001b[6~', 'pageDown')).toBe(true);
	});
	it('does not match unrelated input', () => {
		expect(m('x', 'confirm')).toBe(false);
		expect(m('\t', 'up')).toBe(false);
	});
});


const stubTheme = { bold: (s: string) => s, fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s };

/** Build a ctx whose ctx.ui.custom captures the selector instance created by the
 * factory + the `done` callback, so a test can drive the selector with real
 * handleInput() calls (Enter / ctrl+h / Esc) and observe the command lifecycle. */
function buildCapturingCtx(overrides: { switchSession?: () => Promise<unknown>; order?: string[]; uiInput?: () => Promise<string | undefined>; uiEditor?: (title: string, prefill?: string) => Promise<string | undefined> } = {}): { ctx: any; getSelector: () => any } {
	let capturedSelector: any;
	const ctx: any = {
		cwd: '/p',
		switchSession: overrides.switchSession ?? vi.fn(async () => ({})),
		ui: {
			notify: vi.fn(),
			input: overrides.uiInput ?? vi.fn(async () => undefined),
			editor: overrides.uiEditor ?? vi.fn(async () => undefined),
			custom: vi.fn((_factory: any, _opts: any) => new Promise((resolve) => {
				// Defer factory call so the test can await after runSubagentsSessionsCommand.
				queueMicrotask(() => {
					capturedSelector = _factory({ requestRender() {} }, stubTheme, { matches: () => false }, (r: any) => {
						overrides.order?.push('done');
						resolve(r);
					});
				});
			})),
		},
	};
	return { ctx, getSelector: () => capturedSelector };
}

const sess = (path: string) => ({ path, cwd: '/p', created: new Date('2025-01-01T00:00:00Z'), modified: new Date('2025-06-01T00:00:00Z'), messageCount: 1, firstMessage: 'm', allMessagesText: 'm' });
const appendSessionInfo = vi.fn();
const sdkWithSessions = (sessions: any[]) => async () => ({ SessionManager: { list: () => sessions, listAll: () => sessions, open: () => ({ appendSessionInfo }) } });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('runSubagentsSessionsCommand custom-component lifecycle', () => {
	it('uses done(path) and resumes AFTER ctx.ui.custom resolves (no fire-and-forget)', async () => {
		const order: string[] = [];
		const switchSession = vi.fn(async () => { order.push('switchSession'); return {}; });
		const { ctx, getSelector } = buildCapturingCtx({ switchSession, order });
		const pending = runSubagentsSessionsCommand({ ctx, sdk: sdkWithSessions([sess('/nested/a.jsonl')]), nestedSessionsDir: '/nested' });
		await tick(); await tick(); // factory runs + selector initial async load settles
		getSelector().handleInput('\r'); // Enter -> onSelect -> done(path)
		// The selector callback must NOT resume inline; resume happens only after
		// the custom component is unmounted (the promise resolves). Otherwise the
		// switchSession reload races the custom-component teardown.
		expect(switchSession).not.toHaveBeenCalled();
		expect(order).toEqual(['done']);
		await pending;
		expect(order).toEqual(['done', 'switchSession']); // resume AFTER done resolves
		expect(switchSession).toHaveBeenCalledWith('/nested/a.jsonl');
	});

	it('does not resume when the selector is cancelled (done(undefined))', async () => {
		const switchSession = vi.fn(async () => ({}));
		const { ctx, getSelector } = buildCapturingCtx({ switchSession });
		const pending = runSubagentsSessionsCommand({ ctx, sdk: sdkWithSessions([sess('/nested/a.jsonl')]), nestedSessionsDir: '/nested' });
		await tick(); await tick();
		getSelector().handleInput('\u001b'); // Esc -> onCancel -> done(undefined)
		await pending;
		expect(switchSession).not.toHaveBeenCalled();
	});

	it('ctrl+h closes the selector, THEN opens native input, THEN onBackgroundRunSession(session, prompt)', async () => {
		const onBackgroundRunSession = vi.fn();
		const uiInput = vi.fn(async () => 'the prompt');
		const { ctx, getSelector } = buildCapturingCtx({ uiInput });
		const pending = runSubagentsSessionsCommand({ ctx, sdk: sdkWithSessions([sess('/nested/a.jsonl')]), nestedSessionsDir: '/nested', onBackgroundRunSession });
		await tick(); await tick();
		getSelector().handleInput('\b'); // ctrl+h -> onBackgroundRun -> done({kind:'backgroundRun'}) -> selector unmounts
		await pending; // native input opens AFTER unmount, then onBackgroundRunSession
		expect(uiInput).toHaveBeenCalledTimes(1); // native prompt opened exactly once, after the selector unmounted
		expect(onBackgroundRunSession).toHaveBeenCalledWith({ path: '/nested/a.jsonl', cwd: '/p' }, 'the prompt');
	});

	it('Esc on the native prompt reopens the sessions list (does not exit to pi)', async () => {
		const onBackgroundRunSession = vi.fn();
		const uiInput = vi.fn(async () => undefined); // Esc on the native prompt
		const { ctx, getSelector } = buildCapturingCtx({ uiInput });
		const pending = runSubagentsSessionsCommand({ ctx, sdk: sdkWithSessions([sess('/nested/a.jsonl')]), nestedSessionsDir: '/nested', onBackgroundRunSession });
		await tick(); await tick();
		getSelector().handleInput('\b'); // ctrl+h -> selector unmounts -> native prompt opens
		await tick(); await tick(); await tick(); // native prompt resolves (Esc) -> command reopens the list
		expect(ctx.ui.custom).toHaveBeenCalledTimes(2); // the sessions list was reopened
		expect(onBackgroundRunSession).not.toHaveBeenCalled(); // nothing resumed
		// The reopened list behaves normally: Esc exits to pi.
		getSelector().handleInput('\u001b');
		await pending;
	});

});

describe('resolveNestedSessionsHome', () => {
	it('points at the subagents history home + sessions (separate from main sessions)', () => {
		const home = resolveNestedSessionsHome();
		expect(home.endsWith(`${'subagents'}/sessions`)).toBe(true);
		expect(home).not.toContain('.pi/agent/sessions');
	});
});

describe('runSubagentsSessionsCommand guards', () => {
	it('warns when interactive custom UI is unavailable', async () => {
		const notify = vi.fn();
		await runSubagentsSessionsCommand({ ctx: { cwd: '/p', ui: { notify } } });
		expect(notify).toHaveBeenCalledWith(expect.any(String), 'warning');
	});

	it('errors when the SDK cannot be loaded', async () => {
		const notify = vi.fn();
		await runSubagentsSessionsCommand({
			ctx: { cwd: '/p', ui: { notify, custom: () => undefined } },
			sdk: async () => {
				throw new Error('boom');
			},
		});
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Pi SDK'), 'error');
	});

	it('warns when the SDK lacks SessionManager', async () => {
		const notify = vi.fn();
		await runSubagentsSessionsCommand({
			ctx: { cwd: '/p', ui: { notify, custom: () => undefined } },
			sdk: async () => ({}),
		});
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('SessionManager'), 'warning');
	});
});
