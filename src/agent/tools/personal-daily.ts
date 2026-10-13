import type { ToolHandler } from '../../types';
import { wrapUntrusted } from '../guard';
import { collectDailyData, type DailyReportData } from '../../kanban/summary';
import { buildDailyMaterial, isFutureReportDate, resolveReportDate, writeDailyReport } from '../../report/daily-report';
import { makeReportHandler, type ReportToolDeps } from './report-tool';

/** daily_report handler：采集某日看板活动素材（+ 可选 HTML 日报），供 LLM 组织个人工作日报。 */
export function makeDailyReportHandler({
  kanbanUrl,
  kanbanProjectId,
  kanbanIteration,
  reportLinkBaseUrl,
  channel,
}: ReportToolDeps): ToolHandler {
  return makeReportHandler<DailyReportData>({
    tag: 'daily_report',
    action: '生成日报',
    collect: async (raw) => {
      const date = resolveReportDate(raw.date);
      if (!date) {
        if (isFutureReportDate(raw.date)) {
          return '该日期尚未到来：只能生成今天或过去日期的日报。';
        }
        return '日期参数无法识别：支持「今天」「昨天」或 YYYY-MM-DD（如 2026-09-01）；省略默认为今天。';
      }
      // 迭代口径与 work_summary 一致：参数优先，缺省用配置的默认迭代，未配置则全部任务
      const iteration = (typeof raw.iteration === 'string' && raw.iteration.trim()) || kanbanIteration || '';
      return collectDailyData({
        kanbanUrl,
        projectId: kanbanProjectId || undefined,
        iteration: iteration || undefined,
        date,
      });
    },
    render: async (data, raw) => {
      const htmlPath = raw.html !== false ? await writeDailyReport(data) : undefined;
      // 素材内容源自看板数据（任务标题/摘要等），UNTRUSTED 包裹
      return wrapUntrusted(buildDailyMaterial(data, { htmlPath, linkBaseUrl: reportLinkBaseUrl, channel }));
    },
  });
}
