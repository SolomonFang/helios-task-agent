import readline from 'readline';

import { HK_CLI_INSTALL_HINT, MCP_FALLBACK_TEXT } from './deps';

const ESC = '\u001b';

const codes = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
  white: 37,
} as const;

type StyleName = keyof typeof codes;

function paint(text: unknown, ...styles: StyleName[]): string {
  if (!process.stdout.isTTY) return String(text);
  const seq = styles.map((s) => `${ESC}[${codes[s]}m`).join('');
  return `${seq}${text}${ESC}[${codes.reset}m`;
}

type ColorFn = (t: unknown) => string;

export const c: Record<string, ColorFn> & {
  ok: ColorFn;
  warn: ColorFn;
  err: ColorFn;
  info: ColorFn;
  strong: ColorFn;
  gray: ColorFn;
} = {
  ok: (t) => paint(t, 'green'),
  warn: (t) => paint(t, 'yellow'),
  err: (t) => paint(t, 'red'),
  info: (t) => paint(t, 'cyan'),
  strong: (t) => paint(t, 'bold'),
  // 具名声明（下方循环会覆盖为同一实现）：让 c 可直接满足 commands.Paint
  gray: (t) => paint(t, 'gray'),
};

for (const name of Object.keys(codes) as StyleName[]) {
  if (name === 'reset') continue;
  c[name] = (t) => paint(t, name);
}

/** East Asian Wide/Fullwidth ranges count as 2 cells; block/box-drawing chars as 1. */
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function visibleLen(s: string): number {
  const plain = String(s).replace(/\u001b\[\d+m/g, '');
  let n = 0;
  for (const ch of plain) n += charWidth(ch.codePointAt(0)!);
  return n;
}

export function box(lines: string[], { width = 64 }: { width?: number } = {}): string {
  // 自适应加宽：长行（如 hk_cli 降级链提示）不能顶破右边框；终端更窄时只能任由终端换行
  const w = Math.max(width, ...lines.map((l) => visibleLen(l) + 2));
  const top = '┌' + '─'.repeat(w) + '┐';
  const bottom = '└' + '─'.repeat(w) + '┘';
  const rows = lines.map((line) => {
    const pad = Math.max(0, w - visibleLen(line));
    return `│ ${line}${' '.repeat(Math.max(0, pad - 1))}│`;
  });
  return [top, ...rows, bottom].join('\n');
}

export interface BannerStatus {
  model: string;
  baseUrl: string;
  mcp: 'pending' | 'ok' | 'fail';
  mcpToolCount?: number;
  /** lark-cli 二进制是否存在（调用方探测，如 checkLarkCliStatus() !== 'missing'）。 */
  larkOk: boolean;
  /** lark-cli 是否已授权（调用方探测；larkOk=false 时忽略）。 */
  larkAuthed: boolean;
  /** hk_cli 降级链缺失的依赖（调用方探测，如 checkHkDeps()；空数组 = 齐全）。 */
  hkMissing: string[];
  kanbanUrl: string;
  version: string;
}

export function printBanner(status: BannerStatus): void {
  // 不清屏：向导刚打印的「配置已保存到 …」等上下文需要保留在视野内
  // 探测由调用方完成（hkMissing / larkAuthed）：ui 只做渲染，探测逻辑留在 deps 层
  const hkMissing = status.hkMissing;
  const mcpSuffix =
    status.mcp === 'fail'
      ? hkMissing.length
        ? `，${MCP_FALLBACK_TEXT}，但缺少 ${hkMissing.join('、')}，降级链不可用`
        : `，${MCP_FALLBACK_TEXT}，功能不受影响`
      : '';
  const mcpLine =
    status.mcp === 'ok'
      ? c.ok('●') + ` helios-kanban MCP  已连接（${status.mcpToolCount} 个工具）`
      : status.mcp === 'fail'
        ? c.warn('●') + ` helios-kanban MCP  连接失败${mcpSuffix}`
        : c.warn('●') + ' helios-kanban MCP  连接中…';
  // larkOk 只代表二进制存在，授权态用调用方传入的 larkAuthed，区分未安装/未授权/可用
  const larkAuthed = status.larkOk && status.larkAuthed;
  const larkLine = !status.larkOk
    ? c.warn('●') + ' lark-cli         未找到，飞书能力不可用（可选，见下方安装提示）'
    : larkAuthed
      ? c.ok('●') + ' lark-cli         可用（飞书内容获取）'
      : c.warn('●') + ' lark-cli         未授权，飞书能力不可用（运行 lark-cli auth login 完成授权）';
  const hkLine =
    hkMissing.length > 0
      ? ['  ' + c.warn('●') + ` hk_cli 降级链    缺少 ${hkMissing.join('、')}，MCP 掉线时无法降级（${HK_CLI_INSTALL_HINT}）`]
      : [];
  const lines = [
    '',
    c.strong(c.info('  ██╗  ██╗███████╗██╗     ██╗ ██████╗ ███████╗')),
    c.strong(c.info('  ██║  ██║██╔════╝██║     ██║██╔═══██╗██╔════╝')),
    c.strong(c.info('  ███████║█████╗  ██║     ██║██║   ██║███████╗')),
    c.strong(c.info('  ██╔══██║██╔══╝  ██║     ██║██║   ██║╚════██║')),
    c.strong(c.info('  ██║  ██║███████╗███████╗██║╚██████╔╝███████║')),
    c.strong(c.info('  ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚══════╝')),
    '',
    c.strong('  HELIOS TASK AGENT') + c.gray(`  v${status.version}`),
    c.gray('  从飞书内容到 helios-kanban 任务，一句话搞定'),
    '',
    '  ' + mcpLine,
    '  ' + larkLine,
    ...hkLine,
    // 模型与 kanban 地址只是配置展示（未做健康检查）：用中性灰点，避免与上面两行的「连接正常」绿点混淆
    '  ' + c.gray('●') + ` 模型             ${c.strong(status.model)} ${c.gray('(' + status.baseUrl + ')')}`,
    '  ' + c.gray('●') + ` kanban 地址      ${status.kanbanUrl}`,
    '',
    c.gray('  输入 /help 查看命令，/config 重新配置模型，/exit 退出'),
    '',
  ];
  console.log(box(lines, { width: 66 }));
}

export class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private text: string;
  private i = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(text: string) {
    this.text = text;
  }

  start(text?: string): this {
    if (text) this.text = text;
    if (!process.stdout.isTTY) return this;
    this.stop();
    this.timer = setInterval(() => {
      const frame = c.info(this.frames[(this.i = (this.i + 1) % this.frames.length)]);
      process.stdout.write(`\r${ESC}[K ${frame} ${c.gray(this.text)}`);
    }, 80);
    return this;
  }

  setText(text: string): this {
    this.text = text;
    return this;
  }

  stop(): this {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (process.stdout.isTTY) process.stdout.write(`\r${ESC}[K`);
    }
    return this;
  }
}

