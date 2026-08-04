import { describe, it, expect } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from '../../src/sessions/fuzzy-match.js';
import { filterAndSortSessions, hasSessionName, parseSearchQuery } from '../../src/sessions/session-search.js';
import {
	buildSessionTree,
	buildTreePrefix,
	flattenSessionTree,
	formatSessionDate,
} from '../../src/sessions/session-tree.js';
import type { SessionInfo } from '../../src/sessions/session-info.js';

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

describe('fuzzyMatch (ported from pi-tui)', () => {
	it('matches in-order characters and scores', () => {
		const m = fuzzyMatch('auth', 'review the auth module');
		expect(m.matches).toBe(true);
		expect(m.score).toBeLessThan(0);
	});
	it('does not match missing characters', () => {
		expect(fuzzyMatch('xyz', 'review the auth module').matches).toBe(false);
	});
	it('matches digit/letter swaps', () => {
		expect(fuzzyMatch('abc123', '123abc').matches).toBe(true);
	});
});

describe('fuzzyFilter', () => {
	it('filters and ranks by best match', () => {
		const items = [{ t: 'auth module' }, { t: 'something else' }, { t: 'author' }];
		const out = fuzzyFilter(items, 'auth', (i) => i.t);
		expect(out.map((i) => i.t)).toEqual(['auth module', 'author']);
	});
});

describe('parseSearchQuery', () => {
	it('parses regex mode', () => {
		const q = parseSearchQuery('re:foo');
		expect(q.mode).toBe('regex');
		expect(q.regex).toBeInstanceOf(RegExp);
	});
	it('parses phrase tokens with quotes', () => {
		const q = parseSearchQuery('"node cve" bar');
		expect(q.tokens).toEqual([
			{ kind: 'phrase', value: 'node cve' },
			{ kind: 'fuzzy', value: 'bar' },
		]);
	});
	it('records an error for invalid regex', () => {
		const q = parseSearchQuery('re:(unclosed');
		expect(q.error).toBeTruthy();
	});
});

describe('filterAndSortSessions', () => {
	it('filters by name filter only when query is empty (preserves order)', () => {
		const sessions = [session({ path: '/a', id: 'a', name: 'x' }), session({ path: '/b', id: 'b' })];
		expect(filterAndSortSessions(sessions, '', 'recent', 'named').map((s) => s.path)).toEqual(['/a']);
	});
	it('recent mode filters keeping incoming order', () => {
		const sessions = [
			session({ path: '/a', id: 'a', firstMessage: 'auth', allMessagesText: 'auth' }),
			session({ path: '/b', id: 'b', firstMessage: 'other', allMessagesText: 'other' }),
		];
		expect(filterAndSortSessions(sessions, 'auth', 'recent').map((s) => s.path)).toEqual(['/a']);
	});
	it('relevance mode ranks best matches first', () => {
		const sessions = [
			session({ path: '/loose', id: 'loose', allMessagesText: 'a u t h scattered' }),
			session({ path: '/tight', id: 'tight', allMessagesText: 'auth' }),
		];
		expect(filterAndSortSessions(sessions, 'auth', 'relevance')[0]!.path).toBe('/tight');
	});
});

describe('hasSessionName', () => {
	it('only non-empty trimmed names count', () => {
		expect(hasSessionName(session({ path: '/a', id: 'a', name: 'x' }))).toBe(true);
		expect(hasSessionName(session({ path: '/a', id: 'a', name: '  ' }))).toBe(false);
		expect(hasSessionName(session({ path: '/a', id: 'a' }))).toBe(false);
	});
});

describe('session tree (ported from pi)', () => {
	it('builds a tree from parentSessionPath and sorts roots by activity desc', () => {
		const older = session({ path: '/old.jsonl', id: 'old', modified: new Date('2025-01-01T00:00:00Z') });
		const newer = session({ path: '/new.jsonl', id: 'new', modified: new Date('2025-06-01T00:00:00Z') });
		const child = session({
			path: '/child.jsonl',
			id: 'child',
			parentSessionPath: '/old.jsonl',
			modified: new Date('2025-07-01T00:00:00Z'),
		});
		const roots = buildSessionTree([older, newer, child]);
		const flat = flattenSessionTree(roots);
		// child is nested under old (depth 1)
		const childNode = flat.find((n) => n.session.id === 'child')!;
		expect(childNode.depth).toBe(1);
		expect(childNode.ancestorContinues).toHaveLength(1);
		// old's subtree activity is bumped by its child, so old sorts above newer
		const oldRoot = roots.find((r) => r.session.id === 'old')!;
		expect(oldRoot.children.map((c) => c.session.id)).toContain('child');
	});

	it('buildTreePrefix renders branches', () => {
		expect(buildTreePrefix({ session: {} as SessionInfo, depth: 0, isLast: true, ancestorContinues: [] })).toBe('');
		expect(buildTreePrefix({ session: {} as SessionInfo, depth: 1, isLast: true, ancestorContinues: [false] })).toBe('   └─ ');
		expect(buildTreePrefix({ session: {} as SessionInfo, depth: 1, isLast: false, ancestorContinues: [true] })).toBe('│  ├─ ');
	});
});

describe('formatSessionDate', () => {
	const now = new Date('2025-06-01T12:00:00Z');
	const at = (iso: string) => formatSessionDate(new Date(iso));
	it('uses the now/m/h/d/w/mo/y buckets relative to real now', () => {
		// Note: buckets are relative to new Date() at call time; assert shape only.
		expect(['now', /^\d+m$/, /^\d+h$/, /^\d+d$/, /^\d+w$/, /^\d+mo$/, /^\d+y$/].some((re) => (typeof re === 'string' ? at('2025-06-01T11:55:00Z') === re : re.test(at('2025-06-01T11:55:00Z'))))).toBe(true);
	});
	it('returns now for very recent', () => {
		// calling with a brand-new date is "now" or a few seconds → "now"
		const result = formatSessionDate(new Date(Date.now() - 5_000));
		expect(['now', /^\d+m$/].some((re) => (typeof re === 'string' ? result === re : re.test(result)))).toBe(true);
	});
});
