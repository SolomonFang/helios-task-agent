/**
 * 通用 URL 小工具（与具体业务无关的基础设施）。
 */

/** 判断主机名是否为 loopback；兼容 WHATWG URL 返回的 IPv6 方括号形态。 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** 判断 URL 主机是否为 loopback（localhost / 127.x / ::1）：推送链接在手机上不可达的场景识别用。 */
export function isLoopbackUrl(raw: string): boolean {
  try {
    return isLoopbackHostname(new URL(raw).hostname);
  } catch {
    return false;
  }
}
