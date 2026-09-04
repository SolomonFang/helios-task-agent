# UED 审查 Issue 清单

> 来源：2026-08-05 从极其挑剔的 UED 视角对 CLI + 飞书 bot 全链路体验的人工审查。
> 级别：P1 = 误导用户/有安全风险；P2 = 文案可理解性；P3 = 细节打磨。
> 状态：`[ ]` 待修复 / `[x]` 已修复。
> 注意：文中代码位置引用（`src/...:行号`）为 2026-08-05 审查时点快照，后续重构可能漂移（如 `src/bot.ts` 已改名 `src/bot-main.ts`），以 git 历史为准。

## P1 误导与高风险

- [x] **U1 模型校验两个分支的默认行为相反，必按错**
  - 位置：`src/config-wizard.ts:74-82`
  - 现象：「无法预检」时 `[Y/n]` 默认是**仍然保存**；「校验失败」时 `[Y/n]` 默认是**修改重试**。两个相邻问题同样按回车，结果完全相反，肌肉记忆必然误操作。
  - 方案：统一为不对称显式选择——默认动作始终是「重试/修改」，保存必须显式输入 `s`。

- [x] **U2 确认卡片「取消」按钮误用 danger 红色**
  - 位置：`src/confirm.ts:215-220`
  - 现象：取消是**安全**操作，却给了红色 danger 样式；而「同类免问 10 分钟」是**扩大授权**的操作，反而没有任何视觉警示。视觉权重与安全语义完全颠倒。
  - 方案：「取消」改 default 样式；「同类免问」保持非 primary 并靠文案传达后果（文案已含时长）。

- [x] **U3 `/confirm on` 命名反直觉**
  - 位置：`src/cli.ts:75,303-313`、`src/bot.ts:46`
  - 现象：`/confirm on` 的实际效果是「撤销免问、恢复逐次确认」——“on” 的字面预期是“开启免问/开启确认”，两头都说得通，用户必困惑。
  - 方案：新增语义化别名 `/confirm revoke`（恢复逐次确认），`/confirm on` 保留兼容；帮助文案以 revoke 为主。

- [x] **U4 owner 认领机制对被拒用户零指引**
  - 位置：`src/channels/feishu.ts:262`
  - 现象：陌生人抢先私聊即成为 owner；真正的部署者（或换了账号的 owner 本人）被拒时只收到「已绑定给其他用户」，没有任何自救路径，只能去翻进程日志。
  - 方案：拒绝文案补充「若你是本实例的部署者，请检查 .env 中的 FEISHU_ALLOWED_OPEN_IDS」。

- [x] **U5 校验重试循环无法回头改 preset/模型名**
  - 位置：`src/config-wizard.ts:83-90`
  - 现象：校验失败后只能改 API Key 或 Base URL；若是 preset 选错或模型名填错，只能 Ctrl+C 重跑整个向导。
  - 方案：「修改哪项」增加 `m=模型名` 选项。

## P2 文案可理解性

- [x] **U6 「post 消息」技术黑话 + 拒绝后无出路**
  - 位置：`src/bot/handler.ts:179-182`
  - 现象：「暂只支持文字与富文本（post）消息」——用户不知道什么是 post；发图片/文件被拒后也不知道接下来该怎么办。
  - 方案：改为「暂只支持文字消息：图片/文件里的内容，请直接打字或粘贴文字发给我」。

- [x] **U7 确认卡片「裁决时效」术语硬核**
  - 位置：`src/confirm.ts:236`
  - 方案：改「确认有效期」。

- [x] **U8 卡片标题「飞书写操作确认」缺分隔，可读性差**
  - 位置：`src/confirm.ts:228`、`src/confirm.ts:253-274`（终态卡片同样问题）
  - 方案：`飞书写操作确认` → `飞书 · 写操作确认`（看板/记忆同理）。

- [x] **U9 配置向导出现内部黑话「与 Hermes 相同」**
  - 位置：`src/config-wizard.ts:23`
  - 现象：面向最终用户的引导文案引用了用户不可能知道的内部项目名。
  - 方案：删除该括注，或改为自解释的说明。

- [x] **U10 「API Key (sk-...)」前缀假设误导**
  - 位置：`src/config-wizard.ts:59,88`
  - 现象：并非所有 OpenAI 兼容服务商的 key 都以 sk- 开头（如部分国内厂商），示例前缀会让用户怀疑自己填错。
  - 方案：去掉 `sk-...`，只留「输入显示为 *」。

- [x] **U11 迭代默认值示例「260717」无格式出处**
  - 位置：`src/config-wizard.ts:100-102`
  - 方案：补充「格式与看板 Web UI 迭代名一致」。

- [x] **U12 「ocr」命名与光学字符识别（OCR）混淆**
  - 位置：`src/bot/handler.ts:74`、`src/bot.ts:210-212`、`src/deps.ts:101-103`
  - 现象：AI 审查的通知与 /status 里出现「ocr」，用户第一反应是文字识别，不知道是代码审查工具。
  - 方案：用户可见文案统一写「open-code-review（代码审查）」或「代码审查工具」，保留命令名 `ocr` 仅出现在安装命令里。

- [x] **U13 bot 文本降级确认的 detail 无格式，长命令难读**
  - 位置：`src/bot.ts:272-276`
  - 现象：卡片发送失败降级为纯文本时，detail（完整命令）与正文混排。
  - 方案：detail 用换行+缩进分隔，与卡片代码块视觉对齐。

- [x] **U14 「(无回复)」半角括号，中文语境不统一**
  - 位置：`src/bot/handler.ts:371,380`
  - 方案：改「（无回复）」。

- [x] **U15 lark-cli 未授权提示在 banner 内外重复出现**
  - 位置：`src/ui.ts:120-124`（banner 内已含）与 `src/cli.ts:173-174`（banner 外再 warn 一次）
  - 方案：banner 内已有完整状态行时，banner 外不再重复；仅 missing 时保留外部安装提示（banner 内是“未找到”，外部给安装命令，不重复）。

- [x] **U16 CLI 与 bot 帮助示例两端漂移**
  - 位置：`src/cli.ts:78-85` vs `src/bot.ts:54-60`
  - 现象：「把 xx 群最近的聊天整理成任务」只在 CLI 帮助里有；两端示例靠手工同步，必然越漂越远。
  - 方案：示例列表抽到 `commands.ts` 共用，两端各自只包一层标题。

## P3 细节打磨

- [x] **U17 CLI 代码块渲染注入前导空格，复制即污染**
  - 位置：`src/ui.ts:217`
  - 现象：代码块每行被加两格缩进做视觉区分，用户复制出来每行都带前缀空格。
  - 方案：不加缩进，仅靠灰色着色区分（终端里颜色已是足够的边界提示）。

- [x] **U18 `/config` 换看板地址后，MCP 连旧实例的警告一次性闪过**
  - 位置：`src/cli.ts:366-373`
  - 现象：只提示一次，之后的对话里 kanban_* 工具静默操作旧看板，用户极易忘记。
  - 方案：`/status` 输出中持续显示「MCP 连接实例与配置地址不一致」直到重启。

- [x] **U19 回环地址警告未告知在哪里改配置**
  - 位置：`src/bot.ts:191-198`
  - 现象：提示「把 HELIOS_KANBAN_URL 配置为局域网 IP」，但没说是哪个文件。
  - 方案：附上 `userEnvPath()` 路径。

## 第二轮复查（2026-08-05，修复后回归审查）

- [x] **R1 banner 未授权行自我重复**：`未授权，飞书能力不可用（已安装但未授权：…）` 一句里「未授权」出现两次。`src/ui.ts` 改为行内精简指引；`scripts/unit.ts` 断言同步更新。
- [x] **R2 确认卡片 replyHint 排版不一致**：`「确认」仅此次 ·「同类免问」…` 分隔符前后缺空格，两个分支风格也不统一。`src/confirm.ts` 统一为空格分隔。
- [x] **R3 操作类型字段漏改**：U8 给卡片标题加了 `·` 分隔，但字段值 `${kindText}写操作` 漏了，仍连成一团。已补。
- [x] **R4 被拒文案给了指引但没给关键信息**：让用户改 `FEISHU_ALLOWED_OPEN_IDS` 却不告诉用户自己的 open_id，指引无法执行。现直接在拒绝消息里附上该用户的 open_id。`src/channels/feishu.ts`。
- [x] **R5 闸门提示「同类免问10分钟」缺空格**：`src/cli.ts`。
- [x] **R6 重配模型看不到当前选择**：`/config` 重进向导时选择列表不显示当前模型。CLI 与 bot 的 `choose` 标题动态带上「当前 xxx」。

## 第三轮复查（2026-08-05，覆盖 watcher 卡片 / 报告 / README / .env.example）

- [x] **W1 文档漂移**：README/README.en 仍写 `/confirm on`（一轮已改主命令为 `/confirm revoke`）；「Hermes 风格/与 Hermes 类似」内部黑话还残留在 README 标题与 `.env.example`。已全部同步修正。
- [x] **W2 watcher 卡片标题 markdown 注入风险**：任务标题来自看板数据，却嵌进 lark_md 的 `**《标题》**`——标题含 `*` 等字符会破坏渲染；同一文件的审批列表明明已经因此用了 plain_text。标题改为 plain_text（`src/kanban/watcher.ts`）。
- [x] **W3 llm-error 网络错误病句**：「检查 LLM_BASE_URL（可用 /config）与网络（代理）后重试」语法不通，改为通顺表述（`src/llm-error.ts`）。
- [x] **W4 watcher 纯文本与卡片按钮措辞不一致**：按钮写「人工审查」，文本写「人工 review diff」；「帮我 review」中英混排。统一为「人工审查 diff」「帮我审一下」（watcher.ts + README）。
- [x] **W5 看板就绪超时暴露毫秒**：「超时（90000ms）」是程序员单位，改为秒并补充「多数是首次 npx 下载慢」的出路（`src/kanban/kanban-ensure.ts`）。

## 第四轮复查（2026-08-05，覆盖向导校验报错 / bin 入口 / 审查报告）

- [x] **X1 `--help` 全英文、与产品内全中文语气割裂**：`bin/helios-task-agent.js` 的帮助与「Unknown command」是英文，而 `helios-task-agent-bot` 入口和全部产品内文案都是中文。已改为中文（命令名保留英文）。
- 结论：feishu-verify / llm-verify 的向导报错文案（含排查指引与「仍保存」出路）、review-report 的严重度映射与通过页文案、`helios-task-agent-bot` 入口均无需修改。

## 第五轮复查（2026-08-05，真实渲染回归）

- [x] **B1 banner 长行顶破边框**：`box()` 固定宽 66，MCP 失败/降级链/模型地址等长行直接溢出，右边框错位。`box()` 改为按内容自适应加宽（`src/ui.ts`），渲染复检通过。
- [x] **B2 MCP 降级文案嵌套括号**：「连接失败（已自动切换为 hk_cli（看板 HTTP 接口），功能不受影响）」内外两重全角括号，外层改逗号分隔。
- 结论：向导校验报错、审查报告模板、bot 入口、watch 卡片等其余表面本轮复看无新问题。
- [x] **B3 确认卡片 summary 星号注入**：确认/终态卡片的 `**${summary}**` 里嵌着任务标题，标题含 `*` 会切换加粗破坏排版（与 W2 同类）。星号全角化转义（`src/confirm.ts`）。

## 第六轮复查（2026-08-10，目录重构后全链路复审）

> 背景：`src/` 目录重构（agent/bot/channels/config/infra/kanban/report 分层）后的首次全链路复审，覆盖 CLI、配置向导、bot 消息处理、确认卡片、看板推送/晨报/报告、启动链路、agent 工具层、文档一致性八个表面。文中行号为修复时点快照。

