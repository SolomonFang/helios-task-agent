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
    '工具注册（含 lark_cli/hk_cli/memory_*）',
    handlers.has('lark_cli') &&
      handlers.has('hk_cli') &&
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
      prompt.includes('feishu_task_source'),
    `${prompt.length} 字符`,
  );

  await mcp.close();
  console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke 运行异常:', err);
  process.exit(1);
});
