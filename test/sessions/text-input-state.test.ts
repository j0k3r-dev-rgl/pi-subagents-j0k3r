import { describe, it, expect } from 'vitest';
import { TextInputState } from '../../src/sessions/text-input-state.js';

describe('TextInputState', () => {
	it('inserts at the cursor and advances it', () => {
		const t = new TextInputState();
		t.insert('auth');
		expect(t.value).toBe('auth');
		expect(t.cursor).toBe(4);
		t.cursor = 2;
		t.insert('X');
		expect(t.value).toBe('auXth');
		expect(t.cursor).toBe(3);
	});

	it('backspace removes the char before the cursor', () => {
		const t = new TextInputState('abc');
		t.cursor = 2;
		t.backspace();
		expect(t.value).toBe('ac');
		expect(t.cursor).toBe(1);
	});

	it('deleteForward removes the char at the cursor', () => {
		const t = new TextInputState('abc');
		t.cursor = 1;
		t.deleteForward();
		expect(t.value).toBe('ac');
		expect(t.cursor).toBe(1);
	});

	it('moves the cursor with left/right/home/end clamped to bounds', () => {
		const t = new TextInputState('abc');
		t.home();
		expect(t.cursor).toBe(0);
		t.moveLeft();
		expect(t.cursor).toBe(0);
		t.end();
		expect(t.cursor).toBe(3);
		t.moveRight();
		expect(t.cursor).toBe(3);
	});

	it('deleteWordBackward removes the previous word and trailing spaces', () => {
		const t = new TextInputState('foo bar  baz');
		t.end();
		t.deleteWordBackward();
		expect(t.value).toBe('foo bar  ');
		t.deleteWordBackward();
		expect(t.value).toBe('foo ');
	});

	it('clear empties value and resets cursor', () => {
		const t = new TextInputState('abc');
		t.clear();
		expect(t.value).toBe('');
		expect(t.cursor).toBe(0);
	});

	it('renders with a cursor marker when focused', () => {
		const t = new TextInputState('auth');
		t.focused = true;
		t.cursor = 2;
		expect(t.render()).toBe('> au▏th');
		t.focused = false;
		expect(t.render()).toBe('> auth');
	});
});