### P1 误导与高风险

- [x] **F1 MCP 失败告警谎称「看板功能不受影响」，与同屏 banner 矛盾**：降级链（hk.sh）硬依赖 jq/curl，但 CLI 与 bot 的 MCP 失败文案无条件承诺「功能不受影响」，而 banner 可能同时显示「降级链不可用」。修复：CLI 探测提前、降级链可用时 banner 外不再重复；缺依赖时改口「看板读写暂不可用」并附安装命令；bot 启动补 `checkHkDeps()` 探测，`/tools`、`/status` 的 downNote 同步条件化（`src/cli.ts`、`src/bot-main.ts`、`src/bot/handler.ts`、`src/commands.ts`）。
- [x] **F2 飞书白名单提示「回车=不限制」与实际行为相反**：实际留空是「首个私聊者自动认领为唯一 owner」，既不「不限制」还有陌生人抢占风险。向导改为如实描述认领语义并给出回填路径（`src/config/config-wizard.ts`）。
- [x] **F3 待审批卡片计数是截断后的数字**：watcher `slice(0,5)` 后卡片拿截断长度当总数，8 条只显示「5 个」且漏审。`WatchEvent` 加 `total` 字段，卡片标题用真实总数并补「…还有 N 个」（`src/kanban/watcher.ts`、`src/channels/feishu-cards.ts`）。

### P2 文案可理解性与死胡同

- [x] **F4 校验失败重试流没有「原样重试」出口**：报错让用户「检查网络后重试」，交互却强制修改某项。模型/飞书两个分支均改为「回车 = 直接重试；输入 k/b/m/r 修改；输入 s = 仍然保存」（U1 语义保持：保存必须显式输入 s）。
- [x] **F5 无协议 Base URL 被误报「http:// 明文传输」**：漏写 `https://` 时病因诊断错误。先判 scheme 缺失并直接重问（`config-wizard.ts`）。
- [x] **F6 「已安装但未授权」病句复发**（R1 同类）：`bootstrap.ts` 拼前缀与 `LARK_CLI_AUTH_HINT` 自带前缀重复，去重。
- [x] **F7 手动启动指引硬编码 PORT=7964 且对 AUTO_START=0 用户复读**：`kanbanManualStartHint(opts)` 支持传入解析端口与 autoStart 上下文；`bootstrap.ts` 对未内嵌指引的错误才兜底打印（消除重复）。
- [x] **F8 「高危键」黑话 + 不给目标路径**：cwd .env 忽略告警改为说明原因（凭证/命令注入）并附 `userEnvPath()` 确切路径（`src/config/config.ts`）。
- [x] **F9 上下文超限两处正则漂移**：自愈失败后用户拿不到「/clear」指引。`llm-error.ts` 复用 `agent/llm.ts` 导出的 `CONTEXT_OVERFLOW_RE`，env 路径改 `userEnvPath()`。
- [x] **F10 异常路径进度占位永久停在「处理中」**：/stop 或 LLM 失败后占位仍劝「/stop 可中断」。catch 分支先把占位更新为终态（「⏹ 已中断。」/「⚠️ 处理失败，详见下方」）再回复（`src/bot/handler.ts`）。
- [x] **F11 AI 审查失败/并发上限/超时文案**：「ocr 执行失败」黑话改「代码审查工具」、stderr 倾倒收敛为尾部 3 行（完整进日志）、失败与超时均补「重新点击卡片『AI 审查』重试」出路、并发上限提示补操作入口（`src/kanban/ai-review.ts`、`src/bot/handler.ts`）。
- [x] **F12 群 @ 指引先邀请后拒绝**：非白名单用户被邀请私聊后立刻吃拒绝。回执前查白名单，deny 则静默（刻意不用 `access.check()`，避免群里陌生人借此抢占 owner）（`src/channels/feishu.ts`）。
- [x] **F13 飞书写操作确认卡片用蓝色 header**：对外可见动作（发消息等）警示权重反而低于看板写操作（橙色）。统一 orange（`feishu-cards.ts`）。
- [x] **F14 推送暴露英文状态键**：「todo → inreview」与晨报/报告的「待审阅」两套语言。新增 `statusLabel()`（`src/kanban/summary.ts`），watcher 文本与卡片统一中文状态。
- [x] **F15 降级纯文本指引「点卡片『AI 审查』」**：降级时根本没有卡片。watcher 文本版去除卡片专属指引（`watcher.ts`）。
- [x] **F16 晨报引导语与范围不匹配**：无迭代配置时晨报是全部迭代、引导语却让「总结这个迭代」。按配置动态选择（`daily-brief.ts`）。
- [x] **F17 bot 把 MCP 原始英文错误内联糊给用户**：用户面只留中文结论 + 已知模式诊断 hint，原文收 HTA_DEBUG（`bot-main.ts`）；mcp.ts 诊断 hint 结尾不再无条件承诺「不受影响」。
- [x] **F18 确认超时通知无自救路径**：追加「如仍需执行，直接再跟我说一声即可。」（`bot-main.ts`）。
- [x] **F19 被拒文案「部署目录 .env」不具体**：改 `userEnvPath()` 确切路径（`feishu.ts`）。
- [x] **F20 确认卡片项目字段展示原始 UUID**：用户无法核对落点，标注为「项目 ID」（项目名解析留待后续）（`src/agent/tools/kanban-mcp.ts`）。
- [x] **F21 /clear 不重置「同类免问」且文案未告知**：新增 `clearedText(n)`，清空后仍有免问授权时明确提示并可 `/confirm revoke`（`src/commands.ts`、CLI 与 bot 两端接线）。
- [x] **F22 技能报错指路不给地址**：卸载/未找到两处报错附数据目录绝对路径（`src/agent/skills.ts`）。
- [x] **F23 中断/超限口径统一**：「已被用户中断」三套措辞统一为带出路的一条；工具超限两处统一为同文案同数字（30）并交代「已完成的操作不受影响，可问刚才完成了哪些」（`src/agent/llm.ts`、`tools.ts`）。
- [x] **F24 workspace 黑话集中清理**：确认摘要「启动任务的 workspace」、就绪回执「workspace setup/container」、报错「container_ref/worktree/UI loading」、prompt 教模型说「MCP 降级」、内部分支名 hly-dev 示例——统一改「工作区/备用接口/develop/转圈加载」等（`guard.ts`、`tools.ts`、`workspace-ready.ts`、`prompt.ts`）。
- [x] **F25 推送建议话术在 prompt 无映射**：补「标记完成」「帮我审一下」「为什么失败」三条映射（`prompt.ts`）。
- [x] **F26 更新跳过提示硬编码 @latest**：预发布用户会被导向错误频道，改 `@${info.tag}`（`update-check.ts`）。
- [x] **F27 `HELIOS_REPORT_HOST=0.0.0.0` 报告链接不可点击**：通配绑定地址时链接主机回退 `os.hostname()`（`report-server.ts`）。
- [x] **F28 工作总结 localhost 链接裸发**：bot 场景补「链接仅在本机可达，进程重启后失效」（`report.ts`）。
- [x] **F29 CHANGELOG 缺 [1.0.21] 条目**：更新提示里的变更记录链接指向空。按 tag 时点收编条目。
- [x] **F30 README.en 环境变量表 `HOME / ENV` 缩写照抄不生效**：改全名（同类问题回归）。

### P3 细节打磨

