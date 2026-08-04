import { homedir } from 'node:os';
import {
	deleteSessionFile,
	buildSessionTree,
	buildTreePrefix,
	flattenSessionTree,
	formatSessionDate,
	type FlatSessionNode,
} from './session-tree.js';
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from './session-search.js';
import type { SessionInfo } from './session-info.js';
import { TextInputState } from './text-input-state.js';

type SessionsLoader = (onProgress?: (loaded: number, total: number) => void) => Promise<SessionInfo[]>;

export interface SubagentSessionsSelectorDeps {
	theme: any;
	/** Match raw terminal input against a semantic key name. */
	matchesKey: (data: string, key: SessionSelectorKey) => boolean;
	visibleWidth: (text: string) => number;
	truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
	/** ANSI-aware truncation, used for the fully-themed row line. */
	truncateVisible: (text: string, width: number, ellipsis?: string) => string;
	currentSessionsLoader: SessionsLoader;
	allSessionsLoader: SessionsLoader;
	onSelect: (sessionPath: string) => void;
	onCancel: () => void;
	requestRender: () => void;
	/** Rename callback (enables Ctrl+R). Writes the name onto the session file. */
	renameSession?: (sessionPath: string, name: string | undefined) => Promise<void>;
	/** Open the history panel on the selected session (Space). */
	onView?: (session: { path: string; cwd: string }) => void;
	/** Continue the selected session in the background (Ctrl+H). The prompt is
	 * collected AFTER this selector unmounts (the command closes the selector
	 * via `done({kind:'backgroundRun', session})` and then opens pi's native
	 * `ctx.ui.input`). Collecting the prompt in-selector caused pi-tui to leave
	 * the previous prompt frame visible over the list (it does not clear the
	 * editor-area between renders of an overlay:false custom component). */
	onBackgroundRun?: (session: { path: string; cwd: string }) => void;
	/** Optional debug logger (best-effort, may be absent). */
	maxVisible?: number;
}

export type SessionSelectorKey =
	| 'up'
	| 'down'
	| 'pageUp'
	| 'pageDown'
	| 'home'
	| 'end'
	| 'confirm'
	| 'cancel'
	| 'scope'
	| 'toggleSort'
	| 'toggleNamed'
	| 'togglePath'
	| 'delete'
	| 'rename'
	| 'view'
	| 'backgroundRun'
	| 'left'
	| 'right'
	| 'deleteWord'
	| 'clearLine';

type Scope = 'current' | 'all';
type Mode = 'list' | 'rename';

interface LoadState {
	loading: boolean;
	error: string | null;
}

