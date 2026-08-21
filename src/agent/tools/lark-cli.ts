import type { ToolHandler } from '../../types';
import { classifyLark, looksLikeStrongFailure, passGate, wrapUntrusted, type ConfirmFn } from '../guard';
import { auditLog } from '../../infra/audit';
import { run, summarizeBothEnds } from './shared';

/** 确认摘要的高频子命令中文动作（与看板通道 summarizeMcp 口径对齐）；对象标识留在 detail 区。 */
const LARK_ACTION_LABELS: Record<string, string> = {
  'im send': '发送飞书消息',
  'im reply': '回复飞书消息',
  'im update': '更新飞书消息',
  'im delete': '删除飞书消息',
  'doc create': '创建飞书文档',
  'doc update': '更新飞书文档',
  'task create': '创建飞书任务',
  'task update': '更新飞书任务',
  'calendar create': '创建日程',
  'calendar update': '更新日程',
  'calendar delete': '删除日程',
};

/** lark_cli handler：写操作过确认闸门，读操作留审计（不记读回内容）。 */
export function makeLarkCliHandler({
  uid,
  confirm,
  auditHome,
}: {
  uid: string;
  confirm?: ConfirmFn;
  auditHome?: string;
}): ToolHandler {
  return async (raw, ctx) => {
    const args = raw.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return '参数错误：args 必须是字符串数组';
    }
    const argv = args as string[];
    if (classifyLark(argv) === 'write') {
      const action = LARK_ACTION_LABELS[`${argv[0] ?? ''} ${argv[1] ?? ''}`.trim()];
      // 高频子命令摘要用中文动作（对象标识在 detail）；未覆盖的子命令回退原命令行形态
      const summary = action ?? `飞书写操作：${argv.slice(0, 3).join(' ')}`;
      const detail = summarizeBothEnds(`lark-cli ${argv.join(' ')}`);
      // 「同类免问」按命令路径 + 对象归类（如 lark:im send:ou_x）：子命令后第一个非 flag 实参
      // （接收对象/资源 id）纳入 key，否则免问会放大到任意接收人；无该实参时退化为命令路径，
      // 粒度同步降为类级（batchScope 须与 key 的实际粒度一致，卡片文案才不失实）。
      // 飞书写整体按破坏性对待（超时放宽）
      const sub = argv[1] && !argv[1].startsWith('-') ? ` ${argv[1]}` : '';
      const target = argv.slice(sub ? 2 : 1).find((a) => !a.startsWith('-'));
      const batchKey = target ? `lark:${argv[0]}${sub}:${target}` : `lark:${argv[0]}${sub}`;
      const gate = await passGate(
        // 对象级免问：key 绑接收对象/资源 id，批准发给 ou_x 不授权发给 ou_y；无对象则类级
        { kind: 'lark', summary, detail, batchKey, batchScope: target ? 'object' : 'kind', destructive: true },
        confirm,
      );
      if (!gate.allowed) {
        auditLog({ user: uid, kind: 'lark', summary, detail, decision: gate.reason }, auditHome);
        return gate.message;
      }
      const out = await run('lark-cli', argv, { signal: ctx?.signal });
      auditLog(
        { user: uid, kind: 'lark', summary, detail, decision: 'approved', ok: !looksLikeStrongFailure(out), resultSnippet: out },
        auditHome,
      );
      return wrapUntrusted(out);
    }
    const out = await run('lark-cli', argv, { signal: ctx?.signal });
    // 读审计：飞书数据外发给 LLM 的动作留痕；只记目标命令，不写 resultSnippet（读回内容），
    // 避免审计文件变成敏感数据副本（见 audit.ts 的 kind 约定）
    auditLog(
      {
        user: uid,
        kind: 'lark_read',
        summary: `飞书读操作：lark-cli ${argv.slice(0, 3).join(' ')}`,
        detail: `lark-cli ${argv.join(' ')}`.slice(0, 800),
        decision: 'approved',
        ok: !looksLikeStrongFailure(out),
      },
      auditHome,
    );
    return wrapUntrusted(out);
  };
}
