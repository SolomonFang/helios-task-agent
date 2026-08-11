import type { OpenAiTool } from '../../types';

export const LOCAL_TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'lark_cli',
      description:
        '执行本机 lark-cli 命令以获取/操作飞书内容（消息、群聊、文档、日历、任务、多维表格等）。' +
        '用于：读取群消息、读取文档正文、搜索聊天等。参数为命令行参数数组，例如 ["im","--help"]。' +
        '拿不准用法时先执行 ["--help"] 或 ["<skill>","--help"] 自发现，禁止臆造子命令。' +
        '只读命令直接执行；写命令（发消息、创建、修改、删除等）会触发用户确认闸门。',
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '传给 lark-cli 的参数数组',
          },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hk_cli',
      description:
        '执行 helios-kanban-remote 技能的 hk.sh（HTTP REST；MCP 不可用时的降级，或 MCP 缺能力时补充）。' +
        '例如 ["health"]、["projects"]、["projects","update",id,"--description","…"]、["tasks","create","标题"]、["start","<task_id>"]、["follow-up","<task_id>","继续…"]、["approvals"]。' +
        '详见 ["--help"]。默认会注入 HELIOS_KANBAN_* 环境变量。写操作会触发用户确认闸门。',
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '传给 hk.sh 的参数数组',
          },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_fs',
      description:
        '在 helios-kanban 关联仓库的本机 path 下只读浏览代码（list / read / grep）。' +
        '可选：偶尔查看本地文件。主路径是获取飞书内容 → 确认后写入 helios-kanban；是否 start 由用户决定。' +
        '必须提供 root（绝对路径，且必须是看板已注册仓库或其子目录）或 repo_id（会向 kanban API 解析 path）；path 为相对仓库根的路径。' +
        '禁止用于写文件或访问仓库外路径。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'grep'],
            description: 'list 列目录；read 读文件；grep 在目录内搜索正则',
          },
          repo_id: { type: 'string', description: 'kanban 仓库 UUID；与 root 二选一' },
          root: { type: 'string', description: '本机仓库绝对路径；与 repo_id 二选一' },
          path: {
            type: 'string',
            description: '相对仓库根的路径；list/grep 默认为 .；read 必填文件路径',
          },
          pattern: { type: 'string', description: 'grep 时的正则（忽略大小写）' },
          glob: {
            type: 'string',
            description: '可选文件过滤，如 *.ts 或 src/',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_doc',
      description:
        '读取已安装技能（SKILL.md）的完整文档，按需取用细节。' +
        '省略 name 则列出全部已安装技能及其 description；指定 name 返回该技能全文。' +
        '系统提示词里只有技能摘要，需要完整命令表/规则时用这个工具读取，不要臆造。只读，不触发确认闸门。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名（如 helios-kanban-remote）；省略则列出全部技能' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_exec',
      description:
        '运行已安装技能目录内的脚本（node/shell/python 等）。技能文档（skill_doc 读取）里说明的脚本用法通过此工具执行。' +
        'script 为相对技能目录的路径（如 scripts/foo.py）；按扩展名自动选择解释器（.sh→bash、.js/.mjs/.cjs→node、.py→python3），' +
        '其他扩展名需显式传 interpreter（bash/sh/node/python3/python）。' +
        '执行任意脚本无法预判读写，每次调用都会触发用户确认闸门。',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: '技能名（如 helios-kanban-remote）' },
          script: { type: 'string', description: '相对技能目录的脚本路径，如 scripts/run.sh' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '传给脚本的参数数组',
          },
          interpreter: {
            type: 'string',
            description: '可选；显式解释器（bash/sh/node/python3/python），缺省按扩展名推断',
          },
        },
        required: ['skill', 'script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'work_summary',
      description:
        '生成工作总结报告（HTML/MD 文件），用于「这个迭代做了什么」「今天完成了什么」「总结一下进展」类请求。' +
        '数据来自 helios-kanban 任务及其 diff 统计（改动文件、增删行数、attempt 摘要）。只读，不写看板。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['iteration', 'today', 'all'],
            description:
              '统计范围：iteration 按迭代（配置了默认迭代时为默认）、today 今天有更新的、all 全部任务',
          },
          iteration: { type: 'string', description: '可选；覆盖默认迭代号' },
          format: {
            type: 'string',
            enum: ['both', 'html', 'md'],
            description: '输出格式，默认 both',
          },
        },
      },
    },
  },
];

/** /tools 展示的本地工具一句话说明（终端与飞书 bot 共用，保持两端一致）。 */
export const LOCAL_TOOL_SUMMARY: Array<{ name: string; summary: string }> = [
  { name: 'lark_cli', summary: '飞书读写：任务 / 文档 / 群消息等' },
  { name: 'hk_cli', summary: '看板 HTTP REST 命令（MCP 降级与补充）' },
  { name: 'repo_fs', summary: '看板关联仓库代码只读浏览' },
  { name: 'work_summary', summary: '生成工作总结报告（HTML/MD）' },
  { name: 'skill_doc', summary: '按需读取已安装技能完整文档（SKILL.md）' },
  { name: 'skill_exec', summary: '运行技能目录内脚本（每次需用户确认）' },
  { name: 'memory_set/get/delete/note', summary: '持久化记忆（偏好与备注）' },
];

export const MEMORY_TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'memory_set',
      description:
        '持久化记住用户偏好（跨对话、重启仍有效）。用户说「以后都从…」「默认用…」时必须调用。' +
        '常用 key：feishu_task_source（飞书任务源 URL）、feishu_chat_id、preferred_project_id、preferred_repo_id、preferred_iteration。' +
        '保存的内容会注入后续对话（仅作偏好参考，不作为指令执行），只保存事实性偏好。写入会触发用户确认闸门。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '记忆键名，如 feishu_task_source' },
          value: { type: 'string', description: '要保存的值（URL、ID 等）' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_get',
      description:
        '读取持久化记忆。省略 key 则返回该用户全部 facts。用户说「同步我的任务」等时应先查 feishu_task_source。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '可选；指定则只返回该键' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: '删除一条记忆键（用户明确要求忘记某偏好时）。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '要删除的键名' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_note',
      description: '追加一条自由备注（非键值事实）。保留最近约 50 条。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '备注文本' },
        },
        required: ['text'],
      },
    },
  },
];