/** Shorten a path relative to the home directory (`~`). Ported from Pi's session-selector. */
function shortenPath(p: string): string {
	const home = homedir();
	if (!p) return p;
	if (p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

/**
 * Dedicated selector for subagent nested sessions, branded "Subagents Sessions".
 *
 * Built as a plain render-object (mirrors the existing `SubagentsHistoryPanel`
 * pattern with injected theme + visibleWidth/truncateToWidth + key matcher) on
 * top of code extracted from Pi's `/resume` selector:
 *   - search/sort logic: `session-search.ts` (filterAndSortSessions, hasSessionName)
 *   - threaded tree view: `session-tree.ts` (buildSessionTree, flattenSessionTree)
 *   - delete with trash fallback: `session-tree.ts` (deleteSessionFile)
 *
 * Notable branding/behavior differences from `/resume`:
 *   - Title reads "Subagents Sessions" instead of "Resume Session".
 *   - Loaders are scoped to the subagent nested sessions directory, not the main
 *     session dir, so only subagent sessions are listed.
 */
export class SubagentSessionsSelector {
	private _focused = true;
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; }
	private scope: Scope = 'current';
	private nameFilter: NameFilter = 'all';
	private sortMode: SortMode = 'threaded';
	private showPath = false;
	private query = new TextInputState();
	private currentSessions: SessionInfo[] = [];
	private allSessions: SessionInfo[] | null = null;
	private flatNodes: FlatSessionNode[] = [];
	private selectedIndex = 0;
	private readonly maxVisible: number;
	private currentLoad: LoadState = { loading: false, error: null };
	private allLoad: LoadState = { loading: false, error: null };
	private allLoadSeq = 0;
	private confirmingDeletePath: string | null = null;
	private statusMessage: { type: 'info' | 'error'; message: string } | null = null;
	private mode: Mode = 'list';
	private readonly renameInput = new TextInputState();
	private renameTargetPath: string | null = null;

	constructor(private readonly deps: SubagentSessionsSelectorDeps) {
		this.maxVisible = deps.maxVisible ?? 10;
		this.query.focused = true;
		void this.initialLoad();
	}

	/** Load Current first; if it is empty, auto-switch to All so the user always
	 * sees their subagent sessions without having to press Tab. */
	private async initialLoad(): Promise<void> {
		await this.loadScope('current', 'initial');
		const currentCount = this.currentSessions.length;
		if (currentCount === 0) {
			this.scope = 'all';
			await this.loadScope('all', 'initial');
			this.applyFilterSort();
			this.deps.requestRender();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme, visibleWidth, truncateToWidth, truncateVisible } = this.deps;
		if (this.mode === 'rename') return this.renderRename(width, theme, truncateToWidth);
		return this.renderList(width, theme, visibleWidth, truncateToWidth, truncateVisible);
	}

	private renderList(width: number, theme: any, visibleWidth: (t: string) => number, truncateToWidth: (t: string, w: number, e?: string) => string, truncateVisible: (t: string, w: number, e?: string) => string): string[] {
		const lines: string[] = [];
		const border = theme.fg('accent', '─'.repeat(Math.max(0, width)));

		// buildBaseLayout (ported from Pi's SessionSelectorComponent): spacer, top
		// border, spacer, header, spacer, content, spacer, bottom border.
		lines.push('');
		lines.push(border);
		lines.push('');

		const title = this.scope === 'current' ? 'Subagents Sessions (Current Folder)' : 'Subagents Sessions (All)';
		const sortLabel = this.sortMode === 'threaded' ? 'Threaded' : this.sortMode === 'recent' ? 'Recent' : 'Fuzzy';
		const nameLabel = this.nameFilter === 'all' ? 'All' : 'Named';

		const scopeText =
			this.scope === 'current'
				? `${theme.fg('accent', '◉ Current Folder')}${theme.fg('muted', ' | ○ All')}`
				: `${theme.fg('muted', '○ Current Folder | ')}${theme.fg('accent', '◉ All')}`;
		const rightText = `${scopeText}  ${theme.fg('muted', 'Name: ')}${theme.fg('accent', nameLabel)}  ${theme.fg('muted', 'Sort: ')}${theme.fg('accent', sortLabel)}`;
		lines.push(`${theme.bold(title)}${' '.repeat(Math.max(0, width - visibleWidth(theme.bold(title)) - visibleWidth(rightText)))}${rightText}`);

		// Header always renders two hint lines (matches /resume; keeps height stable).
		let hint1: string;
		let hint2: string;
		if (this.confirmingDeletePath !== null) {
			hint1 = theme.fg('error', truncateToWidth(`Delete session? ${this.labelFor('confirm')} confirm · ${this.labelFor('cancel')} cancel`, width, '…'));
			hint2 = '';
		} else if (this.statusMessage) {
			const color = this.statusMessage.type === 'error' ? 'error' : 'accent';
			hint1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, '…'));
			hint2 = '';
		} else {
			hint1 = truncateToWidth(`${this.labelFor('scope')} scope · re:<pattern> regex · "phrase" exact`, width, '…');
			const parts = [
				`${this.labelFor('toggleSort')} sort`,
				`${this.labelFor('toggleNamed')} named`,
				`${this.labelFor('delete')} delete`,
				`${this.labelFor('togglePath')} path ${this.showPath ? '(on)' : '(off)'}`,
			];
			if (this.deps.renameSession) parts.push(`${this.labelFor('rename')} rename`);
			if (this.deps.onView) parts.push(`${this.labelFor('view')} preview`);
			if (this.deps.onView) parts.push(`${this.labelFor('confirm')} open`); // Enter open
			if (this.scope === 'current' && this.deps.onBackgroundRun) {
				parts.push(`${this.labelFor('backgroundRun')} resume session`);
			}
			hint2 = truncateVisible(parts.join(' · '), width, '…');
		}
		lines.push(hint1);
		lines.push(hint2);

		lines.push('');
		lines.push(truncateToWidth(this.query.render(), width, ''));
		lines.push('');

		const load = this.scope === 'current' ? this.currentLoad : this.allLoad;
		const listLines: string[] = [];

		if (load.loading) {
			listLines.push(theme.fg('muted', '  Loading subagent sessions…'));
		} else if (load.error) {
			listLines.push(theme.fg('error', truncateToWidth(`  Failed to load: ${load.error}`, width, '…')));
		} else if (this.flatNodes.length === 0) {
			listLines.push(theme.fg('muted', truncateToWidth(this.emptyMessage(), width, '…')));
		} else {
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), Math.max(0, this.flatNodes.length - this.maxVisible)),
			);
			const endIndex = Math.min(startIndex + this.maxVisible, this.flatNodes.length);

			for (let i = startIndex; i < endIndex; i += 1) {
				const node = this.flatNodes[i]!;
				const session = node.session;
				const isSelected = i === this.selectedIndex;
				const isConfirmingDelete = session.path === this.confirmingDeletePath;

				const prefix = buildTreePrefix(node);
				const hasName = hasSessionName(session);
				const displayText = (hasName ? session.name : session.firstMessage) ?? '';
				const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, ' ').trim();

				const age = formatSessionDate(session.modified);
				const msgCount = String(session.messageCount);
				let rightPart = `${msgCount} ${age}`;
				if (this.scope === 'all' && session.cwd) rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
				if (this.showPath) rightPart = `${shortenPath(session.path)} ${rightPart}`;

				const cursor = isSelected ? theme.fg('accent', '› ') : '  ';
				const prefixWidth = visibleWidth(prefix);
				const rightWidth = visibleWidth(rightPart) + 2;
				const availableForMsg = Math.max(10, width - 2 - prefixWidth - rightWidth);
				const truncatedMsg = truncateToWidth(normalizedMessage, availableForMsg, '…');

				let messageColor: 'error' | 'warning' | 'accent' | null = null;
				if (isConfirmingDelete) messageColor = 'error';
				else if (hasName) messageColor = 'warning';
				let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
				if (isSelected) styledMsg = theme.bold(styledMsg);

				const leftPart = cursor + theme.fg('dim', prefix) + styledMsg;
				const leftWidth = visibleWidth(leftPart);
				const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
				const styledRight = theme.fg(isConfirmingDelete ? 'error' : 'dim', rightPart);
				let line = leftPart + ' '.repeat(spacing) + styledRight;
				if (isSelected) line = theme.bg('selectedBg', line);
				listLines.push(truncateVisible(line, width));
			}
		}

		// Fixed height: always render exactly maxVisible list rows so the editor-area
		// region (where /resume also renders) does not jump when toggling scope.
		while (listLines.length < this.maxVisible) listLines.push('');
		for (const line of listLines) lines.push(line);

		const counter = this.flatNodes.length > 0 && !load.loading && !load.error
			? `  (${this.selectedIndex + 1}/${this.flatNodes.length})`
			: '';
		lines.push(theme.fg('muted', truncateToWidth(counter, width, '')));

		lines.push('');
		lines.push(border);
		return lines;
	}

	handleInput(data: string): void {
		const m = this.deps.matchesKey;

		if (this.mode === 'rename') return this.handleRenameInput(data, m);

		// Delete confirmation intercepts everything.
		if (this.confirmingDeletePath !== null) {
			if (m(data, 'confirm')) void this.confirmDelete();
			else if (m(data, 'cancel')) this.confirmingDeletePath = null;
			this.deps.requestRender();
			return;
		}

		if (m(data, 'cancel')) {
			this.deps.onCancel();
			return;
		}
		if (m(data, 'confirm')) {
			const selected = this.flatNodes[this.selectedIndex];
			if (selected) this.deps.onSelect(selected.session.path);
			return;
		}
		if (m(data, 'scope')) return this.toggleScope();
		if (m(data, 'toggleSort')) return this.toggleSort();
		if (m(data, 'toggleNamed')) return this.toggleNameFilter();
		if (m(data, 'togglePath')) {
			this.showPath = !this.showPath;
			this.deps.requestRender();
			return;
		}
		if (m(data, 'delete')) return this.startDelete();
		if (m(data, 'rename') && this.deps.renameSession) return this.enterRename();
		if (m(data, 'view') && this.deps.onView) {
			const selected = this.flatNodes[this.selectedIndex];
			if (selected) this.deps.onView?.({ path: selected.session.path, cwd: selected.session.cwd });
			return;
		}
		// ctrl+h is ambiguous with backspace: resume the selected session when the
		// search query is empty (mirrors Pi's ctrl+backspace pattern); otherwise
		// backspace. The selector CLOSES (the command's onBackgroundRun wiring calls
		// done) so pi-tui cleanly tears the selector down before the native prompt
		// opens.
		if (m(data, 'backgroundRun')) {
			if (this.query.getValue().length > 0) return this.applyInput(() => this.query.backspace());
			if (this.deps.onBackgroundRun && this.scope === 'current') {
				const selected = this.flatNodes[this.selectedIndex];
				if (selected) this.deps.onBackgroundRun?.({ path: selected.session.path, cwd: selected.session.cwd });
			}
			return;
		}
		if (m(data, 'up')) return this.move(-1);
		if (m(data, 'down')) return this.move(1);
		if (m(data, 'pageUp')) return this.move(-this.maxVisible);
		if (m(data, 'pageDown')) return this.move(this.maxVisible);
		if (m(data, 'home')) return this.moveTo(0);
		if (m(data, 'end')) return this.moveTo(this.flatNodes.length - 1);

		// Search-box editing keys.
		if (m(data, 'left')) return this.applyInput(() => this.query.moveLeft());
		if (m(data, 'right')) return this.applyInput(() => this.query.moveRight());
		if (m(data, 'clearLine')) return this.applyInput(() => this.query.clear());
		if (m(data, 'deleteWord')) return this.applyInput(() => this.query.deleteWordBackward());

		// Backspace (DEL only; ctrl+h/\b is handled above as run-in-background).
		if (data === '\u007f') return this.applyInput(() => this.query.backspace());

		// Printable text → search query.
		if (data && !data.startsWith('\u001b') && !/\p{Cc}/u.test(data)) {
			this.applyInput(() => this.query.insert(data));
		}
	}

	private labelFor(key: SessionSelectorKey): string {
		const map: Record<SessionSelectorKey, string> = {
			up: '↑', down: '↓', pageUp: 'pgup', pageDown: 'pgdn', home: 'home', end: 'end',
			confirm: 'enter', cancel: 'esc', scope: 'tab', toggleSort: 'ctrl+s',
			toggleNamed: 'ctrl+n', togglePath: 'ctrl+p', delete: 'ctrl+d', rename: 'ctrl+r',
			view: 'space', backgroundRun: 'ctrl+h', left: '←', right: '→', deleteWord: 'ctrl+w', clearLine: 'ctrl+u',
		};
		return map[key];
	}

	private emptyMessage(): string {
		if (this.nameFilter === 'named') {
			if (this.scope === 'current') return 'No named subagent sessions here. Press ctrl+n to show all, or Tab to view all folders.';
			return 'No named subagent sessions. Press ctrl+n to show all.';
		}
		if (this.scope === 'current') return 'No subagent sessions in current folder. Press Tab to view all.';
		return 'No subagent sessions found.';
	}

	private renderRename(width: number, theme: any, truncateToWidth: (t: string, w: number, e?: string) => string): string[] {
		this.renameInput.focused = true;
		const border = theme.fg('border', '─'.repeat(Math.max(0, width)));
		return [
			border,
			'',
			theme.fg('accent', theme.bold('Rename Session')),
			'',
			truncateToWidth(this.renameInput.render(), width, ''),
			'',
			theme.fg('muted', truncateToWidth(`${this.labelFor('confirm')} save  escape/ctrl+c cancel`, width, '…')),
			'',
			border,
		];
	}

	private handleRenameInput(data: string, m: (data: string, key: SessionSelectorKey) => boolean): void {
		if (m(data, 'cancel')) {
			this.exitRename();
			this.deps.requestRender();
			return;
		}
		if (m(data, 'confirm')) {
			void this.confirmRename();
			return;
		}
		if (m(data, 'left')) { this.renameInput.moveLeft(); this.deps.requestRender(); return; }
		if (m(data, 'right')) { this.renameInput.moveRight(); this.deps.requestRender(); return; }
		if (m(data, 'home')) { this.renameInput.home(); this.deps.requestRender(); return; }
		if (m(data, 'end')) { this.renameInput.end(); this.deps.requestRender(); return; }
		if (m(data, 'clearLine')) { this.renameInput.clear(); this.deps.requestRender(); return; }
		if (m(data, 'deleteWord')) { this.renameInput.deleteWordBackward(); this.deps.requestRender(); return; }
		if (data === '\u007f' || data === '\b') { this.renameInput.backspace(); this.deps.requestRender(); return; }
		if (data && !data.startsWith('\u001b') && !/\p{Cc}/u.test(data)) {
			this.renameInput.insert(data);
			this.deps.requestRender();
		}
	}

	private enterRename(): void {
		const selected = this.flatNodes[this.selectedIndex];
		if (!selected) return;
		this.mode = 'rename';
		this.renameTargetPath = selected.session.path;
		this.renameInput.setValue(selected.session.name ?? '');
		this.deps.requestRender();
	}

	private exitRename(): void {
		this.mode = 'list';
		this.renameTargetPath = null;
	}

	private async confirmRename(): Promise<void> {
		const target = this.renameTargetPath;
		const next = this.renameInput.getValue().trim();
		this.exitRename();
		if (!target || !this.deps.renameSession || !next) {
			this.deps.requestRender();
			return;
		}
		try {
			await this.deps.renameSession(target, next);
			this.statusMessage = { type: 'info', message: 'Session renamed' };
			await this.loadScope(this.scope, 'refresh');
		} catch (err) {
			this.statusMessage = { type: 'error', message: `Failed to rename: ${err instanceof Error ? err.message : String(err)}` };
		}
		this.deps.requestRender();
	}

	private applyInput(fn: () => void): void {
		fn();
		this.applyFilterSort();
		this.deps.requestRender();
	}

	private move(delta: number): void {
		if (this.flatNodes.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.flatNodes.length - 1, this.selectedIndex + delta));
		this.deps.requestRender();
	}

	private moveTo(index: number): void {
		if (this.flatNodes.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.flatNodes.length - 1, index));
		this.deps.requestRender();
	}

	private toggleScope(): void {
		this.scope = this.scope === 'current' ? 'all' : 'current';
		this.selectedIndex = 0;
		if (this.scope === 'all' && this.allSessions === null) {
			void this.loadScope('all', 'toggle');
		} else {
			this.applyFilterSort();
		}
		this.deps.requestRender();
	}

	private toggleSort(): void {
		this.sortMode = this.sortMode === 'threaded' ? 'recent' : this.sortMode === 'recent' ? 'relevance' : 'threaded';
		this.applyFilterSort();
		this.deps.requestRender();
	}

	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === 'all' ? 'named' : 'all';
		this.applyFilterSort();
		this.deps.requestRender();
	}

	private startDelete(): void {
		const selected = this.flatNodes[this.selectedIndex];
		if (!selected) return;
		this.confirmingDeletePath = selected.session.path;
		this.deps.requestRender();
	}

	private async confirmDelete(): Promise<void> {
		const pathToDelete = this.confirmingDeletePath;
		this.confirmingDeletePath = null;
		if (!pathToDelete) return;
		const result = await deleteSessionFile(pathToDelete);
		if (result.ok) {
			const msg = result.method === 'trash' ? 'Session moved to trash' : 'Session deleted';
			this.statusMessage = { type: 'info', message: msg };
			if (this.currentSessions) this.currentSessions = this.currentSessions.filter((s) => s.path !== pathToDelete);
			if (this.allSessions) this.allSessions = this.allSessions.filter((s) => s.path !== pathToDelete);
			this.applyFilterSort();
		} else {
			this.statusMessage = { type: 'error', message: `Failed to delete: ${result.error ?? 'Unknown error'}` };
		}
		this.deps.requestRender();
	}

	private applyFilterSort(): void {
		const base = this.scope === 'all' ? this.allSessions ?? [] : this.currentSessions;
		const trimmed = this.query.getValue().trim();
		const showThreaded = this.sortMode === 'threaded' && !trimmed;

		this.statusMessage = null;
		if (showThreaded) {
			const named = this.nameFilter === 'all' ? base : base.filter((s) => hasSessionName(s));
			this.flatNodes = flattenSessionTree(buildSessionTree(named));
		} else {
			const filtered = filterAndSortSessions(base, this.query.getValue(), this.sortMode, this.nameFilter);
			this.flatNodes = filtered.map((session) => ({ session, depth: 0, isLast: true, ancestorContinues: [] }));
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.flatNodes.length - 1));
	}

	private async loadScope(scope: Scope, reason: 'initial' | 'toggle' | 'refresh'): Promise<void> {
		const loadKey = scope === 'current' ? 'currentLoad' : 'allLoad';
		this[loadKey] = { loading: true, error: null };
		this.deps.requestRender();

		const seq = scope === 'all' ? ++this.allLoadSeq : undefined;
		const loader = scope === 'current' ? this.deps.currentSessionsLoader : this.deps.allSessionsLoader;
		try {
			const sessions = await loader();
			if (seq !== undefined && seq !== this.allLoadSeq) return;
			if (scope === 'current') this.currentSessions = sessions;
			else this.allSessions = sessions;
			this[loadKey] = { loading: false, error: null };
			if (scope === this.scope) this.applyFilterSort();
		} catch (err) {
			if (seq !== undefined && seq !== this.allLoadSeq) return;
			this[loadKey] = { loading: false, error: err instanceof Error ? err.message : String(err) };
			if (reason === 'initial' && scope === this.scope) this.applyFilterSort();
		}
		this.deps.requestRender();
	}
}
