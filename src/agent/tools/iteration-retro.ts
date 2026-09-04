import type { ToolHandler } from '../../types';
import { wrapUntrusted } from '../guard';
import { collectWorkSummary } from '../../kanban/summary';
import { buildRetroModel, buildRetroSummary, writeRetroReport } from '../../report/retro';
import { errMessage } from '../../infra/err';

/** iteration_retro handler：迭代复盘报告（概览/吞吐/失败规则归类/改动统计），复用 work-summary 采集。 */
export function makeIterationRetroHandler({
  kanbanUrl,
  kanbanProjectId,
  kanbanIteration,
  reportLinkBaseUrl,
}: {
  kanbanUrl: string;
  kanbanProjectId?: string;
  kanbanIteration?: string;
  reportLinkBaseUrl?: string;
}): ToolHandler {
  return async (raw) => {
    const iteration =
      (typeof raw.iteration === 'string' && raw.iteration.trim()) || kanbanIteration || '';
    try {
      const data = await collectWorkSummary({
        kanbanUrl,
        projectId: kanbanProjectId || undefined,
        iteration: iteration || undefined,
        // 未配置且未指定迭代时覆盖全部任务，报告口径标注为「全部任务」，不硬编迭代号
        scope: iteration ? 'iteration' : 'all',
      });
      const model = buildRetroModel(data);
      const htmlPath = writeRetroReport(model);
      // 报告内容源自看板数据（任务标题/摘要等），UNTRUSTED 包裹
      return wrapUntrusted(buildRetroSummary(model, { htmlPath, linkBaseUrl: reportLinkBaseUrl }));
    } catch (err) {
      // 看板地址（本机 localhost，bot 用户打不开）与英文报错原文不落用户面；原文进 HTA_DEBUG 日志
      if (process.env.HTA_DEBUG) console.error(`[iteration_retro] 报错原文：${errMessage(err)}`);
      return '生成迭代复盘失败：看板服务暂时无响应，请稍后重试；持续失败请联系部署者检查看板服务。';
    }
  };
}
