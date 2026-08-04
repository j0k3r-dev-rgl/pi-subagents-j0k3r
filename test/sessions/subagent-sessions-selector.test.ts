import { describe, it, expect, vi } from 'vitest';
import { SubagentSessionsSelector } from '../../src/sessions/subagent-sessions-selector.js';
import { createSessionSelectorKeyMatcher } from '../../src/sessions/sessions-command.js';
import { truncateToVisibleWidth, truncateToWidth, visibleWidth } from '../../src/render/text-width.js';
import type { SessionInfo } from '../../src/sessions/session-info.js';

const theme = { bold: (s: string) => s, fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s };

function session(overrides: Partial<SessionInfo> & { path: string; id: string }): SessionInfo {
	return {
		cwd: '/p',
		created: new Date('2025-01-01T00:00:00Z'),
		modified: new Date('2025-06-01T00:00:00Z'),
		messageCount: 3,
		firstMessage: 'review the auth module',
		allMessagesText: 'review the auth module',
		...overrides,
	};
}

function makeSelector(current: SessionInfo[], all: SessionInfo[], opts?: { renameSession?: (p: string, n: string | undefined) => Promise<void>; onView?: (s: { path: string; cwd: string }) => void; onBackgroundRun?: (s: { path: string; cwd: string }) => void }) {
	const onSelect = vi.fn();
	const onCancel = vi.fn();
	const requestRender = vi.fn();
	const selector = new SubagentSessionsSelector({
		theme,
		matchesKey: createSessionSelectorKeyMatcher(),
		visibleWidth,
		truncateToWidth,
		truncateVisible: truncateToVisibleWidth,
		currentSessionsLoader: async () => current,
		allSessionsLoader: async () => all,
		onSelect,
		onCancel,
		onView: opts?.onView,
		onBackgroundRun: opts?.onBackgroundRun,
		requestRender,
		renameSession: opts?.renameSession,
	});
	return { selector, onSelect, onCancel, requestRender };
}