- [x] **F31 确认闸选项排版**：分隔符统一，暴露中文关键词「免问」（词表本已支持）（`cli.ts`）。
- [x] **F32 半角标点残留批量清理**：中文句子半角冒号/括号/方括号统一全角（cli、commands、bootstrap、deps、handler、tools、repo-fs、llm、session-store、kanban-ensure、config-wizard 等约 40 处）。
- [x] **F33 /status 状态词 ok→正常**；CLI 失败尾注「未发送成功」归因改「未被处理」；`/memory` 去掉无信息量的 `user=local` 后缀、标题「键值」改「已记住的偏好」。
- [x] **F34 renderTable 行内样式列错位**：列宽按剥离 `` ` ``/`**` 标记后的可见宽度计算（`ui.ts`）。
- [x] **F35 /config 未改模型也宣称「切换」**：未变时说「配置已更新（模型仍为 X）」（`cli.ts`）。
- [x] **F36 嵌套全角括号回归**（B2 同类）：cli /status、commands /tools、handler downNote 外层括号改逗号。
- [x] **F37 OCR 安装提示信息过载**：分层两行，删 provider 细节（README 已覆盖）（`deps.ts`）。
- [x] **F38 mdSafe 只转义 `*`**：反引号与链接语法一并中和（`feishu-cards.ts`）。
- [x] **F39 「确认有效期」标签与值语义不匹配**：改标签「有效期」+ 值「120 秒（超时自动拒绝）」，与文本降级统一（`feishu-cards.ts`）。
- [x] **F40 排队回执带位置**：「已收到并排队（前面还有 N 条）」（`handler.ts`，复用 `queuedCount()`）。
- [x] **F41 /stop 帮助补 AI 审查、破坏性操作枚举收敛、双重中断回执合并、分段失败补发提示、vision 解析失败分支措辞、npx 拉取改「自动下载」**（`bot-main.ts`、`handler.ts`）。
- [x] **F42 向导细节**：「默认 必填」矛盾、非法数字选择重问、改 Base URL/模型名回显当前值、EOF 中断说明未落盘（`config-wizard.ts`）。
- [x] **F43 确认卡片 summary 去工具名括注、优先级中文化、去重拦截 ISO 毫秒时间戳截断到分钟、创建上限去「代码层强制」黑话**（`tools.ts`）。
- [x] **F44 技能契约校验报错附 SKILL.md 完整路径**（`skills.ts`）。
- [x] **F45 闸门裁决落日志**（open_id 脱敏）（`confirm.ts`）。
- [x] **F46 看板进程退出不再倾倒 800 字符 stderr**（收 HTA_DEBUG）、「第 0 行」零基计数、报告 HTML「+N more」中英不一、严重度「高危/中危/低危」改「高/中/低」、报告 404 中文页（`kanban-ensure.ts`、`http.ts`、`report.ts`、`review-report.ts`、`report-server.ts`）。
- [x] **F47 晨报失败分组标注原状态**，消除重复计数困惑（`daily-brief.ts`）。
- [x] **F48 断线告警「请重启机器人」没说怎么重启**：改「请在部署机器上重新运行 helios-task-agent bot」（`ws-alerter.ts`）。
- [x] **F49 bot 启动等待期无反馈**：看板就绪等待与 MCP 连接窗口每 ~10 秒心跳（已等待 N 秒），MCP 心跳经 `connectMcp` onLog 在 bot-main 接线（`kanban-ensure.ts`、`mcp.ts`、`bot-main.ts`）。
- [x] **F50 文档同步**：两 README 配置目录补 skills/reviews/reports/update-check.json、环境变量表补 OCR_LLM_URL/MODEL、英文版注释补齐；bin 帮助 README 链接改 GitHub URL、--rebind/--reconfig 与 bot 内 usage 口径统一并补齐对齐。

### 本轮暂不修（记录在案）

- 确认闸倒计时提醒（120/300 秒中途无剩余时间反馈）：需要 readline 计时器配合，收益低，暂保持静态说明。
- AI 审查报告页回跳看板 diff 链接：需 handler → ai-review → review-report 跨层传参，留待下一轮。
- 晨报看板不可达时当天静默：设计意图是不打扰，暂不补降级提示。
- 会话历史恢复失败 bot 用户零感知：边缘场景，需穿透 session-store 到 channel 的通知通道，暂缓。
- 确认卡片项目 UUID 显示为项目名：需创建前解析 list_projects，本轮仅加「项目 ID」标注。
- CLI 侧 MCP 连接不接心跳：启动 spinner 已提供持续反馈，不需要。

## 第七轮复查（2026-08-20，1.0.21→1.0.29 新增功能后全表面复审）

> 背景：第六轮后经历 AI 审查功能、卡片操作优化、飞书卡片过大精简、创建上限 10→50、kanban 包改回 @latest、tools.ts 拆目录等变更。本轮 12 路并行审查覆盖全部用户可见表面（agent 工具层、prompt、bot、卡片、看板链路、CLI、向导、报告、infra、文档、新增 diff 专项），共修复 36 项。验证：typecheck 0 错误，单测 411 条全过，smoke 与 e2e（真实 helios-kanban MCP 全链路）通过。文中行号为修复时点快照。

### P1 误导与高风险

- [x] **S1 prompt 降级话术谎称「功能不受影响」+ hk_cli 黑话**：`prompt.ts` 教模型原样转告「通过备用接口（hk_cli）连接，功能不受影响」——F1 已判为谎称的同类漏网实例，且把内部黑话写进给用户的口径。改为「通过备用接口连接，大部分功能可用，如遇操作失败请稍后再试」。
- [x] **S2 MCP 掉线推送无条件宣称「已自动切换」**：`bot-main.ts` onLost 推送在 hk 降级链缺 jq/curl 时仍承诺已切换（看板读写实际不可用），是用户最常看到却漏修的一条路径。改为 `checkHkDepsAsync()` 条件化，缺依赖改口「看板读写暂不可用，缺少 jq/curl（安装提示），恢复后自动切回」。
- [x] **S3 banner 与 CLI 告警自相矛盾**：`ui.ts` banner「连接失败，已自动切换为 hk_cli…，但缺少 jq、curl，降级链不可用」同句既断言已切换又说不可用；`cli.ts` 两处同款。缺依赖分支统一不再拼接「已自动切换」，改「备用通道不可用（详见下行）」/「看板连接失败，备用通道缺少 jq、curl…」。
- [x] **S4 CLI 闸口无 batchKey 时输入「免问」被静默按取消**：确认词表两端共用，用户在 CLI 输入「免问/都允许」明确表达批准意图，实际落到「已取消，操作未执行。」且零解释，行为与意图相反。改为命中批量词时提示「该操作不支持同类免问，请回复 y 确认或 N 取消」并重新等待（`cli.ts` confirmWrite 改循环询问）。
- [x] **S5 .env.example 钉版本残留谎称官方默认**：`HELIOS_KANBAN_MCP_ARGS` 两行未注释、注释谎称钉 0.1.39「与代码内置默认值一致」并恐吓「跟随 @latest 供应链风险大，不建议改」——而 @latest 正是代码当前默认（`deps.ts`、`config.ts`），用户照抄即被静默固化在旧版。两行改为注释示例，注释改如实描述（默认跟随 @latest，钉版本用 `HELIOS_KANBAN_PACKAGE`），删除反向恐吓。

### P2 文案可理解性与死胡同

- [x] **S6 MCP_FALLBACK_TEXT 去 hk_cli、去括号**：原值自带全角括号，被 `mcp.ts`（叠「备用通道」成病句）、`handler.ts` 嵌套成双重括号。新值「已自动切换为看板 HTTP 备用通道」，deps/mcp/handler/bot-main/ui/cli 六个拼接点同步。
- [x] **S7 hk-cli 启动报错三重问题**：「无法启动 workspace」黑话回潮、向 bot 用户暴露本机环境变量名 `HELIOS_KANBAN_REPO_ID`、示例分支 `hly-dev` 照抄必失败。改「工作区」、去环境变量名、示例改 develop（`hk-cli.ts`）。
- [x] **S8 确认摘要黑话与不一致**：hk 路径摘要有 `hk` 前缀、lark 路径有 `lark-cli` 前缀、guard fallback 暴露英文工具名、空标题渲染空引号「」而 MCP 路径省略。前缀全去、fallback 固定「看板写操作」、空标题省略引号（`hk-cli.ts`、`lark-cli.ts`、`guard.ts`）。
- [x] **S9 「MCP 工具 xx 调用失败」黑话**：该文本经模型转告用户。改「看板工具 xx 调用失败」，`guard.ts` 强失败判定正则同步（`kanban-mcp.ts`、`guard.ts`）。
- [x] **S10 NO_GATE_MESSAGE 死胡同**：「写操作已被安全策略阻止」无出路。补「这通常表示服务部署时未启用确认通道，请联系部署者检查配置」。
- [x] **S11 prompt 模板黑话与标点**：workspace/executor/variant/default_target_branch 残留（模型易原样搬给用户）、回复模板半角冒号/括号（批量播撒到每条回复）、优先级只教英文键。黑话中文化并加「对用户回复不用英文术语」一条、模板全角化、补优先级中文展示指引（`prompt.ts`）。
- [x] **S12 repo-fs 报错**：「发送给 LLM」→「AI 模型」、ReDoS 黑话→「可能导致匹配卡死，请简化后重试」、`root=/path=/repo_id=` 调试键值串中文化、「kanban 不可达」→「看板」（`repo-fs.ts`）。
- [x] **S13 llm 空回复死胡同**：「（模型未返回内容）」无出路，补「请重试或换个问法」（`llm.ts`）。
- [x] **S14 /status 大改造**：键名中文化+全角冒号（模型/看板/看板连接/备用通道/lark-cli）、飞书长连接英文枚举（connected 等）中文映射、「ok」→「正常」、裸 HTTP 状态码包装「异常（HTTP 502，看板服务可能正在重启…）」、lark-cli 未授权嵌套重复（「未授权（已安装但未授权…）」）去重（`commands.ts`、`handler.ts`、`deps.ts`）。
- [x] **S15 /tools 三问题**：`buildToolsLines` 写死常量导致 memory 工具缺失（`localToolSummary()` 成死代码）、标题「kanban MCP 工具」黑话且 CLI/bot 两端不一致、降级说明嵌套括号。改用 `localToolSummary(memoryEnabled)` 两端接线、标题统一「看板工具（N 个）」（`commands.ts`、`cli.ts`、`handler.ts`）。
- [x] **S16 进度占位暴露内部工具名**：「调用工具 hta_xxx」→ `toolActionLabel()` 中文动作映射（读文件/看板操作/飞书操作等），未知回落「调用工具」（`handler.ts`）。
- [x] **S17 AI 审查错误链路**：「workspace（attempt）记录」黑话、宿主机绝对路径清单推进飞书、ocr stderr tail 原文倾倒、分支名错误暴露 `from=/to=` 且重试必败、超时路径两句措辞不同的重试指引。路径与 tail 进日志，用户面统一中文定性+可执行出路；重试指引只由 handler 追加且 message 截断 200 字符（`ai-review.ts`、`handler.ts`）。
- [x] **S18 飞书 API 原始错误直达用户**：「飞书发卡片失败： code=230001 msg=…」被拼进用户消息。channel 层统一 `apiError()`：用户面「飞书接口拒绝了发送请求，请稍后重试」，code/msg 进日志，7 处同型抛错全改（`feishu.ts`）。
- [x] **S19 kanban-ensure 三条死胡同**：非本机地址被追加本机 npx 指引（完全不对症）、spawn ENOENT 暴露英文原文且兜底指引循环无效（npx 已不存在还教用 npx）、进程退出只有 `code=1` 无原因。三路径各自内嵌对症指引（到该主机启动/安装 Node.js/端口占用排查），`bootstrap.ts` 兜底对 Node 缺失场景不再追加 npx 指引；另修复 macOS 下 ENOENT 以退出码 -2 落地的真实竞态（`kanban-ensure.ts`、`bootstrap.ts`）。
- [x] **S20 http 层英文直达用户**：信封兜底「kanban api error」、裸「HTTP 404」可经 AI 审查链路原样推给飞书用户。中文化为「看板接口返回失败（未附原因）」「看板接口异常（HTTP N）」；健康探测「响应异常（状态码 N）」；validateRows 类型名中文化（`http.ts`）。
- [x] **S21 mcp 端口文件提示黑话堆叠**：一句叠 MCP/端口文件/vibe-kanban.port 三个术语且「重启 helios-kanban」无操作入口。改现象先行：「看板运行时间过久，其端口记录文件可能已被系统清理。退出并重新运行本程序即可恢复」（`mcp.ts`）。
- [x] **S22 配置向导六处**：bot 通道「--reconfig（推荐）」会让用户在原进程在跑时起第二个实例（先停进程再重配）；open_id 全链路无获取路径（补 API 调试台指引）；英文 errMessage/json.msg 原样拼接（新增 `net-error.ts` 模式映射：连接超时/连接被拒/域名解析失败）；「https:// 或 http:// 开头」与 http 安全警告割裂；「选择仍然保存」与「输入 s」漂移；「（输入显示为 *）」在非 TTY 明文回退时承诺不存在（动态后缀「（输入可见）」）（`config/`）。
- [x] **S23 报告三处**：生成时间 ISO 串是 UTC（国内用户差 8 小时）且与 AI 审查报告口径漂移（渲染处改 `toLocaleString('zh-CN')`，数据层保持 ISO 供文件名反解）；404 页裸 HTML 死胡同（补样式+「请回到飞书重新发送指令生成新报告」）；聊天链接注脚固定「仅本机可达」与 `HELIOS_REPORT_HOST=0.0.0.0` 行为相反（按 isLoopbackUrl 分档，与卡片口径一致），并补 30 天保留期（`report.ts`、`report-server.ts`）。
- [x] **S24 晨报与报告计数口径**：晨报头部计数用截断后 50 条、底部却引导去看全量概览的报告；「失败」与状态计数正交无说明。晨报头部改用全量 `data.totals` 并标注「失败 N（含于上方状态）」；报告三形态清单末尾补「仅展示最近 50 条，共 N 条」（`daily-brief.ts`、`report.ts`）。
- [x] **S25 确认/审查卡片五处**：超时终态卡片无出路（补「直接再跟我说一声即可」与文本版对齐）；「状态变更」标签下渲染非跃迁短语「跟进执行完成」语义矛盾（无「→」时改标签「进展」）；statusLabel 未知状态回退原文未过 mdSafe；AI 审查未通过用蓝色头部（改 yellow，与「有意见需处理」匹配）；「已注入会话上下文」实现视角黑话（改「可继续追问审查结论」）（`feishu-cards.ts`）。
- [x] **S26 watcher hints 三套措辞漂移**：done/failed 事件在纯文本版与卡片注脚各说各话，降级时用户前后看到两种说法。收敛为 `watcher.ts` 导出的 `WATCH_HINT_DONE`/`WATCH_HINT_FAILED` 两常量，文本版与卡片共用。
- [x] **S27 CLI 三处**：/config 主动取消被打成红色「配置失败：已取消」（改中性「已取消，配置未变更」）；/skills 页脚「skill_doc」内部工具名（改「按需自动加载」）；HELP 的 /skills 行与 SKILLS_USAGE 两套措辞、「kanban」中英漂移（对齐并统一「看板」）（`cli.ts`、`commands.ts`）。
- [x] **S28 update-check 提示与词表不符**：「现在更新？[y=更新 / N=跳过]」半角括号，且实际接受「更新/升级/确认」等词。改「（输入 y 或「更新」确认，其他输入跳过）」（`update-check.ts`）。
- [x] **S29 文档漂移四处**：免问粒度描述过时（实为命令路径+接收对象、脚本+参数，用户按旧文档预期会觉得免问失灵）；README 中文版 workspace 黑话两处；晨报推送对象「owner」与看板推送「白名单用户」口径不一（代码实为同一集合 allowedOpenIds）；SKILL.md 回复模板让 agent 把英文状态键抛给用户（改 `{中文状态}` 并补映射表）（README×2、`.env.example`、`SKILL.md`）。

### P3 细节打磨

- [x] **S30 半角标点残留**：bin「未知命令：」、config.ts 列表引导冒号、/memory 输出、报告「（无标题）」5 处、CLI 闸口选项串分隔不一致（`bin/`、`config.ts`、`memory.ts`、`report/`、`cli.ts`）。
- [x] **S31 banner 细节**：pending 瞬态误用告警黄点（改灰点）；相邻两行重复报「缺少 jq、curl」（明细只留 hk 行）；「kanban 地址」→「看板地址」；bootstrap「技能契约：」冗余前缀（problem 自带完整文案）（`ui.ts`、`bootstrap.ts`）。
- [x] **S32 gated-write 中英混排**：「⚠️ setup 未完成」→「⚠️ 工作区初始化未完成」（判定正则同步）；「在 kanban 中删除」→「看板」（`gated-write.ts`）。
- [x] **S33 映射未命中透传英文**：确认卡片优先级未命中 PRIORITY_LABELS 时原样漏英文枚举（省略该行）；审查报告 severity/category 未命中映射时英文上徽章（补 warning/suggestion 等映射，未知兜底「提示」）（`kanban-mcp.ts`、`review-report.ts`）。
- [x] **S34 报告细节**：增删行单位三处漂移统一为「新增行/删除行」；HTML 概览补「待办」「已取消」统计卡（MD/聊天概览已有）；MD 侧用户可控数据（标题/摘要/diffUrl）最小转义，与 HTML 侧 escapeHtml 防护对齐（`report.ts`）。
- [x] **S35 workspace-ready 类型字面量**：「不是有效的 { repo_id: string } 输入」→「第 N 个仓库参数格式不正确（需要提供仓库 ID）」（`workspace-ready.ts`）。
- [x] **S36 「请联系实例 owner」中英混排**：→「请联系本实例的部署者开通」（`feishu.ts`）。

### 本轮暂不修（记录在案）

- 确认卡片 detailCodeBlock 把命令里的 ``` 静默替换为 `'''`，所见非所得：lark_md 是否支持四连反引号长围栏未验证，贸然改用可能破坏渲染，暂保持。
- 报告「仅展示最近 50 条，共 N 条」的 N 由五状态计数之和推算（summary 未导出独立全量字段），未知状态任务不计入，极端情况 N 偏小。
- unit-kanban.ts:162 测试 fixture 仍是旧「无法启动 workspace」措辞：仅透传入参，不断言用户文案，不影响产品面。

