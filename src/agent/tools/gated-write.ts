import { looksLikeStrongFailure, passGate, wrapUntrusted, type ConfirmFn } from '../guard';
import { auditLog } from '../../infra/audit';
import { SourceRegistry, kanbanTaskExists } from '../source-registry';
import { extractWorkspaceId, waitForWorkspaceReady } from '../../kanban/workspace-ready';
import { extractUuid } from './shared';

/** 单次会话创建任务数上限（代码层强制，不只靠 prompt 自觉）。 */
const MAX_CREATES_PER_SESSION = 50;
const CREATE_CAP_MESSAGE = `单次会话最多创建 ${MAX_CREATES_PER_SESSION} 个看板任务（已达上限，系统安全限制）。请如实告知用户；如需更多，建议 /clear 后再创建。`;

/**
 * 会话级创建计数：由 AgentSession 持有并经 options 传入 buildTools。
 * MCP 重连 / /config 会重建全部工具闭包，计数若放闭包里会被清零、上限形同虚设；
 * 提升为会话级状态后跨重建存活，仅 clearHistory 显式重置。
 */
export interface CreateCounter {
  count: number;
}

async function appendWorkspaceReadyCheck(
  result: string,
  kanbanUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  if (looksLikeStrongFailure(result)) return result;
  const workspaceId = extractWorkspaceId(result);
  if (!workspaceId) return result;
  const ready = await waitForWorkspaceReady(kanbanUrl, workspaceId, { signal });
  if (ready.ok) {
    return `${result}\n\n（工作区已就绪，可以开始执行任务）`;
  }
  return `${result}\n\n⚠️ 工作区初始化未完成：\n${ready.message || '未知原因'}`;
}

/** runGatedWrite 的单次写操作配置（见 makeGatedWriter）。 */
export interface GatedWriteParams {
  kind: 'kanban' | 'hk';
  summary: string;
  detail: () => string;
  isCreate: boolean;
  isStart: boolean;
  urls: string[];
  title: string;
  batchKey: string;
  /** 「同类免问」粒度（见 guard.ConfirmRequest.batchScope）：类级或对象级，由 key 生成处一并给出。 */
  batchScope: 'kind' | 'object';
  /** 破坏性/高影响操作：确认超时放宽（见 guard.isDestructive 与 ConfirmRequest.destructive）。 */
  destructive: boolean;
  /** start 前置补全（可能改写命令参数）；返回错误消息则审计 error 并拦截。 */
  prepare?: () => Promise<string | null>;
  execute: () => Promise<string>;
  signal?: AbortSignal;
}

export type GatedWrite = (p: GatedWriteParams) => Promise<string>;

/**
 * MCP 动态工具与 hk_cli 共用的写路径流水线：
 * 去重 → 创建上限 → 前置补全（start 分支等）→ 确认闸门 → 执行 → 审计 → 记录来源。
 * 差异点全部参数化：审计 kind、summary/detail（detail 传 getter，前置补全改写命令后取最新值）、
 * 批量免问 batchKey、来源 URL 提取方式、执行体。
 */
export function makeGatedWriter({
  uid,
  registry,
  kanbanUrl,
  confirm,
  auditHome,
  createCounter,
}: {
  uid: string;
  registry: SourceRegistry;
  kanbanUrl: string;
  confirm?: ConfirmFn;
  auditHome?: string;
  createCounter: CreateCounter;
}): GatedWrite {

  /**
   * Returns a block message if any source URL was already synced; cleans stale mappings.
   * 已知限制（跨进程 TOCTOU）：checkDuplicates 与 recordSources 并非原子操作，
   * CLI 与 bot 两个进程并发同步同一来源时可双双通过查重、各建一个任务。
   * 单进程内串行（事件循环 + 同用户串行队列），风险仅限跨进程并发；当前以注释明示，不改行为。
   */
  const checkDuplicates = async (urls: string[]): Promise<string | null> => {
    for (const url of urls) {
      const hit = registry.lookup(uid, url);
      if (!hit) continue;
      // taskId 为 unknown 的是历史遗留数据（recordSources 只写 extractUuid 非空的记录）：
      // 无从核验任务是否仍存活，拦截文案引导的「先删除原任务」也无从操作——
      // 永久拦截即成死锁，清理该映射后放行
      if (hit.taskId === 'unknown') {
        registry.remove(uid, url);
        continue;
      }
      const exists = await kanbanTaskExists(kanbanUrl, hit.taskId);
      if (exists) {
        // 时间戳截断到分钟：ISO 毫秒精度对用户无核对价值
        const createdShort = hit.createdAt.replace('T', ' ').slice(0, 16);
        return (
          `该来源已同步过，为避免重复建任务已拦截：\n- 来源：${url}\n` +
          `- 已创建：${createdShort} → 看板任务 ${hit.taskId}《${hit.title}》\n` +
          '如确需重建，请先在「看板」中删除原任务（或告知用户该任务已存在）；\n' +
          '如用户是想把最新内容合并进原任务，改用 update 更新该任务，不要重建。'
        );
      }
      registry.remove(uid, url); // 原任务已被删除 → 清理映射后放行
    }
    return null;
  };

  const recordSources = (urls: string[], result: string, title: string): void => {
    // 用强失败判定：成功结果的内容文本（如描述提到 error）不应阻碍来源映射记录
    if (!urls.length || looksLikeStrongFailure(result)) return;
    const taskId = extractUuid(result);
    if (!taskId) return;
    const entry = { taskId, title, createdAt: new Date().toISOString() };
    for (const url of urls) registry.record(uid, url, entry);
  };

  return async (p) => {
    if (p.urls.length) {
      const dup = await checkDuplicates(p.urls);
      if (dup) {
        auditLog({ user: uid, kind: p.kind, summary: p.summary, detail: p.detail(), decision: 'blocked_dup' }, auditHome);
        return dup;
      }
    }
    if (p.isCreate && createCounter.count >= MAX_CREATES_PER_SESSION) {
      auditLog({ user: uid, kind: p.kind, summary: p.summary, detail: p.detail(), decision: 'denied' }, auditHome);
      return CREATE_CAP_MESSAGE;
    }
    if (p.prepare) {
      const prepErr = await p.prepare();
      if (prepErr) {
        auditLog({ user: uid, kind: p.kind, summary: p.summary, detail: p.detail(), decision: 'error' }, auditHome);
        return prepErr;
      }
    }
    const gate = await passGate(
      { kind: p.kind, summary: p.summary, detail: p.detail(), batchKey: p.batchKey, batchScope: p.batchScope, destructive: p.destructive },
      confirm,
    );
    if (!gate.allowed) {
      auditLog({ user: uid, kind: p.kind, summary: p.summary, detail: p.detail(), decision: gate.reason }, auditHome);
      return gate.message;
    }
    let result = await p.execute();
    if (p.isStart && !looksLikeStrongFailure(result)) {
      result = await appendWorkspaceReadyCheck(result, kanbanUrl, p.signal);
    }
    const ok = !looksLikeStrongFailure(result) && !/⚠️ 工作区初始化未完成/.test(result);
    auditLog(
      { user: uid, kind: p.kind, summary: p.summary, detail: p.detail(), decision: 'approved', ok, resultSnippet: result },
      auditHome,
    );
    if (ok && p.urls.length) recordSources(p.urls, result, p.title);
    if (ok && p.isCreate) createCounter.count++;
    return wrapUntrusted(result);
  };
}
