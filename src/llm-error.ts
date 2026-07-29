/**
 * LLM 请求失败的友好指引：把原始 API 错误映射为可操作的排查建议。
 * 命中返回提示文案；未命中返回 null（展示原始错误）。
 */
export function friendlyLlmError(raw: string): string | null {
  const s = raw.toLowerCase();
  if (/\b401\b|unauthorized|invalid[_ ]api[_ ]key|incorrect api key|authentication/.test(s)) {
    return '排查建议：API Key 无效或已过期。用 /config 重新配置，或检查 ~/.helios-task-agent/.env 的 LLM_API_KEY。';
  }
  if (/context length|maximum context|context_window|too many tokens|reduce the length|exceed.*token/.test(s)) {
    return '排查建议：对话上下文超出模型上限。/clear 清空历史后重试（或把任务拆小分步执行）。';
  }
  if (/\b429\b|rate limit|too many requests|quota|insufficient|余额|额度/.test(s)) {
    return '排查建议：模型限流或额度不足。稍后重试，或检查账户额度/余额。';
  }
  if (/model[_ ].*not found|no such model|does not exist|invalid[_ ]model/.test(s)) {
    return '排查建议：模型名不存在或当前 Key 无权访问。用 /config 检查 LLM_MODEL。';
  }
  if (/econnrefused|enotfound|fetch failed|network|timed out|etimedout|socket hang up/.test(s)) {
    return '排查建议：无法连接模型服务。检查 LLM_BASE_URL 与网络（代理）后重试。';
  }
  return null;
}
