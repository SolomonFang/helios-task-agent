'use strict';

// Minimal ANSI helpers — no external deps.

const ESC = '\u001b';
const codes = {
  reset: 0, bold: 1, dim: 2,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90, white: 37,
};

function paint(text, ...styles) {
  if (!process.stdout.isTTY) return String(text);
  const seq = styles.map((s) => `${ESC}[${codes[s]}m`).join('');
  return `${seq}${text}${ESC}[${codes.reset}m`;
}

const c = {};
for (const name of Object.keys(codes)) {
  if (name === 'reset') continue;
  c[name] = (t) => paint(t, name);
}
c.ok = (t) => paint(t, 'green');
c.warn = (t) => paint(t, 'yellow');
c.err = (t) => paint(t, 'red');
c.info = (t) => paint(t, 'cyan');
c.strong = (t) => paint(t, 'bold');

/** East Asian Wide/Fullwidth ranges count as 2 cells; block/box-drawing chars as 1. */
function charWidth(cp) {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 || cp === 0x232a ||
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

function visibleLen(s) {
  const plain = String(s).replace(/\u001b\[\d+m/g, '');
  let n = 0;
  for (const ch of plain) n += charWidth(ch.codePointAt(0));
  return n;
}

function box(lines, { width = 64 } = {}) {
  const top = '┌' + '─'.repeat(width) + '┐';
  const bottom = '└' + '─'.repeat(width) + '┘';
  const rows = lines.map((line) => {
    const pad = Math.max(0, width - visibleLen(line));
    return `│ ${line}${' '.repeat(Math.max(0, pad - 1))}│`;
  });
  return [top, ...rows, bottom].join('\n');
}

/**
 * Welcome screen: clear + banner + status lines.
 * @param {object} status
 * @param {string} status.model
 * @param {string} status.baseUrl
 * @param {'pending'|'ok'|'fail'} status.mcp
 * @param {number} [status.mcpToolCount]
 * @param {boolean} status.larkOk
 * @param {string} status.kanbanUrl
 * @param {string} status.version
 */
function printBanner(status) {
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

class Spinner {
  constructor(text) {
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.text = text;
    this.i = 0;
    this.timer = null;
  }

  start(text) {
    if (text) this.text = text;
    if (!process.stdout.isTTY) return this;
    this.stop();
    this.timer = setInterval(() => {
      const frame = c.info(this.frames[this.i = (this.i + 1) % this.frames.length]);
      process.stdout.write(`\r${ESC}[K ${frame} ${c.gray(this.text)}`);
    }, 80);
    return this;
  }

  setText(text) {
    this.text = text;
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (process.stdout.isTTY) process.stdout.write(`\r${ESC}[K`);
    }
    return this;
  }
}

/** Very light markdown render for terminal: code/inline-code/bold get color. */
function renderReply(text) {
  const out = String(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => '\n' + c.gray(code.replace(/\n/g, '\n  ')) + '\n')
    .replace(/`([^`\n]+)`/g, (_, s) => c.info(s))
    .replace(/\*\*([^*]+)\*\*/g, (_, s) => c.strong(s));
  return out;
}

module.exports = { c, box, printBanner, Spinner, renderReply };
