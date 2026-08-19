/**
 * 工具层单测（buildTools / AgentSession 接线 / SourceRegistry）：
 * 单会话创建上限跨工具闭包重建存活、clearHistory 显式重置；
 * hk_cli 脚本用户目录优先、包内兜底；MCP start_workspace 确认卡片 detail
 * 展示前置补全后的最终参数；SourceRegistry 按 mtime 缓存盘上解析结果；
 * hk_cli/lark_cli 批量免问 key 绑定操作对象 id；hk 创建标题跳过 flag 取值；
 * MCP 非法工具名跳过注册；localToolSummary 按 memory 启用标志拼接。
 * 运行：tsx scripts/unit-tools.ts
 */
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { buildTools, localToolSummary, LOCAL_TOOL_SUMMARY, type CreateCounter } from '../src/agent/tools';
import { AgentSession } from '../src/agent/session';
import { SourceRegistry } from '../src/agent/source-registry';
import { MemoryStore } from '../src/agent/memory';
import type { ConfirmFn } from '../src/agent/guard';
import type { KanbanMcp } from '../src/kanban/mcp';
import { checkAsync, finish } from './testkit';
import type { AgentConfig, ToolHandlers } from '../src/types';

const KANBAN_URL = 'http://localhost:1'; // 不可达：不涉及 kanban HTTP 的用例共用

const cfg: AgentConfig = {
  llmBaseUrl: 'http://localhost:1/v1',
  llmApiKey: 'sk-x',
  llmModel: 'm',
  mcpCommand: 'npx',
  mcpArgs: [],
  kanbanUrl: KANBAN_URL,
  kanbanProjectId: '',
  kanbanRepoId: '',
  kanbanIteration: '',
};

