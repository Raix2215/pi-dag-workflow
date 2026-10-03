import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";

/** Deterministic test provider, not a real language model. No network or credentials. */
export default function offlineModel(pi: ExtensionAPI): void {
  let sequence = 0;
  let flaky = 0;
  let pressureTurns = 0;
  let overflowed = false;
  let plainGoalPhase = 0;
  pi.registerFlag('dag-test-plain-goal', { type: 'boolean', description: 'Offline test: finish a Todo then continue the unfinished Goal without a nextStep' });
  pi.registerFlag('dag-test-compaction-pressure', { type: 'boolean', description: 'Offline test-only context pressure on the first Goal turn' });
  pi.registerFlag('dag-test-overflow', { type: 'boolean', description: 'Offline test-only one context overflow on a Goal request' });
  const prefix = Date.now();
  pi.registerProvider("dag-test", {
    api: "dag-test-api", baseUrl: "http://offline.invalid", apiKey: "offline-test-only",
    models: [{ id: "scripted", name: "Offline scripted test (no LLM)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [], timestamp: Date.now(), stopReason: "pending",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        try {
          await options?.onPayload?.({ testOnly: true }, model);
          if (options?.signal?.aborted) throw new Error("aborted");
          stream.push({ type: "start", partial: message });
          // Workflow metadata is also converted to user-role text. Scripted test commands stay
          // tied to the real input, while production models read both the input and checkpoint.
          const relevant = context.messages.filter((item) => {
            if (item.role !== 'user') return true;
            const text = typeof item.content === 'string' ? item.content : item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
            return !text.startsWith('Workflow state checkpoint');
          });
          const last = relevant.at(-1);
          const latestUser = relevant.findLast((item) => item.role === "user");
          const prompt = latestUser?.role === "user" ? typeof latestUser.content === "string" ? latestUser.content : latestUser.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") : "";
          const calls: { name: string; arguments: ToolCall["arguments"] }[] = [];
          if (last?.role !== "toolResult") {
            if (prompt === 'HOLD-IDLE-ENABLE-CHILD') {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, 10000);
                options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
              });
            }
            if (prompt.startsWith('Goal #') && prompt.includes('中断测试')) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, 2000);
                options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
              });
            }
            const explicit = /^TEST CALL (\w+) (\{[\s\S]*\})$/.exec(prompt);
            // Goal error-recovery tests: one Goal fails the first two requests, another fails until
            // its retry budget is spent. Only Goal turns fail; the test's own tool calls stay intact.
            const goalWork = prompt.startsWith('Goal #') || prompt.includes('自动重试');
            if (goalWork && pi.getFlag('dag-test-overflow') === true && !overflowed) {
              overflowed = true; throw new Error('maximum context length exceeded');
            }
            if (prompt === '报告重试触发失败' && flaky < 1) { flaky++; throw new Error('scripted provider failure (500)'); }
            if (goalWork && prompt.includes('出错重试测试') && flaky < 2) { flaky++; throw new Error(flaky === 1 ? 'scripted provider failure (500)' : 'scripted provider failure (503 auth_unavailable)'); }
            if (goalWork && prompt.includes('出错暂停测试')) throw new Error('scripted provider failure (500)');
            const childRequest = /requestId=([^\]]+)/.exec(prompt);
            if (goalWork && pi.getFlag('dag-test-plain-goal') === true && plainGoalPhase < 2) {
              calls.push(plainGoalPhase === 0 ? { name: 'todo', arguments: { action: 'update', id: 1, status: 'completed' } } : { name: 'goal', arguments: { action: 'get', id: 1 } });
              plainGoalPhase++;
            }
            else if (prompt.startsWith('子 Agent 报告') && prompt.includes('RECOVERY-CHILD-RESULT')) calls.push({ name: 'goal', arguments: { action: 'complete' } });
            else if (goalWork && prompt.includes('出错重试测试') && flaky >= 2) calls.push({ name: 'goal', arguments: { action: 'complete' } });
            else if (prompt.startsWith('子 Agent 报告') && prompt.includes('M3预算提问') && childRequest) calls.push({ name: 'subagent_send', arguments: { requestId: childRequest[1]!, message: '按指定范围完成' } });
            else if (prompt.startsWith('Goal #') && prompt.includes('空闲续跑测试')) {
              const dispatched = relevant.some((item) => item.role === 'toolResult' && item.toolName === 'subagent_spawn');
              calls.push(dispatched ? { name: 'goal', arguments: { action: 'complete' } } : { name: 'subagent_spawn', arguments: { task: 'HOLD-IDLE-ENABLE-CHILD' } });
            }
            else if (prompt.startsWith('Goal #') && prompt.includes('委派测试')) calls.push({ name: 'subagent_spawn', arguments: { task: 'TEST CALL subagent_send {"message":"M3预算提问","question":true}' } });
            else if (prompt.startsWith('Goal #') && prompt.includes('预算测试')) calls.push({ name: 'goal', arguments: { action: 'update', progress: `离线预算进展-${sequence}`, nextStep: '预算测试下一步' } });
            else if (prompt.startsWith('Goal #') && prompt.includes('研究测试')) calls.push({ name: 'goal', arguments: { action: 'update', progress: '同一份研究结论', nextStep: '研究测试下一步' } });
            else if (prompt.startsWith('Goal #') && prompt.includes('完成测试')) calls.push({ name: 'goal', arguments: { action: 'complete' } });
            else if (explicit) calls.push({ name: explicit[1]!, arguments: JSON.parse(explicit[2]!) });
            else if (prompt.includes("创建两件待办")) {
              calls.push({ name: "todo", arguments: { action: "create", subject: "检查入口" } }, { name: "todo", arguments: { action: "create", subject: "汇总结果", blockedBy: [1] } });
            } else if (prompt.includes("第一项标为完成")) calls.push({ name: "todo", arguments: { action: "update", id: 1, status: "completed" } });
            else if (prompt.includes("写入测试文件")) calls.push({ name: "write", arguments: { path: "should-not-exist.txt", content: "forbidden" } });
            else if (prompt.includes("查看待办")) calls.push({ name: "todo", arguments: { action: "list" } });
          }
          if (last?.role === 'toolResult' && pi.getFlag('dag-test-plain-goal') === true) {
            if (plainGoalPhase === 2 && last.toolName === 'goal') { calls.push({ name: 'write', arguments: { path: 'objective-evidence.txt', content: 'GOAL-CONTINUED\n' } }); plainGoalPhase++; }
            else if (plainGoalPhase === 3 && last.toolName === 'write') { calls.push({ name: 'goal', arguments: { action: 'complete', id: 1 } }); plainGoalPhase++; }
          }
          for (const requested of calls) {
            const index = message.content.length;
            const call: ToolCall = { type: "toolCall", id: `dag-test-${prefix}-${++sequence}`, name: requested.name, arguments: {} };
            message.content.push(call);
            stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
            call.arguments = requested.arguments;
            stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: message });
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
          }
          if (!calls.length) {
            message.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            const text = last?.role === "toolResult" ? `离线模拟已收到工具结果：${last.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")}` : "离线模拟：仅支持验收用语，不进行真实模型推理。";
            message.content[0] = { type: "text", text };
            stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          }
          if (pi.getFlag('dag-test-compaction-pressure') === true && prompt.startsWith('Goal #') && last?.role === 'toolResult' && pressureTurns++ < 1) {
            message.usage.input = 60000; message.usage.totalTokens = 60000;
          }
          message.stopReason = calls.length ? "toolUse" : "stop";
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message });
          stream.end();
        }
      });
      return stream;
    },
  });
}
