import type { ToolHandler } from '../../types';
import { wrapUntrusted } from '../guard';
import { collectWorkSummary, type WorkSummaryData, type WorkSummaryScope } from '../../kanban/summary';
import { summarizeForChat, writeSummaryReports } from '../../report/report';
import { makeReportHandler, type ReportToolDeps } from './report-tool';

/** work_summary handler：生成工作总结报告；bot 场景传 reportLinkBaseUrl 改推 HTTP 链接。 */
export function makeWorkSummaryHandler({
  kanbanUrl,
  kanbanProjectId,
  kanbanIteration,
  reportLinkBaseUrl,
  channel,
}: ReportToolDeps): ToolHandler {
  return makeReportHandler<WorkSummaryData>({
    tag: 'work_summary',
    action: '生成工作总结',
    collect: (raw) => {
      const iteration = (typeof raw.iteration === 'string' && raw.iteration.trim()) || kanbanIteration || '';
      const scopeArg = typeof raw.scope === 'string' ? raw.scope : '';
      let scope: WorkSummaryScope;
      if (scopeArg === 'iteration' || scopeArg === 'today' || scopeArg === 'all') scope = scopeArg;
      else scope = iteration ? 'iteration' : 'today';
      if (scope === 'iteration' && !iteration) scope = 'today';
      return collectWorkSummary({
        kanbanUrl,
        projectId: kanbanProjectId || undefined,
        iteration: iteration || undefined,
        scope,
      });
    },
    render: async (data, raw) => {
      const format = raw.format === 'html' || raw.format === 'md' ? raw.format : 'both';
      const paths = await writeSummaryReports(data, { format });
      const empty = data.tasks.length
        ? ''
        : '该范围内没有匹配的任务，已生成空报告（各项为 0）。\n\n';
      // 报告内容源自看板数据（任务标题/摘要等），UNTRUSTED 包裹
      return wrapUntrusted(empty + summarizeForChat(data, paths, { linkBaseUrl: reportLinkBaseUrl, channel }));
    },
  });
}
