export function visibleWidth(text: string): number {
  return [...text.replace(/\u001b\][^\u001b\u0007]*(?:\u001b\\|\u0007)|\u001b\[[0-?]*[ -/]*[@-~]/g, '')].length;
}

export function truncateToWidth(text: string, width: number): string {
  const chars = [...text];
  return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : text;
}

/** Truncate a (possibly ANSI-styled) string to a VISIBLE column width,
 * preserving escape sequences. Use this over `truncateToWidth` when the input
 * contains ANSI styling (e.g. a fully-themed selector row). */
export function truncateToVisibleWidth(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  const tokens = text.match(/\u001b\][^\u001b\u0007]*(?:\u001b\\|\u0007)|\u001b\[[0-?]*[ -/]*[@-~]|[\s\S]/gu) ?? [];
  const ellipsisWidth = visibleWidth(ellipsis);
  const cap = Math.max(0, width - ellipsisWidth);
  let out = '';
  let used = 0;
  for (const token of tokens) {
    if (/^\u001b/.test(token)) { out += token; continue; }
    if (used >= cap) break;
    out += token;
    used += 1;
  }
  return out + ellipsis;
}

export function wrapLineToWidth(line: string, width: number): string[] {
  const max = Math.max(1, width);
  if (!line) return [''];
  if (visibleWidth(line) <= max) return [line];
  const tokens = line.match(/\u001b\][^\u001b\u0007]*(?:\u001b\\|\u0007)|\u001b\[[0-?]*[ -/]*[@-~]|[\s\S]/gu) ?? [];
  const lines: string[] = [];
  let current: string[] = [];
  let used = 0;
  let lastBreak = -1;

  const visibleTokenWidth = (token: string) => /^\u001b/.test(token) ? 0 : 1;
  const recompute = () => {
    used = current.reduce((sum, token) => sum + visibleTokenWidth(token), 0);
    lastBreak = -1;
    for (let index = 0; index < current.length; index += 1) if (!/^\u001b/.test(current[index]!) && /\s/.test(current[index]!)) lastBreak = index;
  };
  const pushLine = (tokensToPush: string[]) => {
    const text = tokensToPush.join('').replace(/\s+$/u, '');
    lines.push(text);
  };

  for (const token of tokens) {
    current.push(token);
    used += visibleTokenWidth(token);
    if (!/^\u001b/.test(token) && /\s/.test(token)) lastBreak = current.length - 1;
    if (used <= max) continue;
    if (lastBreak >= 0) {
      pushLine(current.slice(0, lastBreak));
      current = current.slice(lastBreak + 1);
      recompute();
      continue;
    }
    pushLine(current.slice(0, -1));
    current = [token];
    recompute();
  }
  if (current.length || !lines.length) lines.push(current.join(''));
  return lines.filter((entry, index, all) => entry.length > 0 || (index === 0 && all.length === 1));
}
