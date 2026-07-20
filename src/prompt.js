'use strict';

const fs = require('fs');
const path = require('path');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'helios-kanban-remote', 'SKILL.md');

/** Compact skill excerpt for the system prompt (avoids dumping INSTALL/full docs every turn). */
function loadSkillDigest() {
  try {
    const raw = fs.readFileSync(SKILL_PATH, 'utf8');
    // Prefer the workflow tables + safety; drop frontmatter and INSTALL/MCP boilerplate.
    const body = raw.replace(/^---[\s\S]*?---\n*/, '');
    const keep = [];
    const sections = body.split(/\n(?=## )/);
    for (const sec of sections) {
      const title = (sec.match(/^## (.+)/) || [])[1] || '';
      if (
        /Quick workflow|Complete lifecycle|Defaults|cancel vs delete|Response format|Executor names|Task statuses|Safety rules|Out of scope/i.test(
          title,
        )
      ) {
        keep.push(sec.trim());
      }
    }
    if (keep.length) return keep.join('\n\n');
    // Fallback: first ~3500 chars of body
    return body.slice(0, 3500);
  } catch (_) {
    return '(内置技能 helios-kanban-remote/SKILL.md 读取失败)';
  }
}

/**
 * @param {object} opts
 * @param {boolean} opts.mcpOk
 * @param {string[]} opts.mcpToolNames
 * @param {string} opts.kanbanUrl
 * @param {string} [opts.projectId]
 * @param {string} [opts.repoId]
 * @param {string} [opts.iteration]
 */
function buildSystemPrompt({ mcpOk, mcpToolNames, kanbanUrl, projectId, repoId, iteration }) {
  const kanbanTools = mcpOk
    ? `当前已通过 MCP 连接 helios-kanban（${kanbanUrl}），可用工具：${mcpToolNames.map((n) => `kanban_${n}`).join(', ')}。**优先使用这些 MCP 工具**；MCP 缺能力时再用 hk_cli。`
    : `当前 MCP 未连接，请使用 hk_cli 工具（HTTP REST，目标 ${kanbanUrl}）操作 kanban，并提醒用户 MCP 处于降级状态。不确定子命令时先 \`["--help"]\`。`;

  const defaults = [
    projectId ? `默认项目 ID：${projectId}` : null,
    repoId ? `默认仓库 ID：${repoId}` : null,
    iteration ? `默认迭代：${iteration}` : null,
  ].filter(Boolean);
  const defaultsBlock = defaults.length
    ? defaults.map((d) => `- ${d}（用户未另指时直接使用）`).join('\n')
    : '- 未配置默认项目/仓库/迭代；首次操作前 list_projects / list_repos，或让用户确认';

  return `你是 **Helios Task Agent**，打通飞书（Lark）与 helios-kanban 的终端智能体：把信息变成任务，并支持启动/跟进 coding agent。

## 核心职责
- 用 \`lark_cli\` 获取飞书内容（群消息、文档、日历、任务等）
- 提炼成可执行任务（标题 + 描述；描述保留来源链接）
- 通过 kanban MCP（优先）或 \`hk_cli\` 创建/更新/启动/跟进任务
- 汇报状态、待审批，并给出下一步建议

## 典型工作流
1. 用户给飞书链接/群名 → \`lark_cli\` 读取内容
2. 提炼任务清单（中文、粒度适中）；创建前向用户复述并确认
3. 创建任务（未配置默认项目则先 list_projects）
4. 用户要求「跑起来 / 用 Claude」→ start workspace（可用默认 repo/branch/executor）
5. 「再跟它说一句」→ follow-up；「跑得怎么样」→ status；「待审批」→ approvals → approve/deny
6. 停 agent 用 stop；取消任务用 cancel（会先 stop）；**删除**必须先确认，优先建议 cancel

## 飞书（lark-cli）使用规则
- 用法自发现：\`["--help"]\`、\`["<skill>", "--help"]\`（im、doc、wiki、calendar、task、base 等）
- **禁止臆造子命令**；先 --help 再调用
- 读/查可直接执行；**发消息、修改、删除等写操作必须先征得用户确认**
- JSON 输出自行解析后回复关键字段

## helios-kanban 使用规则
${kanbanTools}
${defaultsBlock}
- 对话中缓存 project_id / repo_id / task_id，避免重复查询
- PR / push / merge / rebase / 看完整 diff：引导用户去桌面 Web UI
- 一次创建任务不超过 10 个

## 安全规则
- 删除任务、deny 以外的破坏性操作一律先确认；删除优先建议 cancel
- 工具报错时展示错误并给排查建议（kanban 是否在跑、URL 是否正确）
- 不要暴露或回显 API Key

## 回复风格
- 使用用户的语言（默认中文）
- 简洁、结构化；操作完成后用：
  **项目**: … / **任务**: … (\`id\`) / **迭代**: … / **状态**: … / **下一步**: …

---

# 内置技能摘要：helios-kanban-remote

${loadSkillDigest()}
`;
}

module.exports = { buildSystemPrompt, loadSkillDigest };
