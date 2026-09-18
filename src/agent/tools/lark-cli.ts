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

/**
 * lark-cli 带值 flag（各命令 --help 中标注 string/int/strings 的形态；布尔开关如 --dry-run/--json 不在内）。
 * 无法穷举：未命中的 flag 一律按「无法可靠解析」fail-closed（见 larkTargetArg）。
 */
const LARK_VALUE_FLAGS = new Set([
  '--as', '--format', '--jq', '-q', '--params', '--data', '--output', '-o', '--output-dir', '--profile',
  '--page-size', '--page-token', '--page-limit', '--page-delay',
  '--msg-type', '--content', '--text', '--markdown', '--image', '--file', '--video', '--video-cover', '--audio',
  '--chat-id', '--user-id', '--message-id', '--idempotency-key',
  '--query', '--start', '--end', '--start-time', '--end-time',
  '--doc', '--doc-format', '--api-version', '--command', '--lang', '--keyword', '--detail', '--scope',
  '--domain', '--exclude', '--device-code',
  '--member-id', '--member-type', '--member-role', '--space-id', '--calendar-id', '--file-token', '--version',
]);

/**
 * 「同类免问」key 的对象实参解析：跳过带值 flag 及其值（--flag value 成对、--flag=value 占一位），
 * 取命令路径后第一个位置实参（接收对象/资源 id）。遇到未知 flag 时无法判断它带不带值，
 * 继续解析可能把 flag 值误绑成对象（授权放大）——fail-closed 返回 undefined；
 * 调用方据此不提供 batchKey（每次必问），不得退化为类级免问（与 kanban-mcp 缺对象 id 同口径）。
 */
function larkTargetArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) return a;
    if (a.includes('=')) continue;
    if (LARK_VALUE_FLAGS.has(a)) {
      i++; // 带值 flag：值占下一位，成对跳过
      continue;
    }
    return undefined;
  }
  return undefined;
}

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
      // 高频子命令摘要用中文动作（对象标识在 detail）；未覆盖的子命令回退固定定性（完整命令在 detail 区，
      // 与看板通道 summarizeMcp 的 fallback 口径一致，不透传英文子命令原文）
      const summary = action ?? '飞书写操作';
      const detail = summarizeBothEnds(`lark-cli ${argv.join(' ')}`);
      // 「同类免问」按命令路径 + 对象归类（如 lark:im send:ou_x）：子命令后第一个位置实参
      // （接收对象/资源 id）纳入 key，否则免问会放大到任意接收人；带值 flag 成对跳过。
      // 解析不可靠（未知 flag 排在对象前）或无该实参时 fail-closed 不提供 batchKey（每次必问）——
      // 退化为类级 key 会把一次「发给 ou_x」的批准静默放行成发往任意接收人的同类操作
      // （与 kanban-mcp 缺对象 id 时不提供免问同口径）。
      // 飞书写整体按破坏性对待（超时放宽）
      const sub = argv[1] && !argv[1].startsWith('-') ? ` ${argv[1]}` : '';
      const target = larkTargetArg(argv.slice(sub ? 2 : 1));
      const batchKey = target ? `lark:${argv[0]}${sub}:${target}` : undefined;
      const gate = await passGate(
        // 对象级免问：key 绑接收对象/资源 id，批准发给 ou_x 不授权发给 ou_y；无对象则不提供免问
        { kind: 'lark', summary, detail, batchKey, batchScope: target ? 'object' : 'kind', destructive: true },
        confirm,
        ctx?.signal,
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
