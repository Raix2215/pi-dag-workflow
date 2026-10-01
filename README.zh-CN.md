# pi-dag-workflow

[English](README.md) | 简体中文

为 [Pi](https://pi.dev) 提供可见、会话内的工作流：一份带 `blockedBy` 依赖的 Todo 清单、只读 Plan、最多八个独立 Pi 子 Agent，以及有界续跑的 Goal 循环。主模型决定执行什么，插件负责依赖校验并把进度保持在屏幕上。

## 功能

- **一份任务清单，一张派生 DAG**：Todo 通过 `blockedBy` 携带前驱。前置未完成时，下游不能开始或完成；`/dag` 从同一份清单绘制真实依赖图，没有第二份队列或数据库。
- **先规划再实施**：Plan 是只读模式，用于阅读、搜索、提问和整理 Todo。实施、shell 命令和派发在退出 Plan 前都会被拦截。
- **真实子进程**：最多运行八个 Pi 子进程。每个可带任务、可选的 Todo 关联和具名 Profile；支持发消息、回答提问、等待、取消或移除记录。执行结束后先显示“待交付”，报告进入主会话后才显示“已返回”；返回结果不会自动完成 Todo。
- **有界目标**：一次聚焦一个 Goal。自动续跑与子报告唤醒共享默认 32 次额度；连续三轮没有新进展也会暂停。中断、会话恢复、进入 Plan、额度耗尽或原地打转时，Goal 都会暂停。
- **可读进度**：Nerd Font 面板展示任务树、实线 DAG 和真实的思考／工具／输出活动。界面活动不会写入模型上下文或持久化的工作流状态。
- **会话内持久化**：Todo、Goal、预算和 Job 快照跟随 Pi 活动分支。恢复会话不会复活子进程，也不会自行重启自动工作。

## 环境要求

- Pi `>= 0.99.2`
- Node.js `>= 22.19.0`。子 Agent 模块要求 Pi 运行于 Node，独立二进制宿主不在支持范围内。
- 建议使用 Nerd Font，以正常显示面板图标（是图标，不是 emoji）

## 安装

```bash
pi install https://github.com/<owner>/pi-dag-workflow
```

把 `<owner>` 替换为仓库拥有者。Pi 会从该 GitHub 仓库安装插件；目前没有 npm 包。安装后重启 Pi 或执行 `/reload`，再用 `pi config` 选择要加载的模块（见下文）。

若其他插件已提供 Todo、Plan、Goal 或子 Agent 工具，启用本插件时请先停用它们。工具名相似，但参数与持久化状态并不通用。

## 快速上手

直接把需求告诉主模型：

> 用 Todo 记录调查、实现和测试；实现依赖调查，整合依赖实现与测试。只在确有收益时委派独立工作，检查结果后再完成任务。

使用过程中的常用入口：

- `/plan start` 只读探索，实施前 `/plan off`。
- `/todos` 查看完整清单，`/dag` 查看依赖图。
- `/goal new 改造解析器` 只创建 Goal，不启动；`/goal enable #1` 开始围绕它续跑。

研究不强制创建 Todo：主模型可用 `goal update` 报告新的进展和具体下一步，或在等待你答复时暂停。

## 工具

| 工具 | 用途 |
|---|---|
| `todo` | create/update/list/get/delete/clear；数字编号与 `blockedBy` 前驱 |
| `goal` | create/update/list/get/delete；enable/focus/switch/resume；disable/pause/complete |
| `subagent_spawn` | 启动一个子进程，字段为 `task` 及可选 `todoId`/`profile`/`tools`/`timeout` |
| `subagent_send` | 给 `recipient` 编号发消息，或回答 `requestId` |
| `subagent_wait` | 等待结果或提问；超时、取消等待不会停止子进程 |
| `subagent_inspect` | Job 摘要与 Profile，不默认回传完整子对话 |
| `subagent_cancel` | 停止子进程；可选 `remove` 移除记录，不撤销项目修改 |

## 命令

| 命令 | 示例 |
|---|---|
| `/todos` | `add 标题 --after 1,2`、`start #2`、`done #2`、`pending #2`、`edit #2 新标题`、`delete #2`、`clear` |
| 任务展示 | `/todos paths`、`/todos flat`、`show`、`hide`、`view list`、`view dag` |
| `/dag` | 实线依赖图；↑/↓、PgUp/PgDn、Home/End；Esc 返回 |
| `/plan` | `start`、`off`、`status`；`tools 名称1,名称2` 明确信任额外只读工具，`tools none` 清空 |
| `/goal` | `new 标题`、`list`、`enable [ #1]`、`disable [ #1]`、`edit #1 标题`、`complete #1`、`delete #1`、`get #1`、`config`、`reset` |
| `/agents` | `wait a1`、`send a1 消息`、`reply requestId 回答`、`cancel a1`、`remove a1`、`pause`、`resume` |
| Profile | `/agents profiles`、`profile 名称 provider/model [thinking] [工具逗号列表]`、`unprofile 名称` |

各命令组都支持 `help`；查看帮助不调用模型，也不切换模式。自然语言也能驱动已注册的工具。

### Goal 生命周期

`new` 只记录 Goal，创建后保持暂停。`enable` 是唯一的激活方式：聚焦某个 Goal；省略编号时重新启用当前目标。已完成或已删除的 Goal 都不能重启——返工请新建一个。`disable` 是唯一的停止方式，并保留焦点，便于之后重新启用。停用后再 `enable` 开启的是新一轮完整额度，而不是上一轮的剩余额度。启用另一个 Goal 不会清空共用的 Todo 清单；停用 Goal 也不会杀死正在运行的子 Agent，停止它们请用 `/agents cancel`。

每个操作只有一个写法；旧版本接受过的同义词（`focus`、`switch`、`resume`、`pause`、`on`、`off`、`done`、`del`、`create`、`status`、`/plan exit`）已经移除。首个词不属于命令动作时按自然语言处理，与其他自由描述走同一条路径。

## 模块选择

运行 `pi config`，找到 `pi-dag-workflow` 包，分别勾选它的独立资源。选择由 Pi 原生资源过滤保存；在会话中 `/reload` 或启动新的 Pi 进程即可生效。

| Pi 资源 | 提供的功能 |
|---|---|
| `src/todos/index.ts` | Todo 工具、`/todos`、`/dag` 与派生 DAG |
| `src/plan/index.ts` | `/plan` 命令与只读限制 |
| `src/agents/index.ts` | 子进程、消息与 Profile |
| `src/goal/index.ts` | Goal 工具与有界续跑 |
| `src/ui/index.ts` | 实时面板与可滚动详情 |

组合 Todo＋Plan＋UI 可规划并执行；Goal＋UI 可做独立研究；只选 Agents 可派发独立子进程。DAG 绘制与 `todoId` 关联需要 Todo。不选 UI 时命令输出仍可用，也不启动活动刷新计时器；只选 UI 时没有工作流数据可展示。

每个入口都是真正的 Pi 扩展，拥有各自的默认工厂。已加载入口通过 Pi 事件总线共享一份运行时协调状态，因此没有必选的 core 复选框，也不会重复创建预算。重载会释放旧订阅和子进程资源，未勾选的入口不注册任何工具或指导语。插件**没有自己的 `modules` 配置**。

## 配置

配置只保存插件设置，与 Pi 的会话记录分开存放，使用以下文件名。可运行 `/goal config` 定位它们。

### `pi-dag-workflow-config.json`

可选。模块开关用 `pi config` 控制，不在此文件。修改后 `/reload` 生效。

```json
{
  "language": "auto",
  "goalMaxTurns": 20,
  "goalNoProgressLimit": 3
}
```

- `language` —— `"auto"`、`"en"` 或 `"zh-CN"`。`auto` 在终端 locale 为中文时选 `zh-CN`，否则选 `en`。插件标签、帮助、通知和工作流消息会本地化；用户内容、命令名和工具结构化字段保持原样。
- `goalMaxTurns` —— 新建 Goal 的默认额度（1–200），由自动续跑和子报告唤醒共享。
- `goalNoProgressLimit` —— Goal 在连续多少轮没有新进展后暂停（1–10）。

请删除旧版的 `modules` 字段。未知或无效字段会作为配置错误处理，而不是悄悄保留第二套开关。

### `pi-dag-workflow-profile.json`

可用 `/agents profile …` 保存，或手动编辑这个可选用户级文件：

```json
{
  "profiles": [
    {
      "name": "research",
      "thinking": "off",
      "tools": ["read", "grep", "find", "ls"]
    }
  ]
}
```

命令形式为 `/agents profile 名称 provider/model [thinking] [工具逗号列表]`，其中 `provider/model` 是已在 Pi 注册的模型占位符。Profile 不含 `model` 字段时继承当前主会话所选模型；子 Agent 默认使用 `read`、`grep`、`find`、`ls`，thinking 关闭。明确指定的内置工具可增加 `write`、`edit` 或 `bash`。不会自动复制主会话中任意扩展工具；保存时会校验模型和工具。

## 必须了解的边界

- 额度是**插件额外续跑与唤醒**的预算，不是 Pi 或 API 调用上限。原生工具结果 follow-up 和重试另算，模型报告的进展也应实际核验，而不是直接采信。
- 已完成 Todo 不能悄悄重开；返工请新建任务。`clear` 不复用编号。切换或删除 Goal 既不清空 Todo，也不撤销项目文件。
- 全部 Todo 完成不会自动把 Goal 标记为完成；核验结果后，由主模型或用户明确标记完成。
- Plan 和工具选择是执行限制，**不是操作系统沙箱**。扩展和有写入能力的子进程使用你的操作系统权限，分支导航不会回滚项目修改。
- 恢复会话后自动续跑保持暂停，子 Agent 不会复活。进入 Plan 需要主会话空闲且没有活动的受管理子进程。
- 全新会话只有命令元数据时可能尚未创建会话文件；发送一条正常消息，Pi 才能持久化工作流。
- 子用量随 Job 结果保留。原生父会话统计不包含独立子进程，报告金额是配置估算，不是账单。
- 子报告和结果输出不设插件级字符上限，使用提示词引导合适篇幅；长报告仍会占用模型上下文和会话存储。各类报告及工具结果的交付时机见[通信说明](docs/COMMUNICATION.md)。
- 密集或大型 DAG 会退回前驱列表；被裁剪的小组件会明确标注为预览，不冒充完整依赖图。

## 致谢

pi-dag-workflow 是独立实现。它在可见任务图、只读规划、子 Agent 和界面双语方面的思路，受到 Pi 社区相关探索的启发，包括 [pi-workflow](https://github.com/AgwaB/pi-workflow)、[pi-subagents](https://github.com/nicobailon/pi-subagents)、[pi-plan-mode](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode)、[Pi Subagents](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents)、[pi-goal-x](https://github.com/tmonk/pi-goal-x)、[rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 和 [pi-i18n](https://github.com/jerryfan/pi-i18n)。这些项目是参考来源，不是运行时依赖。

## 许可证

[MIT](LICENSE)