function tmpHome(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hta-unit-tools-${tag}-`));
}

/** 最小 fake MCP：挂一个指定名字的工具，callTool 默认回 'ok'。 */
function fakeMcp(
  toolName: string,
  callTool?: (name: string, args: Record<string, unknown>) => Promise<string>,
): KanbanMcp {
  return {
    connected: true,
    tools: [{ name: toolName, description: `fake ${toolName}`, inputSchema: { type: 'object', properties: {} } }],
    callTool: callTool || (async () => 'ok'),
  } as unknown as KanbanMcp;
}

const approveAll: ConfirmFn = async () => 'once';

const CAP_HINT = '已达上限';

async function main(): Promise<void> {
  // ---------- 任务1：创建上限计数跨 buildTools 重建存活，显式重置后放行 ----------
  await checkAsync('创建上限：计数跨 buildTools 重建存活（模拟 MCP 重连），重置后放行', async () => {
    const tmp = tmpHome('cap');
    try {
      const counter: CreateCounter = { count: 0 };
      const mcp = fakeMcp('create_task');
      const mk = (): ToolHandlers =>
        buildTools({
          mcp,
          kanbanUrl: KANBAN_URL,
          confirm: approveAll,
          registry: new SourceRegistry(tmp),
          auditHome: tmp,
          createCounter: counter,
        }).handlers;
      let create = mk().get('kanban_create_task')!;
      for (let i = 0; i < 50; i++) {
        const r = await create({ title: `t${i}` });
        assert.ok(!r.includes(CAP_HINT), `第 ${i + 1} 次创建不应触顶: ${r}`);
      }
      assert.ok((await create({ title: 't51' })).includes(CAP_HINT), '第 51 次应触顶');
      // 模拟 setMcpOk→applyConfig 重建全部工具闭包：计数不清零，仍触顶
      create = mk().get('kanban_create_task')!;
      assert.ok((await create({ title: 't52' })).includes(CAP_HINT), '重建后计数应保留');
      // 显式重置（clearHistory 语义）后放行
      counter.count = 0;
      create = mk().get('kanban_create_task')!;
      assert.ok(!(await create({ title: 't13' })).includes(CAP_HINT), '重置后应放行');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 任务1 接线：AgentSession setMcpOk 不清零，clearHistory 重置 ----------
  await checkAsync('AgentSession：setMcpOk 热切换不清零创建计数，clearHistory 显式重置', async () => {
    const tmp = tmpHome('capsess');
    const prevHome = process.env.HELIOS_TASK_AGENT_HOME;
    process.env.HELIOS_TASK_AGENT_HOME = tmp; // registry/audit 落临时目录，不污染真实数据目录
    try {
      const session = new AgentSession(cfg, fakeMcp('create_task'), true, {
        userId: 'u1',
        memory: new MemoryStore(tmp),
        confirm: approveAll,
      });
      const createOf = () =>
        (session as unknown as { handlers: ToolHandlers }).handlers.get('kanban_create_task')!;
      for (let i = 0; i < 50; i++) await createOf()({ title: `t${i}` });
      session.setMcpOk(false);
      session.setMcpOk(true); // 触发 applyConfig → 重建工具闭包
      assert.ok((await createOf()({ title: 't51' })).includes(CAP_HINT), 'MCP 重连后计数应保留');
      session.clearHistory();
      assert.ok(!(await createOf()({ title: 't52' })).includes(CAP_HINT), 'clearHistory 后应放行');
    } finally {
      if (prevHome === undefined) delete process.env.HELIOS_TASK_AGENT_HOME;
      else process.env.HELIOS_TASK_AGENT_HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 任务2：hk_cli 脚本用户目录优先，移除后回退包内 ----------
  await checkAsync('hk_cli：用户目录技能脚本优先（与 skill_doc 一致），包内兜底', async () => {
    const tmp = tmpHome('hk');
    const prevHome = process.env.HELIOS_TASK_AGENT_HOME;
    process.env.HELIOS_TASK_AGENT_HOME = tmp;
    try {
      const skillDir = path.join(tmp, 'skills', 'helios-kanban-remote');
      fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: helios-kanban-remote\ndescription: fake\n---\n');
      fs.writeFileSync(path.join(skillDir, 'scripts', 'hk.sh'), '#!/bin/bash\necho HK_USER_SCRIPT_MARKER\n');
      const { handlers } = buildTools({ mcp: null, kanbanUrl: KANBAN_URL });
      const hk = handlers.get('hk_cli')!;
      const outUser = await hk({ args: ['health'] });
      assert.ok(outUser.includes('HK_USER_SCRIPT_MARKER'), `应执行用户目录脚本: ${outUser}`);
      // 移除用户版 → 回退包内脚本（输出不得再含用户标记）
      fs.rmSync(skillDir, { recursive: true, force: true });
      const outPkg = await hk({ args: ['--help'] });
      assert.ok(!outPkg.includes('HK_USER_SCRIPT_MARKER'), '应回退包内脚本');
      assert.ok(outPkg.length > 0);
    } finally {
      if (prevHome === undefined) delete process.env.HELIOS_TASK_AGENT_HOME;
      else process.env.HELIOS_TASK_AGENT_HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 任务3：MCP start_workspace 确认卡片 detail 为前置补全后的最终参数 ----------
  await checkAsync('MCP 确认卡片：detail 惰性求值，展示补全后的 base_branch', async () => {
    const tmp = tmpHome('mcpdetail');
    // fake kanban：仅实现 GET /api/repos/:id 返回默认分支
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/repos/r1') {
        res.end(JSON.stringify({ success: true, data: { default_target_branch: 'dev-main' } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: 'not found' }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      let receivedArgs = '';
      const mcp = fakeMcp('start_workspace', async (_name, args) => {
        receivedArgs = JSON.stringify(args);
        return 'ok'; // 无 workspace_id：跳过 appendWorkspaceReadyCheck 的额外 HTTP
      });
      let confirmDetail = '';
      const confirm: ConfirmFn = async (req) => {
        confirmDetail = req.detail;
        return 'once';
      };
      const { handlers } = buildTools({
        mcp,
        kanbanUrl: `http://127.0.0.1:${port}`,
        confirm,
        registry: new SourceRegistry(tmp),
        auditHome: tmp,
      });
      const out = await handlers.get('kanban_start_workspace')!({ repos: [{ repo_id: 'r1' }] });
      assert.ok(!out.includes('无法启动'), out);
      // 确认卡片必须展示 prepare 补全后的参数，而不是调用前的旧值
      assert.ok(confirmDetail.includes('"base_branch":"dev-main"'), `确认卡片缺 base_branch: ${confirmDetail}`);
      assert.ok(receivedArgs.includes('"base_branch":"dev-main"'), `MCP 实参缺 base_branch: ${receivedArgs}`);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 任务4：SourceRegistry 按 mtime 缓存，合并语义不变 ----------
  await checkAsync('SourceRegistry：指纹未变走缓存跳过重读，指纹变化重新合并', async () => {
    const tmp = tmpHome('regcache');
    try {
      const reg = new SourceRegistry(tmp);
      const entry = { taskId: 't1', title: 'a', createdAt: '2026-01-01T00:00:00.000Z' };
      reg.record('u', 'https://a.feishu.cn/docx/1', entry);
      // 外部进程写入新映射；随后把缓存基线对齐到当前文件指纹（utimes 精度无法
      // 精确还原旧 mtime，直接对齐私有基线模拟「该版本已解析过」的合法缓存态）
      const raw = JSON.parse(fs.readFileSync(reg.filePath, 'utf8')) as Record<string, Record<string, unknown>>;
      raw.u!['https://a.feishu.cn/docx/2'] = { taskId: 't2', title: 'b', createdAt: entry.createdAt };
      fs.writeFileSync(reg.filePath, JSON.stringify(raw));
      const boxed = reg as unknown as { diskCache: { fingerprint: string | null }; statFingerprint(): string | null };
      boxed.diskCache.fingerprint = boxed.statFingerprint();
      // 指纹与缓存一致 → 走缓存跳过重读，看不到盘上新键
      assert.equal(reg.lookup('u', 'https://a.feishu.cn/docx/2'), undefined, '指纹未变应走缓存');
      assert.equal(reg.lookup('u', 'https://a.feishu.cn/docx/1')?.taskId, 't1');
      // mtime 前进 → 指纹变化，缓存失效，重新读盘合并
      fs.utimesSync(reg.filePath, new Date(), new Date(Date.now() + 5000));
      assert.equal(reg.lookup('u', 'https://a.feishu.cn/docx/2')?.taskId, 't2', '指纹变化应重新合并');
      // 多实例合并语义保持：另一实例写入后本实例可见，且不丢本实例已有键
      const reg2 = new SourceRegistry(tmp);
      reg2.record('u', 'https://a.feishu.cn/docx/3', { taskId: 't3', title: 'c', createdAt: entry.createdAt });
      assert.equal(reg.lookup('u', 'https://a.feishu.cn/docx/3')?.taskId, 't3');
      assert.equal(reg.lookup('u', 'https://a.feishu.cn/docx/1')?.taskId, 't1');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- hk_cli batchKey：start/stop/approve/deny/follow-up 绑定 argv[1] 对象 id ----------
  await checkAsync('hk_cli 批量免问 key：start/stop/approve/deny/follow-up 均绑定操作对象 id', async () => {
    const tmp = tmpHome('hkkey');
    try {
      const keys: Array<string | undefined> = [];
      const { handlers } = buildTools({
        mcp: null,
        kanbanUrl: KANBAN_URL,
        registry: new SourceRegistry(tmp),
        auditHome: tmp,
        confirm: async (req) => {
          keys.push(req.batchKey);
          return false; // 闸门即拒，不真正执行子进程
        },
      });
      const hk = handlers.get('hk_cli')!;
      const taskA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const repoB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const wsA = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const apA = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      // --branch 已带：start 前置补全直接放行（无需 HTTP），确认闸门先于执行
      await hk({ args: ['start', taskA, '--repo', repoB, '--branch', 'dev'] });
      await hk({ args: ['stop', wsA] });
      await hk({ args: ['approve', apA] });
      await hk({ args: ['deny', apA] });
      await hk({ args: ['follow-up', taskA, '继续'] });
      // sub 本身含 argv[1]（既有格式），对象 id 再经 extractUuid(argv[1]) 绑定一次
      assert.deepEqual(
        keys,
        [
          `hk:start ${taskA}:${taskA}`, // 绑定任务 id，不得被 --repo 的 repo id 抢占
          `hk:stop ${wsA}:${wsA}`,
          `hk:approve ${apA}:${apA}`,
          `hk:deny ${apA}:${apA}`,
          `hk:follow-up ${taskA}:${taskA}`,
        ],
        `实际 keys=${JSON.stringify(keys)}`,
      );
      assert.ok(!keys[0]!.includes(repoB), `start 的 key 不得绑到 --repo id: ${keys[0]}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- hk_cli 创建标题：flag 及其值不阻断标题提取 ----------
  await checkAsync('hk_cli 创建标题：--flag value 成对跳过，取到 flag 后的标题', async () => {
    const tmp = tmpHome('hktitle');
    try {
      const summaries: string[] = [];
      const { handlers } = buildTools({
        mcp: null,
        kanbanUrl: KANBAN_URL,
        registry: new SourceRegistry(tmp),
        auditHome: tmp,
        confirm: async (req) => {
          summaries.push(req.summary);
          return false;
        },
      });
      const hk = handlers.get('hk_cli')!;
      await hk({ args: ['tasks', 'create', '--project', 'proj-x', '修复登录态'] });
      assert.ok(summaries[0]?.includes('修复登录态'), `确认卡片标题为空或错位: ${summaries[0]}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- lark_cli batchKey：写操作 key 含目标实参 ----------
  await checkAsync('lark_cli 批量免问 key：im send 绑定接收对象，不同接收人各自确认', async () => {
    const tmp = tmpHome('larkkey');
    try {
      const keys: Array<string | undefined> = [];
      const { handlers } = buildTools({
        mcp: null,
        kanbanUrl: KANBAN_URL,
        auditHome: tmp,
        confirm: async (req) => {
          keys.push(req.batchKey);
          return false;
        },
      });
      const lark = handlers.get('lark_cli')!;
      await lark({ args: ['im', 'send', 'ou_aaa', '--content', 'hi'] });
      await lark({ args: ['im', 'send', 'ou_bbb', '--content', 'hi'] });
      assert.deepEqual(keys, ['lark:im send:ou_aaa', 'lark:im send:ou_bbb'], `实际 keys=${JSON.stringify(keys)}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- skill_exec batchKey：绑定脚本与实际参数（同脚本换参数各自确认） ----------
  await checkAsync('skill_exec 批量免问 key：绑定脚本与 argv，同脚本不同参数不共用免问', async () => {
    const tmp = tmpHome('skillkey');
    try {
      const keys: Array<string | undefined> = [];
      const { handlers } = buildTools({
        mcp: null,
        kanbanUrl: KANBAN_URL,
        auditHome: tmp,
        confirm: async (req) => {
          keys.push(req.batchKey);
          return false; // 闸门即拒，不真正执行脚本
        },
      });
      const exec = handlers.get('skill_exec')!;
      // 仓库自带技能脚本（skills/helios-kanban-remote/scripts/hk.sh），闸门在执行前拦截
      await exec({ skill: 'helios-kanban-remote', script: 'scripts/hk.sh', args: ['tasks', 'list'] });
      await exec({ skill: 'helios-kanban-remote', script: 'scripts/hk.sh', args: ['tasks', 'delete', 'abc'] });
      await exec({ skill: 'helios-kanban-remote', script: 'scripts/hk.sh' });
      assert.deepEqual(
        keys,
        [
          'skill:helios-kanban-remote/scripts/hk.sh:tasks list',
          'skill:helios-kanban-remote/scripts/hk.sh:tasks delete abc',
          'skill:helios-kanban-remote/scripts/hk.sh', // 无参数不拼尾随冒号
        ],
        `实际 keys=${JSON.stringify(keys)}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- MCP 动态工具名：非法名跳过注册并 warn，不拖垮整个 tools 数组 ----------
  await checkAsync('MCP 工具名非法（含空格/加前缀后超 64）时跳过并 warn，合法工具不受影响', async () => {
    const tmp = tmpHome('mcpname');
    const origWarn = console.warn;
    const warns: string[] = [];
    console.warn = (m?: unknown) => {
      warns.push(String(m));
    };
    try {
      const longName = 'a'.repeat(60); // 加 kanban_ 前缀后 67 > 64
      const mcp = {
        connected: true,
        tools: [
          { name: 'bad name!', description: 'x', inputSchema: { type: 'object', properties: {} } },
          { name: longName, description: 'x', inputSchema: { type: 'object', properties: {} } },
          { name: 'good_tool', description: 'x', inputSchema: { type: 'object', properties: {} } },
        ],
        callTool: async () => 'ok',
      } as unknown as KanbanMcp;
      const { openAiTools, handlers } = buildTools({ mcp, kanbanUrl: KANBAN_URL, auditHome: tmp });
      const names = openAiTools.map((t) => t.function.name);
      assert.ok(!names.includes('kanban_bad name!'), '含空格名应跳过');
      assert.ok(!names.includes(`kanban_${longName}`), '超长名应跳过');
      assert.ok(names.includes('kanban_good_tool'), '合法名应注册');
      assert.ok(handlers.has('kanban_good_tool') && !handlers.has('kanban_bad name!'));
      assert.ok(warns.some((w) => w.includes('kanban_bad name!')), `应有跳过告警: ${JSON.stringify(warns)}`);
    } finally {
      console.warn = origWarn;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- localToolSummary：memory 行按启用标志拼接 ----------
  await checkAsync('localToolSummary：memory 未启用时摘要不列 memory_*，启用时才拼入', async () => {
    assert.ok(!LOCAL_TOOL_SUMMARY.some((t) => t.name.startsWith('memory_')), '基础摘要不应含 memory 行');
    assert.equal(localToolSummary(false).length, LOCAL_TOOL_SUMMARY.length);
    const withMem = localToolSummary(true);
    assert.equal(withMem.length, LOCAL_TOOL_SUMMARY.length + 1);
    assert.ok(withMem.some((t) => t.name === 'memory_set/get/delete/note'));
  });

  finish();
}

void main();
