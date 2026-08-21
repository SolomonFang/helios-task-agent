/**
 * 报告静态服务：把报告目录下的 HTML 报告通过本机 HTTP 暴露，
 * 飞书只推一个链接即可查看完整内容（与看板 localhost 链接同 reachability）。
 *
 * 安全边界：仅服务指定目录内的 *.html；路径穿越一律 404；随机空闲端口；
 * 默认只绑回环（报告含代码 diff，绑 0.0.0.0 会暴露到局域网）；
 * 报告文件名带 128-bit 随机 token（foo.<token>.html）作为访问凭证：
 * 服务不做目录列举，文件名不完全匹配即 404，猜不到 token 就拉不到报告。
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

/** 报告访问 token：128-bit 随机 hex，由报告写入方拼进文件名（见 writeReviewReport / writeSummaryReports）。 */
export function newReportToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export interface ReportServer {
  /** 报告基地址，如 http://localhost:51234（拼上 /文件名 即完整链接）。 */
  baseUrl: string;
  close: () => void;
  /** 底层 http.Server（测试/诊断用，如断言 error 监听已换挂）。 */
  server: http.Server;
}

/** kanbanUrl 的主机名作为链接主机（与既有看板链接的可达性一致），解析失败回退 localhost。 */
function linkHost(kanbanUrl: string): string {
  try {
    return new URL(kanbanUrl).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}

// URL.hostname 对 IPv6 地址返回带方括号的形式（[::1]），这里两种写法都认
function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** 通配绑定地址（0.0.0.0 / ::）不能拼进链接：回退本机主机名。 */
function isWildcard(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

/** 说明页模板：卡片式中文提示（404/405/400 共用结构，只换标题与正文）。 */
function noticePage(title: string, lines: string[]): string {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + title + '</title>' +
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;' +
    'color:#1f2937;background:#f3f4f8;padding:48px 20px;line-height:1.8}' +
    '.card{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 24px;text-align:center;' +
    'box-shadow:0 2px 8px rgba(15,23,42,.06)}h1{font-size:18px;margin-bottom:12px}p{font-size:14px;color:#4b5563}</style></head>' +
    '<body><div class="card"><h1>' + title + '</h1>' +
    lines.map((l) => '<p>' + l + '</p>').join('') +
    '</div></body></html>';
}

/** 404 统一中文说明（报告按 30 天清理，链接随机端口随进程重启失效），并给出找回报告的出路。 */
const NOT_FOUND_HTML = noticePage('报告不存在或已过期', [
  '报告保留 30 天，进程重启后旧链接也会失效。',
  '请回到飞书重新发送指令，或重新点击卡片上的「AI 审查」，生成新报告。',
]);

/** 400/405 统一中文说明：请求本身没法处理时，告诉用户回飞书重新拿链接。 */
const BAD_REQUEST_HTML = noticePage('链接无法处理', [
  '链接格式不正确，请回到飞书重新获取报告链接。',
]);

/** dirs：允许服务的报告目录（可多个，如 reviews/ 与 reports/）。 */
export function startReportServer(dirs: string | string[], kanbanUrl: string): Promise<ReportServer> {
  const roots = (Array.isArray(dirs) ? dirs : [dirs]).map((d) => path.resolve(d));
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/html; charset=utf-8' }).end(BAD_REQUEST_HTML);
        return;
      }
      const pathname = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
      const name = pathname.replace(/^\/+/, '');
      // 仅允许根目录下的单层 .html 文件名，杜绝路径穿越
      if (!/^[\w.-]+\.html$/.test(name)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(NOT_FOUND_HTML);
        return;
      }
      // 命中任一报告目录即服务；均不存在则 404
      const file = roots.map((root) => path.join(root, name)).find((f) => fs.existsSync(f));
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(NOT_FOUND_HTML);
        return;
      }
      // existsSync 与读流之间有竞态（报告可能恰好被 prune 删掉）：error 无监听者会以
      // 未捕获异常打崩整个 bot 进程。headers 推迟到流成功打开再发，出错时未发则 404，
      // 已发（打开后读失败）则直接断开。
      const stream = fs.createReadStream(file);
      stream.on('open', () => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        stream.pipe(res);
      });
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(404);
        res.end();
      });
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(BAD_REQUEST_HTML);
    }
  });
  return new Promise((resolve, reject) => {
    const onBootError = (err: Error) => reject(err);
    server.once('error', onBootError);
    // 端口 0 = 随机空闲端口，避免与看板等本地服务冲突；
    // 绑定地址默认仅回环，且独立于看板的 HELIOS_KANBAN_HOST：
    // 报告含代码 diff，暴露到局域网必须显式设 HELIOS_REPORT_HOST
    const bindHost = process.env.HELIOS_REPORT_HOST || '127.0.0.1';
    server.listen(0, bindHost, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      // listen 成功后摘掉启动期的 reject 监听：promise 已 settle，留着会把 listen 之后的
      // 运行时 error 静默吞掉。换挂记日志的监听（不抛出——error 事件无监听者会打崩进程）
      server.removeListener('error', onBootError);
      server.on('error', (err) => {
        console.error(`[report] 报告服务运行时错误: ${err.message}`);
      });
      // 链接主机：看板在本机时沿用其主机名（与既有看板链接同 reachability）；
      // 看板是远程地址而报告服务绑在本机，则退回绑定地址，不编造局域网可达性；
      // 绑定地址是通配地址（0.0.0.0/::）时链接不可点击，回退本机主机名
      const kanbanHost = linkHost(kanbanUrl);
      let host = isLoopback(kanbanHost) ? kanbanHost : bindHost;
      if (isWildcard(host)) host = os.hostname();
      // IPv6 地址拼进 URL 必须带方括号（如 http://[::1]:51234），否则是无效地址
      const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      resolve({
        baseUrl: `http://${urlHost}:${port}`,
        close: () => server.close(),
        server,
      });
    });
  });
}
