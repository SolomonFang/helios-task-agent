import type { ToolHandler } from '../../types';
import { errMessage } from '../../infra/err';

/** work_summary / daily_report / iteration_retro 三个报告工具的公共依赖。 */
export interface ReportToolDeps {
  kanbanUrl: string;
  kanbanProjectId?: string;
  kanbanIteration?: string;
  reportLinkBaseUrl?: string;
  channel?: 'cli' | 'bot';
}

/**
 * 报告类工具公共骨架（参数解析 → 看板采集 → 写盘渲染）：两段 try/catch 分开定性——
 * 采集失败归因看板服务，写盘失败归因报告目录。三者差异仅收进 collect / render 回调；
 * collect 返回 string 时按参数错误等用户面文案直接返回（不走失败定性）。
 */
export function makeReportHandler<T>({
  tag,
  action,
  collect,
  render,
}: {
  /** HTA_DEBUG 日志 tag（即工具名）。 */
  tag: string;
  /** 用户面失败文案的动作短语，如「生成工作总结」。 */
  action: string;
  /** 看板数据采集；抛错按「看板服务无响应」定性，返回 string 则原样回给用户（参数错误等）。 */
  collect: (raw: Record<string, unknown>) => Promise<T | string>;
  /** 报告写盘（异步，0600）+ 会话摘要渲染（看板数据外发须自行 wrapUntrusted）；抛错按「报告文件写入失败」定性。 */
  render: (data: T, raw: Record<string, unknown>) => string | Promise<string>;
}): ToolHandler {
  return async (raw) => {
    let data: T;
    try {
      const collected = await collect(raw);
      if (typeof collected === 'string') return collected;
      data = collected;
    } catch (err) {
      // 看板地址（本机 localhost，bot 用户打不开）与英文报错原文不落用户面；原文进 HTA_DEBUG 日志
      if (process.env.HTA_DEBUG) console.error(`[${tag}] 报错原文：${errMessage(err)}`);
      return `${action}失败：看板服务暂时无响应，请稍后重试；持续失败请联系部署者检查看板服务。`;
    }
    try {
      return await render(data, raw);
    } catch (err) {
      // 写盘失败（磁盘满/权限不足）重试必败，与看板采集失败分开定性，不把部署者引向看板服务
      if (process.env.HTA_DEBUG) console.error(`[${tag}] 报错原文：${errMessage(err)}`);
      return `${action}失败：报告文件写入失败，请联系部署者检查报告目录。`;
    }
  };
}
