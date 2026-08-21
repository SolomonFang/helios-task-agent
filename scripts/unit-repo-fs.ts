/**
 * repo-fs 工具单测（异步化改造后行为不回归）：
 * 异步 grep 正确性（命中格式/大小写/glob/无命中）；扫描总量上限截断（字节口径）；
 * 符号链接防逃逸（read 拒绝、grep 直扫拒绝、树扫描不跟随）；MAX_GREP_HITS 上限；
 * skipDir 与敏感文件跳过；ReDoS 启发式防护不变；list/read 异步正确性；
 * 大扫描期间事件循环不被阻塞（setTimeout 能触发）；grep 单行限长兜底；
 * list 超上限时先排序再截断（窗口确定）；read 按 bytesRead 截断（无残留 \0）。
 * 运行：tsx scripts/unit-repo-fs.ts
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { repoFsList, repoFsRead, repoFsGrep } from '../src/agent/repo-fs';
import { checkAsync, finish } from './testkit';

function tmpRepo(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hta-unit-repofs-${tag}-`));
}

async function main(): Promise<void> {
  // ---------- 异步 grep：命中格式 / 大小写不敏感 / 子目录递归 ----------
  await checkAsync('repoFsGrep：命中格式为 rel:line:content，大小写不敏感，递归子目录', async () => {
    const root = tmpRepo('basic');
    try {
      fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(root, 'app.ts'), 'const Token = 1;\nconsole.log(Token);\n');
      fs.writeFileSync(path.join(root, 'src', 'deep', 'util.ts'), '// token here\n');
      const out = await repoFsGrep(root, 'token');
      assert.ok(out.includes('app.ts:1:const Token = 1;'), out);
      assert.ok(out.includes('app.ts:2:console.log(Token);'), out);
      assert.ok(out.includes(path.join('src', 'deep', 'util.ts') + ':1:// token here'), out);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- glob 过滤 ----------
  await checkAsync('repoFsGrep：glob 过滤只扫匹配后缀的文件', async () => {
    const root = tmpRepo('glob');
    try {
      fs.writeFileSync(path.join(root, 'a.ts'), 'needle\n');
      fs.writeFileSync(path.join(root, 'b.md'), 'needle\n');
      const out = await repoFsGrep(root, 'needle', '.', '*.ts');
      assert.ok(out.includes('a.ts:1:needle'), out);
      assert.ok(!out.includes('b.md'), out);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- 无命中扫完全树（异步遍历完整性） ----------
  await checkAsync('repoFsGrep：无命中时扫完全树并报告（无命中）', async () => {
    const root = tmpRepo('nohit');
    try {
      for (let i = 0; i < 30; i++) {
        fs.mkdirSync(path.join(root, `d${i}`), { recursive: true });
        fs.writeFileSync(path.join(root, `d${i}`, `f${i}.txt`), 'nothing here\n');
      }
      const out = await repoFsGrep(root, 'zzz-not-exist');
      assert.ok(out.includes('（无命中）'), out);
      assert.ok(!out.includes('已达扫描总量上限'), out);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- 扫描总量上限：字节口径截断并在输出中注明 ----------
  await checkAsync('repoFsGrep：扫描字节超 50MB 上限即截断，输出注明结果可能不全', async () => {
    const root = tmpRepo('bytelimit');
    try {
      // 每个文件 200KB（恰在单文件上限内），280 个 > 50MB 总量；pattern 不命中避免先触 hits 上限
      const buf = Buffer.alloc(200_000, 'a');
      for (let i = 0; i < 280; i++) {
        fs.writeFileSync(path.join(root, `f${String(i).padStart(3, '0')}.txt`), buf);
      }
      const out = await repoFsGrep(root, 'zzz-not-exist');
      assert.ok(out.includes('已达扫描总量上限，结果可能不全'), out);
      assert.ok(out.includes('50MB'), out);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- 事件循环让出：大扫描期间 timer 能触发 ----------
  await checkAsync('repoFsGrep：大量文件扫描期间事件循环不被阻塞（setTimeout 可触发）', async () => {
    const root = tmpRepo('yield');
    try {
      const buf = Buffer.alloc(200_000, 'a');
      for (let i = 0; i < 280; i++) {
        fs.writeFileSync(path.join(root, `f${String(i).padStart(3, '0')}.txt`), buf);
      }
      let ticked = false;
      const timer = setTimeout(() => {
        ticked = true;
      }, 0);
      await repoFsGrep(root, 'zzz-not-exist');
      clearTimeout(timer);
      assert.equal(ticked, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- MAX_GREP_HITS 上限不变 ----------
  await checkAsync('repoFsGrep：命中数达 40 条上限即停并注明', async () => {
    const root = tmpRepo('hits');
    try {
      fs.writeFileSync(path.join(root, 'many.txt'), Array.from({ length: 60 }, (_, i) => `hit line ${i}`).join('\n'));
      const out = await repoFsGrep(root, 'hit line');
      assert.ok(out.includes('已达 40 条上限'), out);
      assert.ok(!out.includes('hit line 40'), out); // 第 41 条起不收录
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- 符号链接防逃逸：read 拒绝 ----------
  await checkAsync('repoFsRead：符号链接指向仓库外，拒绝读取', async () => {
    const root = tmpRepo('symlink-read');
    const outside = tmpRepo('outside');
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
      const out = await repoFsRead(root, 'link.txt');
      assert.ok(out.includes('路径越界'), out);
      assert.ok(!out.includes('outside-secret'), out);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // ---------- 符号链接防逃逸：grep 直接以符号链接为起点拒绝；树扫描不跟随 ----------
  await checkAsync('repoFsGrep：起点为越界符号链接拒绝；树扫描中符号链接不跟随（不泄露界外内容）', async () => {
    const root = tmpRepo('symlink-grep');
    const outside = tmpRepo('outside');
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret-xyz\n');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
      fs.writeFileSync(path.join(root, 'normal.txt'), 'plain\n');
      const direct = await repoFsGrep(root, 'outside-secret-xyz', 'link.txt');
      assert.ok(direct.includes('路径越界'), direct);
      const tree = await repoFsGrep(root, 'outside-secret-xyz');
      assert.ok(tree.includes('（无命中）'), tree);
      assert.ok(!tree.includes('outside-secret-xyz:'), tree);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // ---------- skipDir / 点目录跳过不回归 ----------
  await checkAsync('repoFsGrep：node_modules 与点目录跳过，正常目录仍扫描', async () => {
    const root = tmpRepo('skipdir');
    try {
      fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'needle\n');
      fs.writeFileSync(path.join(root, '.hidden', 'x.js'), 'needle\n');
      fs.writeFileSync(path.join(root, 'main.js'), 'needle\n');
      const out = await repoFsGrep(root, 'needle');
      assert.ok(out.includes('main.js:1:needle'), out);
      assert.ok(!out.includes('node_modules'), out);
      assert.ok(!out.includes('.hidden'), out);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- 敏感文件跳过 / 直接拒绝不回归 ----------
  await checkAsync('repoFsGrep：树扫描跳过 .env，直接对 .env 明确拒绝；read 拒绝 .env', async () => {
    const root = tmpRepo('sensitive');
    try {
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=needle\n');
      fs.writeFileSync(path.join(root, 'app.ts'), '// needle\n');
      const tree = await repoFsGrep(root, 'needle');
      assert.ok(tree.includes('app.ts'), tree);
      assert.ok(!tree.includes('.env'), tree);
      const direct = await repoFsGrep(root, 'needle', '.env');
      assert.ok(direct.includes('已拒绝读取'), direct);
      const read = await repoFsRead(root, '.env');
      assert.ok(read.includes('已拒绝读取'), read);
      assert.ok(!read.includes('SECRET'), read);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- ReDoS 启发式防护不变 ----------
  await checkAsync('repoFsGrep：ReDoS 防护（嵌套量词/相邻量词段/超长）仍拒绝', async () => {
    const root = tmpRepo('redos');
    try {
      fs.writeFileSync(path.join(root, 'a.txt'), 'abc\n');
      assert.ok((await repoFsGrep(root, '(\\w+)+$')).includes('嵌套量词'));
      assert.ok((await repoFsGrep(root, '.*.*.*b')).includes('连续相邻的量词段'));
      assert.ok((await repoFsGrep(root, 'a'.repeat(201))).includes('搜索表达式过长'));
      assert.ok((await repoFsGrep(root, '[')).includes('不是有效的正则表达式'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- 单行限长兜底：启发式逃逸的 pattern 只在前 2000 字符内匹配 ----------
  await checkAsync('repoFsGrep：单行限长 2000 兜底（行内 2000 字符之后的命中不计）', async () => {
    const root = tmpRepo('linelen');
    try {
      const pad = 'x'.repeat(3000);
      // 第 1 行命中在限长窗口内；第 2 行命中在 2000 字符之后，不得计入
      fs.writeFileSync(path.join(root, 'long.txt'), `needle ${pad}\n${pad} needle\n`);
      const out = await repoFsGrep(root, 'needle');
      assert.ok(out.includes('long.txt:1:'), out);
      assert.ok(!out.includes('long.txt:2:'), out);
      // 启发式逃逸的 pattern（[ab]*[ab]*z：剥离字符类后不被相邻量词段判定捕获）不被拒绝、扫描有界完成
      fs.writeFileSync(path.join(root, 'ab.txt'), `${'ab'.repeat(150)}\n`);
      const esc = await repoFsGrep(root, '[ab]*[ab]*z', 'ab.txt');
      assert.ok(esc.includes('（无命中）'), esc);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- list 异步正确性与条目上限 ----------
  await checkAsync('repoFsList：列目录（目录带 / 后缀、排序），超 200 项先排序再截断（窗口确定且稳定）', async () => {
    const root = tmpRepo('list');
    try {
      fs.mkdirSync(path.join(root, 'sub'));
      fs.writeFileSync(path.join(root, 'a.txt'), '');
      const out = await repoFsList(root, '.');
      assert.ok(out.includes('sub/'), out);
      assert.ok(out.includes('a.txt'), out);
      assert.ok(out.indexOf('a.txt') < out.indexOf('sub/'), out);
      for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(root, `e${String(i).padStart(3, '0')}`), '');
      const big = await repoFsList(root, '.');
      assert.ok(big.includes('已截断'), big);
      // 先排序再截断：展示窗口为排序后前 200 项（a.txt + e000…e198），不随 readdir 顺序漂移
      assert.ok(big.includes('e198'), big);
      assert.ok(!big.includes('e199'), big);
      assert.ok(!big.includes('sub/'), big);
      assert.equal(await repoFsList(root, '.'), big, '多次调用结果应一致');
      const notDir = await repoFsList(root, 'a.txt');
      assert.ok(notDir.includes('不是目录'), notDir);
      const missing = await repoFsList(root, 'nope');
      assert.ok(missing.includes('路径不存在'), missing);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- read 异步正确性与大文件截断 ----------
  await checkAsync('repoFsRead：读取内容；超 200KB 仅读前段并注明；缺参/不存在/非文件报错', async () => {
    const root = tmpRepo('read');
    try {
      fs.writeFileSync(path.join(root, 'hello.txt'), '你好世界\n');
      fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(210_000, 'b'));
      fs.mkdirSync(path.join(root, 'dir'));
      const out = await repoFsRead(root, 'hello.txt');
      assert.ok(out.includes('# hello.txt'), out);
      assert.ok(out.includes('你好世界'), out);
      // 按 bytesRead 截断：stat 后文件被截短也不得在输出尾部残留 \0
      assert.ok(!out.includes('\0'), '输出不得含 NUL 字符');
      const big = await repoFsRead(root, 'big.bin');
      // 200KB 正文超出 MAX_OUTPUT 截断，输出注明已截断且不含完整 210KB
      assert.ok(big.includes('输出过长，已截断'), big.slice(-200));
      assert.ok(big.length < 210_000);
      assert.ok((await repoFsRead(root, '')).includes('参数错误'));
      assert.ok((await repoFsRead(root, 'missing.txt')).includes('文件不存在'));
      assert.ok((await repoFsRead(root, 'dir')).includes('不是文件'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------- 路径越界（..）防护不回归 ----------
  await checkAsync('repoFs*：../ 越界一律拒绝', async () => {
    const root = tmpRepo('traversal');
    try {
      fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
      assert.ok((await repoFsRead(root, '../etc/passwd')).includes('路径越界'));
      assert.ok((await repoFsList(root, '..')).includes('路径越界'));
      assert.ok((await repoFsGrep(root, 'x', '..')).includes('路径越界'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  finish();
}

void main();
