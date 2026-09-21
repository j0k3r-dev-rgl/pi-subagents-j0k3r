const MAX_SUBAGENT_SESSION_TITLE_LENGTH = 100;

/**
 * Normalize an orchestrator-supplied nested session title: strip control and
 * format characters, collapse whitespace, and cap the length so the session
 * picker stays readable. Returns undefined when nothing meaningful remains.
 */
export function cleanSessionTitle(text: string | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_SUBAGENT_SESSION_TITLE_LENGTH
    ? cleaned.slice(0, MAX_SUBAGENT_SESSION_TITLE_LENGTH).trim()
    : cleaned;
}

