# pi-dag-workflow

一份会话级 Todos、派生 DAG、用户控制的 Plan、单层子 Agent 和 Goal 续跑控制。

**当前：M0–M4 首版已完成，并经过审查和联合验收。** 实线 DAG、单层子进程、Profile、实时活动与 Goal 可在隔离环境使用。未发布／全局安装；真实终端字体与交互仍建议用户按自己的环境手动验收。

最新基准：[`../docs/WORKFLOW.md`](../docs/WORKFLOW.md)。开发进度：[`../docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md)。完成后复审与性能对比：[`../docs/POST-M4-REVIEW.md`](../docs/POST-M4-REVIEW.md)。

验收记录：[`../docs/M1-VALIDATION.md`](../docs/M1-VALIDATION.md)、[`../docs/M3-VALIDATION.md`](../docs/M3-VALIDATION.md)、[`../docs/M4-VALIDATION.md`](../docs/M4-VALIDATION.md)。

## 已有功能

- 一个会话一份 Todos。`todo` 的 create/update/list/get/delete/clear 使用常用 rpiv 字段，支持说明、进行时标签、负责人和 metadata。
- 依赖是真实门槛：前置未完成不能开始／完成；循环、悬空或指向删除项的依赖被拒绝，失败不改状态。
- Plan 可以探索、提问和整理当前清单，不执行写入、任意 shell、完成任务或派发。工具错误不终止整轮。
- 原生 Pi 会话记录保存状态；重载／恢复／切分支读取活动分支，不另存任务 JSON 或数据库。相同会话里的常见旧 Todo 快照可读取，不迁移跨会话 Goal 库。
- 输入框上方以 `●/○` 为树根，显示 Nerd Font `Todo · Plan · Goal` 标题与 ASCII 树干；有未完成项为实心。Todo 标题／任务正文 accent，树干／编号／额外前驱 dim，状态保留语义色。
- 两种任务树可切换：默认多层主路径，仅在左编号补其他前驱；平铺则写完整前驱。宽度不足先取消列级对齐，极窄才退回平铺。默认最多 8 项，优先保留未完成项并注明隐藏数量。
- Plan 块只在规划时显示；Goal 块来自真实当前焦点，暂停时明确标注。创建 Goal 不自动启动，enable/focus/switch/resume 选择唯一当前目标。
- 子 Agent 使用真实 Pi 子进程，最多 4 个并发，无排队系统。支持消息、提问、等待、取消／移除；返回结果由主会话核验，不自动完成 Todo。右侧为 `[jobId · Profile] [状态]`。
- 实时状态用确认的 Nerd Font：思考 `󰧑`、工具 `󰆍`、输出 `󰏫`、等待 `󰋗`、启动 `󰓦`、失败 `󰅙`、中断 `󰙦`。只从真实事件推导，不推测模型隐藏的思考。工具名保留动作名并按 10 列截断；节流 300ms，仅工具秒数每秒更新；活动不落盘、不进模型上下文。
- Goal 续跑与 Agent 报告唤醒共用默认 20 次额度，普通查看不重置。Plan、恢复、用户中断、需答复、预算耗尽或连续无进展都暂停，需明确恢复。没有 Todos 也可研究，用 goal update 的 progress/nextStep 报告新进展与具体下一步；只剩 Agent 时等待真实结果，不轮询模型。
- `/dag` 为从上到下的实线框图，节点只显示 `#编号`，不重复前驱；分流／汇合和跨层线路完整绘制，`╳` 明确表示交叉不汇合。宽度／资源不足则明确降级为前驱列表，编号装不下时换行保留完整关系。
- 详情固定标题／操作栏，支持 ↑/↓、PgUp/PgDn、Home/End 滚动；小组件仅生成最多 11 行图预览并注明 /dag 查看完整图，不用高频重画长列表。
- DAG 拓扑与线路仅内存缓存，状态／标题／执行者变化不重算结构；改编号／依赖／删除才更新。滚动复用内容，无额外模型调用。

## 命令

| 操作 | 命令 |
|---|---|
| 查看完整清单／基础依赖图 | `/todos`、`/dag`（Esc 返回） |
| 快速添加 | `/todos add 检查入口` |
| 添加有前置的任务 | `/todos add 汇总 --after 1,2` |
| 开始／完成／退回待执行 | `/todos start #2`、`done #2`、`pending #2` |
| 改标题／删除／确认清空 | `/todos edit #2 新标题`、`delete #2`、`clear` |
| 小组件显示与视图 | `/todos show`、`hide`、`view list`、`view dag` |
| 任务树样式 | `/todos paths`（默认多层）、`/todos flat`（平铺全部前驱） |
| 规划模式 | `/plan` 切换，`/plan start`、`off`、`status` |
| 额外可信只读搜索工具 | 正常模式下 `/plan tools 名称1,名称2`，`none` 清空 |
| Agent 查看／通信 | `/agents`、`/agents wait a1`、`send a1 内容`、`reply requestId 内容` |
| Agent 停止／移除 | `/agents cancel a1`、`remove a1`；不回滚文件／完成 Todo |
| Profile 管理 | `/agents profiles`、`profile 名称 provider/model [thinking] [工具逗号列表]`、`unprofile 名称` |
| Goal 管理 | `/goal`、`new 标题`、`enable #1`、`switch #2`、`edit #1 新标题`、`complete #1`、`delete #1` |
| 明确暂停／恢复 | `/goal off`、`/goal resume`；`/agents pause` 暂停自动唤醒而不停止子进程 |
| 配置／损坏重置 | `/goal config` 查看路径；`/goal reset` 与 `/agents reset` 均需确认 |

也可直接说自然语言，让当前主模型调用 `todo`、`goal` 或五个常用 `subagent_*` 工具。`/todos <需求>` 发给当前模型；`/plan <需求>` 先进入规划再提交需求。只有用户能通过命令／明确请求切换模式。

已完成项不能悄悄重开，返工创建新项。clear 清空任务但不复用编号；这两点与部分旧插件习惯有差异，避免历史结果与现有任务混淆。删除被其他任务依赖的节点需先改依赖。

**原生持久化边界**：Pi 只在产生用户／assistant 对话后创建新会话文件。全新会话只用 `/todos add` 等命令时会提示“尚未落盘”，发送一条消息后才随会话保存。`--no-session` 永不落盘。切分支恢复的是记录，不会回滚文件。

**Plan 不是 OS 沙箱**：它约束工具入口，不控制任意扩展内部或外部进程。额外工具需明确允许且可信；不能通过此入口放行内置写入／shell／派发工具。进入 Plan 需主会话空闲且本插件没有活动子 Agent；只能等结束或明确取消。Goal 只允许查看和停用等停止操作，命令与工具规则一致。

## 插件配置

默认目录 `~/.pi/agent/pi-dag-workflow/`，遵循 Pi 的 `PI_CODING_AGENT_DIR`（含 `~` 展开）：

- `pi-dag-workflow-config.json`：可选通用配置，例如 `{"goalMaxTurns":20,"goalNoProgressLimit":3}`。未提供时用默认值，不自动写入全局文件。
- `pi-dag-workflow-profile.json`：具名 Profile 配置，形如 `{"profiles":[{"name":"research","model":{"provider":"example-provider","id":"example-model"},"thinking":"low","tools":["read","grep","find","ls"]}]}`。显式保存时校验模型／工具。不自动覆盖／迁移旧项目配置。

Todo、Goal、Job 与预算仍只保存在 Pi 会话，以上是配置而非另一份状态库。20 次限制针对插件要求的额外续跑（含报告唤醒），Pi 原生工具结果后的正常 follow-up／重试不是新的插件续跑，所以不承诺总 API 请求恰好 20 次。progress 是主模型报告，插件能去重、检查状态变化，不能替代真实结果审核。

## 开发与验证

```bash
cd pi-dag-workflow
npm ci --ignore-scripts
npm run check          # 类型、离线单元／真实 Pi RPC、打包检查；不请求真实模型
npm run test:flash     # M1 有界真实模型验收，会消耗额度
npm run test:goal-flash # M3 有界真实模型验收，最多 14 次请求／90 秒
npm run test:joint-flash # M4 主会话＋两子 Agent 有界验收，会消耗额度
npm run test:performance # 本机刷新基准，无网络模型调用
node test/post-review-performance.ts # 完成后复审的可比较性能基准
```

Flash 验收新建临时 Pi 会话，只加载新插件、使用 `example-model` 和 low thinking；不加载冲突插件，不复制凭据、不改全局配置。最多 16 次模型请求，两段短验收后停止。原生模型／认证由已有 Pi 配置读取；结果只记录非敏感报告与用量。

`npm run test:tui` 为先前的 tmux 回归脚本，**按当前用户要求暂停使用，不属于默认检查**。已有终端捕获与窗口信息保留；以后如需再运行，先确认。

## 隔离试用（不会自动安装）

在此包目录中手动运行：

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-themes -e "$PWD/src/index.ts"
```

这只是当前会话的启用列表，不覆盖日常配置。模型／认证使用已有 Pi 配置；需指定时加 `--provider example-provider --model example-model`。`/todos help`、`/goal help`、`/agents help`、`/plan help` 都是本地帮助，不调用模型、不切模式。

子 Agent 的 requests/tokens/estimatedCost 随 Job 输出保存，在 `/agents wait jobId` 可查看。原生 Pi 主会话费用不含这些独立子进程，不能把主会话金额称为父子合计。联合验收报告单独汇总父子估算。

包仍为 `private: true`，尚未发布或全局安装。同名 Todo／Plan／Goal／Subagent 插件不能直接同时启用，请用隔离启用列表测试。
