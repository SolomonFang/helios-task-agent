/**
 * 通用 URL 小工具（与具体业务无关的基础设施）。
 */

/** 判断 URL 主机是否为 loopback（localhost / 127.x / ::1）：推送链接在手机上不可达的场景识别用。 */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || h.startsWith('127.');
  } catch {
    return false;
  }
}
