export function visibleWidth(text: string): number {
  return [...text.replace(/\u001b\][^\u001b\u0007]*(?:\u001b\\|\u0007)|\u001b\[[0-?]*[ -/]*[@-~]/g, '')].length;
}

export function truncateToWidth(text: string, width: number): string {
  const chars = [...text];
  return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : text;
}

export function wrapLineToWidth(line: string, width: number): string[] {
  const max = Math.max(1, width);
  if (!line) return [''];
  if ([...line].length <= max) return [line];
  const out: string[] = [];
  let current = '';
  for (const word of line.split(/\s+/).filter(Boolean)) {
    const wordLength = [...word].length;
    const currentLength = [...current].length;
    if (!current) {
      if (wordLength <= max) {
        current = word;
      } else {
        const chars = [...word];
        for (let index = 0; index < chars.length; index += max) out.push(chars.slice(index, index + max).join(''));
      }
      continue;
    }
    if (currentLength + 1 + wordLength <= max) {
      current += ` ${word}`;
      continue;
    }
    out.push(current);
    current = '';
    if (wordLength <= max) {
      current = word;
    } else {
      const chars = [...word];
      for (let index = 0; index < chars.length; index += max) out.push(chars.slice(index, index + max).join(''));
    }
  }
  if (current) out.push(current);
  return out.length ? out : [''];
}
