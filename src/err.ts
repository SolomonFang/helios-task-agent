/**
 * 统一把 unknown 错误揉成单行文案：Error 取 message，其余 String() 兜底。
 * 替代全仓散落的 `err instanceof Error ? err.message : String(err)` 手写点。
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
