export function resolveCurrentSessionId(ctx: any): string | undefined {
  const managerId = ctx?.sessionManager?.getSessionId?.();
  if (typeof managerId === 'string' && managerId.length > 0) return managerId;

  const direct = ctx?.sessionId;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const file = ctx?.sessionManager?.getSessionFile?.();
  return typeof file === 'string' && file.length > 0 ? file : undefined;
}
