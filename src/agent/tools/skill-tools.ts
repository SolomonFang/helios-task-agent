import path from 'path';
import fs from 'fs';
import type { ToolHandler } from '../../types';
import { looksLikeStrongFailure, passGate, wrapUntrusted, type ConfirmFn } from '../guard';
import { auditLog } from '../../infra/audit';
import { readSkillDoc, resolveSkillDir } from '../skills';
import { ALLOWED_INTERPRETERS, run, SCRIPT_INTERPRETERS, summarizeBothEnds, truncate } from './shared';

/** skill_doc handler：技能文档是本仓库自带内容（非外部注入），无需 UNTRUSTED 包裹。 */
export function makeSkillDocHandler(): ToolHandler {
  return async (raw) => {
    const name = typeof raw.name === 'string' ? raw.name : '';
    return truncate(readSkillDoc(name));
  };
}

/** skill_exec handler：任意代码执行无法分类读写，一律过确认闸门（按破坏性对待，超时放宽）。 */
export function makeSkillExecHandler({
  uid,
  confirm,
  auditHome,
}: {
  uid: string;
  confirm?: ConfirmFn;
  auditHome?: string;
}): ToolHandler {
  return async (raw, ctx) => {
    const skill = typeof raw.skill === 'string' ? raw.skill.trim() : '';
    const script = typeof raw.script === 'string' ? raw.script.trim() : '';
    if (!skill || !script) return '参数错误：skill 与 script 均必填';
    if (!/^[\w][\w.-]*$/.test(skill)) return `参数错误：非法技能名「${skill}」`;
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string'))) {
      return '参数错误：args 必须是字符串数组';
    }
    const argv = (raw.args as string[] | undefined) || [];
    const dir = resolveSkillDir(skill);
    if (!dir) return `未找到技能「${skill}」。先用 skill_doc（空 name）列出已安装技能。`;
    if (path.isAbsolute(script)) return `参数错误：script 必须是相对技能目录的路径：「${script}」`;
    // 防路径逃逸：realpath 后必须仍在技能目录内（覆盖 ../ 与符号链接两种形态）
    const rootReal = fs.realpathSync(dir);
    let scriptReal: string;
    try {
      scriptReal = fs.realpathSync(path.join(rootReal, script));
    } catch {
      return `技能「${skill}」内不存在脚本「${script}」`;
    }
    if (!scriptReal.startsWith(rootReal + path.sep)) {
      return `参数错误：脚本路径越出技能目录：「${script}」`;
    }
    let interpreter = typeof raw.interpreter === 'string' ? raw.interpreter.trim() : '';
    if (interpreter) {
      if (!ALLOWED_INTERPRETERS.has(interpreter)) {
        return `参数错误：不支持的解释器「${interpreter}」（仅允许 ${[...ALLOWED_INTERPRETERS].join('/')}）`;
      }
    } else {
      interpreter = SCRIPT_INTERPRETERS[path.extname(scriptReal).toLowerCase()] || '';
      if (!interpreter) {
        return `参数错误：无法按扩展名推断「${script}」的解释器，请显式传 interpreter（bash/sh/node/python3/python）`;
      }
    }
    const summary = `执行技能脚本：${skill}/${script}`;
    const detail = summarizeBothEnds(`${interpreter} ${scriptReal}${argv.length ? ' ' + argv.join(' ') : ''}`);
    // 执行任意脚本 = 任意代码执行，按破坏性对待（超时放宽）；「同类免问」绑定脚本与实际参数
    //（与 hk_cli 的 hk:tasks delete:<id> 同口径——授权 key 绑定操作对象，换参数需重新确认）
    const batchKey = `skill:${skill}/${script}${argv.length ? `:${argv.join(' ')}` : ''}`;
    const gate = await passGate({ kind: 'skill', summary, detail, batchKey, destructive: true }, confirm);
    if (!gate.allowed) {
      auditLog({ user: uid, kind: 'skill', summary, detail, decision: gate.reason }, auditHome);
      return gate.message;
    }
    const out = await run(interpreter, [scriptReal, ...argv], { signal: ctx?.signal, cwd: rootReal });
    auditLog(
      { user: uid, kind: 'skill', summary, detail, decision: 'approved', ok: !looksLikeStrongFailure(out), resultSnippet: out },
      auditHome,
    );
    return wrapUntrusted(out);
  };
}
