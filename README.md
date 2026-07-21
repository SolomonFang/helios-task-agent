# Helios Task Agent

终端 / 飞书私聊智能体：把飞书内容整理成 [helios-kanban](https://github.com/SolomonFang/vibe-kanban) 任务，并支持启动、跟进 coding agent。

## 安装

```bash
npm i -g helios-task-agent
# 或
npx helios-task-agent
```

Node.js >= 18。

## 像 Hermes 一样用

配置保存在用户目录（与仓库无关）：

```text
~/.helios-task-agent/.env
~/.helios-task-agent/memory.json
```

### 终端

```bash
helios-task-agent
```

首次运行会引导配置模型（LLM）；也可事先编辑 `~/.helios-task-agent/.env`。

### 飞书私聊机器人

```bash
helios-task-agent bot
# 或
helios-task-agent-bot
```

1. **第一次运行会自动进入向导**：打印开放平台勾选清单，并询问 `App ID` / `App Secret`（以及尚未配置时的 LLM）
2. 按提示在 [飞书开放平台](https://open.feishu.cn/) 建好机器人（长连接 + `im.message.receive_v1`）
3. 向导保存后建立长连接；用手机**私聊**机器人即可

无需公网 Webhook。进程在线才能收消息。

改配置：再跑一次 `helios-task-agent bot` 并在缺项时重填，或直接编辑 `~/.helios-task-agent/.env`。

## 命令

| 命令 | 作用 |
|------|------|
| `helios-task-agent` | 交互式终端 Agent |
| `helios-task-agent bot` | 飞书私聊机器人（缺配置则向导） |
| `helios-task-agent-bot` | 同上 |
| `helios-task-agent help` | 帮助 |

本地开发：`npm start` / `npm run bot`（仍会加载用户目录与项目 `.env`）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 必填（向导可写） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | bot 必填（向导可写） |
| `FEISHU_ALLOWED_OPEN_IDS` | 可选，逗号分隔 open_id 白名单 |
| `HELIOS_KANBAN_URL` | 看板地址，默认 `http://localhost:7964` |
| `HELIOS_TASK_AGENT_HOME` | 数据目录，默认 `~/.helios-task-agent` |
| `HELIOS_TASK_AGENT_ENV` | 强制指定 `.env` 写入路径 |

加载顺序：用户目录 `.env` → 项目 `.env` → 当前目录 `.env`（后者覆盖前者）。完整示例见 [.env.example](.env.example)。

### 开放平台清单（向导也会打印）

1. 创建企业自建应用 → 启用机器人  
2. 事件订阅 → **使用长连接接收事件** → `im.message.receive_v1`  
3. 权限：读取单聊消息、以应用身份发消息 → 发布版本  
4. 复制 App ID / App Secret  

## 飞书里可以说

- `/help` `/memory` `/clear`
- 「以后都从这个飞书地址同步任务：\<链接\>」
- 「同步我的任务」/「列出我的任务」（任务中心条目若含飞书链接，会再拉链接详情展示，确认后再写 kanban）
- 「有哪些项目」「创建一个任务：…」

记忆按飞书 `open_id` 分桶。

## 依赖组件

- **helios-kanban**：本机地址未就绪时会自动 `npx -y helios-kanban`（可用 `HELIOS_KANBAN_AUTO_START=0` 关闭）；默认再连 MCP，失败降级 `hk.sh`
- **lark-cli**（可选）：读飞书文档/群消息

## 开发

```bash
npm install
npm run typecheck
npm run smoke
npm run build
```

## License

ISC
