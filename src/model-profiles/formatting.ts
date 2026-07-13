import type { SubagentModelProfile } from '../types.js';
import { globalSubagentsConfigPath } from './data.js';

export function buildNoChangesModelProfilesMessage(agentDir?: string): string {
  return `No subagent model profile changes to save. Nothing written to ${globalSubagentsConfigPath(agentDir)}.`;
}

function stripTerminalEscapes(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\][^\u001b]*(?:\u001b\\|\u0007)/g, '');
}

export function visibleWidth(text: string): number {
  return stripTerminalEscapes(text).length;
}

export function truncateToVisibleWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return '…';
  let output = '';
  let visible = 0;
  for (let index = 0; index < text.length;) {
    if (text[index] === '\u001b') {
      const csi = text.slice(index).match(/^\u001b\[[0-9;]*m/);
      if (csi) {
        output += csi[0];
        index += csi[0].length;
        continue;
      }
      const osc = text.slice(index).match(/^\u001b\][^\u001b]*(?:\u001b\\|\u0007)/);
      if (osc) {
        output += osc[0];
        index += osc[0].length;
        continue;
      }
    }
    if (visible >= width - 1) break;
    output += text[index];
    visible += 1;
    index += 1;
  }
  return `${output}…`;
}

export function constrainLines(lines: string[], width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width || 1));
  return lines.map((line) => truncateToVisibleWidth(line, safeWidth));
}

export function padToVisibleWidth(text: string, width: number): string {
  const clipped = truncateToVisibleWidth(text, width);
  return `${clipped}${' '.repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export function frameModal(title: string, body: string[], width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width || 1));
  if (safeWidth < 24) return constrainLines([title, ...body], safeWidth);
  const innerWidth = safeWidth - 2;
  const contentWidth = Math.max(1, innerWidth - 2);
  const titleText = ` ${title} `;
  const visibleTitle = truncateToVisibleWidth(titleText, Math.max(1, innerWidth));
  const top = `╭${visibleTitle}${'─'.repeat(Math.max(0, innerWidth - visibleWidth(visibleTitle)))}╮`;
  const bottom = `╰${'─'.repeat(innerWidth)}╯`;
  return [top, ...body.map((line) => `│ ${padToVisibleWidth(line, contentWidth)} │`), bottom];
}

export function pendingLabel(count: number): string {
  if (count === 0) return 'pending: none';
  return `pending: ${count} change${count === 1 ? '' : 's'}`;
}

export function normalizeModalKey(data: string): string {
  if (data === '\r' || data === '\n') return 'enter';
  if (data === '\u001b') return 'esc';
  if (data === '\u001b[A') return 'up';
  if (data === '\u001b[B') return 'down';
  if (data === '\u001b[H') return 'home';
  if (data === '\u001b[F') return 'end';
  return data;
}

export function profileLabel(profile: SubagentModelProfile | undefined, field: 'model' | 'effort'): string | undefined {
  if (!profile) return undefined;
  if (field === 'model') return profile.model ? `${profile.model.provider}/${profile.model.id}` : undefined;
  return profile.effort;
}
