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
            const hint = command === 'lark-cli' ? `\n${LARK_CLI_INSTALL_HINT}` : '';
            resolve(`未找到可执行命令「${command}」。${hint}`.trim());
            return;
          }
          resolve(`命令执行失败：${error.message}\n${truncate(stderr || '')}`.trim());
        } else if (error) {
          // 非零退出但有 stdout：不能只回 stdout 让模型误判成功；失败信号放在开头
          // （looksLikeStrongFailure 只扫前 300 字符，放末尾会漏判）
          resolve(`命令执行失败（非零退出）：${error.message}\n${truncate(stderr || '')}\n--- stdout ---\n${truncate(stdout || '')}`.trim());
        } else {
          const out = truncate(stdout || '');
          resolve(stderr && !out ? truncate(stderr) : out || '（无输出）');
        }
      },
    );
  });
}

export function extractUuid(s: string): string | null {
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}