/** 简单 markdown 表格做列对齐渲染；结构不完整（缺分隔行 / 列数不齐）时原样返回。 */
function renderTable(block: string): string {
  // 行内标记（`code` / **bold**）不计列宽：外层 renderReply 在表格渲染后才给它们上色，
  // 按含标记的原文计宽会让渲染后的整列错位
  const stripInline = (s: string) => s.replace(/`([^`\n]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
  const rows = block.split('\n');
  if (rows.length < 2) return block;
  const splitRow = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const header = splitRow(rows[0]!);
  const sep = splitRow(rows[1]!);
  if (header.length < 2 || sep.length !== header.length || !sep.every((cell) => /^:?-{2,}:?$/.test(cell))) return block;
  const body: string[][] = [];
  for (const row of rows.slice(2)) {
    const cells = splitRow(row);
    if (cells.length !== header.length) return block; // 列数不齐：退化为原样
    body.push(cells);
  }
  const widths = header.map((h, i) => Math.max(visibleLen(stripInline(h)), ...body.map((r) => visibleLen(stripInline(r[i]!)))));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visibleLen(stripInline(s))));
  const line = (cells: string[]) => cells.map((cell, i) => pad(cell, widths[i]!)).join('  ');
  return [c.strong(line(header)), line(widths.map((w) => '─'.repeat(w))), ...body.map(line)].join('\n');
}

/**
 * Very light markdown render for terminal: code blocks原样保留（先抽占位），
 * 标题加粗、行内代码/加粗上色、简单表格列对齐；列表保持原样。
 */
