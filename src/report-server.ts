/**
 * 报告静态服务：把报告目录下的 HTML 报告通过本机 HTTP 暴露，
 * 飞书只推一个链接即可查看完整内容（与看板 localhost 链接同 reachability）。
 *
 * 安全边界：仅服务指定目录内的 *.html；路径穿越一律 404；随机空闲端口；
 * 默认只绑回环（报告含代码 diff，绑 0.0.0.0 会暴露到局域网）。
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

export interface ReportServer {
  /** 报告基地址，如 http://localhost:51234（拼上 /文件名 即完整链接）。 */
  baseUrl: string;
  close: () => void;
}

/** kanbanUrl 的主机名作为链接主机（与既有看板链接的可达性一致），解析失败回退 localhost。 */
function linkHost(kanbanUrl: string): string {
  try {
    return new URL(kanbanUrl).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** dirs：允许服务的报告目录（可多个，如 reviews/ 与 reports/）。 */
export function startReportServer(dirs: string | string[], kanbanUrl: string): Promise<ReportServer> {
  const roots = (Array.isArray(dirs) ? dirs : [dirs]).map((d) => path.resolve(d));
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      const pathname = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
      const name = pathname.replace(/^\/+/, '');
      // 仅允许根目录下的单层 .html 文件名，杜绝路径穿越
      if (!/^[\w.-]+\.html$/.test(name)) {
        res.writeHead(404).end('not found');
        return;
      }
      // 命中任一报告目录即服务；均不存在则 404
      const file = roots.map((root) => path.join(root, name)).find((f) => fs.existsSync(f));
      if (!file) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(400).end('bad request');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 端口 0 = 随机空闲端口，避免与看板等本地服务冲突；
    // 绑定地址跟随看板约定 HELIOS_KANBAN_HOST，默认回环（与看板默认 HOST 一致）
    const bindHost = process.env.HELIOS_KANBAN_HOST || '127.0.0.1';
    server.listen(0, bindHost, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      // 链接主机：看板在本机时沿用其主机名（与既有看板链接同 reachability）；
      // 看板是远程地址而报告服务绑在本机，则退回绑定地址，不编造局域网可达性
      const kanbanHost = linkHost(kanbanUrl);
      const host = isLoopback(kanbanHost) ? kanbanHost : bindHost;
      resolve({
        baseUrl: `http://${host}:${port}`,
        close: () => server.close(),
      });
    });
  });
}
