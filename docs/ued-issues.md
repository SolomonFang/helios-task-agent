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
