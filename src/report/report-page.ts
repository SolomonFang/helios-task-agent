/**
 * HTML 报告公共页框与基础样式：work-summary（report.ts）与 AI 审查（review-report.ts）
 * 两份自包含报告共用同一套 reset / body 字体 / .page 页框 / .hero 头卡 / 药丸徽章 /
 * 等宽代码片基底；页面专属区块样式由各自渲染器注入（拼在 BASE_CSS 之后，可覆盖基底）。
 * 报告全部内联样式：无外部资源、无 JS。
 */

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

/**
 * 两份报告的公共基底 CSS。页面差异（背景色、行高、页宽、hero 渐变/留白、徽章配色、
 * 代码片尺寸）留在各自渲染器的区块样式里。注意 .badge/.sev、.chips code/.md code
 * 是两套页面各自的类名，基底同时列出——未用到的选择器在对应页面里天然惰性。
 */
const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #1f2937;
    padding: 32px 16px 64px;
  }
  .page { margin: 0 auto; }
  .hero {
    color: #fff;
    border-radius: 16px;
    box-shadow: 0 8px 24px rgba(99, 102, 241, 0.25);
  }
  .hero h1 { letter-spacing: 1px; }
  .hero .subtitle { margin-top: 6px; opacity: 0.95; }
  .hero .gen { font-size: 12px; opacity: 0.75; }
  /* 药丸徽章基底（report 的 .badge / review 的 .sev 共用） */
  .badge, .sev {
    font-size: 12px;
    font-weight: 600;
    border-radius: 999px;
    padding: 2px 10px;
    white-space: nowrap;
  }
  /* 等宽代码片基底（report 的 .chips code / review 的 .md code 共用） */
  .chips code, .md code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    color: #374151;
  }
`;

/**
 * 报告页框：<html>/<head>/<style> 骨架 + .page 容器。
 * title 由调用方先行 escapeHtml（两处调用点的转义口径不同，不在这里二转义）。
 */
export function renderReportPage(opts: { title: string; css: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${opts.title}</title>
<style>${BASE_CSS}${opts.css}</style>
</head>
<body>
<div class="page">
${opts.body}
</div>
</body>
</html>
`;
}
