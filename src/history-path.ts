import os from 'node:os';
import path from 'node:path';

export function resolveSubagentsHistoryHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_SUBAGENTS_HISTORY_HOME) return path.resolve(env.PI_SUBAGENTS_HISTORY_HOME);
  const xdg = env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, 'pi', 'subagents') : path.join(os.homedir(), '.local', 'share', 'pi', 'subagents');
}

export function resolveSubagentHistoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_SUBAGENTS_HISTORY_DB_PATH) return path.resolve(env.PI_SUBAGENTS_HISTORY_DB_PATH);
  return path.join(resolveSubagentsHistoryHome(env), 'subagents-history.sqlite');
}
