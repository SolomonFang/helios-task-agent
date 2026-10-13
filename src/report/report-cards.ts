/**
 * 清单类报告（work-summary / 迭代复盘 / 日报）共享的渲染件：
 * 统计卡 HTML、生成时间格式化、三页雷同的 CSS 区块单源。
 * 公共页框与基底样式见 report-page.ts；本模块的 REPORT_CARDS_CSS 拼在页面专属
 * 样式之前（renderReportPage 的 css 参数），页面用同选择器规则覆盖差异项。
 * 与 BASE_CSS 同一约定：未被某页用到的选择器在该页天然惰性。
 */

/** 数据层 generatedAt 保持 ISO（文件名反解依赖它）；仅渲染层转本地可读时间。 */
export function formatGeneratedAt(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export function htmlStatCard(num: string, label: string, cls = ''): string {
  return `<div class="stat${cls ? ` ${cls}` : ''}"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
}

/**
 * 三份清单报告完全雷同的 CSS 区块。页面差异（hero 渐变、.card/.diff-link 的留白、
 * 徽章配色、复盘特有的 .dist/.stat.warn 等）留在各自渲染器的 *_PAGE_CSS 里覆盖/补充。
 */
export const REPORT_CARDS_CSS = `
  body { background: #f3f4f8; line-height: 1.6; }
  .page { max-width: 880px; }
  .hero { padding: 36px 40px; }
  .hero h1 { font-size: 28px; }
  .hero .subtitle { font-size: 17px; }
  .hero .gen { margin-top: 10px; }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 12px;
    margin: 20px 0 8px;
  }
  .stat {
    background: #fff;
    border-radius: 12px;
    padding: 16px;
    text-align: center;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  }
  .stat-num { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .stat.add .stat-num { color: #16a34a; }
  .stat.del .stat-num { color: #dc2626; }
  .group { margin-top: 28px; }
  .group h2 { font-size: 18px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .count {
    font-size: 12px;
    font-weight: 600;
    background: #e5e7eb;
    color: #4b5563;
    border-radius: 999px;
    padding: 1px 9px;
  }
  .card {
    background: #fff;
    border-radius: 12px;
    padding: 18px 20px;
    margin-bottom: 12px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  }
  .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .card-head h3 { font-size: 16px; flex: 1; }
  .meta-line { font-size: 12px; color: #9ca3af; margin-top: 2px; }
  .summary { font-size: 14px; color: #4b5563; margin-top: 8px; white-space: normal; }
  .changes { font-size: 13px; margin-top: 8px; color: #6b7280; }
  .diff-link {
    display: inline-block;
    margin-top: 12px;
    font-size: 13px;
    font-weight: 600;
    color: #6366f1;
    text-decoration: none;
    border: 1px solid #c7d2fe;
    border-radius: 8px;
    padding: 4px 14px;
  }
  .diff-link:hover { background: #eef2ff; }
  .empty { text-align: center; color: #9ca3af; margin-top: 40px; }
  .notes { margin-top: 32px; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  .notes li { margin-left: 18px; }
`;