## 第八轮复查（2026-08-21，免问粒度优化后全表面复审）

> 背景：第七轮后唯一变更「feat：免问逻辑优化」（免问分级为类级/对象级两档）。本轮 12 路并行审查 = 增量 diff 专项 + 11 个用户可见表面（CLI、bot、卡片、向导、看板链路、agent 核心、工具层、报告、infra、文档、晨报），共修复 50 余项。验证：typecheck 0 错误，单测 12 个脚本全过，smoke 与 e2e（真实 helios-kanban MCP 全链路）通过。文中行号为修复时点快照。

### P1 误导与高风险

- [x] **G1 lark-cli 无目标参数时「同对象免问」失实承诺**：target 取不到时 batchKey 已退化为整命令路径（按类放行），batchScope 却硬编码 `'object'`，卡片渲染「同对象免问」。改 `batchScope: target ? 'object' : 'kind'`（`tools/lark-cli.ts`）。
- [x] **G2 /status 降级文案自相矛盾（S3 漏网链路）**：mcpDownNote「已自动切换为备用通道」与 hkMissing 追加的「备用通道缺少 jq、curl，不可用」同句矛盾，且「备用通道」行重复报缺依赖。缺依赖时改「连接失败，备用通道缺少 jq、curl，看板读写暂不可用」（`commands.ts`、`cli.ts`）。
- [x] **G3 /tools downNote 谎称「功能不受影响」（S1 漏网）**：bot 与 CLI 两端统一改「已切换为备用通道，大部分功能可用，如遇操作失败请稍后再试」（`handler.ts`、`cli.ts`）。
- [x] **G4 启动期诊断提示无条件宣称「已自动切换」（S2/S3 漏网路径）**：`diagnoseMcpFailure` 增加 `opts.fallbackAvailable`，缺 jq/curl 时改口「看板读写暂不可用（备用通道缺少 jq、curl）」；重启说明独立成句消除相邻双括号。CLI 与 bot-main 调用点按已探测的 hkMissing 传参（`mcp.ts`、`cli.ts`、`bot-main.ts`）。
- [x] **G5 文档创建上限漂移**：README×2 与 CHANGELOG 仍写「单会话最多创建 10 个」，代码已是 50。README 同步；CHANGELOG 不篡改历史（1.0.23 条目去数字、1.0.27 补 10→50 提升记录）。

### P2 文案可理解性与死胡同

- [x] **G6 免问粒度优化的漏改面**：bot 文本降级确认仍静态写「同类免问」（对象级授权被夸大，改复用 `batchScopeWord`/`batchAckText`）；bot /help 与 README 闸门行补「同对象免问」应答词与两档说明（`bot-main.ts`、README×2）。
- [x] **G7 MCP 黑话集中清理**：掉线/恢复推送、/tools 与 /status downNote、`mcp.ts` 两处 `throw 'MCP 未连接'`、启动控制台「正在连接 helios-kanban MCP…/MCP 已连接/MCP 连接失败」、连接等待心跳，统一「看板连接」；hkMissing 推送双括号改逗号串联（`bot-main.ts`、`handler.ts`、`mcp.ts`）。
- [x] **G8 原始英文错误内联用户消息两处**：确认发送失败「原因：${error}」、AI 审查降级「（${dmsg}）」均可能含 axios/fs 英文原文与宿主机绝对路径，用户面只留中文结论+出路，原文进日志（`bot-main.ts`、`handler.ts`）。
- [x] **G9 首次 AI 审查安全提示黑话堆叠**：LLM/OCR_LLM_*/OCR_LLM_TOKEN/`ocr config provider` 四术语收敛为一条可执行出路（`handler.ts`）。
- [x] **G10 网络错误映射形同虚设**：Node fetch 连接失败抛 `TypeError: fetch failed`，真实原因挂在 `err.cause`，「连接被拒/域名解析失败」映射永不命中。`friendlyNetError` 解包 cause（含 AggregateError）并补 fetch failed 兜底映射（`net-error.ts`，新增单测覆盖）。
- [x] **G11 向导三处**：k/b/m 缩写补含义说明；飞书校验失败英文 json.msg 收 HTA_DEBUG；「http:// 仅限本机调试，会有明文警告」与实际行为两处不符，改如实描述（`config-wizard.ts`、`feishu-verify.ts`）。
- [x] **G12 /config 改看板地址警示三连黑话**：MCP/kanban_*/hk_cli 同句直达用户，改「当前连接仍指向旧看板，看板工具操作的是旧看板；备用通道已指向新地址」；/status 持续警示同口径（`cli.ts`）。
- [x] **G13 CLI spinner 暴露内部工具名**：`toolActionLabel` 上移到 `commands.ts` 共用，CLI 与 bot 进度统一中文动作（`commands.ts`、`cli.ts`、`handler.ts`）。
- [x] **G14 /skills 用法教了不存在的子命令**「/skills 列表」：改「/skills（列出）· install · uninstall」（`commands.ts`）。
- [x] **G15 确认闸未识别回答静默按取消**：「好的/ok」等明确批准意图落到「已取消」零解释。非空未命中词表时提示「无法识别的回答，请回复 y 确认或 N 取消」并重问（S4 先例扩展）（`cli.ts`）。
- [x] **G16 /status lark-cli 未安装无出路**：补安装+授权指引，与未授权分支对称（`commands.ts`）。
- [x] **G17 repo-fs 错误链路（S12/S20 漏网重灾区）**：裸 HTTP 码+响应体倾倒、英文原文、误诊「看板不可达」、无效正则英文原文、key=value 调试串、pattern 中英混排、截断缺单位——统一中文定性+出路，原文进日志（`repo-fs.ts`）。
- [x] **G18 prompt 教模型的英文话术**：PR/push/merge/rebase/桌面 Web UI/attempt/URL/kanban 中文化，禁用英文术语清单补 web ui/attempt/url（`prompt.ts`）。
- [x] **G19 shared.run 错误通道**：超时单独成文（保留「命令执行失败」行首，guard 强失败判定依赖）；英文 error.message 与含本机绝对路径的完整命令不进用户面，stderr 收敛尾部 3 行进日志；ENOENT 对 python3/node/bash 补安装出路（`tools/shared.ts`）。
- [x] **G20 看板工具报错英文蛇形名**：`看板工具 start_workspace 调用失败：<英文原文>` 改复用 `summarizeMcp` 中文动作摘要，英文原文收 HTA_DEBUG（`tools/kanban-mcp.ts`）。
- [x] **G21 hk/lark 确认摘要英文子命令**：「tasks delete 9f2e4c…」「im send ou_xxx…」映射中文动作（删除看板任务/发送飞书消息等），与 MCP 通道口径对齐（`tools/hk-cli.ts`、`tools/lark-cli.ts`）。
- [x] **G22 去重拦截时间戳是 UTC**：展示处改 `toLocaleString('zh-CN')`，存储层保持 ISO（S23 同款）（`tools/gated-write.ts`）。
- [x] **G23 work_summary 失败裸给 localhost 地址**：bot 用户打不开，改「看板服务暂时无响应…请联系部署者检查看板服务」（`tools/work-summary.ts`）。
- [x] **G24 待审批纯文本版截断无提示**：列 5 条报 8 个，补「· …还有 N 个」（F3 只修了卡片版）（`watcher.ts`）。
- [x] **G25 缺默认分支报错裸 UUID+内部参数名**：列表改「仓库名（ID：…）/仓库 ID：…」（best-effort 拉取仓库名），「base_branch / --branch」改「直接告诉我使用哪个分支」（`workspace-ready.ts`）。
- [x] **G26 晨报头部失败计数仍是截断样本 + 待办不可见**：`WorkSummaryTotals` 增加 `failed`（截断前全量计数）；头部补「待办 N」，正文增加待办分组；范围内全待办时不再输出全零空晨报（`summary.ts`、`daily-brief.ts`）。
- [x] **G27 报告 MD 本机路径裸推 bot 场景**：有 linkBaseUrl 时省略 Markdown 行（F28 漏网分支）（`report.ts`）。
- [x] **G28 概览改动统计全量/样本口径混排**：截断发生时三形态统一补「改动文件与增删行仅统计最近 N 条」（`report.ts`）。
- [x] **G29 报告服务 400/405 英文裸响应**：改中文说明页；404 出路补「或重新点击卡片上的「AI 审查」」（`report-server.ts`）。
- [x] **G30 确认卡片注脚丢「超时自动拒绝」（F39 口径回归）**：batch 与非 batch 两分支补回，与文本降级版对齐（`feishu-cards.ts`）。
- [x] **G31 bootstrap 兜底两处**：非本机地址错误仍被追加本机 npx 指引（S19 修复不完整，排除条件补「非本机」）；手动启动指引硬编码 PORT=7964，改从 kanbanUrl 解析端口与 autoStart 上下文（`bootstrap.ts`）。
- [x] **G32 banner hkLine 黑话+时态矛盾**：「MCP 掉线时无法降级」改按 MCP 状态分时态（正常「看板主通道中断时将没有备用通道可用」/已 fail「看板读写当前不可用，安装后可恢复」）（`ui.ts`）。
- [x] **G33 文档三处**：README 补「--reconfig/--rebind 前先停当前进程」警告（与 llm-error 口径一致）；CHANGELOG 按 tag 时点收编 [1.0.23]–[1.0.29] 版本节（F29 同类复发，免问粒度条目保留在 Unreleased）；SKILL.md 回复模板英文残留（{priority}/running/failed/Executor 中文化+优先级中文对照表）。

