import type { ToolHandler } from '../../types';
import { classifyLark, looksLikeStrongFailure, passGate, wrapUntrusted, type ConfirmFn } from '../guard';
import { auditLog } from '../../infra/audit';
import { run, summarizeBothEnds } from './shared';

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
      const summary = `飞书写操作：lark-cli ${argv.slice(0, 3).join(' ')}`;
      const detail = summarizeBothEnds(`lark-cli ${argv.join(' ')}`);
      // 「同类免问」按命令路径归类（如 lark:im send / lark:task create）；飞书写整体按破坏性对待（超时放宽）
      const sub = argv[1] && !argv[1].startsWith('-') ? ` ${argv[1]}` : '';
      const gate = await passGate(
        { kind: 'lark', summary, detail, batchKey: `lark:${argv[0]}${sub}`, destructive: true },
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
