export function hasToolGlob(pattern: string): boolean {
  return pattern.includes('*');
}

function wildcardToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

export function matchesToolPattern(toolName: string, pattern: string): boolean {
  return hasToolGlob(pattern) ? wildcardToRegExp(pattern).test(toolName) : toolName === pattern;
}

export function isSubagentToolName(toolName: string): boolean {
  return toolName.startsWith('subagent_');
}

/**
 * Expand asterisk patterns against the tool names available in the parent Pi session.
 * Exact names remain unchanged so unknown non-pattern names retain existing behavior.
 * Asterisk patterns fail closed when the available tool list is unavailable.
 */
export function expandToolPatterns(patterns: readonly string[], availableToolNames?: readonly string[]): string[] {
  const available = availableToolNames ? [...new Set(availableToolNames)] : undefined;
  const expanded: string[] = [];
  const add = (name: string) => {
    if (isSubagentToolName(name) || expanded.includes(name)) return;
    expanded.push(name);
  };

  for (const pattern of patterns) {
    if (hasToolGlob(pattern)) {
      if (!available) continue;
      for (const toolName of available) {
        if (matchesToolPattern(toolName, pattern)) add(toolName);
      }
      continue;
    }
    add(pattern);
  }
  return expanded;
}