### P3 细节打磨

- [x] **G34 batchAckText「该对象」指代不明**：按 kind 细化——lark「发往同一接收人」、kanban/hk「对同一任务/审批」、skill「同一脚本同一参数」；`batchAckText(scope, kind?)` 签名扩展，handler/CLI 经 `lastWriteKind` 接线传入（`guard.ts`、`bot-main.ts`、`handler.ts`、`cli.ts`）。
- [x] **G35 bot 侧**：作废确认通知补「新操作会另发确认，请留意处理」；「open-code-review」裸称统一为「代码审查工具（open-code-review）」；bot-main 控制台半角冒号 10 处全角化、「kanban 地址」中文化、`.env` 补 `userEnvPath()`、「每 60s 轮询」改「秒」。
- [x] **G36 卡片**：「重启后失效」三处补主语「机器人重启后」；AI 审查按钮标题截断 50 字符补省略号（`feishu-cards.ts`）。
- [x] **G37 向导**：「当前绑定 App ID:」半角冒号、「无法预检：…预检」重复、「bot --rebind」缩写到全称、「helios-kanban 地址」改「看板地址」（`config/`）。
- [x] **G38 agent 核心**：memory「key/value 不能为空」中文化+写盘失败补「请再试一次」；llm 工具异常三条（未知工具/参数解析/执行异常）中文化，`STRONG_FAILURE_LINE_ZH_RE` 与注释同步；skills「（无 description）」等英文残留（`memory.ts`、`llm.ts`、`guard.ts`、`skills.ts`、`commands.ts`）。
- [x] **G39 工具层**：/tools 本地摘要去「HTTP REST/MCP 降级/SKILL.md/HTML/MD」技术记号（`defs.ts`）。
- [x] **G40 看板链路**：进程退出报错「退出码 N+最后一行 stderr」收 HTA_DEBUG，用户面保留中文出路；AI 审查失败指引补「请联系部署者」落点；「（空结果）」全角；工作区初始化失败去裸 UUID、分支列表 `join('、')`（`kanban-ensure.ts`、`ai-review.ts`、`mcp.ts`、`workspace-ready.ts`）。
- [x] **G41 晨报**：「失败 0（含于上方状态）」零值不挂括注；`值非法:` 半角冒号；空范围兜底与头部范围口径统一（`daily-brief.ts`）。
- [x] **G42 报告**：chips「Token 消耗」改「模型用量（Token）」、ocr 耗时「1m23s」中文化「1 分 23 秒」；hero「AI 代码审查」统一「AI 审查」；任务级增删补「行」单位；HTML「生成时间」补全角冒号；「完成任务」统一「完成」（`report.ts`、`review-report.ts`）。
- [x] **G43 CLI**：帮助两端对齐（/skills 分隔符、/tools「看板 + 本地」、/status 与实际行标签、/memory「你的记忆」）；未知命令改首词匹配与 bot 对齐；闸口破坏性操作标题加「· 高危」（`cli.ts`）。
- [x] **G44 infra/文档**：HK_CLI_INSTALL_HINT 补无 brew 兜底与 Ubuntu 示例；技能迁移提示「包内目录/数据目录」改「个人数据目录」；.env.example 去 `sk-...` 前缀（U10 复发）、半角冒号 5 处、「先 list」中文化、ocr 表述顺序与 README 对齐（`deps.ts`、`bootstrap.ts`、`.env.example`）。
- [x] **G45 收尾一致性**：guard 强失败注释形态示例更新；unit-bot 断言随启动文案同步；mcp.ts/bot-main 启动控制台 MCP 字样清尾。

### 本轮暂不修（记录在案）

- 代码注释与文件头中的 MCP/hk_cli 字样（非用户可见面，改注释收益低且易与代码标识符脱节）。
- bot 场景 Markdown 报告仍无 HTTP 访问路径（报告服务只托管 HTML）：本轮选择 bot 场景省略 MD 行，MD 在线化留待后续。
- `lastWriteKind` 按 openId 记录最近一次写操作 kind：同用户并发两个不同 kind 确认时回执措辞可能张冠李戴（授权行为本身按 batchKey 正确，仅措辞），边缘场景暂缓。


## 第九轮复查（2026-08-24，断线告警「用户无感」改造后全表面复审）

> 背景：第八轮后经历「feat：cicd检查」（工程面，无用户可见影响）与「feat: 消息优化」（ws-alerter 断线告警改完全静默）两个增量。本轮 13 路并行审查 = 增量专项 + 12 个用户可见表面，共修复 60 余项。验证：typecheck 0 错误，单测 12 个脚本 418 条全过（含 4 个新增用例），smoke 与 e2e（真实 helios-kanban MCP 全链路）通过。文中行号为修复时点快照。

### P1 误导与高风险

- [x] **N1 断线「完全静默」论证只在短时成立，长断线 owner 零感知**：96bc508 以「SDK 自动重连 + 飞书补投」论证 reconnecting/reconnected 全面静默，但 SDK 对网络类错误无限重试、onError 几乎只在鉴权/配置类不可重试错误触发——挂机过夜/断网数小时（全是 retryable）failed 永不到来，owner 无任何感知（僵尸态回潮）；补投只在重连成功时发生，断线 6 小时消息就延迟 6 小时。告警通道（notifyOwners 走飞书 HTTPS API）与 WS 长连接独立、断线期间可送达。修：恢复低频非对称提醒——持续断线超 15 分钟推一条（之后每小时至多一条），reconnected 按是否提醒过补「已恢复」，短时抖动依旧零打扰（保留改造初衷）（`src/bot/ws-alerter.ts` 重写、`src/bot-main.ts` 接线注释，新增 3 个单测用例）。
- [x] **N2 「/status 仍可查连接状态」是循环自救**：bot 的 /status 经 WS 长连接投递，断线时根本到不了 bot。CHANGELOG 与文件头注释中的该表述已随 N1 删除。
- [x] **N3 banner 仍宣称「功能不受影响」（S1/G3 最后一个存活实例）**：banner 的 MCP 失败行与同会话 /tools「大部分功能可用，如遇操作失败请稍后再试」自相矛盾。改「大部分功能可用」（`src/infra/ui.ts`）。
- [x] **N4 免问批准回执把类级授权描述成对象级（G1 回执侧漏网）**：`batchAckText` 的 kind 分支不看 scope——lark target 缺失、kanban start 类/id 缺失时实际按类放行，回执却说「发往同一接收人」「对同一任务/审批」，用户以为只免问一个对象、实际整类静默放行。kind 分支先看 scope：类级给「飞书写操作/同类看板操作本会话内免问」，对象级才用原措辞（`src/agent/guard.ts`）。
- [x] **N5 无待确认时日常词被吞 + 谎称提示**：「算了/不用/取消/确认/yes」等日常会话词被确认拦截器吞掉（消息永远不到 LLM），还收到谎称「可能已超时/被取消/被替代」的提示。无 pending 时仅确认专属词（确认执行/同类免问/同对象免问/批量允许/以后都/一直允许/始终允许）仍拦截，日常词照常入队（`src/agent/confirm.ts`）。
- [x] **N6 AI 审查「记录已清理」同屏两个出路自相矛盾且重试必败**：错误文案给「重新发起该任务后再试」，handler 关键词机制又追加「重新点击卡片『AI 审查』重试」——旧卡片带旧 attemptId，重试必败。handler 抑制条件扩展：message 含「重新发起」/「人工审查」不再追加重试指引；执行失败分支「请稍后重试」改「请重新点击卡片上的『AI 审查』重试」（出路详略倒挂一并消除）（`src/bot/handler.ts`、`src/kanban/ai-review.ts`）。

### P2 文案可理解性与死胡同

