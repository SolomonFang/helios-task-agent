import type { ToolHandler } from '../../types';
import { wrapUntrusted } from '../guard';
import { collectWorkSummary, type WorkSummaryData } from '../../kanban/summary';
import { buildRetroModel, buildRetroSummary, writeRetroReport } from '../../report/retro';
import { makeReportHandler, type ReportToolDeps } from './report-tool';

/** iteration_retro handler：迭代复盘报告（概览/吞吐/失败规则归类/改动统计），复用 work-summary 采集。 */
export function makeIterationRetroHandler({
  kanbanUrl,
  kanbanProjectId,
  kanbanIteration,
  reportLinkBaseUrl,
  channel,
}: ReportToolDeps): ToolHandler {
  return makeReportHandler<WorkSummaryData>({
    tag: 'iteration_retro',
    action: '生成迭代复盘',
    collect: (raw) => {
      const iteration = (typeof raw.iteration === 'string' && raw.iteration.trim()) || kanbanIteration || '';
      return collectWorkSummary({
        kanbanUrl,
        projectId: kanbanProjectId || undefined,
        iteration: iteration || undefined,
        // 未配置且未指定迭代时覆盖全部任务，报告口径标注为「全部任务」，不硬编迭代号
        scope: iteration ? 'iteration' : 'all',
      });
    },
    render: async (data) => {
      const model = buildRetroModel(data);
      const htmlPath = await writeRetroReport(model);
      // 报告内容源自看板数据（任务标题/摘要等），UNTRUSTED 包裹
      return wrapUntrusted(buildRetroSummary(model, { htmlPath, linkBaseUrl: reportLinkBaseUrl, channel }));
    },
  });
}
