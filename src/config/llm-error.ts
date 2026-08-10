/**
 * LLM 请求失败的友好指引：把原始 API 错误映射为可操作的排查建议。
 * 命中返回提示文案；未命中返回 null（展示原始错误）。
 * channel：终端有 /config；bot 没有该命令，首选 helios-task-agent bot --reconfig 重配，也可改 .env 后重启——建议必须指向存在的操作。
 */
import { userEnvPath } from './config';
import { CONTEXT_OVERFLOW_RE } from '../agent/llm';

export function friendlyLlmError(raw: string, opts: { channel?: 'cli' | 'bot' } = {}): string | null {
  const s = raw.toLowerCase();
  const envFile = userEnvPath();
  const reconfig = 'helios-task-agent bot --reconfig';
  const keyHint =
    opts.channel === 'bot'
      ? `运行 ${reconfig} 重新配置（推荐），或编辑 ${envFile} 的 LLM_API_KEY 后重启 bot。`
      : `用 /config 重新配置，或检查 ${envFile} 的 LLM_API_KEY。`;
  const modelHint =
    opts.channel === 'bot'
      ? `运行 ${reconfig} 检查 LLM_MODEL（推荐），或编辑 ${envFile} 后重启 bot。`
      : '用 /config 检查 LLM_MODEL。';
  if (/\b401\b|unauthorized|invalid[_ ]api[_ ]key|incorrect api key|authentication/.test(s)) {
    return `排查建议：API Key 无效或已过期。${keyHint}`;
  }
  // 上下文超限特征与 agent/llm.ts 单源复用（CONTEXT_OVERFLOW_RE），自愈失败的用户也能拿到 /clear 指引
  if (CONTEXT_OVERFLOW_RE.test(s)) {
    return '排查建议：对话上下文超出模型上限。/clear 清空历史后重试（或把任务拆小分步执行）。';
  }
  if (/\b429\b|rate limit|too many requests|quota|insufficient|余额|额度/.test(s)) {
    return '排查建议：模型限流或额度不足。稍后重试，或检查账户额度/余额。';
  }
  if (/model[_ ].*not found|no such model|does not exist|invalid[_ ]model/.test(s)) {
    return `排查建议：模型名不存在或当前 Key 无权访问。${modelHint}`;
  }
  if (/econnrefused|enotfound|fetch failed|network|timed out|etimedout|socket hang up/.test(s)) {
    const baseHint =
      opts.channel === 'bot'
        ? `运行 ${reconfig} 检查 LLM_BASE_URL（或编辑 ${envFile} 后重启 bot）`
        : '检查 LLM_BASE_URL（可用 /config 修改）';
    return `排查建议：无法连接模型服务。请${baseHint}，并确认网络/代理可用后重试。`;
  }
  return null;
}