- [x] **N7 CHANGELOG 缺 [1.0.30] 节（F29/G33 第三次复发）**：按 tag 时点收编——免问粒度条目移入 [1.0.30]，第七/八轮修复仿 [1.0.18] 先例各收编一条摘要；[Unreleased] 只留断线告警条目（按 N1 新行为改写）与本轮摘要。
- [x] **N8 MCP 失败 + 缺 jq/curl 同屏重复 2-3 遍（U15/S31 同类）**：banner 外 warn 与 banner 内 hkLine 完全重复，banner 内已完整展示（含安装命令）时外部不再打印（`src/cli.ts`）。
- [x] **N9 /status「备用通道：不可用」裸状态**：MCP 正常但缺 jq/curl 时无原因无出路，补「（缺少 jq、curl，主通道中断时将无备用；安装：…）」（`src/commands.ts`）。
- [x] **N10 /status 健康包装正则永不命中**：`/^HTTP \d+$/` 匹配不上 http.ts 实际返回的「响应异常（状态码 N）」，「看板服务可能正在重启」出路成死代码。正则改匹配「状态码 \d+」（`src/commands.ts`）。
- [x] **N11 向导看板可选字段「回车跳过」与实际行为相反**：回车实为保留当前值。改「回车 = 保留当前 <值>」并支持输入「-」清除（与白名单一致）；同屏 open_id 提示口径统一（`src/config/config-wizard.ts`）。
- [x] **N12 向导认领回填指引 `--rebind` 未提示先停在跑 bot**（S22/G33 漏网）：补「先停止当前机器人进程」（--rebind 会启动完整实例，与在跑实例冲突）。
- [x] **N13 看板地址零校验**：漏写协议头静默保存、运行时才暴露。向导增加 http(s):// scheme 校验重问（`config-wizard.ts`）。
- [x] **N14 llm-error 指引口径不齐**：CLI 分支补「（改 .env 需重启生效）」；bot modelHint 补键名「的 LLM_MODEL」（`src/config/llm-error.ts`）。
- [x] **N15 bot LLM 失败收尾英文原文未截断直达用户（F17/G8 漏网链路）**：`llmFailureParts` 未命中已知模式时 head 不再内联英文 message——只留「请求失败」+ 通用出路，原文截断 200 字符收 HTA_DEBUG；已知模式指引不变（`src/commands.ts`）。
- [x] **N16 bot 启动链路黑话与谎称三连**：启动告警「hk_cli 降级链…MCP 掉线」改「备用通道缺少 jq、curl：看板主连接中断时…」（G7 漏网）；MCP 首连失败主文案按 hkMissing 条件化（缺依赖改口「看板读写暂不可用」，S2/S3/G4 漏网分支）；CLI spinner「正在连接 helios-kanban MCP…」改「正在连接看板…」（`src/bot-main.ts`、`src/cli.ts`）。
- [x] **N17 mdSafe 漏 ~~、`<font>`、`<at>`（B3/W2/F38 同类漏网分支）**：确认卡片 summary 含外部可控的看板任务标题，可被注入删除线/彩色伪造警示/@ 提及。补 `~`→`～`、`<`→`＜`、`>`→`＞` 全角化（`src/channels/feishu-cards.ts`，新增单测）。
- [x] **N18 owner 认领欢迎语「owner」中英混排**：与拒绝文案「本实例的部署者」（S36）统一为「部署者」（`src/bot-main.ts`）。
- [x] **N19 看板信封英文 message 直达飞书用户**：envelopeData 失败抛服务端英文原文，经 AI 审查链路原样推送。用户面统一「看板拒绝了请求」，原文收 HTA_DEBUG（`src/kanban/http.ts`）。
- [x] **N20 watcher 纯文本版裸发 localhost 链接无可达性注记**：卡片发送失败降级时用户必然踩死链。`linkReachNote` 上移 watcher 导出复用，文本版链接行补注记（`src/kanban/watcher.ts`、`src/channels/feishu-cards.ts`）。
- [x] **N21 shared.run 超时归因张冠李戴**：lark-cli/技能脚本超时也被归因「看板服务响应慢」。改中性「可能是网络或服务响应慢」（`src/agent/tools/shared.ts`）。
- [x] **N22 memory 失败文案蛇形工具名前缀**（G20 同型漏网）：「memory_set 失败：」→「保存记忆失败：」等（`src/agent/tools/memory-tools.ts`）。
- [x] **N23 prompt 教的创建上限（10）与代码闸门（50）矛盾（G5 漏网）**：改 50（`src/agent/prompt.ts`）。
- [x] **N24 SKILL.md 回复模板与 prompt 禁令同屏打架**：模板教模型输出 `**URL**:`/`{target_branch}`（prompt 禁用 url 英文术语）、残留英文 or、九行半角冒号与 prompt 模板两套排版。全角化并改「链接/分支名/迭代，无则 —」（`skills/helios-kanban-remote/SKILL.md`）。
- [x] **N25 prompt 黑话残留**：「HTTP REST」括注、kanban→看板（4 处）、coding agent/base 分支/task id/URL 中文化（`src/agent/prompt.ts`）。
- [x] **N26 HK_CLI_INSTALL_HINT 嵌套全角括号系统性复发（B2/F36 同类）**：hint 内层括号改分句，五个拼接点（含直推飞书用户的一处）全部解套；ui.ts 双冒号「（安装：macOS：…」消除（`src/infra/deps.ts`、`src/infra/ui.ts`）。
- [x] **N27 确认挂起时「好的/可以」被当新对话发给模型**：确认静默挂起直到超时，行为与意图相反（CLI 侧 G15 已重问，bot 漏）。有挂起确认且文本 ≤10 字符时回复「请回复「确认」或「取消」，或点卡片上的按钮。」（每份确认只提醒一次）；长文本照常入队（`src/agent/confirm.ts` 导出 `hasPendingConfirmation`、`src/bot/handler.ts`，新增单测）。
- [x] **N28 CLI 闸口两缺口**：超时分支无出路（补「如仍需执行，再说一次即可。」，与 bot 对齐）；「空回车 = 取消」未在选项串说明（补「回车=取消」）（`src/cli.ts`）。
- [x] **N29 免问状态/撤销/cleared 文案统称「同类免问」且按「类」计数**：对象级授权被叫错名字、多个对象级 key 被数成「N 类」。统一中性「免问授权」口径（「N 项写操作免问授权生效中」），CLI/bot 两端空态同步（`src/commands.ts`、`src/cli.ts`、`src/bot/handler.ts`）。
- [x] **N30 README 示例与晨报枚举漂移**：两版 README 补「总结迭代/生成报告」示例（英文版恢复为对齐条目列表）；README×2 与 .env.example 晨报枚举补「待办」；「全部迭代」统一「全部任务」。
- [x] **N31 lark-cli 未授权告警缺影响说明**：与未安装分支不对称，补「未授权期间飞书任务/文档读取不可用」（`src/infra/deps.ts`）。
- [x] **N32 技能迁移提示不给目标路径**：附 `userSkillsDir()` 绝对路径（F22 先例）（`src/bootstrap.ts`）。
- [x] **N33 向导细节**：非 TTY 编号列表分支标题不带当前模型（R6 漏网分支）；「开发者后台」统一「飞书开放平台」；「网络 / 代理」排版统一；「请选择 [1-N]」改「请输入 1 到 N 的数字」（`src/config/`）。
- [x] **N34 工作区 404 误诊「超时未就绪」**：记录已清理时出现「超过 1 秒仍未就绪」怪话且误导排查方向。404 分支单独文案「工作区记录已被看板清理，请重新发起任务」（`src/kanban/workspace-ready.ts`）。
- [x] **N35 报告未知任务状态透传英文键（S33 同类漏网）**：`|| '其他'` 是死代码（statusLabel 对未知键返回键本身）。status.ts 新增 `isKnownStatus()`，报告未知状态归「其他」组；晨报失败分组同口径（`src/kanban/status.ts`、`src/report/report.ts`、`src/bot/daily-brief.ts`）。
- [x] **N36 变更文件「等 +N 个」死代码**：上游 slice(0,10) 不保留总数，改动 25 个文件静默只显 10 个。summary 新增 `changedFilesTotal`，报告 MD/HTML 据实渲染（`src/kanban/summary.ts`、`src/report/report.ts`）。
- [x] **N37 晨报分组计数样本与头部全量矛盾**：分组标题与「还有 N 个」改用 totals 全量；范围内仅已取消/未知状态时不再输出全零空晨报（兜底体现「已取消 N 个」）；「全部迭代」与报告「全部任务」统一（`src/bot/daily-brief.ts`）。

### P3 细节打磨

- [x] **N38** /help /status 枚举顺序与实际输出对齐（lark-cli 在备用通道前）；/skills 描述截断补省略号（`src/cli.ts`、`src/commands.ts`）。
- [x] **N39** hk/lark 摘要 fallback 透传英文子命令 → 固定「看板写操作」「飞书写操作」（S8 口径对齐）；shared.run 的 `[stderr]`/`--- stdout ---` 英文标注中文化统一；tools/index.ts 非法工具名提示的正则原文改「名称含非法字符或过长」（`src/agent/tools/`）。
- [x] **N40** 创建上限两通道口径：MCP `isCreate` 把 create_project 计入任务配额 → 限定任务创建（与 hk 对齐）（`src/agent/tools/kanban-mcp.ts`）。
- [x] **N41** memory_get 返回省略 UTC ISO updatedAt；确认 detail 的 key=value 伪调用串改「键：…/值：…」中文两行（`src/agent/tools/memory-tools.ts`）。
- [x] **N42** MCP 通道确认摘要去完整 UUID（对象标识 detail 区已有，与 hk/lark 口径一致）（`src/agent/guard.ts`）。
- [x] **N43** 超时/作废两种终态落裁决日志（verdict=timeout/superseded，open_id 脱敏）；`GateResult.reason` 扩展透传真实终态，审计可区分「用户拒绝」与「超时未处理」（`src/agent/confirm.ts`、`src/agent/guard.ts`、`src/infra/audit.ts`、tools 层透传）。
- [x] **N44** /stop 措辞统一：占位收尾改「⏹ 已中断（未完成的操作未执行，可继续对话）。」（与 llm.ts 一条）；AI 审查中断计数行与带标题通知双发收敛为带标题逐条（`src/bot/handler.ts`）。
- [x] **N45** 确认卡片 destructive 操作标题补「· 高危」（与 CLI 闸口 G43 口径一致）（`src/channels/feishu-cards.ts`）。
- [x] **N46** watcher 措辞收敛：review 分隔符统一「；」、failed 引导语抽 `WATCH_HINT_FAILED_LOG` 常量文本/卡片共用；待审批 label 兜底裸 UUID 改「未命名审批（ID：…）」（`src/kanban/watcher.ts`）。
- [x] **N47** ws-alerter 恢复通知「恢复」三现精简：「✅ 飞书长连接已自行恢复（此前重连失败，无需重启）」（`src/bot/ws-alerter.ts`）。
- [x] **N48** bot-main 细节：缺依赖列表 join('/') 与 open_id 列表 join(', ') 统一「、」；确认失败日志 open_id 一处漏脱敏补齐；认领欢迎语去 owner（`src/bot-main.ts`）。
- [x] **N49** llm.ts「模型返回为空」与「模型未返回内容」措辞统一（throw message 会展示给用户）；memory 上限「记忆键（100）」改「记忆条目（100 条）」；skills 卸载「包内内置技能」改「随产品自带的技能」；source-registry/session 控制台半角冒号（`src/agent/`）。
- [x] **N50** 审查报告类别兜底「提示」（严重度词汇、语义错位）改「其他」，CAT_LABELS 补中文类别键（与 SEV_MAP 对称）；404 页「进程重启后」改「机器人重启后」（G36 漏网）；「其余 N 条见报告文件」按 bot/CLI 分措辞；MD 报告 projectName/iteration 过 mdText；空态标点两形态统一（`src/report/`）。
- [x] **N51** 文档：README「约每 60s」改「60 秒」（G35 漏网）；.env.example 同句全半角括号混用统一；SKILL.md 模板「运行状态：」后多余空格（批次 H）。

### 本轮暂不修（记录在案）

- CLI 闸口免问词表与授权粒度脱节：类级操作下输入「同对象免问」会被静默授予类级授权（比字面范围大），反之亦然。边缘场景（用户须输入提示里没展示的词），授权行为按 batchKey 正确、仅措辞与授权范围的映射问题，暂缓。
- src/agent/llm.ts:305、src/agent/confirm.ts:195 两处 console 日志半角冒号（非用户可见面，随下轮顺手清理）。
- 第八轮遗留项（代码注释黑话、bot 场景 MD 报告在线化、lastWriteKind 并发措辞）维持暂不修结论。

## 第十轮复查（2026-09-04，六大新功能落地后全表面复审）

> 背景：第九轮后经历 5 个提交（建任务类型推断、1.0.32、技能文档同步、提醒/个人日报/迭代复盘/周报/停滞催办/AI 失败诊断六大新功能、多角度审查加固）。本轮 14 路并行审查 = 增量 diff 专项 + 13 个用户可见表面（提醒、推送链路、报告、卡片、确认闸、会话、CLI、向导、prompt/技能文档、文档一致性、工具层、看板链路、AI 审查回归），P1 三条均已人工复核代码确认。修复由 11 路并行完成；验证：typecheck 0 错误，单测 16 个套件 539 条断言全过（含新增用例），smoke 与 e2e（真实 helios-kanban MCP 全链路）通过。文中行号为审查时点快照。

### P1 误导与高风险

- [x] **T1 提醒跨形态串桶投递：飞书提醒可被 CLI 截胡并标记「已投递」，反向必败重试无休**
  - 位置：`src/agent/reminder.ts:317`（`due()` 跨全部用户桶）、`src/cli.ts:402`（deliver 忽略 uid 直接打印终端并落盘 delivered）、`src/bot-main.ts:710`（对 uid=`local` 调 `notifyOpenId` 必被飞书拒绝）
  - 现象：CLI 与 bot 默认共享 `~/.helios-task-agent/reminders.json`。飞书设的提醒到期时若本机开着 CLI，提醒只打印在终端并落盘已投递，飞书永不再推——与创建回执「到点主动推送」相反；反向 CLI 提醒被 bot 每 ≤30 分钟退避重试，永不放弃，日志持续报错。
  - 方案：Reminder 记录创建形态或 deliver 按 uid 过滤（CLI 只投 `local`、bot 跳过 `local`），跨形态桶不投递不标记。

- [x] **T2 看板可控的 diffUrl 未校验 scheme 直接进报告页 href**
  - 位置：`src/report/retro.ts:251`、`src/report/daily-report.ts:91`、`src/report/report.ts:165`（MD 侧 `report.ts:125` 同样裸嵌）
  - 现象：`<a href="${escapeHtml(t.diffUrl)}">`——escapeHtml 只挡属性逃逸，挡不住 `javascript:alert(...)` 这类 scheme；diffUrl 来自看板任务数据（代码自标 UNTRUSTED），用户在自己信任的内部报告页点「查看改动」即在报告源内执行任意脚本。
  - 方案：渲染前校验 URL 仅放行 `http:`/`https:`，其余按无链接处理（与 W2/B3/N17 外部可控数据中和同族）。

