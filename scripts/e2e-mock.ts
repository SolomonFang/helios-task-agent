// E2E test with a local mock OpenAI server — verifies the full agent loop
// against the REAL helios-kanban MCP. Run: npm run test:e2e

import http from 'http';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import path from 'path';

const TEST_TITLE = '【测试】Helios Task Agent 冒烟任务（自动删除）';
const FINAL_REPLY = '模拟回复：任务已创建并清理，链路正常。';

function extractUuid(text: string | undefined): string | null {
  const m = String(text).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

function toolCall(name: string, args: Record<string, unknown>) {
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

interface MockState {
  calls: number;
  projectId: string | null;
  taskId: string | null;
  createdOk: boolean;
  deletedOk: boolean;
  larkOk: boolean;
  error: string | null;
}

function startMockServer(): Promise<{ server: http.Server; state: MockState; port: number }> {
  const state: MockState = {
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
      const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content?: string }> };
      const lastTool = (parsed.messages || []).filter((m) => m.role === 'tool').pop();

      let payload: unknown;
      try {
        if (state.calls === 1) {
          payload = toolCall('kanban_list_projects', {});
        } else if (state.calls === 2) {
          state.projectId = extractUuid(lastTool?.content);
          if (!state.projectId) throw new Error('list_projects 结果中未找到 project_id: ' + lastTool?.content);
          payload = toolCall('kanban_create_task', {
            project_id: state.projectId,
            title: TEST_TITLE,
            description: '由 scripts/e2e-mock.ts 自动创建，验证后会自动删除。',
          });
        } else if (state.calls === 3) {
          const content = lastTool?.content || '';
          state.taskId = extractUuid(content);
          if (!state.taskId) throw new Error('create_task 结果中未找到 task_id: ' + content);
          payload = toolCall('kanban_get_task', { task_id: state.taskId });
        } else if (state.calls === 4) {
          const content = lastTool?.content || '';
          state.createdOk = content.includes(TEST_TITLE);
          payload = toolCall('kanban_delete_task', { task_id: state.taskId });
        } else if (state.calls === 5) {
          const content = lastTool?.content || '';
          state.deletedOk = Boolean(state.taskId && content.includes(state.taskId));
          payload = toolCall('lark_cli', { args: ['--version'] });
        } else {
          const content = lastTool?.content || '';
          if (/lark-cli version/.test(content)) state.larkOk = true;
          payload = finalReply();
        }
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
        payload = finalReply();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      resolve({ server, state, port: addr.port });
    });
  });
}

async function main(): Promise<void> {
  const { server, state, port } = await startMockServer();
  const bin = path.join(__dirname, '..', 'src', 'cli.ts');
  const tsx = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  // 隔离环境：临时 HOME + 强制 .env（最高优先级），避免用户/项目 .env 覆盖 mock 端点
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-e2e-'));
  const forcedEnv = path.join(tmpHome, '.env');
  fs.writeFileSync(
    forcedEnv,
    `LLM_BASE_URL=http://127.0.0.1:${port}/v1\nLLM_API_KEY=mock-key\nLLM_MODEL=mock-model\n`,
    'utf8',
  );
  const child = spawn(process.execPath, [tsx, bin], {
    env: {
      ...process.env,
      HELIOS_TASK_AGENT_HOME: tmpHome,
      HELIOS_TASK_AGENT_ENV: forcedEnv,
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_API_KEY: 'mock-key',
      LLM_MODEL: 'mock-model',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let stdout = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  // 流程固定产生两次写闸门确认（create_task + delete_task），依次回答 y
  child.stdin.write('创建一个测试任务然后删掉\ny\ny\n/exit\n');
  child.stdin.end();

  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  server.close();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const failures: string[] = [];
  if (code !== 0) failures.push(`agent 退出码 ${code}`);
  if (state.error) failures.push('mock 侧错误: ' + state.error);
  if (!state.projectId) failures.push('未能从 list_projects 获取 project_id');
  if (!state.createdOk) failures.push('create_task 结果未包含测试标题');
  if (!state.deletedOk) failures.push('delete_task 未确认删除');
  if (!state.larkOk) failures.push('lark_cli 工具未成功执行');
  if (!stdout.includes('写操作请求')) failures.push('未出现写操作确认提示（闸门未触发）');
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
