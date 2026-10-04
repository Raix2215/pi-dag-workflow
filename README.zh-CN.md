# pi-dag-workflow

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![Node 22.19.0+](https://img.shields.io/badge/Node-22.19.0%2B-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[English](README.md) | 简体中文

为 [Pi](https://pi.dev) 提供可见、会话内的工作流：一份带 `blockedBy` 依赖的 Todo 清单、只读 Plan、最多八个独立 Pi 子 Agent，以及有界续跑的 Goal 循环。主模型决定执行什么，插件负责依赖校验并把进度保持在屏幕上。

## 功能

- **一份任务清单，一张派生 DAG**：Todo 通过 `blockedBy` 携带前驱。前置未完成时，下游不能开始或完成；`/dag` 从同一份清单绘制真实依赖图，没有第二份队列或数据库。
- **先规划再实施**：Plan 是只读模式，用于阅读、搜索、提问和整理 Todo；只读网络工具可通过 `planTools` 启用。实施、shell 命令和派发在退出 Plan 前都会被拦截。
- **真实子进程**：最多运行八个 Pi 子进程。每个可带任务、可选的 Todo 关联和具名 Profile；支持发消息、回答提问、等待、取消或移除记录。执行结束后先显示“待交付”；报告交付后，关联的未完成 Todo 显示“待核验”，验收后才变为“已完成”。返回结果不会自动完成 Todo。
- **有界目标**：一次聚焦一个 Goal。自动续跑与子报告唤醒共享默认 32 次额度。常规模式连续八轮未记录到工作进展时先重新规划，再一轮仍无进展才暂停；`nopause` 在额度内继续尝试。模型请求失败先自动重试（默认 5 次）。可用每个 Goal 的 `/goal nolimit` 菜单取消续跑轮数上限，不重置已用次数。用户停止、会话恢复、Plan、有限额度耗尽与压缩失败仍保留安全停止。
- **可读进度**：Nerd Font 面板展示任务树、实线 DAG 和真实的思考／工具／输出活动。工具执行超过 99 秒后仍持续刷新，以紧凑的秒／分／时显示。界面活动不会写入模型上下文或持久化的工作流状态。
- **压缩后保留状态**：压缩、重载或分支导航后，通过尾部追加的检查点补充关键 Todo／Job 状态，以及原始 Goal 要求和执行策略；命令修改会合并，普通工具结果自行承载提醒。检查点不唤醒模型，也不替换记忆插件的摘要。
- **会话内持久化**：Todo、Goal、预算和 Job 快照跟随 Pi 活动分支。恢复会话不会复活子进程，也不会自行重启自动工作。

## 环境要求

- Pi `>= 1.0.0`
- Node.js `>= 22.19.0`。子 Agent 模块要求 Pi 运行于 Node，独立二进制宿主不在支持范围内。
- 建议使用 Nerd Font，以正常显示面板图标（是图标，不是 emoji）

## 安装

```bash
pi install https://github.com/Raix2215/pi-dag-workflow
```

Pi 会从该 GitHub 仓库安装插件；目前没有 npm 包。安装后重启 Pi 或执行 `/reload`，再用 `pi config` 选择要加载的模块（见下文）。

若其他插件已提供 Todo、Plan、Goal 或子 Agent 工具，请只启用其中一个，详见[与其他插件的兼容性](#与其他插件的兼容性)。

## 快速上手

直接把需求告诉主模型：

> 用 Todo 记录调查、实现和测试；实现依赖调查，整合依赖实现与测试。只在确有收益时委派独立工作，检查结果后再完成任务。

使用过程中的常用入口：

- `/plan start` 只读探索，实施前 `/plan off`。
- `/todos` 查看完整清单，`/dag` 查看依赖图。
- `/goal new 改造解析器` 只创建 Goal，不启动；`/goal enable #1` 开始围绕它续跑。

研究不强制创建 Todo：用简短 `goal update` 记录新证据和下一执行动作。Goal 优先实施、实验和验证；只有明确要求，或交付、复现必需时才处理文档。

## 面板

面板始终贴在编辑器上方，随工作推进刷新；`/dag` 把同一份清单画成实线依赖图。两者都由那一份 Todo 渲染。

```text
●  Todo (1/5) · 󰓾 Goal: #1 完成解析器重写
└─ #1              ✓ 调查现有解析器             [主会话] [已完成]
   └─ #2           ◐ 重写分词器              [a1 · fast] [󰆍 工具]
      ├─ #3        ○ 补充回归测试              [主会话] [待执行]
      └─ #4        ○ 更新 CLI 文档             [主会话] [待执行]
         └─ #5<-#3 ○ 万行基准测试              [主会话] [待执行]
●  Standalone Subagents · 2
├─ a2 · fast   调查 CI 偶发失败                  [󰧑 思考中]
└─ a3 · codex  起草迁移指南                      [󰥔 待交付]
```

`#5<-#3` 表示 #5 还依赖 #3，而 #3 的分支没有画出来。`[a1 · fast]` 是一个正在运行的子 Agent，状态列显示它当前在做什么。

不带 `todoId` 派发的子 Agent 没有任务行可挂，它们进入清单下方的 `Standalone Subagents` 小节：先列进行中的，再列待交付的，然后是失败／取消／中断的。没有这类 job 需要关注时该小节完全不显示，也不会重复任务行上已有的 job。左侧树根圆点与 Todo 同规则：块内还有未结的事时为实心，只剩已结束的 job 时为空心。

```text
●  Todo (1/3) DAG · 󰓾 Goal: #1 完成解析器重写
                       ┌───────────────────┐
                       │ ✓ #1 调查现有解…  │
                       │ [主会话]          │
                       │ [已完成]          │
                       └────────┬──────────┘
                      ┌─────────┴─────────────┐
                      │                       │
                      │                       │
           ┌──────────┴────────┐   ┌──────────┴────────┐
           │ ◐ #2 重写分词器   │   │ ○ #3 补充回归测试 │
           │ [a1 · fast]       │   │ [主会话]          │
           │ [󰆍 工具]          │   │ [待执行]          │
           └───────────────────┘   └───────────────────┘
```

终端宽度放不下图形时，`/dag` 会退回到上面的列表，依赖关系在任何宽度下都保持可读。

### 派发子 Agent

默认一个任务一个子 Agent，但一个子 Agent 也可以带**整条串行链**：当 B 需要 A 的结论时，把 A、B 一起交给它；互相独立的分支则分别派发。**只派发前置已完成的任务**——子 Agent 无法等待另一个子 Agent 的任务，所以仍依赖在跑工作的任务应留在主模型手里，等工作结束后再派。并发上限 8 个，子 Agent 不能再派子 Agent。

串行链建议让子 Agent **每完成一步就发一条简短中间汇报**，父模型据此推进任务状态；最终报告仍是你核对的依据。最后一步已经可启动时可以绑定它；若它仍被依赖阻塞，就绑定**首个可启动任务**。例如 `A → B → C` 中只有 A 可启动，就绑定 A，父模型核验中间汇报后依次推进 A、B、C。子 Agent 汇报过后，允许只把绑定任务的状态标记为完成；内容修改仍需明确发送调整信息，重开、删除、清空及触及该任务的片段重置要等子 Agent 停止。每条工作流同时最多一个任务处于进行中。任务完成时还会打印一行"前置已完成，可开始：#N …"的提示，但插件**不会自动开始**它们。

`context: true` 会给这一个子 Agent 附上一段简报：它在片段中的步骤位置、整个片段及当前状态、以及该片段前序步骤报告的开头部分。让子 Agent 接着片段往下走时打开它，可以省掉重复摸底。简报经环境变量传入、在子进程中读取一次即删除，且不会通过 `subagent_inspect` 暴露。

## 工具

| 工具 | 用途 |
|---|---|
| `todo` | create/update/list/get/delete/clear；update 可记录 failed/cancelled；clear 范围 completed/closed/all；片段 apply/reset；数字编号与 `blockedBy` 前驱 |
| `goal` | create/update/list/get/delete；enable；disable；complete，每个操作一个名称 |
| `subagent_spawn` | 启动一个子进程，字段为 `task` 及可选 `todoId`/`profile`/`tools`/`timeout`/`context` |
| `subagent_send` | 给 recipient 发方向，可选 interrupt:true 在同一子会话调整；或回答 requestId |
| `subagent_wait` | timeout:0 立即快照；until:update（默认5秒）／finish（默认30秒），可带 after 报告版本；超时／取消只影响等待 |
| `subagent_inspect` | 当前工具／活动、时长、排队方向、问题ID、报告版本和todoStatus；默认简要Profile，profiles:true含完整指令 |
| `subagent_cancel` | 停止子进程；可选 `remove` 移除记录，不撤销项目修改 |

failed／cancelled 表示已结束的尝试，可显式回到 pending／in_progress 重试；它们不能满足前置依赖。子任务的失败／取消结果可让未完成 Todo 进入对应视图分组，但不代表 Todo 已验收。

创建时填写 `status: "pending"` 会正常接受；填写 `status: "in_progress"` 仅在前置已完成且 Plan 已关闭时开始任务。创建为 `completed` 或 `deleted` 会明确拒绝：核验完成后用 `update`，移除任务用 `delete`。

## 命令

| 命令 | 示例 |
|---|---|
| `/todos` | `add 标题 --after 1,2`、`start #2`、`done #2`、`pending #2`、`failed #2`、`cancelled #2`、`edit #2 新标题`、`delete #2`、`clear [completed/closed/all]` |
| 任务展示 | `/todos paths`、`/todos flat`、`show`、`hide`、`view list/dag [full/pending/completed/failed/cancelled]` |
| 完整查看 | `/todos list [筛选]`、`/dag [筛选]`，不截断行数；↑/↓、PgUp/PgDn、Home/End；Esc 返回 |
| `/plan` | `start`、`off`、`status`；`tools 名称1,名称2` 明确信任额外只读工具，`tools none` 清空 |
| `/goal` | `new 标题`、`list`、`enable [ #1]`、`disable [ #1]`、`edit #1 标题`、`complete #1`、`delete #1`、`get #1`、`nopause [ #1]`、`nolimit [ #1]`、`config`、`reset` |
| `/agents` | `wait a1`、`send a1 [--interrupt] 消息`、`reply requestId 回答`、`cancel a1`、`remove a1`、`pause`、`resume` |
| 任务片段 | `/todos presets`、`apply 名称 [键=值 …]`、`reset 名称 [步骤键]` |
| Profile | `/agents profiles`、`profile 名称 provider/model [thinking] [工具逗号列表]`、`unprofile 名称` |

各命令组都支持 `help`；查看帮助不调用模型，也不切换模式。自然语言也能驱动已注册的工具。

### 筛选与记录清理

`full` 表示全部 Todo 状态，不是取消预览行数限制；`pending` 含待执行、进行中和待验收；`completed` 要求 Todo 已验收；`failed`／`cancelled` 也参考最新非历史子结果，后者含中断。面板保持8行Todo、4行Standalone与11行图形预览。完整窗口应用相同筛选、不截断行数。DAG复用Standalone块，隐藏的前置用编号引用保留。full沿用成功返回后自动隐藏的规则，completed可显式查看这类Standalone历史。

`/todos clear` 打开用户菜单：completed清理已完成记录；closed再包含失败、取消／中断和已删除记录；all清空全部可清理记录。todo工具使用相同scope。运行中、待交付／待核验和必要依赖锚点保留。清理不停止子进程、不改项目文件和Goal，也不重写Pi对话历史；任务和Job编号在清理及重载后不复用。

### Goal 生命周期

`new` 只记录 Goal，创建后保持暂停。`enable` 是唯一的激活方式：聚焦某个 Goal；省略编号时重新启用当前目标。已完成或已删除的 Goal 都不能重启——返工请新建一个。`disable` 是唯一的停止方式，并保留焦点，便于之后重新启用。停用后再 `enable` 开启的是新一轮完整额度，而不是上一轮的剩余额度。启用另一个 Goal 不会清空共用的 Todo 清单；停用 Goal 也不会杀死正在运行的子 Agent，停止它们请用 `/agents cancel`。

对于仍启用、但主会话已空闲的 Goal，`/goal enable #1` 会使用剩余额度发起下一次请求，不重置已用预算，也不重复派发正在运行的子任务。主会话正在运行或唤醒已排定时，重复 enable 不再发送一轮。

压缩成功后保留当前 Goal 和剩余额度，Pi 自身的超限重试优先执行。续跑草案被丢弃时，退回本次预留额度并保留下一步。空闲兜底会继续具体工作；Todo 全部完成或模型漏写 `nextStep` 时，仍通过 `goal get` 核对并推进同一目标。普通最终答复不会停止已启用 Goal。子任务仍在执行时，主会话可保持空闲，等报告回来后唤醒；真实等待超时不会被算作无进展。子任务提问优先处理，但不会丢失已保存的独立下一步。压缩失败／取消、用户明确停用仍保持停止。

原始要求全部核验达成后才用 `complete`。常规模式先尝试安全替代路径并继续独立工作，仅真实外部阻塞时询问用户。空 `nextStep` 只清除工作建议，仍继续原始目标；建议不能缩小目标或撤销已有授权。成功的 shell 工作计为活动，重复汇报和未执行的计划不算进展。默认八轮无进展后先重新规划，再一轮仍无进展才安全暂停。目标检查消耗剩余额度，不能取得新的授权。

### `nolimit` 轮数限制控制

`/goal nolimit [ #编号]` 在原有限额度与不限续跑轮数之间切换，省略编号作用于当前Goal。此设置用户专属、按Goal保存；菜单不启动／暂停、不补充额度、不清已用计数。切回有限时在下一次正常准入生效，若已用次数超过原上限，就在该边界停止。错误重试、用户停止、Plan、会话恢复、压缩失败和常规模式的无进展保护仍有效。

### `nopause` 模型中断控制

使用 `/goal nopause #1`，在 Goal 运行中切换是否允许模型自行中断：**允许模型中断**（默认）或**禁止模型中断**；省略编号时作用于当前 Goal。策略属于这个 Goal，随会话快照保存，启用、重载或分支恢复后保留，不改变其他 Goal 或全局配置。打开或取消菜单不会启动、暂停目标，也不重置预算。

禁止时进入自主执行：拒绝模型 `disable`、`delete` 和空 `nextStep`，要求模型通过检查、合理假设、实验和替代路径自行补齐缺口，不向用户提问或交回工作。运行期间隐藏并在执行入口拦截 `goalNoPauseTools` 中的工具，包括嵌套调用；默认禁用 `ask_user_question`。停止后只恢复由该 Goal 移除的工具。无进展只触发重新规划，不因此暂停。核验后的 `complete` 仍可使用；用户显式 `/goal disable`、`/goal delete`、有限预算、错误、Plan 与运行／压缩故障的安全控制仍有效。策略不能扩大已有权限，也不能代替真实验收。

模型无法通过 Goal 工具修改 `modelPause`。`goal get` 会显示策略，续跑提示按策略给出指导，被拒绝的停用请求不改变 Goal 状态。`/goal nopause` 是用户命令，支持交互终端与 RPC 选择菜单。

每个操作只有一个写法；首个词不属于命令动作时按自然语言处理，与其他自由描述走同一条路径。

### 观察与调整子 Agent

subagent_inspect可不等待地查看活动、待答问题和reportVersion。默认Profile简要，指定Job时不附Profile；profiles:true按需返回完整指令。subagent_wait返回完整输出和原因snapshot／update／question／finished／timeout。默认update等下一次报告、问题或结束，最多5秒；after使用已有reportVersion。finish默认30秒、上限300秒，提问仍提前返回。主模型应继续独立工作，避免重复轮询。

普通subagent_send在安全边界消费，不中断当前工具；interrupt:true先中止本地当前回合，清除过期方向／问题，再在同一子上下文发送新方向。delivery为accepted／queued／answered，不代表模型已执行。已触发的远端动作仍可能继续，开始重叠工作前需核对真实外部状态。subagent_cancel彻底终止进程；已结束的Job需重新派发。

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

## 与其他插件的兼容性

本插件是它参照的 Todo、Plan、Goal、子 Agent 插件的超集，因此注册了相近的工具名与命令。这些名字无法共享：

- **工具** —— Pi 每个工具名只保留一个定义，后注册的会替换先注册的。
- **命令** —— Pi 会给重名命令加后缀，例如两个 `/plan` 会变成 `/plan:1` 和 `/plan:2`，原来的 `/plan` 也就不再可用。

| 插件 | 重名内容 | 建议 |
|---|---|---|
| [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | `todo` 工具 | 只启用一个；任务数据双向可读（见下文）。 |
| [pi-plan-mode](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode) | `/plan` 命令 | 只启用一个；两者实现只读规划的方式不同。 |
| [Pi Subagents](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents) | `subagent_spawn`、`subagent_send`、`subagent_wait`、`subagent_inspect`、`subagent_cancel` | 只启用一个。 |
| [pi-goal-x](https://github.com/tmonk/pi-goal-x) | `/goal` 命令 | 只启用一个；两个续跑引擎会同时唤醒模型。 |

命名相近，但参数与持久化状态并不通用。一个插件创建的 Job 或 Goal，另一个插件不认识；两者的设置文件与 Profile 文件各自独立。

### 记忆与压缩插件

未安装压缩扩展时，工作流直接支持 **Pi 原生压缩**。同时启用 `pi-blackhole`、`pi-cache-optimizer` 或 `pi-observational-memory` 时，检查点消息与它们的摘要、上下文投影保持独立；没有新增运行依赖，不覆盖摘要，不改写之前的模型消息。各插件自己的 Pi 版本支持范围与彼此冲突仍需遵守。

检查点最多列出 12 项未完成任务和 8 个活动 Job，不重播完整报告；在安全时机尾部追加，之后保留原样。记忆插件可以过滤检查点，工作流不会绕过过滤强行补回。这能避免工作流自身造成前缀反复变化，但实际缓存命中仍取决于完整请求与供应商规则。检查点不接管压缩摘要、不改写之前的模型消息，也不会自行唤醒模型。

### 接手使用过 rpiv-todo 的会话

rpiv-todo 把任务清单保存在 `todo` 工具结果的 `details` 里，本插件写入相同结构：`tasks`、`nextId`，以及共用的任务字段与状态。使用 pending／in_progress／completed／deleted 的清单仍双向可读；其他插件不一定识别本插件新增的 failed／cancelled 尝试状态。

本插件在当前活动分支上找不到自己的快照时，会回放分支上最近一次 `todo` 结果，沿用相同的编号、标题、状态、属主与 `blockedBy` 依赖，而不是从空清单开始。分支上一旦存在本插件的快照，就以它为准；本插件写回的结果结构相同，所以切回 rpiv-todo 时那份清单仍然可用。

Plan 模式、Goal 与子 Agent Job 并不共享：它们各自保存在本插件的会话条目里，格式互不相同。

## 配置

配置只保存插件设置，与 Pi 的会话记录分开存放，使用以下文件名。可运行 `/goal config` 定位它们。

### `pi-dag-workflow-config.json`

可选。这六个键就是全部配置项，缺省时使用示例中的默认值。模块开关用 `pi config` 控制，不在此文件；修改后 `/reload` 生效。

```json
{
  "language": "auto",
  "goalMaxTurns": 32,
  "goalNoProgressLimit": 8,
  "goalErrorRetries": 5,
  "planTools": [],
  "goalNoPauseTools": ["ask_user_question"]
}
```

- `language` —— `"auto"`（默认）、`"en"` 或 `"zh-CN"`。`auto` 在终端 locale 为中文时选 `zh-CN`，否则选 `en`。插件标签、帮助、通知和工作流消息会本地化；用户内容、命令名和工具结构化字段保持原样。
- `goalMaxTurns` —— 新建 Goal 的默认额度，取值 1–200（默认 `32`），由自动续跑和子报告唤醒共享。
- `goalNoProgressLimit` —— 连续多少轮未记录到工作进展后重新规划，取值 1–100（默认 `8`）。常规模式再一轮仍无进展才暂停；`nopause` 在有限额度内继续尝试。
- `goalNoPauseTools` —— `nopause` Goal 运行期间禁用的工具，最多 16 个不重复的精确名称（默认 `["ask_user_question"]`）。可加入其他提问工具名；`[]` 表示不禁用工具，自主执行提示和 Goal 停用守卫仍有效。该列表作用于主会话，不修改子 Agent Profile 的工具列表。
- `goalErrorRetries` —— Goal 运行中模型请求失败后的自动重试次数，取值 0–20（默认 `5`）。每个失败的请求各得一次重试，且等 Pi 自身的重试耗尽、当前运行结束后才发起；成功一轮后计数清零，设为 `0` 表示首次出错即暂停。重试不消耗续跑额度。用户输入、停用、切换目标、重置或会话导航会取消待发起的重试。
- `planTools` —— Plan 模式的机器级额外只读工具，最多 16 个不重复名称（默认 `[]`）。想让规划阶段联网检索就写 `["web_search", "fetch_content", "get_search_content", "source_check"]`；名称要与你的 Pi 已安装工具一致。写入、shell 与派发永远不受它影响；`/plan tools 名称1,名称2` 可在单个会话上追加。

未知键和越界取值都会作为配置错误处理；模块选择只在 `pi config` 里，不写在此文件。

### `pi-dag-workflow-profile.json`

可用 `/agents profile …` 保存，或手动编辑这个可选用户级文件。示例包含一个只读研究 Profile 和一个明确指定模型的写入 Profile：

```json
{
  "profiles": [
    {
      "name": "research",
      "thinking": "off",
      "tools": ["read", "grep", "find", "ls"],
      "instructions": "先读后写。报告文件路径与行号，不要修改任何文件。"
    },
    {
      "name": "fast-edit",
      "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
      "thinking": "low",
      "tools": ["read", "grep", "find", "ls", "edit", "write"]
    }
  ]
}
```

- `name` —— 1–48 个字母、数字、`_` 或 `-`，以字母或数字开头；`inherit` 为保留名。
- `model` —— 必须是 Pi 已认识的 `provider` 与 `id`，写法与 `/model` 中显示的一致（`anthropic/claude-sonnet-4-5` 只是示例）。省略 `model` 表示继承主会话当前所选模型，如上面的 `research`。
- `thinking` —— `off`（默认）、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`；不支持推理的模型只能用 `off`。
- `tools` —— 最多 8 个子 Agent 工具。`read`、`grep`、`find`、`ls` 始终可用，`edit`、`write`、`bash` 是可选的额外内置工具；主会话中的任意扩展工具不会被复制。
- `instructions` —— 可选提示词，上限 2000 字符，会成为该 profile 派发的每个子 Agent 的一个系统提示词段（`dag_profile`，与内置子 Agent 规则并列）。用来固化“这类活该怎么干”；它不会赋予任务之外的权限。文本通过子进程环境变量传递、读取一次即删除，也不会经 `subagent_inspect` 出现在模型上下文里。

同一份 Profile 也可以在会话里用 `/agents profile 名称 provider/model [thinking] [工具逗号列表]` 修改，用 `/agents unprofile 名称` 删除。文件最多保存 64 个 Profile、上限 64 KiB、不允许未知字段，从 `/agents` 保存时以仅属主可读写的权限写入。

### `pi-dag-workflow-preset.json`

可选的可复用任务片段，用于反复执行的固定流程。`apply` 一次把片段的任务全部加入清单；`reset` 把已完成的实例重新打开，让同一片段再跑一轮：

```json
{
  "presets": [
    {
      "name": "release",
      "description": "发布一个版本",
      "skill": "release-checklist",
      "steps": [
        { "key": "verify", "subject": "跑全量检查", "owner": "fast" },
        { "key": "changelog", "subject": "更新 CHANGELOG 到 v{version}" },
        { "key": "tag", "subject": "打标签并发布 v{version}", "after": ["verify", "changelog"] }
      ]
    }
  ]
}
```

- `name` —— 1–48 个字母、数字、`_` 或 `-`，以字母或数字开头。
- `description` —— 单行、≤200 字符；它会像 skill 描述一样出现在系统提示词里，模型不必读步骤就知道这个片段存在。
- `skill` —— 可选，执行片段前建议加载的 Pi skill 名称。
- `steps` —— 1–32 步。`key` 是片段内的稳定标识，`subject` 是任务标题，`{占位符}` 由 apply 时的 `vars` 填充；`after` 列出必须先完成的步骤键，`owner` 预置负责人/profile，`description`/`activeForm` 与任务字段同义。
- 无环依赖可以引用文件中位于前面或后面的步骤键；展示序号保持定义顺序。
- apply **总是开新一轮**且绝不复用编号，已完成轮次保留为历史；面板标签显示步骤序号，如 `[release#1]`、`[release#2]`，后续轮次加后缀，如 `[release#1·r2]`，位于 owner 与状态之前。
- `reset` 重开最新一轮，或用 `reset 名称 步骤键` 重开某一步；工具的 `run` 字段可指定更早实例。两种方式都会重开全部仍存在的下游任务，包括片段之外的任务。已删除行保持删除；闭包内任一任务绑定了活动子 Agent 时，重置会被拒绝。
- 片段放在一个用户级文件里（64 KiB、最多 64 个片段）；默认不定义任何片段。建议将文件权限设为仅属主可读写。

## 安全与隐私

- **存了什么。** Todo、Goal、预算与 Job 快照保存在 Pi 自己的会话记录里，跟随当前活动分支。插件唯一写入的文件是保存 Profile 时的 `~/.pi/agent/pi-dag-workflow/pi-dag-workflow-profile.json`（仅属主可读写）；配置文件由你自己创建。数据不会进入数据库或第三方服务。
- **插件自身不联网。** 它不会访问任何远端地址，也不上报遥测。子 Agent 通过 Pi 使用你已经配置好的模型与凭据。
- **子 Agent 凭据。** 模型启动信息通过环境变量传给子进程，子进程启动时立即解析并删除，不落盘、不出现在命令行参数里。子进程也会继承进程环境及所选 provider 所需的环境变量；启动信息清理不构成凭据沙箱。
- **与主会话相同的系统权限。** 主会话、Plan 模式和每个子进程都以你的身份运行。Plan 与工具选择是执行守卫；取消子 Agent 只停止进程，不回滚它已经改过的文件。
- **报告与输出。** 子 Agent 报告、提问与工具输出在显示前会清除终端控制字符，随后进入模型上下文并保留在会话记录中。插件不设字符上限，长报告与会话中的其他内容一样占用上下文和存储。

## 必须了解的边界

- 额度是**插件额外续跑与唤醒**的预算，不是 Pi 或 API 调用上限。原生工具结果 follow-up 和重试另算，模型报告的进展也应实际核验，而不是直接采信。
- 已完成的片段任务通过明确的 `reset` 重开，其它已完成 Todo 返工请新建任务。`clear` 不复用编号。切换或删除 Goal 既不清空 Todo，也不撤销项目文件。
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
