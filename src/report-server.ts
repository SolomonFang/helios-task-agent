/**
 * 报告静态服务：把 reviews/ 目录下的 HTML 报告通过本机 HTTP 暴露，
 * 飞书只推一个链接即可查看完整内容（与看板 localhost 链接同 reachability）。
 *
 * 安全边界：仅服务指定目录内的 *.html；路径穿越一律 404；随机空闲端口。
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

export function startReportServer(dir: string, kanbanUrl: string): Promise<ReportServer> {
  const root = path.resolve(dir);
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
      const file = path.join(root, name);
      if (path.dirname(file) !== root || !fs.existsSync(file)) {
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
    // 端口 0 = 随机空闲端口，避免与看板等本地服务冲突；绑 0.0.0.0 与看板默认 HOST 行为一致
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://${linkHost(kanbanUrl)}:${port}`,
        close: () => server.close(),
      });
    });
  });
}
