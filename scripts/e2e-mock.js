'use strict';

// E2E test with a local mock OpenAI server — verifies the full agent loop
// against the REAL helios-kanban MCP:
//   1) mock LLM 要求 kanban_list_projects
//   2) mock LLM 用真实 project_id 要求 kanban_create_task
//   3) mock LLM 用返回的 task_id 要求 kanban_delete_task（清理现场）
//   4) mock LLM 输出最终回复
// 同时验证 lark_cli 工具可被调用。无需真实 LLM API。Run: node scripts/e2e-mock.js

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const TEST_TITLE = '【测试】Helios Task Agent 冒烟任务（自动删除）';
const FINAL_REPLY = '模拟回复：任务已创建并清理，链路正常。';

function extractUuid(text) {
  const m = String(text).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

function toolCall(name, args) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

function finalReply() {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: FINAL_REPLY } }],
  };
}

function startMockServer() {
  const state = {
    calls: 0,
    projectId: null,
    taskId: null,
    createdOk: false,
    deletedOk: false,
    larkOk: false,
    error: null,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      state.calls++;
      const parsed = JSON.parse(body);
      const lastTool = (parsed.messages || []).filter((m) => m.role === 'tool').pop();

      let payload;
      try {
        if (state.calls === 1) {
          payload = toolCall('kanban_list_projects', {});
        } else if (state.calls === 2) {
          state.projectId = extractUuid(lastTool && lastTool.content);
          if (!state.projectId) throw new Error('list_projects 结果中未找到 project_id: ' + (lastTool || {}).content);
          payload = toolCall('kanban_create_task', {
            project_id: state.projectId,
            title: TEST_TITLE,
            description: '由 scripts/e2e-mock.js 自动创建，验证后会自动删除。',
          });
        } else if (state.calls === 3) {
          const content = (lastTool && lastTool.content) || '';
          state.taskId = extractUuid(content);
          if (!state.taskId) throw new Error('create_task 结果中未找到 task_id: ' + content);
          payload = toolCall('kanban_get_task', { task_id: state.taskId });
        } else if (state.calls === 4) {
          const content = (lastTool && lastTool.content) || '';
          state.createdOk = content.includes(TEST_TITLE);
          payload = toolCall('kanban_delete_task', { task_id: state.taskId });
        } else if (state.calls === 5) {
          const content = (lastTool && lastTool.content) || '';
          state.deletedOk = content.includes(state.taskId);
          payload = toolCall('lark_cli', { args: ['--version'] });
        } else {
          const content = (lastTool && lastTool.content) || '';
          if (/lark-cli version/.test(content)) state.larkOk = true;
          payload = finalReply();
        }
      } catch (err) {
        state.error = err.message;
        payload = finalReply();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

async function main() {
  const { server, state, port } = await startMockServer();
  const bin = path.join(__dirname, '..', 'bin', 'helios-task-agent.js');
  const child = spawn(process.execPath, [bin], {
    env: {
      ...process.env,
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_API_KEY: 'mock-key',
      LLM_MODEL: 'mock-model',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stdin.write('创建一个测试任务然后删掉\n/exit\n');
  child.stdin.end();

  const code = await new Promise((resolve) => child.on('close', resolve));
  server.close();

  const failures = [];
  if (code !== 0) failures.push(`agent 退出码 ${code}`);
  if (state.error) failures.push('mock 侧错误: ' + state.error);
  if (!state.projectId) failures.push('未能从 list_projects 获取 project_id');
  if (!state.createdOk) failures.push('create_task 结果未包含测试标题');
  if (!state.deletedOk) failures.push('delete_task 未确认删除');
  if (!state.larkOk) failures.push('lark_cli 工具未成功执行');
  if (!stdout.includes(FINAL_REPLY)) failures.push('agent 输出中未找到最终回复');

  if (failures.length) {
    console.error('E2E 失败:');
    for (const f of failures) console.error('  - ' + f);
    console.error('\n--- agent stdout ---\n' + stdout);
    process.exit(1);
  }
  console.log('E2E 通过 ✓');
  console.log(`  project_id = ${state.projectId}`);
  console.log(`  创建任务 → 删除任务 → lark_cli，全链路经真实 helios-kanban MCP 验证`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
