import type { ToolHandler } from '../../types';
import { wrapUntrusted } from '../guard';
import { collectWorkSummary, type WorkSummaryScope } from '../../kanban/summary';
import { summarizeForChat, writeSummaryReports } from '../../report/report';
import { errMessage } from '../../infra/err';

/** work_summary handler：生成工作总结报告；bot 场景传 reportLinkBaseUrl 改推 HTTP 链接。 */
export function makeWorkSummaryHandler({
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
    const scopeArg = typeof raw.scope === 'string' ? raw.scope : '';
    let scope: WorkSummaryScope;
    if (scopeArg === 'iteration' || scopeArg === 'today' || scopeArg === 'all') scope = scopeArg;
    else scope = iteration ? 'iteration' : 'today';
    if (scope === 'iteration' && !iteration) scope = 'today';
    const format = raw.format === 'html' || raw.format === 'md' ? raw.format : 'both';
    try {
      const data = await collectWorkSummary({
        kanbanUrl,
        projectId: kanbanProjectId || undefined,
        iteration: iteration || undefined,
        scope,
      });
      const paths = writeSummaryReports(data, { format });
      const empty = data.tasks.length
        ? ''
        : '该范围内没有匹配的任务，已生成空报告（各项为 0）。\n\n';
      // 报告内容源自看板数据（任务标题/摘要等），UNTRUSTED 包裹
      return wrapUntrusted(empty + summarizeForChat(data, paths, { linkBaseUrl: reportLinkBaseUrl }));
    } catch (err) {
      // 看板地址（本机 localhost，bot 用户打不开）与英文报错原文不落用户面；原文进 HTA_DEBUG 日志
      if (process.env.HTA_DEBUG) console.error(`[work_summary] 报错原文：${errMessage(err)}`);
      return '生成工作总结失败：看板服务暂时无响应，请稍后重试；持续失败请联系部署者检查看板服务。';
    }
  };
}