- [x] **T3 prompt 无条件教模型谎称「大部分功能可用」（S1 同型最后存活实例）**
  - 位置：`src/agent/prompt.ts:51`
  - 现象：MCP 未连接时 prompt 教模型转告「看板当前通过备用接口连接，大部分功能可用，如遇操作失败请稍后再试」——缺 jq/curl 时备用通道整体不可用，模型会在每次操作失败后仍复读该承诺。banner、/status、/tools、启动告警已全部按 hkMissing 条件化（G2/G4/N16），唯独这句没有；`buildSystemPrompt` 入参根本拿不到 hk 依赖状态。
  - 方案：`buildSystemPrompt` 增加 hkAvailable 参数，缺依赖时改教「看板读写暂不可用（备用通道缺少 jq、curl，安装后恢复）」。

### P2 文案可理解性与死胡同

- [x] **T4 AI 诊断「模型配置不完整」暴露三个环境变量名且 handler 追加必败重试**
  - 位置：`src/kanban/failure-diagnosis.ts:201` + `src/bot/handler.ts:342-344`
  - 现象：watcher 推送失败卡片（不依赖 LLM）后用户点「AI 诊断」，收到「模型配置不完整（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）…可稍后重新点击失败卡片上的『AI 诊断』重试」——配置不会自愈，重试必败。
  - 方案：改「模型配置不完整，请联系部署者检查模型配置」，并把「配置不完整」纳入 `hasOwnWayOut` 抑制词。

- [x] **T5 诊断采集阶段英文原文直达用户**：`failure-diagnosis.ts:187`（collect 在 try 外）——看板不可达/健康超时时用户收到「⚠️ AI 诊断失败：《x》\nfetch failed」或「The operation timed out.」。采集段包 try，复用 `friendlyNetError` 转中文定性，原文收 HTA_DEBUG（G8/G10/G17 同型漏网链路）。

- [x] **T6 「可设 HTA_DEBUG=1 重新运行」出路对 bot 用户不可执行**：`src/kanban/http.ts:33`——N19 修复文案面向 CLI 部署者，但新诊断/重试/AI 审查链路把它送达无部署权限的飞书用户。用户面改「请稍后重试；持续失败请联系部署者」，HTA_DEBUG 提示仅 CLI 场景拼接。

- [x] **T7 `html:false` 时截断注记指向不存在的报告**：`src/report/daily-report.ts:262`——只取素材未生成 HTML 时仍输出「…还有 N 个见上方报告链接 / 见报告文件」。注记按 `opts.htmlPath` 条件拼接，否则只报数量（「完整清单可直接问我」）。

- [x] **T8 停滞提醒时长文案可与事实相反**：`src/kanban/watcher.ts:397`、`src/kanban/stale-nudge.ts:15-23`——`Math.round` 把 8.55 小时报成「已超过 9 小时」；`HTA_STALE_NUDGE_HOURS=0.5`（解析器允许小数）时 30 分钟就推「已超过 1 小时」。改 `Math.floor`（只少报不多报），阈值校验 ≥1 或不足 1 小时按分钟描述。

- [x] **T9 周报头部「已完成 N」（迭代累计）与同屏【本周完成】M 直接打架**：`src/bot/weekly-brief.ts:113-114,122`——周报语境下极易把迭代累计读成本周完成数。头部补口径标注「（迭代累计）」或只保留本周口径。

- [x] **T10 催办引导「催一下」在 prompt 无话术映射（F25 同类漏网）**：`src/kanban/watcher.ts:400` + `src/agent/prompt.ts:94`——模型收到「催一下」行为不可预期。补「催一下/查看进度 → 读任务状态与运行记录并汇报」映射。

- [x] **T11 本地写盘失败被误诊「看板服务暂时无响应」**：`src/agent/tools/iteration-retro.ts:36-37`、`src/agent/tools/personal-daily.ts:40-41`——catch 同时罩住看板采集与报告写盘（磁盘满/权限不足），重试必败且把部署者引向看板服务。区分两类失败，写盘失败改「报告文件写入失败，请联系部署者检查报告目录」（N21 同类）。

- [x] **T12 诊断卡片正文 LLM 输出按 lark_md 渲染、无任何中和**：`src/channels/feishu-cards.ts:317-321`——诊断输入含失败日志/任务描述等外部可控数据，经 LLM 复述后 `[文字](链接)`/`<font color>`/`~~删除线~~` 会真实渲染，可伪造警示或钓鱼链接（W2/B3/N17 防护体系在「LLM 中转」分支漏网）。渲染前对诊断文本最小中和（`<at`/`<font` 标签与 `~~`），或证据段改 plain_text 引用块。

- [x] **T13 诊断去重回执在文本降级场景引用不存在的卡片按钮**：`src/bot/handler.ts:272-276` vs `319-325`——诊断卡片推送失败走纯文本后，重复点「AI 诊断」仍收到「结果见上方诊断卡片；点卡片上的『↻ 按诊断结论重试』」。按 `diagnosisResults.get(taskId)?.cardMessageId` 分支，无卡片改「回复『重试这个任务』」（F15 同类漏网）。

- [x] **T14 确认超时后模型仍被告知「用户拒绝了该写操作」**：`src/agent/guard.ts:162-163`——用户刚收到「确认超时，已自动拒绝」，模型最终回复却说「你已拒绝该写操作」，同屏自相矛盾（N43 只透传审计，没管模型话术）。新增 TIMEOUT_MESSAGE：「确认超时未处理，操作未执行（并非用户拒绝）；如仍需执行可重新发起」。

- [x] **T15 skill_exec 确认 detail 暴露宿主机绝对路径**：`src/agent/tools/skill-tools.ts:62`——确认卡片代码块与 CLI 灰字展示 `bash /Users/<部署者用户名>/…/script.sh`，泄露部署目录结构（S17/G8 先例漏网）。detail 改相对形态（`skill/script + 参数`），绝对路径只进审计日志。

- [x] **T16 /clear 静默撤销免问授权，提醒分支成死代码**：`src/agent/session.ts:224`（clearHistory 先撤销全部免问）+ `src/commands.ts:214` + `src/cli.ts:447-448` + `src/bot/handler.ts:840-841`——clearHistory 后 `activeBatchApprovals()` 恒为 0，F21 加的「仍有 N 项免问授权生效中」永不可达；行为已从「保留免问」反转为「撤销免问」，文案既没按新行为告知、旧分支又成死代码。clearHistory 前先取计数，按新语义告知「N 项免问授权已一并恢复逐次确认」。

- [x] **T17 「↻ 按诊断结论重试」连点竞态发起两次重试**：`src/bot/handler.ts:370-378`——`retryLaunched.has` 检查与 `add` 之间隔 `await sendFollowUp`，双击都通过检查，同一执行记录被注入两条相同跟进指令。落键提到首个 await 前，失败时摘键回补（对照 feishu.ts:773 群 @ 冷却先例）。

- [x] **T18 attempts 端点异常时去重键退化 `task:latest` 永久占位**：`src/bot/handler.ts:271,309`——该任务之后再次失败点「AI 诊断」收到「这次失败已诊断过」，实际新失败从未诊断，且被导向一张旧卡片。无 attemptId 时不写 `diagnosedKeys`（或去重键带时间窗）。

- [x] **T19 失败卡片「AI 诊断」按钮与「回复为什么失败」注脚两套引导并存无分工**：`src/channels/feishu-cards.ts:216,229`——两路径产出不同（按钮=正式诊断+一键重试；回复=会话自由发挥），用户无从分辨。卡片 hint 改「点上方『AI 诊断』自动分析失败原因」，回复路径保留为备选。

- [x] **T20 CLI 闸口重问提示被 spinner 反复擦除**：`src/cli.ts:351-380`——输入「好的/ok」后打印「无法识别的回答…」，但 spinner 已重启，每 80ms `\r\x1b[K` 清行，重问提示与用户输入被「思考中…」覆盖（且「思考中」本身在谎称，实际在等用户）。`continue` 前先 `spinner.stop()`（S4/G15 修复路径在真实终端不可见）。

- [x] **T21 CLI /tools 用启动时探测结果，与 /status、bot 端实时探测矛盾**：`src/cli.ts:312,480-484` vs `src/commands.ts:62`、`src/bot/handler.ts:521`——会话中补装 jq/curl 后 /status 显示「备用通道：正常」、同端 /tools 仍显示「缺少 jq 不可用」。CLI /tools 改调用时 `await checkHkDepsAsync()`。

- [x] **T22 net-error fallback 英文原文内联**：`src/config/net-error.ts:26`——未命中映射的错误（代理拦截页、证书错误 unable to verify the first certificate 等）原样拼给用户（G10/G11 漏网分支）。fallback 改通用「网络请求失败」，原文统一收 HTA_DEBUG。

- [x] **T23 llm-verify 5xx 误诊「端点未实现 /models 接口…不代表配置有误」**：`src/config/llm-verify.ts:36-40`——500/502/503（网关故障/服务重启）被当作「兼容网关如此」，还诱导输入 s 保存故障中的配置。5xx 单列「模型服务异常（HTTP N），请稍后重试」。

- [x] **T24 EOF/中断报错「配置未完成，未写入任何更改」两处失实**：`src/config/config-wizard.ts:38,45,199`——bot 两阶段流程模型配置已先落盘，飞书阶段中断时文案与磁盘状态相反；出路「重新运行命令进入向导」对无交互终端部署（systemd/Docker）必然同样 EOF，且未告知 .env 确切路径。改「已完成的步骤已保存，重新运行可从断点继续；无交互终端时请直接编辑 <userEnvPath()>」。

- [x] **T25 prompt 英文术语禁用清单漏 MCP/hk_cli/lark_cli**：`src/agent/prompt.ts:146`——这三个词在 prompt 正文出现十余次，模型照学极易原样搬给用户（F24/G7 系统性清理的回流口）。禁用清单补这三个词，或加一条「工具名只在调用时使用，回复用户一律说『看板/备用通道』」。

- [x] **T26 「周报/本周进展」在 prompt 无映射**：`src/agent/prompt.ts:87-100`——周报已是正式推送功能，但用户主动说「这周完成了什么」时 12 条工作流无一覆盖，模型只能即兴（错用 today 范围或连调 7 次日报）。补一条映射并如实说明无周粒度口径。

- [x] **T27 prompt 相邻工作流口径打架：报告「文件路径」vs「链接」**：`src/agent/prompt.ts:97-99`——#9 教给文件路径（bot 场景会把部署机路径发给飞书用户，G27 还专门删过），#10/#11 教给链接。统一「以工具实际返回为准 + 3~5 行概览」。

- [x] **T28 SKILL.md 多仓启动自相矛盾**：`skills/helios-kanban-remote/SKILL.md:56,178` vs `:186`——Quick workflow 与 Safety rule 5 教 `hk start --repo id1 --repo id2:develop`，Out of scope 却把「Multi-repo workspace create」列为不支持。删除该条或澄清为「与任务无关的独立多仓工作区创建」。

- [x] **T29 投递失败退避中的提醒在列表里显示「已到点」无解释**：`src/agent/reminder.ts:62`——飞书推送失败进入退避时，用户查列表看到「已到点」却没收到推送，也不知系统正在自动重试。`failCount>0` 的条目改显示「已到点，投递失败，正在自动重试」。

- [x] **T30 周期提醒静默降级为一次性**：`src/agent/prompt.ts:100`——用户说「每周一提醒我写周报」，模型只能建一条一次性提醒且无话术要求如实说明。prompt 补「不支持周期性提醒，用户要求重复提醒时必须如实说明」。

