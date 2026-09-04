import type { ToolHandler } from '../../types';
import { wrapUntrusted } from '../guard';
import { collectDailyData, type DailyReportData } from '../../kanban/summary';
import { buildDailyMaterial, resolveReportDate, writeDailyReport } from '../../report/daily-report';
import { errMessage } from '../../infra/err';

/** daily_report handler：采集某日看板活动素材（+ 可选 HTML 日报），供 LLM 组织个人工作日报。 */
export function makeDailyReportHandler({
  kanbanUrl,
  kanbanProjectId,
  kanbanIteration,
  reportLinkBaseUrl,
  channel,
}: {
  kanbanUrl: string;
  kanbanProjectId?: string;
  kanbanIteration?: string;
  reportLinkBaseUrl?: string;
  channel?: 'cli' | 'bot';
}): ToolHandler {
  return async (raw) => {
    const date = resolveReportDate(raw.date);
    if (!date) {
      return '日期参数无法识别：支持「今天」「昨天」或 YYYY-MM-DD（如 2026-09-01）；省略默认为今天。';
    }
    // 迭代口径与 work_summary 一致：参数优先，缺省用配置的默认迭代，未配置则全部任务
    const iteration =
      (typeof raw.iteration === 'string' && raw.iteration.trim()) || kanbanIteration || '';
    const genHtml = raw.html !== false;
    let data: DailyReportData;
    try {
      data = await collectDailyData({
        kanbanUrl,
        projectId: kanbanProjectId || undefined,
        iteration: iteration || undefined,
        date,
      });
    } catch (err) {
      // 看板地址（本机 localhost，bot 用户打不开）与英文报错原文不落用户面；原文进 HTA_DEBUG 日志
      if (process.env.HTA_DEBUG) console.error(`[daily_report] 报错原文：${errMessage(err)}`);
      return '生成日报失败：看板服务暂时无响应，请稍后重试；持续失败请联系部署者检查看板服务。';
    }
    try {
      const htmlPath = genHtml ? writeDailyReport(data) : undefined;
      // 素材内容源自看板数据（任务标题/摘要等），UNTRUSTED 包裹
      return wrapUntrusted(buildDailyMaterial(data, { htmlPath, linkBaseUrl: reportLinkBaseUrl, channel }));
    } catch (err) {
      // 写盘失败（磁盘满/权限不足）重试必败，与看板采集失败分开定性，不把部署者引向看板服务
      if (process.env.HTA_DEBUG) console.error(`[daily_report] 报错原文：${errMessage(err)}`);
      return '生成日报失败：报告文件写入失败，请联系部署者检查报告目录。';
    }
  };
}
