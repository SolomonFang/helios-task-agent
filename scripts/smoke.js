'use strict';

// Smoke test: MCP connectivity + tool registry + local tools. No LLM calls.
// Run: npm run smoke

const { KanbanMcp } = require('../src/mcp');
const { buildTools } = require('../src/tools');
const { currentConfig } = require('../src/config');
const { buildSystemPrompt } = require('../src/prompt');

async function main() {
  const cfg = currentConfig();
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  // 1. MCP connect + listTools
  const mcp = new KanbanMcp({ command: cfg.mcpCommand, args: cfg.mcpArgs });
  let tools = [];
  try {
    tools = await mcp.connect({ timeoutMs: 60000 });
    check('MCP 连接 helios-kanban', true, `${tools.length} 个工具`);
  } catch (err) {
    check('MCP 连接 helios-kanban', false, err.message);
  }

  // 2. tool registry
  const { openAiTools, handlers } = buildTools({ mcp: mcp.connected ? mcp : null, kanbanUrl: cfg.kanbanUrl });
  check('工具注册（含 lark_cli/hk_cli）', handlers.has('lark_cli') && handlers.has('hk_cli'),
    `共 ${openAiTools.length} 个工具`);
  check('OpenAI 工具定义格式', openAiTools.every((t) => t.type === 'function' && t.function.name));

  // 3. MCP create_task schema presence
  if (mcp.connected) {
    const create = openAiTools.find((t) => t.function.name === 'kanban_create_task');
    check('kanban_create_task 可用', Boolean(create), create ? JSON.stringify(create.function.parameters.required || []) : '');

    // 4. real read-only MCP call
    const listProjects = [...handlers.keys()].find((k) => k.includes('list_projects'));
    if (listProjects) {
      const out = await handlers.get(listProjects)({});
      check('MCP list_projects 调用', typeof out === 'string' && out.length > 0, out.slice(0, 80).replace(/\n/g, ' '));
    } else {
      check('MCP list_projects 调用', false, '未找到 list_projects 工具');
    }
  }

  // 5. lark_cli
  const larkOut = await handlers.get('lark_cli')({ args: ['--version'] });
  check('lark_cli 工具', /lark-cli/i.test(larkOut), larkOut.trim());

  // 6. hk_cli health
  const hkOut = await handlers.get('hk_cli')({ args: ['health'] });
  check('hk_cli health', /success|OK/i.test(hkOut), hkOut.slice(0, 80).replace(/\n/g, ' '));

  // 7. system prompt builds and embeds skill
  const prompt = buildSystemPrompt({
    mcpOk: mcp.connected,
    mcpToolNames: mcp.tools.map((t) => t.name),
    kanbanUrl: cfg.kanbanUrl,
  });
  check('系统提示词包含技能内容', prompt.includes('helios-kanban-remote') && prompt.includes('lark_cli'),
    `${prompt.length} 字符`);

  await mcp.close();
  console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke 运行异常:', err);
  process.exit(1);
});