- [x] **T31 占位收尾「✅ 已完成」与中止文案同屏矛盾**：`src/bot/handler.ts:714`——插过确认卡片的轮次，占位恒收尾「✅ 已完成，结果见下方」，但正文可能是「已中止」「模型未返回内容」。占位收尾改中性「处理结束，结果见下方」或按内容分支用 ⚠️。

- [x] **T32 CHANGELOG 缺 [1.0.31]、[1.0.32] 节且 [Unreleased] 混入已发布内容（F29/G33/N7 第四次复发）**：`CHANGELOG.md:7-30`——断线告警与第九轮条目实际随 1.0.31 发布却仍挂 [Unreleased]；更新提示的变更链接点进去看不到目标版本内容。按 tag 时点收编 [1.0.31]（补技能类型条目）、新增 [1.0.32] 节。

### P3 细节打磨

- [x] **T33** memory/reminder 对象级免问回执兜底「该对象」（G34 漏网新 kind）：`src/agent/guard.ts:81`——补 memory（同一记忆键）/reminder（同一条提醒）分支。
- [x] **T34** 内部工具名漏出：「可先用 reminder_list 查看序号」经模型转告用户（`reminder-tools.ts:91`）；「相对时长请用 in_minutes 参数」（`reminder.ts:136`）——改自然语言「先问『我有哪些提醒』」「直接说『30 分钟后』」。
- [x] **T35** 提醒确认「（本地时间）」实为部署机器时区，远程部署误导：`src/agent/tools/reminder-tools.ts:43`——改「（按部署机器时区）」或在 /status 暴露时区。
- [x] **T36** 「晚上 12 点」被解析为次日中午 12:00（hour=12 不加 12 规则漏网）：`src/agent/reminder.ts:99`——「晚上」且 hour===12 按 0 点处理或报错确认。
- [x] **T37** `toolActionLabel` 对 reminder_* 一律「设置提醒」（取消/查询时与动作相反）、对 daily_report/iteration_retro 回落「调用工具」（同类 work_summary 显示「生成报告」）：`src/commands.ts:137-146`。
- [x] **T38** CLI 空闲时提醒打印打乱 readline 输入行（不重绘提示符）；投递日志「[reminder] 提醒已送达（local）：<正文>」英文标签+内部 uid+正文二次出现：`src/cli.ts:206,406`、`src/agent/reminder.ts:413-420`。
- [x] **T39** 周报【本周完成】是截断样本（≤50 条）口径，与同文件 totals 全量组不一致，极端时输出谎言「本周暂无新完成的任务」：`src/bot/weekly-brief.ts:99-105,122`——截断时补「（按最近 50 条样本统计）」或由 summary 补全量计数。
- [x] **T40** 周报头部日期范围含未来日期（周一推送显示「至 周日」）：`src/bot/weekly-brief.ts:99-100,113`——终点取推送当天或改「第 N 周」。
- [x] **T41** `KANBAN_WATCH=0` 时 `HTA_STALE_NUDGE_HOURS` 静默完全失效零告警：`src/bot-main.ts:575-583`——watch 关闭且 stale 变量已设置时 console.warn 一句。
- [ ] **T42** 周报错过推送日即整周静默，无补推无告知：`src/bot/weekly-brief.ts:248-249`——当周后续日期补推一次并注明补发，或录入暂不修。
- [x] **T43** 报告服务启动失败时 bot 推送本机绝对路径（死链+目录泄露，G23/F28 漏网分支）：`src/report/retro.ts:345`、`src/report/daily-report.ts:246`——bot 场景无 linkBaseUrl 时省略 HTML 行。
- [x] **T44** 日报页未注「当日」为服务器本地时区日界（复盘页已注，姊妹页口径不一）：`src/report/daily-report.ts:188-193`。
- [x] **T45** 「· …还有 N 个见上方报告链接」数量与指引粘连缺标点：`src/report/daily-report.ts:262`。
- [x] **T46** 诊断重试遇看板 404/500 裸 HTTP 码直达且 404 重试必败：`src/bot/handler.ts:389-393` + `src/kanban/http.ts:61-66`——404 单独定性「执行记录已被看板清理，请到看板手动重新发起」并纳入 hasOwnWayOut。
- [x] **T47** hk-cli 两处漏网：默认仓库缺默认分支报裸 UUID 列表（G25 漏网分支，`hk-cli.ts:124`）；「未指定 --branch / --repo ID:branch」CLI 旗标黑话经模型转告（S7 口径，`hk-cli.ts:131-134`）。
- [x] **T48** 诊断 prompt 任务标题取不到时回退裸 UUID，LLM 大概率复述进卡片：`src/kanban/failure-diagnosis.ts:138`——prompt 里用「该任务」，卡片标题调用方兜底「未命名任务」。
- [x] **T49** 挂起确认的短应答提醒与排队回执在文本降级场景指引落空（根本没有卡片按钮），且未提「免问」应答词：`src/bot/handler.ts:604,870`。
- [x] **T50** 确认专属词表漏「免问/都允许」缩略词：超时后回「免问」被当新对话发给模型，模型可能顺口承诺「已开启免问」（实际无授权）；回「同类免问」却得到正确提示，同族词两种待遇：`src/agent/confirm.ts:55` vs `src/cli.ts:349`。
- [x] **T51** 两端 /help 仍写「查看『同类免问』状态」，与 N29 统一的「免问授权」口径漂移：`src/cli.ts:97`、`src/bot-main.ts:59`。
- [x] **T52** 去重拦截文案夹英文工具名「改用 update 更新该任务」：`src/agent/tools/gated-write.ts:104-105`。
- [x] **T53** bot 文本降级确认免问提示同句三个「免问」堆砌：`src/bot-main.ts:394-397`。
- [x] **T54** 确认挂起期间静默心跳刷「⏳ 仍在处理…（已等待 N 秒）」——实际在等用户点卡片：`src/bot/handler.ts:696`——pending 时改「等待你处理上方的写操作确认」。
- [x] **T55** 图片消息 LLM 失败尾注引用内部占位「你的上一条消息未处理：「[图片]」，可修改后重发」：`src/bot/handler.ts:938` + `src/commands.ts:247`——图片轮次用原配文，措辞改「可重发图片」。
- [x] **T56** 排队上限拒收文案「（或先 /stop 清空队列）」隐瞒 /stop 会连带中断当前任务：`src/bot/handler.ts:863`。
- [x] **T57** /stop 双回执措辞不一（「⏹ 已中断当前任务。」vs 占位「⏹ 已中断（未完成的操作未执行，可继续对话）。」），像两个事件：`src/bot/handler.ts:466,805`。
- [x] **T58** vision 开启时 post 富文本消息里的配图被静默丢弃，无任何提示：`src/bot/handler.ts:945`——post 含图片块时追加「（消息中的图片未读取，请单独发送图片）」。
- [x] **T59** 未知斜杠命令走串行队列，排在最长 30 分钟的任务后才回「未知命令」：`src/bot/handler.ts:844-847`——识别前移到即时命令分发。
- [x] **T60** 「执行 Agent」中英混排两处（G18/N25 漏网）：`src/bot/handler.ts:387`、`src/channels/feishu-cards.ts:344`——统一「任务执行方」。
- [x] **T61** `/confirm off` 被报「未知命令 /confirm」且与 bot 端行为相反（bot 按状态查询应答）：`src/cli.ts:449,555` vs `src/bot/handler.ts:482-490`。
- [x] **T62** bin --help 的 --rebind/--reconfig 行缺「先停止当前进程」警告（README/向导已带），且未列出实际支持的 `-v`/`version` 形式：`bin/helios-task-agent.js:20-24`。
- [x] **T63** /config 改看板地址警示在「MCP 从未连上」场景失实（「当前连接仍指向旧看板」——此时无连接，工具实际走已指向新地址的备用通道，同句下半句也这么说）：`src/cli.ts:540-547`——按 mcpOk 条件化。
- [x] **T64** 向导取消两端口径漂移（S27 漏网）：CLI /config 按 Esc 中性灰字，bot --reconfig 按 Esc 红色「配置失败：已取消」并 exit 1：`src/bot-main.ts:267-272` vs `src/cli.ts:548-553`。
- [x] **T65** 启动横幅「配置目录：/…/.env」把 .env 文件标注为目录：`src/bot-main.ts:174`。
- [x] **T66** 向导看板地址仍写「默认 X」，与可选字段已统一的「回车 = 保留当前 X」口径不一（N11 漏网）：`src/config/config-wizard.ts:164`。
- [x] **T67** 向导白名单回显 `join(',')` 非「、」（N48 口径）；--rebind 流程内仍引导「再运行 --rebind 回填」循环指路：`src/config/config-wizard.ts:249-250`。
- [x] **T68** README 示例与产品内 TRY_EXAMPLES 漂移：/help 已含提醒示例而 README 没有；两端都缺「复盘一下这个迭代」「帮我写今天的日报」（U16/N30 同类）：`README.md:243-249`、`README.en.md:238-244` vs `src/commands.ts:27-36`。
- [x] **T69** 创建任务确认 detail「类型：feat」英文前缀直达用户，且本轮 prompt 改「必须显式传 task_type」后将高频出现：`src/agent/tools/kanban-mcp.ts:27-28`——加中文映射，未命中省略该行（与优先级同口径）。
- [x] **T70** kanban-mcp 英文报错一律兜底「看板服务暂时无响应，请稍后重试」——对确定性失败（任务不存在/参数非法）归因失实且重试必败：`src/agent/tools/kanban-mcp.ts:96`。
- [x] **T71** 技能文档细节：SKILL.md 回复模板类型英文键无中文对照（`:119`）；Safety rule 6 与 Out of scope 仍教英文「PR/push/merge/rebase/desktop Web UI」与 prompt 禁令冲突（`:179-186`）；INSTALL.md 完成汇报模板 5 处半角冒号（`:185-189`）。
- [x] **T72** hk.sh 失败时把 `HTTP <code>: <完整响应体>`（可能是反代整页 HTML）与完整 JSON 两遍倒到 stderr，单行超长 JSON 可经 shared.run 进入模型上下文：`skills/helios-kanban-remote/scripts/hk.sh:29-39`——收敛为「状态码 + message 字段」。
- [x] **T73** /memory 超预算「（记忆过长，已省略 N 条）」无出路（被省略条目所有用户面不可见）：`src/agent/memory.ts:249`——补「可让我删除不再需要的记忆」。
- [x] **T74** repo-fs 两条英文参数名残留（S12/G17 漏网）：「需要 root（绝对路径）或 repo_id」「action 必须是 list | read | grep」：`src/agent/repo-fs.ts:146,363`。
- [x] **T75** 停滞提醒 hint 文本版与卡片注脚是两份独立字符串（仅差末尾句号），S26/N46 同源化先例漏网：`src/kanban/watcher.ts:400` vs `src/channels/feishu-cards.ts:230`——抽 `WATCH_HINT_STALE` 常量。
- [x] **T76** ws-alerter 重复提醒「已断开超过 N 小时」用 Math.round（1.6 小时报「超过 2 小时」）且丢掉了首提里的重启出路：`src/bot/ws-alerter.ts:84-86`。
- [x] **T77** 周报「其它状态」与全项目「其他」不统一：`src/bot/weekly-brief.ts:137`。

### 本轮暂不修（记录在案）

- 周报错过推送日不补推（T42）：若修复需引入「本周已推」落盘判重，与晨报「看板不可达当天静默」同属刻意不打扰的设计权衡，修复前维持现状。
- 提醒/晨报按部署机器时区触发（T35 的根因）：产品级约定，本轮仅修文案标注，时区可配置化留待后续。
