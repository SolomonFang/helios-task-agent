// Unit tests (safety batch): pure logic only — no LLM, no kanban, no network. Run: npx tsx scripts/unit-safety.ts

import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { loadEnvFiles, writeEnvFile } from '../src/config';
import { repoFsRead, repoFsGrep } from '../src/repo-fs';
import { kanbanPackageSpec, DEFAULT_KANBAN_PACKAGE } from '../src/deps';
import { check, checkAsync, finish } from './testkit';

async function main() {
  // ---------- loadEnvFiles：cwd .env 命令注入类高危键被忽略 ----------
  await checkAsync('loadEnvFiles：cwd .env 受限键（MCP/包规格/看板地址/数据目录）被忽略', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-safety-home-'));
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-safety-cwd-'));
    fs.writeFileSync(
      path.join(tmpHome, '.env'),
      'HELIOS_KANBAN_URL=http://home-kanban\nHELIOS_KANBAN_PACKAGE=helios-kanban@home\n',
    );
    fs.writeFileSync(
      path.join(tmpCwd, '.env'),
      [
        'HELIOS_KANBAN_MCP_COMMAND=evil-cmd',
        'HELIOS_KANBAN_MCP_ARGS=--evil',
        'HELIOS_KANBAN_PACKAGE=evil-pkg',
        'OCR_PACKAGE=evil-ocr',
        'HELIOS_KANBAN_URL=http://evil-kanban',
        'HTA_SAFETY_NONRESTRICTED=from-cwd',
        '',
      ].join('\n'),
    );
    const ENV_KEYS = [
      'HELIOS_TASK_AGENT_HOME',
      'HELIOS_KANBAN_MCP_COMMAND',
      'HELIOS_KANBAN_MCP_ARGS',
      'HELIOS_KANBAN_PACKAGE',
      'OCR_PACKAGE',
      'HELIOS_KANBAN_URL',
      'HTA_SAFETY_NONRESTRICTED',
    ];
    const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    const prevCwd = process.cwd();
    // 静默丢弃提示（[config] cwd .env 中的高危键已被忽略…），不打断测试输出
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      process.env.HELIOS_TASK_AGENT_HOME = tmpHome; // shell 提供，cwd .env 不得覆盖
      process.chdir(tmpCwd);
      loadEnvFiles();
      // home .env 最后 override 加载：受限键须等于 home 值或保持未设置
      assert.equal(process.env.HELIOS_KANBAN_URL, 'http://home-kanban');
      assert.equal(process.env.HELIOS_KANBAN_PACKAGE, 'helios-kanban@home');
      assert.notEqual(process.env.HELIOS_KANBAN_MCP_COMMAND, 'evil-cmd');
      assert.notEqual(process.env.HELIOS_KANBAN_MCP_ARGS, '--evil');
      assert.notEqual(process.env.OCR_PACKAGE, 'evil-ocr');
      // 非受限键仍生效
      assert.equal(process.env.HTA_SAFETY_NONRESTRICTED, 'from-cwd');
    } finally {
      console.warn = origWarn;
      process.chdir(prevCwd);
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  // ---------- .env 序列化 round-trip：dotenv.parse 原样读回 ----------
  await checkAsync('writeEnvFile：含空格/#/引号的值序列化后 dotenv.parse 原样读回', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-safety-env-'));
    try {
      const envPath = path.join(tmp, '.env');
      const values: Record<string, string> = {
        LLM_API_KEY: 'sk-test-123', // 简单值直写
        LLM_BASE_URL: 'https://example.com/v1',
        HELIOS_KANBAN_URL: 'http://localhost:7964/#/board', // 含 #，未加引号会被截断
        HTA_SAFETY_SPACED: 'hello world', // 含空格
        HTA_SAFETY_COMMENT: 'token #1', // 含 " #"
        HTA_SAFETY_QUOTE: "O'Neill", // 含单引号
      };
      writeEnvFile(values, envPath);
      const parsed = dotenv.parse(fs.readFileSync(envPath));
      for (const [k, v] of Object.entries(values)) {
        assert.equal(parsed[k], v, `${k} 应原样读回，实际 ${JSON.stringify(parsed[k])}`);
      }
      // 二次合并写（走 parseEnvFile）后仍 round-trip
      writeEnvFile({ LLM_MODEL: 'm' }, envPath);
      const parsed2 = dotenv.parse(fs.readFileSync(envPath));
      for (const [k, v] of Object.entries(values)) {
        assert.equal(parsed2[k], v, `合并写后 ${k} 应原样保留，实际 ${JSON.stringify(parsed2[k])}`);
      }
      assert.equal(parsed2.LLM_MODEL, 'm');
      // 含双引号/反斜杠的值：dotenv@16 不反转义 \" \\，以 writeEnvFile 自身合并读回为准
      writeEnvFile({ HTA_SAFETY_DQUOTE: 'say "hi"', HTA_SAFETY_BSLASH: 'C:\\new' }, envPath);
      writeEnvFile({ LLM_MODEL: 'm2' }, envPath); // 再合并一次，触发 parseEnvFile 读回
      const parsed3 = dotenv.parse(fs.readFileSync(envPath));
      assert.equal(parsed3.LLM_MODEL, 'm2');
      const raw = fs.readFileSync(envPath, 'utf8');
      const dquoteLine = raw.split('\n').find((l) => l.startsWith('HTA_SAFETY_DQUOTE='))!;
      assert.ok(dquoteLine.startsWith('HTA_SAFETY_DQUOTE="'), '含双引号的值应加引号序列化');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- repo_fs 敏感文件 denylist ----------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-safety-fs-'));
    const root = path.join(tmp, 'repo');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'LLM_API_KEY=sk-secret');
    fs.writeFileSync(path.join(root, '.env.local'), 'TOKEN=t');
    fs.writeFileSync(path.join(root, 'id_rsa'), 'PRIVATE KEY');
    fs.writeFileSync(path.join(root, 'cert.pem'), 'PEM');
    fs.writeFileSync(path.join(root, '.npmrc'), '//registry/:_authToken=x');
    fs.writeFileSync(path.join(root, 'app.ts'), 'const token = 1;\n');

    const denied = ['.env', '.env.local', 'id_rsa', 'cert.pem', '.npmrc'];
    check(
      'repoFsRead 敏感文件命中 denylist（拒绝且不泄露内容）',
      denied.every((f) => {
        const out = repoFsRead(root, f);
        return out.includes('已拒绝读取') && !out.includes('sk-secret') && !out.includes('PRIVATE KEY');
      }),
    );
    const okOut = repoFsRead(root, 'app.ts');
    check('repoFsRead 普通文件放行', okOut.includes('const token = 1;'));
    const grepTree = repoFsGrep(root, 'token');
    check(
      'repoFsGrep 树扫描跳过敏感文件（不泄露 .npmrc/.env 内容）',
      grepTree.includes('app.ts') && !grepTree.includes('sk-secret') && !grepTree.includes('_authToken'),
      grepTree.split('\n').slice(0, 4).join(' | '),
    );
    const grepDirect = repoFsGrep(root, 'token', '.env');
    check('repoFsGrep 直接对敏感文件给出明确拒绝说明', grepDirect.includes('已拒绝读取'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- helios-kanban 默认包规格钉版本 ----------
  check(
    'DEFAULT_KANBAN_PACKAGE 钉版本（不再 @latest），HELIOS_KANBAN_PACKAGE 可覆盖',
    /^helios-kanban@\d+\.\d+\.\d+$/.test(DEFAULT_KANBAN_PACKAGE) &&
      kanbanPackageSpec({}) === DEFAULT_KANBAN_PACKAGE &&
      kanbanPackageSpec({ HELIOS_KANBAN_PACKAGE: 'helios-kanban@0.1.36' }) === 'helios-kanban@0.1.36',
    DEFAULT_KANBAN_PACKAGE,
  );

  finish();
}

void main();
