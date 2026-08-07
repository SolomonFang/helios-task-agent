/**
 * 飞书自建应用凭证联网校验（onboarding 自检）：
 * 先换 tenant_access_token 验证 App ID/Secret，再查机器人信息确认「机器人」能力已启用。
 * 目标：凭证/能力问题在向导里立刻暴露，而不是等到长连接失败才排查。
 */

import { errMessage } from './err';

export interface FeishuVerifyResult {
  ok: boolean;
  /** 机器人应用名（校验通过时用于回显确认）。 */
  botName?: string;
  /** 失败原因 + 排查建议（面向最终用户）。 */
  message: string;
}

const OPEN_BASE = 'https://open.feishu.cn';

export async function verifyFeishuApp(appId: string, appSecret: string, timeoutMs = 8000): Promise<FeishuVerifyResult> {
  let token: string;
  try {
    const res = await fetch(`${OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };
    if (json.code !== 0 || !json.tenant_access_token) {
      return {
        ok: false,
        message: `App ID / App Secret 无效（${json.msg || `code=${json.code}`}）。请到开发者后台 → 凭证与基础信息重新复制。`,
      };
    }
    token = json.tenant_access_token;
  } catch (err) {
    return {
      ok: false,
      message: `无法连接 open.feishu.cn（${errMessage(err)}）。检查网络后重试，或选择仍然保存。`,
    };
  }

  try {
    const res = await fetch(`${OPEN_BASE}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { code?: number; msg?: string; bot?: { app_name?: string } };
    if (json.code !== 0) {
      return {
        ok: false,
        message: `凭证有效，但「机器人」能力未启用（${json.msg || `code=${json.code}`}）。请到开发者后台 → 应用能力 → 添加「机器人」，并发布版本。`,
      };
    }
    return { ok: true, botName: json.bot?.app_name, message: 'ok' };
  } catch (err) {
    return {
      ok: false,
      message: `机器人信息查询失败（${errMessage(err)}）。可重试，或选择仍然保存。`,
    };
  }
}
