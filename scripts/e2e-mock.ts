// E2E test with a local mock OpenAI server — verifies the full agent loop
// against the REAL helios-kanban MCP. Run: npm run test:e2e
//
// 严格模式：HTA_REQUIRE_E2E=1 时，前置缺失（缺 lark-cli / 看板不可达）不再 SKIP 退出（退出码 0），
// 而是 FAIL 退出（退出码 1 并说明缺什么前置），防止发布链路上「verify 通过」掩盖 e2e 未真跑。
// scripts/smoke.ts 的 SKIP 用例共用同一开关。

import http from 'http';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import path from 'path';
import { errMessage } from '../src/infra/err';
import { checkLarkCli } from '../src/infra/deps';
import { fetchKanbanHealth } from '../src/kanban/http';

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
        state.error = errMessage(err);
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

/** 兜底清理：按 id 直调看板 HTTP API 删除测试任务（同 src/kanban/http.ts 的 DELETE /api/tasks/<id>）。 */
async function cleanupTestTask(kanbanUrl: string, state: MockState): Promise<void> {
  if (!state.taskId) return;
  try {
    // 正常链路已删除时这里是重复 DELETE（404），无害；不校验响应，只保证请求发出
    await fetch(`${kanbanUrl}/api/tasks/${state.taskId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error(`测试任务兜底清理失败，请手动删除（task_id=${state.taskId}）: ${errMessage(err)}`);
  }
}

async function main(): Promise<void> {
  // 前置检查：缺 lark-cli / 看板不可达属于环境问题，默认按 SKIP 退出（退出码 0，同 smoke.ts 惯例）；
  // HTA_REQUIRE_E2E=1 时改为 FAIL（退出码 1），防止发布链路上「verify 通过」掩盖 e2e 未真跑
  const requireE2e = process.env.HTA_REQUIRE_E2E === '1';
  const skipOrFail = (reason: string): void => {
    if (requireE2e) {
      console.error(`FAIL  e2e-mock  — HTA_REQUIRE_E2E=1 要求 e2e 必须执行，但前置缺失：${reason}`);
      process.exit(1);
    }
    console.log(`SKIP  e2e-mock  — ${reason}`);
  };
  if (!checkLarkCli()) {
    skipOrFail('未找到可执行命令「lark-cli」，请先安装并完成授权后再运行本用例');
    return;
  }
  const kanbanUrl = (process.env.HELIOS_KANBAN_URL || 'http://localhost:7964').replace(/\/+$/, '');
  const health = await fetchKanbanHealth(kanbanUrl);
  if (health !== 'ok') {
    skipOrFail(`看板不可达（${kanbanUrl}: ${health}），请先启动 helios-kanban`);
    return;
  }

  const { server, state, port } = await startMockServer();
  const bin = path.join(__dirname, '..', 'src', 'cli.ts');
  const tsx = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  // 隔离环境：临时 HOME + 强制 .env（最高优先级），避免用户/项目 .env 覆盖 mock 端点
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-e2e-'));
  let exitCode = 0;
  try {
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

    // 总超时保护：子进程挂起时 kill 并计失败，不能永久卡住 npm run verify
    const E2E_TIMEOUT_MS = 180_000;
    let timedOut = false;
    const code = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, E2E_TIMEOUT_MS);
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve(c ?? 1);
      });
    });

    const failures: string[] = [];
    if (timedOut) failures.push(`agent 超过 ${E2E_TIMEOUT_MS / 1000}s 未退出，已强制 kill`);
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
      exitCode = 1;
    } else {
      console.log('E2E 通过 ✓');
      console.log(`  project_id = ${state.projectId}`);
      console.log(`  创建任务 → 删除任务 → lark_cli，全链路经真实 helios-kanban MCP 验证`);
    }
  } finally {
    server.close();
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    // 兜底清理：只要 mock 侧拿到过 taskId，无论脚本成败（含超时 kill）都按 id 删除，不在看板留残留任务
    await cleanupTestTask(kanbanUrl, state);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
