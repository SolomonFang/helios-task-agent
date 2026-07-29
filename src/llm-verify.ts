/**
 * LLM 配置联网预检（向导用）：GET {base}/models 验证 Base URL 与 API Key。
 * 与飞书凭证校验同一目标：配置错误在向导里立刻暴露，而不是等首次对话 401。
 *
 * OpenAI 兼容端点普遍实现 /models；少数兼容网关不实现或路径不同——
 * 这种情况标记 uncertain（无法预检），由用户选择仍保存，不误拦。
 */

export interface LlmVerifyResult {
  ok: boolean;
  /** true = 无法确定（端点不支持预检 / 网络不通），用户可选择仍保存。 */
  uncertain?: boolean;
  message: string;
}

export async function verifyLlmConfig(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 8000,
): Promise<LlmVerifyResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, message: 'ok' };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `API Key 无效或无权访问（HTTP ${res.status}）。请检查 Key 是否复制完整、是否已过期。`,
      };
    }
    return {
      ok: false,
      uncertain: true,
      message: `端点未实现 /models 预检（HTTP ${res.status}）。部分兼容网关如此，不代表配置有误。`,
    };
  } catch (err) {
    return {
      ok: false,
      uncertain: true,
      message: `无法连接 ${baseUrl}（${err instanceof Error ? err.message : String(err)}）。检查网络 / 代理后重试，或选择仍然保存。`,
    };
  }
}
