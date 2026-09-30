# pi-dag-workflow

一份会话级 Todos、派生 DAG、用户控制的 Plan 模式，以及后续的一层 Agent 和 Goal 协作。

**当前：M1 已实现。** Todo 工具、依赖检查、Plan、会话恢复和紧凑 GUI 可在隔离环境测试。Goal、子 Agent／Profile 与完整 DAG 连线布局尚未实现，不作为日常整套工作流安装。

最新基准：[`../docs/WORKFLOW.md`](../docs/WORKFLOW.md)。开发进度：[`../docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md)。本地验收记录：[`../docs/M1-VALIDATION.md`](../docs/M1-VALIDATION.md)。

## 已有功能

- 一个会话一份 Todos。`todo` 的 create/update/list/get/delete/clear 使用常用 rpiv 字段，支持说明、进行时标签、负责人和 metadata。
- 依赖是真实门槛：前置未完成不能开始／完成；循环、悬空或指向删除项的依赖被拒绝，失败不改状态。
- Plan 可以探索、提问和整理当前清单，不执行写入、任意 shell、完成任务或派发。工具错误不终止整轮。
- 原生 Pi 会话记录保存状态；重载／恢复／切分支读取活动分支，不另存任务 JSON 或数据库。相同会话里的常见旧 Todo 快照可读取，不迁移跨会话 Goal 库。
- 输入框上方以 `●/○` 为树根，显示 Nerd Font `Todo · Plan · Goal` 标题与 ASCII 树干；有未完成项为实心。Todo 标题／任务正文 accent，树干／编号／额外前驱 dim，状态保留语义色。
- 两种任务树可切换：默认多层主路径，仅在左编号补其他前驱；平铺则写完整前驱。宽度不足先取消列级对齐，极窄才退回平铺。默认最多 8 项，优先保留未完成项并注明隐藏数量。
- Plan 块只在规划时显示；Goal 块仅接收真实当前目标的展示数据。M1 尚无 Goal 控制器，所以不伪造 Goal。
- `/dag` 当前是准确的分层依赖视图；复杂拓扑连线和更完整的视觉布局在 M4 实现，不把依赖误画成单父子树。

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

也可直接说自然语言，让当前主模型调用 `todo`。`/todos <需求>` 发给当前模型；`/plan <需求>` 先进入规划再提交需求。只有用户能通过命令／明确请求切换模式。

已完成项不能悄悄重开，返工创建新项。clear 清空任务但不复用编号；这两点与部分旧插件习惯有差异，避免历史结果与现有任务混淆。删除被其他任务依赖的节点需先改依赖。

**原生持久化边界**：Pi 只在产生用户／assistant 对话后创建新会话文件。全新会话只用 `/todos add` 等命令时会提示“尚未落盘”，发送一条消息后才随会话保存。`--no-session` 永不落盘。切分支恢复的是记录，不会回滚文件。

**Plan 不是 OS 沙箱**：它约束工具入口，不控制任意扩展内部或外部进程。额外工具需明确允许且可信；不能通过此入口放行内置写入／shell／派发工具。进入 Plan 需主会话空闲；M2 将接入本插件的活动子 Agent 检查。

## 开发与验证

```bash
cd pi-dag-workflow
npm ci --ignore-scripts
npm run check          # 类型、离线单元／真实 Pi RPC、打包检查；不请求真实模型
npm run test:flash     # 显式低成本真实模型验收，会消耗额度
```

Flash 验收新建临时 Pi 会话，只加载新插件、使用 `example-model` 和 low thinking；不加载冲突插件，不复制凭据、不改全局配置。最多 16 次模型请求，两段短验收后停止。原生模型／认证由已有 Pi 配置读取；结果只记录非敏感报告与用量。

`npm run test:tui` 为先前的 tmux 回归脚本，**按当前用户要求暂停使用，不属于默认检查**。已有终端捕获与窗口信息保留；以后如需再运行，先确认。

包仍为 `private: true`，尚未发布或全局安装。同名 Todo／Plan／Goal／Subagent 插件不能直接同时启用，请用隔离启用列表测试。
