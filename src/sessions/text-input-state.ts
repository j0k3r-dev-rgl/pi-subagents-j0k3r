/**
 * Minimal single-line text input state for the Subagents Sessions search box.
 *
 * Pi's `/resume` uses the `Input` component from `@earendil-works/pi-tui`, which
 * the extension does not depend on. This is a small, dependency-free stand-in
 * exposing the surface the selector needs: a value, a cursor, movement, editing,
 * and a render line. The selector truncates the rendered line itself.
 */
export class TextInputState {
	value = '';
	cursor = 0;
	focused = false;

	constructor(value = '') {
		this.setValue(value);
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = value.length;
	}

	getValue(): string {
		return this.value;
	}

	insert(text: string): void {
		if (!text) return;
		this.value = `${this.value.slice(0, this.cursor)}${text}${this.value.slice(this.cursor)}`;
		this.cursor += text.length;
	}

	backspace(): void {
		if (this.cursor <= 0) return;
		this.value = `${this.value.slice(0, this.cursor - 1)}${this.value.slice(this.cursor)}`;
		this.cursor -= 1;
	}

	deleteForward(): void {
		if (this.cursor >= this.value.length) return;
		this.value = `${this.value.slice(0, this.cursor)}${this.value.slice(this.cursor + 1)}`;
	}

	moveLeft(): void {
		this.cursor = Math.max(0, this.cursor - 1);
	}

	moveRight(): void {
		this.cursor = Math.min(this.value.length, this.cursor + 1);
	}

	home(): void {
		this.cursor = 0;
	}

	end(): void {
		this.cursor = this.value.length;
	}

	/** Delete the word before the cursor (ctrl+w style). */
	deleteWordBackward(): void {
		if (this.cursor <= 0) return;
		let i = this.cursor;
		while (i > 0 && /\s/.test(this.value[i - 1]!)) i -= 1;
		while (i > 0 && !/\s/.test(this.value[i - 1]!)) i -= 1;
		this.value = `${this.value.slice(0, i)}${this.value.slice(this.cursor)}`;
		this.cursor = i;
	}

	clear(): void {
		this.value = '';
		this.cursor = 0;
	}

	/** Render as `> <before>▏<after>` when focused, else `> <value>`. */
	render(): string {
		const prompt = '> ';
		if (!this.focused) return `${prompt}${this.value}`;
		const before = this.value.slice(0, this.cursor);
		const after = this.value.slice(this.cursor);
		return `${prompt}${before}▏${after}`;
	}
}
