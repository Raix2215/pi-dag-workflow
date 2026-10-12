# pi-dag-workflow

[![CI](https://github.com/Raix2215/pi-dag-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/Raix2215/pi-dag-workflow/actions/workflows/ci.yml)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[English](README.md) | 简体中文

为 [Pi](https://pi.dev) 提供任务依赖、只读规划、子 Agent 和目标续跑。在当前会话维护一份任务清单，查看实时执行状态，核验结果后再完成任务。

## 安装

```bash
pi install https://github.com/Raix2215/pi-dag-workflow
```

重启 Pi 或执行 `/reload`，再用 `pi config` 选择所需模块。

要求 **Pi 1.0.0+**、**Node.js 22.19.0+**。子 Agent 需要基于 Node 的 Pi 宿主。建议使用 Nerd Font 显示面板图标。界面支持英文和简体中文。

对于 `todo`、`/plan`、`/goal`、`subagent_spawn` 等同名入口，只启用一个提供它的扩展。

## 快速上手

直接让 Pi 整理并执行任务：

> 用 Todo 记录调查、实现和测试；实现依赖调查。把独立工作交给子 Agent，检查结果后再完成任务。

```text
/plan start
```

只读探索项目并整理 Todo。准备实施时：

```text
/plan off
/todos
/dag
```

需要跨模型回合持续推进的工作：

```text
/goal new 添加 CSV 导出并通过测试
/goal enable #1
```

需要持续工作时才创建 Goal。重要发现或决定改变了后续行动时记录进展；普通活动由任务和工具结果承载。

## 功能

- **任务依赖**：`blockedBy` 关联前置任务。开始、完成或派发下游任务前，前置必须已完成。
- **只读 Plan**：阅读、搜索、提问和编辑任务定义；实施与派发需先 `/plan off`。
- **并行子 Agent**：最多八个独立 Pi 进程，支持明确派发、问题答复、报告、Profile 和原任务接续。
- **Goal 续跑**：一次聚焦一个目标，支持用户控制的中断策略和持续研究模式。
- **错误恢复**：用户通过 `/retry` 控制 Normal、Plan 和 Goal 主会话重试；间隔循环，可限制次数并按指定顺序替换模型。
- **实时进度**：任务树或 DAG 预览、子进程活动、待交付和待核验状态；完整视图可滚动。
- **会话持久化**：任务、Goal 和 Job 记录跟随 Pi 当前分支。恢复时自动工作保持暂停，原有子进程保持停止。

## 任务与依赖

模型通过 `todo` 管理任务。以下 batch 原子创建两个依赖任务：

```json
{
  "action": "batch",
  "operations": [
    { "action": "create", "ref": "build", "subject": "实现 CSV 导出" },
    { "action": "create", "subject": "核验 CSV 导出", "blockedBy": ["@build"] }
  ]
}
```

batch 接受 **1–50 个定义操作**：创建 pending 任务，或修改任务定义。`@ref` 引用本次调用中更早创建的任务。任一操作无效时，整个清单保持不变。

常用查询：

```json
{"action":"list","ready":true,"limit":50}
{"action":"get","id":2}
{"action":"status"}
```

list 默认返回 50 项，每页最多 200 项。使用结果中的完整续页参数，保持同一筛选条件。get 返回完整任务、直接后继 `blocks` 和未满足前置 `unmetPrerequisites`。status 返回模式、任务计数、保护及重试状态的简短只读摘要；goal get 也附带重试状态。

任务状态为 `pending`、`in_progress`、`completed`、`failed`、`cancelled`、`deleted`。单条 create 接受 pending，也可在依赖允许时创建为 in_progress；batch 创建 pending 任务。失败和取消的尝试不能满足前置依赖。

核验后只需更新状态：

```json
{"action":"update","id":1,"status":"completed"}
```

description 保存任务要求和必要上下文。验收摘要放在会话答复中，或给出产物路径；状态变更不需要再把报告写进任务描述。

### 视图与清理

任务树展示当前工作与执行者：

```text
●  Todo (1/3)
└─ #1       ✓ 检查解析器                                     [主会话] [已完成]
   └─ #2    ◐ 实现 CSV 导出                           [a1 · worker] [󰥔 运行中]
      └─ #3 ○ 测试 CSV 导出                                  [主会话] [待执行]
```

`/dag` 绘制同一份任务的依赖关系：

```text
●  Todo (1/3) DAG
          ┌───────────────────────────────┐
          │ ✓ #1 检查解析器               │
          │ [主会话]                      │
          │ [已完成]                      │
          └──────────────┬────────────────┘
                         └─┐
                           │
                           │
          ┌────────────────┴──────────────┐
          │ ◐ #2 实现 CSV 导出            │
          │ [a1 · worker]                 │
          │ [󰥔 运行中]                    │
          └──────────────┬────────────────┘
                         └─┐
                           │
                           │
          ┌────────────────┴──────────────┐
          │ ○ #3 测试 CSV 导出            │
          │ [主会话]                      │
          │ [待执行]                      │
          └───────────────────────────────┘
```

`/todos` 打开完整清单，`/dag` 打开依赖图。`paths` 按依赖树展示，`flat` 平铺展示。编辑器上方的预览随终端高度收缩，最多 12 行，优先显示需要关注的工作。放不下的图形用依赖列表展示。完整视图支持 ↑/↓、PgUp/PgDn、Home/End，Esc 返回。

筛选：`full`、`pending`、`completed`、`failed`、`cancelled`。

- pending 包含待核验工作。
- completed 表示 Todo 已验收。
- failed／cancelled 参考当前最新子执行尝试；中断属于 cancelled 分组。
- 明确退役的尝试保留在 Job 历史；未完成 Todo 回到 pending，可继续执行。

`/todos clear` 打开确认菜单。工具支持 `scope: "completed"`、`"closed"`、`"all"`。清理保留活动工作、待交付报告、待核验任务和必要依赖记录；编号不会复用。

## 子 Agent

给子任务提供输入路径、范围和预期证据：

```json
{
  "task": "检查 CSV 解析器的边界情况，报告文件路径与行号，不修改文件。",
  "todoId": 1,
  "tools": ["read", "grep", "find", "ls"]
}
```

通过 `subagent_spawn` 调用。todoId 可选；关联任务必须可执行。子 Agent 在同一工作目录中使用独立模型上下文，加载工作区规则，并收到本次任务、选中的 Profile 指导及可选任务简报。

### 前置简报

关联 Job 设置 context:true，可附上任务要求摘要、直接前置状态和当前有效报告摘要。片段任务还包含步骤位置和片段状态。简报最多2,000字符，不复制主会话历史，不采用过期报告；普通任务简报注明省略的输入。

在 Todo 的 metadata.artifacts 记录明确产物引用：

```json
{"action":"update","id":1,"metadata":{"artifacts":["build/results.csv","test-results.json"]}}
```

引用是未核验输入，不是完成证据或权限。实际派发说明仍需自包含，提供简报省略但本次必需的路径和要求。

### 查询、收集与调整

使用 `subagent_inspect`：

```json
{"jobId":"a1"}
{"jobId":"a1","output":true,"timeout":0}
{"jobId":"a1","output":true,"until":"finish","timeout":30}
```

默认返回简要状态、活动和待答复问题编号。output:true 收集输出和问题，必须指定 jobId，支持：

- timeout:0：立即快照。
- until:update：等待新报告、问题或结束，默认最多 5 秒。
- until:finish：等待执行结束或问题，默认最多 30 秒。
- after：等待已有 reportVersion 之后的新结果。

等待最长 300 秒，问题会提前返回。超时或取消只结束等待；停止子进程请用 `subagent_cancel`。

使用 `subagent_send`：

```json
{"recipient":"a1","message":"请包含引号字段和空行的检查。"}
{"requestId":"request-id","message":"按已记录的 CSV 规则处理。"}
```

普通方向信息在安全边界消费。对 recipient 使用 interrupt:true，会中止当前本地回合、清除过期方向和问题，再在同一子上下文继续。送达确认不代表指令已被执行。

### 接续中断的任务

先查看诊断，核对已有文件及外部操作，再对同一 Todo 开始新尝试：

```json
{
  "resumeFrom": "a1",
  "profile": "research",
  "task": "检查已有结论，继续剩余的解析器审查，不重复已完成工作。"
}
```

resumeFrom 保留原 Todo 关联和派发说明。新 Job 可以选择其他 Profile；工具范围默认沿用前一次尝试，明确 tools 时才覆盖。Todo 定义发生变化时，需要新的自包含派发说明。记录中没有保存完整原任务时，task 必须提供完整指示。

明确取消失败或中断尝试后，它从当前面板退役，历史仍可查询，未完成任务显示“可接续”。主会话状态更新表示接管；新子尝试显示自己的活动。

子任务错误包含有界根因摘要和恢复建议。先处理账户或网络问题，核验部分产物，再明确接续。子模型请求不自动重试。Job 默认执行期限为 600 秒，timeout 最多可设 86,400 秒。

### 验收结果

执行、报告交付和验收分别进行：

```text
子 Agent 结束 → 报告交付 → 主会话核验 → Todo 完成
```

成功子任务在关联的未完成任务行先显示“待交付”，交付后显示“待核验”。主会话检查工作后再完成 Todo。取消已经成功的 Job 会保留其待交付报告；remove:true 明确移除记录。

交付时机和中断细节见[子 Agent 通信](docs/COMMUNICATION.md)。

## Goal

Goal 保存目标、范围和核验要求。创建后保持暂停，`/goal enable` 开始续跑；普通目标的原始要求全部核验通过后才完成。

| 控制 | 行为 |
|---|---|
| `/goal enable [#id]` | 启动或恢复所选 Goal；仍运行但空闲的目标使用剩余额度继续 |
| `/goal disable [#id]` | 暂停 Goal，子进程仍可独立控制 |
| `/goal nopause [#id]` | 选择是否允许模型暂停；禁止时要求在已有权限内自主决定 |
| `/goal nolimit [#id]` | 选择有限或不限续跑轮数，保留已用计数 |
| `/goal autoresearch [#id]` | 选择普通目标或持续自主研究，设置不启动工作 |
| `/goal complete #id` | 记录已核验结果；持续研究目标只能由用户完成 |

自动 Goal 回合和子报告唤醒共享默认 **32** 次额度，统计插件请求的续跑，不是全部 API 请求或工具结果 follow-up。常规模式八轮未记录工作进展时先重新规划，再一轮仍无进展才暂停。nopause 继续尝试，但用户停止、预算和错误保护仍有效。

progress 只记录重要验收结果、可复现发现、决定或阻塞变化。nextStep 仅在下一步实质改变时更新。工作笔记不改变原目标或权限。

Goal 请求错误收尾后，开启 /retry 时等待恢复，否则暂停。Goal 恢复使用剩余续跑额度；nolimit 控制该额度，不控制 /retry 设置。

### 持续研究

```text
/goal new 在 src/parser 范围内持续改善解析器正确性和性能
/goal autoresearch #1
/goal enable #1
```

在菜单选择“持续研究”。模型核验阶段成果后，继续选择原范围内的下一个假设、实验或证据检查；不能完成、停用、删除或切换整个 Goal，不能提问或交还工作。独立 Todo 仍可核验后完成。

该模式有效启用不限续跑和自主决定，但保留原 nolimit／nopause 设置；关闭后恢复原值，不清已用轮数。goal get 的 goal 保存原设置，controls 显示实际生效值。关闭模式不是停止命令；用 /goal disable 停止后续续跑，或中断 Pi 来中止当前工作。

研究可以量化，也可以按事实和核验结果判断。不会新增实验工具、自动 Git 提交或额外权限；保留用户改动，只撤销本次实验自己的无效修改。用户停止、Plan、资源不可用、重试次数及压缩保护仍有效。错误等待期间改变策略或范围，会取消旧恢复并可能暂停 Goal，需明确恢复。重载后始终保持暂停。

持续工作可能无限消耗模型用量；无人值守前先设置服务商费用上限。

## 错误恢复

`/retry` 打开用户菜单，也可直接输入：

```text
/retry when-error 5m,30s,10m count 3
/retry when-error 3m
/retry off
/retry status
```

恢复**默认关闭**，用于 Normal、Plan 和 Goal 的主会话，等待 Pi 原生恢复结束后处理错误。开启后覆盖已收尾的模型请求错误，包括额度和鉴权失败；原因未解决时可用 /retry off 停止重复尝试。

- 间隔使用正整数和 s／m／h，以逗号分隔，序列循环。
- count 限制一轮连续错误中的实际重试次数；省略不限。成功回合重置连续错误计数和间隔位置。
- 到期时 Pi 仍忙，则再等同一间隔；不扣次数，也不推进序列。
- 用户取消、模式或 Goal 范围改变、Goal 完成、导航和压缩会取消过期工作；Goal 额度与 Plan 只读限制仍有效。
- 重载后设置保留、恢复保持关闭，需明确重新开启。不重试子 Agent 或 shell 工具。

菜单包含“重试设置”“替代模型”“查看状态”和“退出菜单”。子页返回或 Esc 回上一级，主菜单 Esc 退出。保存、状态和开关操作后返回主菜单；非法输入保留供修改，取消不保存。无变化不重启倒计时；只改总次数保留剩余等待和已用次数。

### 替代模型

```text
/retry models
/retry models provider-b/model-b provider-c/model-c
/retry models after 2
/retry models off
```

示例占位符需替换为 Pi 已注册名称，也可在菜单中选择。候选顺序明确指定，最多八个不同模型。设置候选会启用模型替代，不会开启自动重试；恢复仍通过 /retry when-error 开启。候选和每模型次数的修改需要交互确认。/retry models off 关闭替代，保留普通重试。

每轮连续错误先尝试当前模型，再按顺序使用候选并去重。每模型默认最多两次插件尝试；间隔序列和总 count 跨模型共用，切换不增加等待，也不跳过下一次等待。初始失败和 Pi 原生重试不扣插件次数。已不存在、未配置鉴权或不支持当前图像输入的候选会跳过，不发探测请求。

成功的替代模型保留在当前会话，不修改全局默认。即使总 count 不限，候选耗尽也会停止恢复。重载保留候选设置，自动重试仍关闭。手动选择模型取消旧恢复；已发起的模型选择调用仍可能收尾，取消后应核对当前模型。不会自动恢复已取消的请求。

**跨服务商会把当前上下文发送给所选服务，也可能增加费用和缓存开销。** 保存候选前先确认服务范围。上下文处理由 Pi 负责；插件不自行删除历史以适配模型。

Pi 1.1+ 在最终收尾区分 provider 中止和用户取消；缺少该信号的宿主不自动恢复无法鉴别的 provider-aborted 请求。重试设置由用户控制，模型工具只能查询，不能配置。

## 工具与命令

以下是模型工具，上文 JSON 展示其参数。

| 工具 | 用途 |
|---|---|
| `todo` | 任务、分页查询、只读状态、依赖校验、片段和原子定义批量操作 |
| `goal` | 目标、重要进展、续跑和核验完成 |
| `subagent_spawn` | 新子 Job 与 resumeFrom 接续尝试 |
| `subagent_inspect` | 状态、可选输出／等待、Profile 发现 |
| `subagent_send` | 方向调整和子问题答复 |
| `subagent_cancel` | 停止或明确移除子记录 |

| 命令组 | 常用操作 |
|---|---|
| `/todos` | `add`、`start`、`done`、`pending`、`failed`、`cancelled`、`edit`、`delete`、`clear`、`paths`、`flat`、`view`、`show`、`hide`、`presets`、`apply`、`reset` |
| `/dag` | `[full/pending/completed/failed/cancelled]` |
| `/plan` | `start`、`off`、`status`、`tools 名称1,名称2` |
| `/goal` | `new`、`enable`、`disable`、`complete`、`delete`、`edit`、`get`、`list`、`nopause`、`nolimit`、`autoresearch`、`config`、`reset` |
| `/agents` | `list`、`wait`、`send`、`reply`、`cancel`、`remove`、`pause`、`resume`、`profiles`、`profile`、`unprofile`、`reset` |
| `/retry` | 菜单、`when-error 间隔 [count N]`、`off`、`status`、`models` |

/todos、/plan、/goal、/agents 的 help 显示具体语法；/retry 打开菜单。`/agents wait a1` 向用户展示输出；模型用 subagent_inspect 的 output:true 收集报告。

## 配置

文件位于 Pi agent 目录下，通常为 `~/.pi/agent/pi-dag-workflow/`。`/goal config` 显示路径。支持 Pi 选择的 agent 目录，包括 `PI_CODING_AGENT_DIR` 覆盖。

### 设置

可选 `pi-dag-workflow-config.json`：

```json
{
  "language": "auto",
  "goalMaxTurns": 32,
  "goalNoProgressLimit": 8,
  "planTools": [],
  "goalNoPauseTools": ["ask_user_question"]
}
```

| 设置 | 取值 |
|---|---|
| language | auto、en、zh-CN；auto 跟随终端 locale |
| goalMaxTurns | 1–200，新 Goal 的默认额度 |
| goalNoProgressLimit | 1–100，重新规划前允许的无进展轮数 |
| planTools | 最多 16 个可信额外只读工具名 |
| goalNoPauseTools | 最多 16 个 nopause／持续研究运行时禁用的主会话工具 |

确认额外 Plan 工具只读后再信任它们。编辑、shell 和派发仍受限制。修改设置后 `/reload` 生效。

### Profile

可选 `pi-dag-workflow-profile.json`：

```json
{
  "profiles": [
    {
      "name": "research",
      "thinking": "off",
      "tools": ["read", "grep", "find", "ls"],
      "instructions": "阅读指定输入，报告发现和对应文件路径、行号。"
    }
  ]
}
```

省略 profile 或指定 inherit，捕获派发时主会话的模型、思考等级和受支持的活动内置工具。命名 Profile 覆盖明确填写的字段；调用中的 tools 替换整个工具列表。可选 model 为 `{ "provider": "…", "id": "…" }`，使用 Pi 已注册模型的精确名称。隐式思考等级按能力适配，明确不支持的等级会被拒绝。

支持的子工具：read、grep、find、ls、edit、write、bash，以及宿主提供时的 powershell。子进程另有父会话通信工具。只读派发应明确选择只读工具。

Profile 指导作为任务上下文交付。用 subagent_inspect 发现：

```json
{"profiles":"summary"}
{"profile":"research"}
```

摘要包含设置、不含 instructions；命名查询返回一个完整 Profile，profiles:true 请求完整目录。Profile 名称 1–48 字符，最多 8 个工具，instructions 最多 2,000 字符；文件最多 64 个 Profile、64 KiB。`/agents profile` 使用仅属主读写权限保存，保留选定的技能入口。

Profile 可选 skills 指定本地 Markdown 文件：

```json
{"name":"csv-review","tools":["read","grep"],"skills":["skills/csv-review/SKILL.md"]}
```

最多八个文件，支持绝对路径、~/、相对于派发工作目录的路径。派发时每个文件必须可读、非空、不超过64 KiB；所选工具中必须已有 read。入口作为任务引用一次性交付，子任务按需读取正文。技能文本不会启用工具、扩展或 MCP，不授予脚本权限，也不覆盖本次任务要求。

### 任务片段

可选 `pi-dag-workflow-preset.json`：

```json
{
  "presets": [
    {
      "name": "verify-change",
      "description": "审查并测试已完成的修改",
      "steps": [
        { "key": "review", "subject": "审查实现" },
        { "key": "test", "subject": "测试 {target}", "after": ["review"] }
      ]
    }
  ]
}
```

通过 todo 发现和应用：

```json
{"action":"presets"}
{"action":"presets","preset":"verify-change"}
{"action":"apply","preset":"verify-change","vars":{"target":"CSV 导出"}}
```

目录查询返回名称、简介和步骤数；命名查询返回完整定义。每次 apply 创建新实例和新编号。reset 重开实例或指定步骤及其仍存在的后继；活动子绑定保护相关任务。绑定片段任务时，context:true 提供有界片段简报。

每个片段 1–32 步；after 指定前置步骤键，description／activeForm 提供任务指示，owner 是展示标签。可选 skill 是建议加载的技能名称。文件最多 64 个片段、64 KiB。个人配置保持仅属主可读，并放在源代码管理之外。

### 模块

通过 pi config 选择：

| 资源 | 功能 |
|---|---|
| `src/todos/index.ts` | Todo 工具、/todos、/dag |
| `src/plan/index.ts` | Plan 命令和执行限制 |
| `src/agents/index.ts` | 子 Job、消息和 Profile |
| `src/goal/index.ts` | Goal 记录与续跑 |
| `src/ui/index.ts` | 预览面板与完整详情 |

例如，Todo＋Plan＋UI 用于规划和执行，Goal＋UI 用于研究。任务关联和任务图需要 Todo。重载后模块选择生效。

## 安全与持久化

- 任务、Goal、派发说明、诊断和已完成的子输出保存在 Pi 会话记录中，跟随活动分支。会话文件可能含敏感信息。
- 子进程使用已配置模型并继承进程环境。Plan 和工具选择是执行限制，所有进程仍使用你的操作系统权限。
- 取消和分支导航不回滚文件、提交或已发出的外部请求。接续前先检查副作用。
- 恢复时原有子进程停止、Goal 暂停；恢复的是记录，不是子执行断点。崩溃前尚未封口的流式文本可能没有保留。
- Goal 原始要求通过当前上下文和恢复检查点交付，保留记忆摘要和早期消息；报告仍需验收。
- 长报告消耗模型上下文和会话存储。诊断摘要会脱敏常见凭据形式，分享前仍应检查任意报告正文。
- 插件不上报遥测；模型请求使用 Pi 已配置的 provider。子用量单独记录，配置价格估算不是账单。

参见[子 Agent 通信](docs/COMMUNICATION.md)、[贡献指南](CONTRIBUTING.md)和[安全政策](SECURITY.md)。

## 致谢

受到 Pi 社区项目的启发，包括 [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)、[pi-plan-mode](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode)、[Pi Subagents](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents)、[pi-goal-x](https://github.com/tmonk/pi-goal-x)和 [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch)。

## 许可证

[MIT](LICENSE)
