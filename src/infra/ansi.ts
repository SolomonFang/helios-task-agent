/**
 * 剥离 ANSI 转义序列（CSI/SGR 等）。含外部可控内容（看板任务标题、命令参数等）的文本
 * 打印到终端前调用，防注入序列改写终端显示。与 kanban/ai-review.ts 的 sanitizeCliOutput
 * 同源（那边额外去 \r，用于喂飞书消息；这里保留换行语义，仅剥转义）。
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][0-9A-B]|\x07/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
