import path from 'path';
import { execFile } from 'child_process';
import { LARK_CLI_INSTALL_HINT } from '../../infra/deps';
import { resolveSkillDir } from '../skills';
import { minimalChildEnv } from '../../infra/proc-env';
import { packageRoot } from '../../infra/paths';

/** hk.sh 包内兜底路径（用户目录无覆盖版本时使用，见 resolveHkScript）。 */
const HK_SCRIPT = path.join(packageRoot, 'skills', 'helios-kanban-remote', 'scripts', 'hk.sh');

/**
 * hk.sh 定位：与 skill_doc 同一套 resolveSkillDir（用户目录优先覆盖），找不到回退包内路径。
 * 每次调用重新解析：运行中新装/更新用户技能即时生效，且与 skill_doc 读到的文档版本一致。
 */
export function resolveHkScript(): string {
  const dir = resolveSkillDir('helios-kanban-remote');
  return dir ? path.join(dir, 'scripts', 'hk.sh') : HK_SCRIPT;
}

const MAX_OUTPUT = 8000;
const EXEC_TIMEOUT = 60000;

/** 技能脚本解释器：按扩展名推断（未命中的扩展名需显式传 interpreter）。 */
export const SCRIPT_INTERPRETERS: Record<string, string> = {
  '.sh': 'bash',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.py': 'python3',
};

/** 显式指定的解释器白名单。 */
export const ALLOWED_INTERPRETERS = new Set(['bash', 'sh', 'node', 'python3', 'python']);

/**
 * 确认/审计展示的双向摘要：超长时展示首 600 + 中间省略长度警示 + 尾 200，
 * 注入载荷无法藏在截断点之后（单向 slice 会把尾部内容彻底藏掉）。
 */
export function summarizeBothEnds(s: string, head = 600, tail = 200): string {
  if (s.length <= head + tail) return s;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}…（中间省略 ${omitted} 字符，共 ${s.length} 字符）…${s.slice(s.length - tail)}`;
}

export function truncate(s: unknown): string {
  const str = String(s);
  return str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + `\n…（输出过长，已截断，共 ${str.length} 字符）` : str;
}

/** stderr 用户面只带尾部几行（完整内容与英文原文进 HTA_DEBUG 日志，不落用户面）。 */
function tailLines(s: string, n: number): string {
  const lines = s.trim().split('\n').filter(Boolean);
  return lines.slice(-n).join('\n');
}

/** 子进程失败原文（error.message 含完整命令与本机绝对路径、stderr 全文）进 HTA_DEBUG 日志。 */
function logExecFailure(command: string, args: string[], error: Error, stderr: string): void {
  if (!process.env.HTA_DEBUG) return;
  console.error(`[exec] ${command} ${args.join(' ')} 失败原文：${error.message}`);
  if (stderr.trim()) console.error(`[exec] stderr 完整内容：\n${stderr}`);
}

export function run(
  command: string,
  args: string[],
  { env, signal, cwd }: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('⏹ 已中断（未完成的操作未执行，可继续对话）。');
      return;
    }
    // 最小环境（见 proc-env.ts）：不向 lark-cli / hk.sh / 技能脚本泄露 LLM_API_KEY 等敏感变量
    execFile(
      command,
      args,
      { timeout: EXEC_TIMEOUT, maxBuffer: 4 * 1024 * 1024, env: minimalChildEnv(env), signal, cwd },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          resolve('⏹ 已中断（未完成的操作未执行，可继续对话）。');
          return;
        }
        if (error && !stdout) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            const hint =
              command === 'lark-cli'
                ? LARK_CLI_INSTALL_HINT
                : `请先在部署机器上安装 ${command} 后重试；如不会操作，请联系部署者。`;
            resolve(`未找到可执行命令「${command}」。\n${hint}`);
            return;
          }
          logExecFailure(command, args, error, stderr || '');
          // 超时中止：signal 中断已在上方拦截，此处的 killed/SIGTERM 即 EXEC_TIMEOUT 触发
          if (error.killed === true || /timed?\s*out/i.test(error.message)) {
            // 保留「命令执行失败」行首：looksLikeStrongFailure 依行首识别强失败（审计/来源映射/创建计数）
            resolve(
              `命令执行失败：执行超时（超过 ${EXEC_TIMEOUT / 1000} 秒已自动中止）。` +
                '请稍后重试；若持续超时，可能是看板服务响应慢。',
            );
            return;
          }
          // 英文 error.message（含完整命令与本机绝对路径）不进用户面；stderr 只带尾部 3 行
          const code = (error as NodeJS.ErrnoException).code;
          const codeText = typeof code === 'number' ? `（退出码 ${code}）` : '';
          const tail = tailLines(stderr || '', 3);
          resolve(`命令执行失败${codeText}${tail ? `：\n${tail}` : '。'}`);
        } else if (error) {
          logExecFailure(command, args, error, stderr || '');
          // 非零退出但有 stdout：不能只回 stdout 让模型误判成功；失败信号放在开头
          // （looksLikeStrongFailure 只扫前 300 字符，放末尾会漏判）
          const code = (error as NodeJS.ErrnoException).code;
          const codeText = typeof code === 'number' ? `（退出码 ${code}）` : '';
          const tail = tailLines(stderr || '', 3);
          resolve(
            `命令执行失败（非零退出）${codeText}${tail ? `\n${tail}` : ''}\n--- stdout ---\n${truncate(stdout || '')}`,
          );
        } else {
          const out = truncate(stdout || '');
          if (out && stderr) {
            // 成功但 stderr 非空：警告不得静默丢弃，截断摘要附在输出后（同 summarizeBothEnds 风格）
            resolve(`${out}\n[stderr] ${summarizeBothEnds(stderr.trim())}`);
          } else {
            resolve(stderr && !out ? truncate(stderr) : out || '（无输出）');
          }
        }
      },
    );
  });
}

export function extractUuid(s: string): string | null {
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}