export function renderReply(text: string): string {
  const blocks: string[] = [];
  // 代码块只上色不缩进：缩进会污染用户复制出来的内容，终端里颜色已是足够的边界提示
  let out = String(text).replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang: string, code: string) => {
    blocks.push('\n' + c.gray(code) + '\n');
    return `\u0000${blocks.length - 1}\u0000`;
  });
  out = out
    .replace(/(\|[^\n]*\|)(\n\|[^\n]*\|)+/g, (table) => renderTable(table))
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, (_m, s: string) => c.strong(s))
    .replace(/`([^`\n]+)`/g, (_m, s: string) => c.info(s))
    .replace(/\*\*([^*]+)\*\*/g, (_m, s: string) => c.strong(s));
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]!);
}

export interface SelectOption {
  name: string;
  baseUrl?: string;
}

function defaultRenderLine(opt: string | SelectOption): string {
  if (typeof opt === 'string') return opt;
  return opt.name + (opt.baseUrl ? c.gray('  ' + opt.baseUrl) : '');
}

export function selectList({
  title,
  options,
  renderLine = defaultRenderLine,
}: {
  title: string;
  options: Array<string | SelectOption>;
  renderLine?: (opt: string | SelectOption, i: number) => string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? Boolean(stdin.isRaw) : false;
    let current = 0;
    let settled = false;

    const draw = () => {
      const lines = [
        '',
        c.strong(title),
        ...options.map((opt, i) => {
          const text = renderLine(opt, i);
          return i === current ? `  ${c.info('❯')} ${c.info(text)}` : `    ${text}`;
        }),
        '',
        c.gray('  ↑/↓ 选择，回车确认，数字键直选，Esc 取消'),
      ];
      process.stdout.write(lines.join('\n') + '\n');
      return lines.length;
    };

    let lineCount = draw();

    const redraw = () => {
      process.stdout.write(`${ESC}[${lineCount}A\r${ESC}[0J`);
      lineCount = draw();
    };

    const cleanup = () => {
      stdin.removeListener('keypress', onKeypress);
      if (stdin.isTTY && Boolean(stdin.isRaw) !== wasRaw) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const settle = (fn: (v: number) => void, value: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const onKeypress = (str: string | undefined, key: readline.Key | undefined) => {
      key = key || {};
      if (key.name === 'up' || str === 'k') {
        current = (current - 1 + options.length) % options.length;
        redraw();
      } else if (key.name === 'down' || str === 'j') {
        current = (current + 1) % options.length;
        redraw();
      } else if (key.name === 'return') {
        settle(resolve, current);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        settled = true;
        cleanup();
        reject(new Error('已取消'));
      } else if (str && /^[1-9]$/.test(str)) {
        const idx = Number(str) - 1;
        if (idx < options.length) {
          current = idx;
          settle(resolve, current);
        }
      }
    };

    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY && !wasRaw) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKeypress);
  });
}

/**
 * 密码式输入（API Key / App Secret 等敏感信息）：回显 * 而非明文，
 * 避免肩窥与终端滚屏残留。仅用于 TTY；调用方在非 TTY 时应回退普通逐行输入。
 * 与 selectList 同一模式：调用前需 rl.pause()，结束后 rl.resume()。
 */
export function readSecret(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? Boolean(stdin.isRaw) : false;
    let buf = '';
    let settled = false;

    const cleanup = () => {
      stdin.removeListener('keypress', onKeypress);
      if (stdin.isTTY && Boolean(stdin.isRaw) !== wasRaw) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onKeypress = (str: string | undefined, key: readline.Key | undefined) => {
      key = key || {};
      if (key.name === 'return') {
        if (settled) return;
        settled = true;
        process.stdout.write('\n');
        cleanup();
        resolve(buf);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        if (settled) return;
        settled = true;
        process.stdout.write('\n');
        cleanup();
        reject(new Error('已取消'));
      } else if (key.name === 'backspace') {
        if (buf.length) {
          buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (str && !key.ctrl && !key.meta) {
        // 粘贴可能一次进来多个字符（含换行，剔除后整体入库）
        const clean = str.replace(/[\r\n]/g, '');
        if (!clean) return;
        buf += clean;
        process.stdout.write('*'.repeat([...clean].length));
      }
    };

    process.stdout.write(promptText);
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY && !wasRaw) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKeypress);
  });
}
