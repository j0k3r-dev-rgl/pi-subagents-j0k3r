import { describe, expect, it } from 'vitest';
import { cleanSessionTitle } from '../src/session-metadata.js';

describe('cleanSessionTitle', () => {
  it('collapses whitespace and trims an orchestrator-supplied title', () => {
    expect(cleanSessionTitle('  Audit\nthe\tauth\n\nflow  ')).toBe('Audit the auth flow');
  });

  it('strips control and format characters', () => {
    expect(cleanSessionTitle('Review\u0000\u200b auth\uFEFF flows')).toBe('Review auth flows');
  });

  it('caps the title length so the session picker stays readable', () => {
    const longTitle = 'Fix '.repeat(60) + ' trailing phrase';
    const cleaned = cleanSessionTitle(longTitle)!;
    expect(cleaned.length).toBeLessThanOrEqual(100);
    expect(cleaned).toBe(longTitle.replace(/\s+/g, ' ').trim().slice(0, 100).trim());
  });

  it('returns undefined for missing, empty, or whitespace-only input', () => {
    expect(cleanSessionTitle(undefined)).toBeUndefined();
    expect(cleanSessionTitle('')).toBeUndefined();
    expect(cleanSessionTitle('   \n\t ')).toBeUndefined();
  });
});
