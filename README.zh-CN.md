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

## 用 `pi config` 选择模块

运行 `pi config`，找到本地 `pi-dag-workflow` 包，分别勾选其资源。选择由 Pi 原生资源过滤保存；保存后在会话中 `/reload`，或重新启动 Pi。

| 入口 | 提供的功能 |
|---|---|
| `src/todos/index.ts` | Todo 工具、任务命令和派生 DAG |
| `src/plan/index.ts` | Plan 命令与执行限制 |
| `src/agents/index.ts` | 子进程、消息和 Profile |
| `src/goal/index.ts` | Goal 工具与有界续跑 |
| `src/ui/index.ts` | 实时面板和可滚动详情 |

勾选 Todo＋Plan＋UI 可只规划／管理任务；Goal＋UI 可独立研究；只选 Agents 可独立派发子进程。DAG、todoId 关联需要 Todo。不选 UI 仍可看本地命令输出，不启动活动刷新计时器。只选 UI 时没有工作流数据可展示。

各入口都是真正的 Pi 扩展默认工厂。已加载入口通过 Pi 事件总线共享一份运行时协调状态；没有必选的 core 复选框，也不创建多份预算。重载释放旧订阅和子进程资源。未勾选的入口不注册工具／指导。**没有插件自己的 `modules` 开关**。

## 配置

配置目录为 `~/.pi/agent/pi-dag-workflow/`，遵循 Pi 的 `PI_CODING_AGENT_DIR` 和 `~` 展开。配置不是另一份任务状态库。

### `pi-dag-workflow-config.json`

可选，只设置续跑限制；模块开关用 `pi config`，不在此文件控制。修改后 `/reload`。

```json
{
  "goalMaxTurns": 20,
  "goalNoProgressLimit": 3
}
```

曾使用旧版 `modules` 字段时请删除它；Goal 会报配置错误，不悄悄保留第二套开关。

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

测试使用隔离 Pi 0.99.2 会话和原生包资源过滤。工具提供命名空间／按需指导与操作提示，支持原生 codemode；嵌套调用仍经过 Plan 限制。工具默认直接可用，不替你启用 codemode 或选择模型。真实验收需要已配置 `example-model`，会消耗额度。tmux 测试按当前要求暂停，不属于默认检查。

```text
src/
  workflow/      共享会话状态、运行时协调与绘制生命周期
  todos/         Todo 状态、工具与命令
  plan/          规划命令与只读限制
  agents/        子进程、消息、Profile 与用量
  goal/          Goal 状态、注意力与共享续跑预算
  dag/           图校验、临时缓存与实线路由
  ui/            主题绘制与滚动
  shared/        配置路径与模块选择
```
