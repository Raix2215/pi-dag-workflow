# pi-dag-workflow

[English](README.md) | 简体中文

为 [Pi](https://pi.dev) 提供可见、会话内的工作流：一份 Todo 清单、派生 DAG、只读 Plan、单层子 Agent 和有界 Goal 续跑。主模型决定执行什么，插件负责依赖校验和进度展示。

## 你能获得什么

- **一份任务清单**：任务和前驱无需另一份 DAG 队列或数据库。前置未完成，下游不能开始／完成。
- **先规划再实施**：Plan 允许探索、搜索、提问和整理 Todo；退出后才允许实施和派发。
- **真实子进程**：最多 4 个 Pi 子 Agent，支持具名 Profile、消息、提问、等待、取消和移除。返回结果不自动完成 Todo。
- **有界目标**：一次选择一个 Goal。Goal 续跑与 Agent 报告唤醒共享默认 20 次额度；中断、恢复、Plan、预算耗尽、无新进展时暂停。
- **可读进度**：Nerd Font 面板、主路径／平铺任务树、可滚动的实线 DAG，以及真实思考／工具／输出活动。界面活动不进入模型上下文或任务持久化。
- **原生会话恢复**：Todo、Goal、预算和 Job 快照跟随 Pi 活动分支；恢复不复活子进程，也不自行重启自动工作。

## 安装

使用 Pi 包安装器从插件的 GitHub 仓库安装。

## 快速开始

直接告诉主模型：

> 用 Todo 记录调查、实现和测试；实现依赖调查，整合依赖实现与测试。有收益时才委派独立工作，检查结果后再完成任务。

用 `/plan start` 只读探索，实施前 `/plan off`。`/todos` 查看完整清单，`/dag` 查看真实连线。`/goal new 改造解析器` 只创建目标；`/goal enable #1` 开始围绕它推进，`/goal off` 暂停，`/goal resume` 明确恢复。

研究不强制创建 Todo：主模型可通过 `goal update` 报告新的 `progress` 和具体 `nextStep`，需要用户答复时暂停。

## 工具与命令

| 工具 | 用途 |
|---|---|
| `todo` | create/update/list/get/delete/clear；数字编号、blockedBy 前驱 |
| `goal` | create/update/list/get/delete；enable/focus/switch/resume；disable/pause/complete |
| `subagent_spawn` | 启动子进程，task 及可选 todoId/profile/tools/timeout |
| `subagent_send` | 给 recipient jobId 发消息，或回答 requestId |
| `subagent_wait` | 等结果／提问；超时和取消等待不停止子进程 |
| `subagent_inspect` | Job 摘要和 Profile，不默认回传完整子对话 |
| `subagent_cancel` | 停止子进程；可选 remove 移除记录，不撤销项目修改 |

| 命令 | 示例 |
|---|---|
| `/todos` | `add 标题 --after 1,2`、`start #2`、`done #2`、`edit #2 新标题`、`delete #2`、`clear` |
| 任务展示 | `/todos paths`、`/todos flat`、`show`、`hide`、`view list`、`view dag` |
| `/dag` | 实线框图；↑/↓、PgUp/PgDn、Home/End；Esc 返回 |
| `/plan` | `start`、`off`、`status`；`tools 名称1,名称2` 明确允许可信只读工具 |
| `/goal` | `new 标题`、`enable #1`、`switch #2`、`resume`、`off`、`edit #1 标题`、`complete #1`、`delete #1` |
| `/agents` | `wait a1`、`send a1 消息`、`reply requestId 回答`、`cancel a1`、`remove a1`、`pause`、`resume` |
| Profile | `/agents profiles`、`profile 名称 provider/model [thinking] [工具逗号列表]`、`unprofile 名称` |

这些入口都有本地 `help`，不调用模型、不切模式。自然语言也能驱动已注册工具。

## 配置与可选模块

配置目录为 `~/.pi/agent/pi-dag-workflow/`，遵循 Pi 的 `PI_CODING_AGENT_DIR` 和 `~` 展开。配置不是另一份任务状态库。

### `pi-dag-workflow-config.json`

可选。省略 `modules` 时全部启用；提供数组则只启用列出的功能。修改后 `/reload`。

```json
{
  "modules": ["todos", "plan", "agents", "goal", "ui"],
  "goalMaxTurns": 20,
  "goalNoProgressLimit": 3
}
```

| 选择 | 行为 |
|---|---|
| `["todos", "plan", "ui"]` | 任务、DAG 和规划，无 Goal／子 Agent 工具 |
| `["goal", "ui"]` | 独立目标，无 Todo／子 Agent 工具 |
| `["agents"]` | 独立子进程，无 Todo 关联和实时面板 |
| `[]` | 本插件不注册工具、命令或会话资源 |

`ui` 控制实时面板和可滚动详情；不启用它仍可查看本地命令输出。DAG 属于 `todos`，关联 `todoId` 也需要 `todos`。未启用模块不会注册工具／指导，关闭 UI 不启动活动刷新定时器。

**只有一个公开扩展入口** `src/index.ts`。功能目录中的 `index.ts` 是内部注册入口，不应单独传给 `-e`：Plan 限制、唯一 Todo 身份、Goal／Agent 预算需要同一个协调器。用配置选择模块，而非同时启动多个工作流实例。

### `pi-dag-workflow-profile.json`

可用 `/agents profile …` 保存，也可手动编辑这个可选用户级文件：

```json
{
  "profiles": [
    {
      "name": "research",
      "model": { "provider": "example-provider", "id": "example-model" },
      "thinking": "low",
      "tools": ["read", "grep", "find", "ls"]
    }
  ]
}
```

未指定 Profile 时继承主会话所选模型，默认 read/grep/find/ls、thinking off。明确指定的内置工具可增加 write/edit/bash；不自动复制任意主会话扩展工具。保存时校验模型和工具；只有显式保存才写用户配置。

## 必须了解的边界

- 20 次是**插件额外续跑／唤醒额度**，不是 API 总请求上限。Pi 原生工具结果 follow-up 和重试另算；主模型报告的进展需要实际核验。
- 已完成 Todo 不悄悄重开，返工建新项。clear 不复用编号。切换／删除 Goal 不清空 Todo，不撤销文件。
- 进入 Plan 需要主会话空闲且受管理子进程不再活动。退出 Plan、查看和恢复不会重启暂停的 Goal。
- 全新会话仅有命令元数据时可能尚未创建会话文件。发送正常消息后随 Pi 落盘；插件只提示，不另写任务文件。`--no-session` 不持久化。
- 扩展和有写入能力的子进程使用你的 OS 权限。Plan／工具选择**不是沙箱**，分支导航不会回滚项目修改。
- 子用量随 Job 结果保存（`/agents wait jobId`）。原生父会话费用不包含独立子进程；报告金额是配置估算，不是账单。
- 密集／大 DAG 明确退回完整前驱列表；裁剪小组件明确标注预览，不冒充完整图。

## 开发

```bash
npm run check                 # 类型、离线／实际 Pi 回归、打包检查
npm run test:performance      # 本机绘制基准，不调用模型
npm run test:goal-flash       # 显式真实模型 Goal 验收，会消耗额度
npm run test:joint-flash      # 有界主会话＋两子 Agent 联合验收
```

测试使用隔离 Pi 会话和明确的启用列表。真实验收需要已配置 `example-model`，会消耗额度。tmux 测试按当前要求暂停，不属于默认检查。

```text
src/
  index.ts       公开入口与模块选择
  workflow/      共享会话状态、协调与绘制生命周期
  todos/         Todo 状态、工具与命令
  plan/          规划命令与只读限制
  agents/        子进程、消息、Profile 与用量
  goal/          Goal 状态、注意力与共享续跑预算
  dag/           图校验、临时缓存与实线路由
  ui/            主题绘制与滚动
  shared/        配置路径与模块选择
```
