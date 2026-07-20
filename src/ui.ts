import readline from 'readline';

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
} = {
  ok: (t) => paint(t, 'green'),
  warn: (t) => paint(t, 'yellow'),
  err: (t) => paint(t, 'red'),
  info: (t) => paint(t, 'cyan'),
  strong: (t) => paint(t, 'bold'),
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
  const top = '┌' + '─'.repeat(width) + '┐';
  const bottom = '└' + '─'.repeat(width) + '┘';
  const rows = lines.map((line) => {
    const pad = Math.max(0, width - visibleLen(line));
    return `│ ${line}${' '.repeat(Math.max(0, pad - 1))}│`;
  });
  return [top, ...rows, bottom].join('\n');
}

export interface BannerStatus {
  model: string;
  baseUrl: string;
  mcp: 'pending' | 'ok' | 'fail';
  mcpToolCount?: number;
  larkOk: boolean;
  kanbanUrl: string;
  version: string;
}

export function printBanner(status: BannerStatus): void {
  process.stdout.write(`${ESC}[2J${ESC}[H`);
  const mcpLine =
    status.mcp === 'ok'
      ? c.ok('●') + ` helios-kanban MCP  已连接（${status.mcpToolCount} 个工具）`
      : status.mcp === 'fail'
        ? c.err('●') + ' helios-kanban MCP  连接失败（降级为 HTTP/hk.sh）'
        : c.warn('●') + ' helios-kanban MCP  连接中…';
  const larkLine = status.larkOk
    ? c.ok('●') + ' lark-cli         可用（飞书内容获取）'
    : c.err('●') + ' lark-cli         未找到，飞书能力不可用';
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
    '  ' + c.ok('●') + ` 模型             ${c.strong(status.model)} ${c.gray('(' + status.baseUrl + ')')}`,
    '  ' + c.ok('●') + ` kanban 地址      ${status.kanbanUrl}`,
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

/** Very light markdown render for terminal: code/inline-code/bold get color. */
export function renderReply(text: string): string {
  return String(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang: string, code: string) => '\n' + c.gray(code.replace(/\n/g, '\n  ')) + '\n')
    .replace(/`([^`\n]+)`/g, (_m, s: string) => c.info(s))
    .replace(/\*\*([^*]+)\*\*/g, (_m, s: string) => c.strong(s));
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
        c.gray('  ↑/↓ 选择，回车确认，数字键直选'),
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
