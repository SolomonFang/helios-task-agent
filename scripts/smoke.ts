// Smoke test: MCP connectivity + tool registry + local tools. No LLM calls.
// Run: npm run smoke

import fs from 'fs';
import os from 'os';
import path from 'path';
import { KanbanMcp } from '../src/mcp';
import { buildTools } from '../src/tools';
import { currentConfig } from '../src/config';
import { buildSystemPrompt } from '../src/prompt';
import { MemoryStore } from '../src/memory';
import { classifyHk, classifyLark, classifyMcp, withBatchApproval, type ConfirmRequest } from '../src/guard';
import { SourceRegistry, extractSourceUrls } from '../src/source-registry';
import { ConfirmationManager } from '../src/confirm';
import { createAccessChecker, splitText, parsePostContent } from '../src/channels/feishu';
import { parseDailyTime } from '../src/scheduler';
import { runAgentTurn } from '../src/llm';
import type { OpenAiClient } from '../src/types';

async function main(): Promise<void> {
  const cfg = currentConfig();
  let failures = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  const mcp = new KanbanMcp({ command: cfg.mcpCommand, args: cfg.mcpArgs });
  try {
    const tools = await mcp.connect({ timeoutMs: 60000 });
    check('MCP 连接 helios-kanban', true, `${tools.length} 个工具`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check('MCP 连接 helios-kanban', false, message);
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-memory-'));
  const memory = new MemoryStore(tmpHome);
  const { openAiTools, handlers } = buildTools({
    mcp: mcp.connected ? mcp : null,
    kanbanUrl: cfg.kanbanUrl,
    memory,
    userId: 'local',
  });
  check(
    '工具注册（含 lark_cli/hk_cli/repo_fs/memory_*）',
    handlers.has('lark_cli') &&
      handlers.has('hk_cli') &&
      handlers.has('repo_fs') &&
      handlers.has('memory_set') &&
      handlers.has('memory_get'),
    `共 ${openAiTools.length} 个工具`,
  );
  check(
    'OpenAI 工具定义格式',
    openAiTools.every((t) => t.type === 'function' && Boolean(t.function.name)),
  );

  await handlers.get('memory_set')!({ key: 'feishu_task_source', value: 'https://example.feishu.cn/base/test' });
  const mem2 = new MemoryStore(tmpHome);
  const got = mem2.getFact('local', 'feishu_task_source');
  check('memory 持久化读写', got === 'https://example.feishu.cn/base/test', got || '');
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (mcp.connected) {
    const create = openAiTools.find((t) => t.function.name === 'kanban_create_task');
    const required =
      create &&
      create.function.parameters &&
      typeof create.function.parameters === 'object' &&
      'required' in create.function.parameters
        ? (create.function.parameters as { required?: string[] }).required
        : [];
    check('kanban_create_task 可用', Boolean(create), create ? JSON.stringify(required || []) : '');

    const listProjects = [...handlers.keys()].find((k) => k.includes('list_projects'));
    if (listProjects) {
      const out = await handlers.get(listProjects)!({});
      check('MCP list_projects 调用', typeof out === 'string' && out.length > 0, out.slice(0, 80).replace(/\n/g, ' '));
    } else {
      check('MCP list_projects 调用', false, '未找到 list_projects 工具');
    }
  }

  const larkOut = await handlers.get('lark_cli')!({ args: ['--version'] });
  check('lark_cli 工具', /lark-cli/i.test(larkOut), larkOut.trim());

  const hkOut = await handlers.get('hk_cli')!({ args: ['health'] });
  check('hk_cli health', /success|OK/i.test(hkOut), hkOut.slice(0, 80).replace(/\n/g, ' '));

  const repoRoot = path.join(__dirname, '..');
  const listOut = await handlers.get('repo_fs')!({ action: 'list', root: repoRoot, path: 'src' });
  check('repo_fs list', /prompt\.ts|tools\.ts|repo-fs\.ts/.test(listOut), listOut.slice(0, 120).replace(/\n/g, ' '));
  const escapeOut = await handlers.get('repo_fs')!({ action: 'read', root: repoRoot, path: '../.env' });
  check('repo_fs 拒绝路径越界', /越界|禁止/.test(escapeOut), escapeOut.slice(0, 80));

  const prompt = buildSystemPrompt({
    mcpOk: mcp.connected,
    mcpToolNames: mcp.tools.map((t) => t.name),
    kanbanUrl: cfg.kanbanUrl,
    memoryText: '- feishu_task_source: https://example.feishu.cn/base/test',
  });
  check(
    '系统提示词包含技能与记忆',
    prompt.includes('helios-kanban-remote') &&
      prompt.includes('lark_cli') &&
      prompt.includes('用户记忆') &&
      prompt.includes('feishu_task_source') &&
      prompt.includes('飞书→看板') &&
      prompt.includes('不要自动 start') &&
      !prompt.includes('Kimi Plan（技术设计）'),
    `${prompt.length} 字符`,
  );

  // ---- 写闸门 / 安全分类（离线） ----
  check(
    'lark 分类：只读放行',
    classifyLark(['--help']) === 'read' &&
      classifyLark(['im', '+chat-list']) === 'read' &&
      classifyLark(['im', '+messages-search', '--query', 'x']) === 'read' &&
      classifyLark(['api', 'GET', '/open-apis/x']) === 'read' &&
      classifyLark(['task', '+get-my-tasks']) === 'read',
  );
  check(
    'lark 分类：写与未知拦截',
    classifyLark(['im', '+messages-send', '--chat-id', 'x', '--text', 'hi']) === 'write' &&
      classifyLark(['api', 'POST', '/open-apis/x']) === 'write' &&
      classifyLark(['base', '+record-create']) === 'write' &&
      classifyLark(['mystery-cmd']) === 'write',
  );
  check(
    'hk 分类',
    classifyHk(['health']) === 'read' &&
      classifyHk(['tasks', 'list']) === 'read' &&
      classifyHk(['projects']) === 'read' &&
      classifyHk(['tasks', 'create', 't']) === 'write' &&
      classifyHk(['tasks', 'delete', 'id']) === 'write' &&
      classifyHk(['start', 'id']) === 'write' &&
      classifyHk(['projects', 'update', 'id']) === 'write',
  );
  check(
    'mcp 分类',
    classifyMcp('list_projects') === 'read' &&
      classifyMcp('get_task') === 'read' &&
      classifyMcp('create_task') === 'write' &&
      classifyMcp('delete_task') === 'write' &&
      classifyMcp('start_workspace') === 'write' &&
      classifyMcp('mystery_tool') === 'write',
  );

  const urls = extractSourceUrls('标题 https://xxx.feishu.cn/docx/abc123 和 https://y.larksuite.com/wiki/z9。');
  check('来源 URL 提取', urls.length === 2 && urls[0] === 'https://xxx.feishu.cn/docx/abc123', urls.join(','));

  const gateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-gate-'));
  const reg = new SourceRegistry(gateHome);
  let confirmCalls = 0;
  const gated = buildTools({
    mcp: null,
    kanbanUrl: 'http://127.0.0.1:9', // 故意不可达
    registry: reg,
    auditHome: gateHome,
    userId: 'local',
    confirm: async () => {
      confirmCalls++;
      return false;
    },
  });
  const denied = await gated.handlers.get('hk_cli')!({ args: ['tasks', 'create', 'x'] });
  check('闸门拒绝时写操作不执行', confirmCalls === 1 && /拒绝了该写操作/.test(denied), denied.slice(0, 50));

  reg.record('local', 'https://xxx.feishu.cn/docx/abc', {
    taskId: 'unknown',
    title: '旧任务',
    createdAt: '2026-07-22T00:00:00.000Z',
  });
  const dupOut = await gated.handlers.get('hk_cli')!({
    args: ['tasks', 'create', '重复', '--desc', '来源 https://xxx.feishu.cn/docx/abc'],
  });
  check('重复来源拦截且不进闸门', /已同步过/.test(dupOut) && confirmCalls === 1, dupOut.slice(0, 50));
  const auditText = fs.existsSync(path.join(gateHome, 'audit.log'))
    ? fs.readFileSync(path.join(gateHome, 'audit.log'), 'utf8')
    : '';
  check('审计日志写入', auditText.includes('blocked_dup') && auditText.includes('denied'));

  const wrapped = await gated.handlers.get('lark_cli')!({ args: ['--version'] });
  check('lark_cli 输出带 UNTRUSTED 标记', wrapped.includes('UNTRUSTED_FEISHU_CONTENT'));

  // ---- 确认管理器（bot 通道，离线） ----
  const cm = new ConfirmationManager(async () => {});
  const pr1 = cm.request('u1', { kind: 'kanban', summary: 's', detail: 'd' });
  const a1 = cm.resolveFromText('u1', '确认');
  check('文本「确认」放行闸门（仅此次）', a1 === 'approved' && (await pr1) === 'once');
  const pr2 = cm.request('u1', { kind: 'kanban', summary: 's', detail: 'd' });
  const a2 = cm.resolveFromText('u1', '取消');
  check('文本「取消」拒绝闸门', a2 === 'denied' && (await pr2) === false);
  let cardId = '';
  const cm2 = new ConfirmationManager(async (_o, _c, _r, id) => {
    cardId = id;
  });
  const pr3 = cm2.request('u1', { kind: 'kanban', summary: 's', detail: 'd', batchKey: 'kanban:create_task' });
  await new Promise((r) => setImmediate(r));
  check(
    '卡片回调「同类免问」+ 过期卡片忽略',
    cm2.resolveFromCard('u1', cardId, 'batch') === 'approved_batch' &&
      (await pr3) === 'batch' &&
      cm2.resolveFromCard('u1', cardId, 'batch') === 'ignored',
  );
  const cm3 = new ConfirmationManager(async () => {}, { timeoutMs: 30, destructiveTimeoutMs: 30 });
  check('确认超时自动拒绝', (await cm3.request('u2', { kind: 'hk', summary: 's', detail: 'd' })) === false);

  // 收窄确认词：pending 期间随口应答不再误放行；明确词仍可批准
  const prC = cm.request('u1', { kind: 'kanban', summary: 's', detail: 'd' });
  check(
    'pending 期间随口「好」/「ok」不批准',
    cm.resolveFromText('u1', '好') === 'ignored' && cm.resolveFromText('u1', 'ok') === 'ignored',
  );
  check('「确认执行」仍可批准', cm.resolveFromText('u1', '确认执行') === 'approved' && (await prC) === 'once');

  // 「都允许」仅对可批量操作生效；无 batchKey 时按非应答忽略
  const prBatch = cm.request('u1', { kind: 'kanban', summary: 's', detail: 'd', batchKey: 'k' });
  check(
    '文本「都允许」= 同类免问',
    cm.resolveFromText('u1', '都允许') === 'approved_batch' && (await prBatch) === 'batch',
  );
  const prNoKey = cm.request('u1', { kind: 'kanban', summary: 's', detail: 'd' });
  check('无 batchKey 时「都允许」不生效', cm.resolveFromText('u1', '都允许') === 'ignored');
  cm.resolveFromText('u1', '取消');
  await prNoKey;

  // pending 被新请求替代：旧请求拒绝 + onSuperseded 通知
  let supersededSummary = '';
  const cm4 = new ConfirmationManager(async () => {}, {
    onSuperseded: (_o, req) => {
      supersededSummary = req.summary;
    },
  });
  const prOld = cm4.request('u3', { kind: 'kanban', summary: 'old', detail: 'd' });
  const prNew = cm4.request('u3', { kind: 'kanban', summary: 'new', detail: 'd' });
  check('pending 被替代时旧请求拒绝并通知', (await prOld) === false && supersededSummary === 'old');
  const aNew = cm4.resolveFromText('u3', '确认');
  check('替代后新请求可确认', aNew === 'approved' && (await prNew) === 'once');

  // ---- 批量确认（仅 'batch' 裁决缓存：同类放行 / 异类与无 key 重问 / 'once' 与拒绝不缓存） ----
  let asks = 0;
  const batchConfirm = withBatchApproval(async () => {
    asks++;
    return 'batch' as const;
  }, 60000);
  const mkReq = (batchKey?: string): ConfirmRequest => ({ kind: 'kanban', summary: 's', detail: 'd', batchKey });
  const b1 = await batchConfirm(mkReq('kanban:create_task'));
  const b2 = await batchConfirm(mkReq('kanban:create_task'));
  const b3 = await batchConfirm(mkReq('kanban:start_task'));
  const b4 = await batchConfirm(mkReq());
  check('批量确认：同类放行、异类/无key重问', Boolean(b1 && b2 && b3 && b4) && asks === 3, `asks=${asks}`);
  let onceAsks = 0;
  const onceConfirm = withBatchApproval(async () => {
    onceAsks++;
    return 'once' as const;
  }, 60000);
  await onceConfirm(mkReq('k'));
  await onceConfirm(mkReq('k'));
  check('批量确认：「仅此次」不缓存', onceAsks === 2);
  let denyAsks = 0;
  const denyConfirm = withBatchApproval(async () => {
    denyAsks++;
    return false as const;
  }, 60000);
  await denyConfirm(mkReq('k'));
  await denyConfirm(mkReq('k'));
  check('批量确认：拒绝不缓存', denyAsks === 2);

  // ---- 飞书文本拆分 ----
  const longText = '段落一\n\n'.repeat(1500);
  const parts = splitText(longText, 3000);
  check(
    '长文本拆分：全部 ≤ 上限',
    parts.length >= 2 && parts.every((p) => p.length <= 3000),
    `${parts.length} 段`,
  );
  check('短文本不拆', splitText('短', 3000).join('') === '短');

  // ---- owner 认领 ----
  const ac = createAccessChecker([]);
  check(
    '白名单为空：首个用户认领 owner，其余拒绝',
    ac.check('ou_first') === 'claim' &&
      ac.check('ou_first') === 'allow' &&
      ac.check('ou_second') === 'deny' &&
      ac.list().join(',') === 'ou_first',
  );
  const ac2 = createAccessChecker(['ou_a']);
  check('白名单已配：仅放行列表内用户', ac2.check('ou_a') === 'allow' && ac2.check('ou_b') === 'deny');

  // ---- 晨报时间解析 ----
  check(
    '每日时间解析',
    parseDailyTime('9:05')?.hh === 9 &&
      parseDailyTime('23:59')?.mm === 59 &&
      parseDailyTime('25:00') === null &&
      parseDailyTime('abc') === null &&
      parseDailyTime('') === null,
  );

  // ---- post 富文本解析 ----
  const postJson = JSON.stringify({
    title: '需求文档',
    content: [
      [
        { tag: 'text', text: '请看 ' },
        { tag: 'a', text: '这个链接', href: 'https://x.feishu.cn/docx/1' },
      ],
      [{ tag: 'at', user_name: '张三' }, { tag: 'text', text: ' 跟进' }, { tag: 'img' }],
    ],
  });
  const postText = parsePostContent(postJson);
  check(
    'post 富文本解析',
    postText.includes('需求文档') &&
      postText.includes('这个链接(https://x.feishu.cn/docx/1)') &&
      postText.includes('@张三') &&
      postText.includes('[图片]'),
    postText.slice(0, 60).replace(/\n/g, ' '),
  );

  // ---- /stop 中断 ----
  const fakeClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error('不应被调用');
        },
      },
    },
  } as unknown as OpenAiClient;
  const stopCtl = new AbortController();
  stopCtl.abort();
  const stopOut = await runAgentTurn({
    client: fakeClient,
    model: 'm',
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ],
    tools: [],
    handlers: new Map(),
    signal: stopCtl.signal,
  });
  check('/stop：已中止信号立即返回', stopOut.includes('中断'));

  try {
    fs.rmSync(gateHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  await mcp.close();
  console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke 运行异常:', err);
  process.exit(1);
});