// Allow the initial async load to settle.
function settled(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderText(selector: SubagentSessionsSelector, width = 100): string {
	return selector.render(width).join('\n');
}

describe('SubagentSessionsSelector', () => {
	it('renders the branded title, the sessions, and the position counter after load', async () => {
		const { selector } = makeSelector([session({ path: '/a.jsonl', id: 'a' })], []);
		await settled();
		const out = renderText(selector);
		expect(out).toContain('Subagents Sessions (Current Folder)');
		expect(out).toContain('review the auth module');
		expect(out).toContain('(1/1)'); // counter is always shown, not only when scrolling
	});

	it('auto-switches to All and shows the All empty-state when there are no sessions anywhere', async () => {
		const { selector } = makeSelector([], []);
		await settled();
		expect(renderText(selector)).toContain('Subagents Sessions (All)');
		expect(renderText(selector)).toContain('No subagent sessions found.');
	});

	it('resumes the selected session on Enter', async () => {
		const { selector, onSelect } = makeSelector(
			[session({ path: '/a.jsonl', id: 'a', firstMessage: 'aaa', allMessagesText: 'aaa' }), session({ path: '/b.jsonl', id: 'b', firstMessage: 'bbb', allMessagesText: 'bbb' })],
			[],
		);
		await settled();
		selector.handleInput('\u001b[B'); // down
		selector.handleInput('\r'); // enter
		expect(onSelect).toHaveBeenCalledWith('/b.jsonl');
	});

	it('toggles to All scope on Tab and loads the all-scope sessions', async () => {
		const { selector } = makeSelector(
			[session({ path: '/a.jsonl', id: 'a', firstMessage: 'aaa', allMessagesText: 'aaa' })],
			[session({ path: '/a.jsonl', id: 'a', firstMessage: 'aaa', allMessagesText: 'aaa' }), session({ path: '/c.jsonl', id: 'c', firstMessage: 'only all', allMessagesText: 'only all' })],
		);
		await settled();
		expect(renderText(selector)).toContain('Subagents Sessions (Current Folder)');
		selector.handleInput('\t'); // tab -> all
		await settled();
		expect(renderText(selector)).toContain('Subagents Sessions (All)');
		expect(renderText(selector)).toContain('only all');
	});

	it('filters sessions live as you type in the search box', async () => {
		const { selector } = makeSelector(
			[
				session({ path: '/a.jsonl', id: 'a', firstMessage: 'auth module', allMessagesText: 'auth module' }),
				session({ path: '/b.jsonl', id: 'b', firstMessage: 'database work', allMessagesText: 'database work' }),
			],
			[],
		);
		await settled();
		expect(renderText(selector)).toContain('database work');
		// switch to recent sort so search filters flat
		selector.handleInput('\u0013'); // ctrl+s -> recent
		selector.handleInput('auth'); // type into search
		const out = renderText(selector);
		expect(out).toContain('auth module');
		expect(out).not.toContain('database work');
	});

	it('cancels on Escape', async () => {
		const { selector, onCancel } = makeSelector([session({ path: '/a.jsonl', id: 'a' })], []);
		await settled();
		selector.handleInput('\u001b'); // esc
		expect(onCancel).toHaveBeenCalled();
	});

	it('toggles the name filter on ctrl+n', async () => {
		const { selector } = makeSelector(
			[session({ path: '/a.jsonl', id: 'a', name: 'named one' }), session({ path: '/b.jsonl', id: 'b' })],
			[],
		);
		await settled();
		expect(renderText(selector)).toContain('Name: All');
		selector.handleInput('\u000e'); // ctrl+n -> named
		const out = renderText(selector);
		expect(out).toContain('Name: Named');
		expect(out).toContain('named one');
		expect(out).not.toContain('review the auth module');
	});

	it('toggles the session path display on ctrl+p', async () => {
		const { selector } = makeSelector([session({ path: '/abs/nested/a.jsonl', id: 'a' })], []);
		await settled();
		expect(renderText(selector)).not.toContain('/abs/nested/a.jsonl');
		selector.handleInput('\u0010'); // ctrl+p -> show path
		expect(renderText(selector)).toContain('/abs/nested/a.jsonl');
	});

	it('renames the selected session via ctrl+r -> type -> enter', async () => {
		const renameSession = vi.fn(async (_p: string, _n: string | undefined) => undefined);
		const { selector } = makeSelector([session({ path: '/a.jsonl', id: 'a' })], [], { renameSession });
		await settled();
		selector.handleInput('\u0012'); // ctrl+r -> enter rename mode
		selector.handleInput('my label'); // type
		selector.handleInput('\r'); // enter -> save
		await settled();
		expect(renameSession).toHaveBeenCalledWith('/a.jsonl', 'my label');
	});

	it('cancel exits rename mode without renaming', async () => {
		const renameSession = vi.fn(async () => undefined);
		const { selector } = makeSelector([session({ path: '/a.jsonl', id: 'a' })], [], { renameSession });
		await settled();
		selector.handleInput('\u0012'); // ctrl+r
		selector.handleInput('\u001b'); // esc
		expect(renderText(selector)).toContain('Subagents Sessions (Current Folder)');
		expect(renameSession).not.toHaveBeenCalled();
	});

	it('rename overlay is framed with borders, blanks, and an accent title (like the resume prompt)', async () => {
		const renameSession = vi.fn(async () => undefined);
		const { selector } = makeSelector([session({ path: '/a.jsonl', id: 'a' })], [], { renameSession });
		await settled();
		selector.handleInput('\u0012'); // ctrl+r -> rename mode
		const out = selector.render(100);
		expect(out[0]).toMatch(/^─+$/); // top border (accent)
		expect(out[1]).toBe(''); // blank below the top border
		expect(out[2]).toBe('Rename Session'); // accent + bold title
		expect(out[out.length - 1]).toMatch(/^─+$/); // bottom border
		expect(out[out.length - 2]).toBe(''); // blank above the bottom border
		expect(out.join('\n')).toContain('save');
		expect(out.join('\n')).toContain('escape/ctrl+c cancel');
	});

	it('keeps a constant overlay height regardless of session count (no jump on Tab)', async () => {
		const one = makeSelector([session({ path: '/a.jsonl', id: 'a' })], []);
		await settled();
		const few = makeSelector(
			Array.from({ length: 3 }, (_, i) => session({ path: `/${i}.jsonl`, id: `s${i}` })),
			[],
		);
		await settled();
		const many = makeSelector(
			Array.from({ length: 25 }, (_, i) => session({ path: `/${i}.jsonl`, id: `s${i}`, firstMessage: `m${i}`, allMessagesText: `m${i}` })),
			[],
		);
		await settled();
		const a = one.selector.render(100).length;
		const b = few.selector.render(100).length;
		const c = many.selector.render(100).length;
		expect(a).toBe(b);
		expect(b).toBe(c); // fixed maxVisible rows + chrome + counter
	});

	it('frames the list with top and bottom border lines (like /resume)', async () => {
		const { selector } = makeSelector([session({ path: '/a.jsonl', id: 'a' })], []);
		await settled();
		const out = selector.render(100);
		expect(out[0]).toBe(''); // leading spacer
		expect(out.some((l) => /^─+$/.test(l))).toBe(true); // accent border line(s)
		expect(out[out.length - 1]).toMatch(/^─+$/); // bottom border is the last line
	});

	it('shows the session cwd only in All scope', async () => {
		const { selector } = makeSelector(
			[session({ path: '/cur.jsonl', id: 'cur', firstMessage: 'current', allMessagesText: 'current' })],
			[session({ path: '/a.jsonl', id: 'a', cwd: '/distinct/proj-cwd', firstMessage: 'aaa', allMessagesText: 'aaa' })],
		);
		await settled();
		expect(renderText(selector)).not.toContain('/distinct/proj-cwd'); // Current: cwd hidden
		selector.handleInput('\t'); // tab -> all
		await settled();
		expect(renderText(selector)).toContain('/distinct/proj-cwd');
	});

	it('uses the full width for the name when path is off, and right-aligns the path when on', async () => {
		const longMsg = 'x'.repeat(200);
		// Current scope, no ctrl+p => path OFF: name should be wide.
		const off = makeSelector([session({ path: '/a.jsonl', id: 'a', firstMessage: longMsg, allMessagesText: longMsg })], []);
		await settled();
		const width = 100;
		const offRow = off.selector.render(width).find((l) => l.startsWith('› '))!;
		expect(offRow).toContain('…');
		expect(visibleWidth(offRow)).toBeLessThanOrEqual(width);
		const offMsg = offRow.slice(2, offRow.indexOf('…') + 1);
		expect(offMsg.length).toBeGreaterThan(50); // dynamic full width, not capped at 50%

		// All scope (auto-switched because Current is empty) => path ON (cwd shown), right-aligned.
		const on = makeSelector(
			[],
			[session({ path: '/a.jsonl', id: 'a', cwd: '/proj', firstMessage: longMsg, allMessagesText: longMsg })],
		);
		await settled();
		const onRow = on.selector.render(width).find((l) => l.startsWith('› '))!;
		expect(onRow).toContain('/proj'); // path right-aligned
		expect(visibleWidth(onRow)).toBeLessThanOrEqual(width);
	});

	it('preserves path/count/age on ANSI-styled rows (ANSI-aware final truncation)', async () => {
		const ansiTheme = {
			bold: (st: string) => `\u001b[1m${st}\u001b[22m`,
			fg: (_c: string, st: string) => `\u001b[31m${st}\u001b[39m`,
			bg: (_c: string, st: string) => `\u001b[44m${st}\u001b[49m`,
		};
		const longMsg = 'x'.repeat(300);
		const selector = new SubagentSessionsSelector({
			theme: ansiTheme,
			matchesKey: createSessionSelectorKeyMatcher(),
			visibleWidth,
			truncateToWidth,
			truncateVisible: truncateToVisibleWidth,
			currentSessionsLoader: async () => [],
			allSessionsLoader: async () => [session({ path: '/a.jsonl', id: 'a', cwd: '/proj', firstMessage: longMsg, allMessagesText: longMsg, messageCount: 7 })],
			onSelect: vi.fn(),
			onCancel: vi.fn(),
			requestRender: vi.fn(),
		});
		await settled(); // Current empty -> auto-switch All
		const row = selector.render(60).find((l) => l.includes('xx'))!;
		expect(visibleWidth(row)).toBeLessThanOrEqual(60);
		const visible = row.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
		expect(visible).toContain('/proj'); // cwd (path) survived
		expect(visible).toContain('7');     // messageCount survived
		expect(visible).toMatch(/\s7\s/);  // count + age meta survived
	});

	it('calls onView with the selected session path on space and shows the hint', async () => {
		const onView = vi.fn();
		const { selector } = makeSelector(
			[session({ path: '/a.jsonl', id: 'a', firstMessage: 'aaa', allMessagesText: 'aaa' }), session({ path: '/b.jsonl', id: 'b', firstMessage: 'bbb', allMessagesText: 'bbb' })],
			[],
			{ onView },
		);
		await settled();
		expect(renderText(selector)).toContain('space preview'); // hint advertises it
		selector.handleInput('\u001b[B'); // down -> second
		selector.handleInput(' '); // space -> view
		expect(onView).toHaveBeenCalledWith({ path: '/b.jsonl', cwd: '/p' });
	});

	it('calls onBackgroundRun with the selected session on ctrl+h (only when search is empty)', async () => {
		const onBackgroundRun = vi.fn();
		const { selector } = makeSelector([session({ path: '/a.jsonl', id: 'a', firstMessage: 'aaa', allMessagesText: 'aaa' })], [], { onBackgroundRun });
		await settled();
		selector.handleInput('\b'); // ctrl+h, empty query
		expect(onBackgroundRun).toHaveBeenCalledWith({ path: '/a.jsonl', cwd: '/p' });
		onBackgroundRun.mockClear();
		selector.handleInput('z');
		selector.handleInput('\b'); // non-empty query -> backspace
		expect(onBackgroundRun).not.toHaveBeenCalled();
	});

	it('matches ctrl+h in CSI u (kitty) format \u001b[104;5u', async () => {
		const onBackgroundRun = vi.fn();
		const { selector } = makeSelector([session({ path: '/a.jsonl', id: 'a' })], [], { onBackgroundRun });
		await settled();
		selector.handleInput('\u001b[104;5u'); // ctrl+h CSI u
		expect(onBackgroundRun).toHaveBeenCalledWith({ path: '/a.jsonl', cwd: '/p' });
	});

	it('ctrl+h resume hint shown in Current Folder, hidden+disabled in All scope', async () => {
		const onBackgroundRun = vi.fn();
		const { selector } = makeSelector([session({ path: '/a.jsonl', id: 'a' })], [], { onBackgroundRun });
		await settled();
		expect(selector.render(200).join('\n')).toContain('resume session'); // hint advertised in Current
		selector.handleInput('\u001b[104;5u'); // ctrl+h in Current -> onBackgroundRun
		expect(onBackgroundRun).toHaveBeenCalledTimes(1);
		onBackgroundRun.mockClear();
		selector.handleInput('\t'); // tab to All
		await settled();
		expect(selector.render(200).join('\n')).not.toContain('resume session'); // hint hidden in All
		selector.handleInput('\u001b[104;5u'); // ctrl+h in All -> nothing (no onBackgroundRun)
		expect(onBackgroundRun).not.toHaveBeenCalled();
	});

});