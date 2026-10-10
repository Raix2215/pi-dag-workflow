import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";

/** Deterministic test provider, not a real language model. No network or credentials. */
export default function offlineModel(pi: ExtensionAPI): void {
  let sequence = 0;
  let flaky = 0;
  let pressureTurns = 0;
  let overflowed = false;
  const overflowRounds = new Set<number>();
  let plainGoalPhase = 0;
  pi.registerFlag('dag-test-plain-goal', { type: 'boolean', description: 'Offline test: finish a Todo then continue the unfinished Goal without a nextStep' });
  pi.registerFlag('dag-test-compaction-pressure', { type: 'boolean', description: 'Offline test-only context pressure on the first Goal turn' });
  pi.registerFlag('dag-test-overflow', { type: 'boolean', description: 'Offline test-only one context overflow on a Goal request' });
  pi.registerFlag('dag-test-repeated-overflow', { type: 'boolean', description: 'Offline test-only context overflow on three separate Goal continuation rounds' });
  pi.registerFlag('dag-test-context-metrics', { type: 'boolean', description: 'Offline test-only size measurements of the provider-facing context' });
  pi.registerFlag('dag-test-context-export', { type: 'boolean', description: 'Offline test-only full normalized context and provider output in non-model custom entries' });
  pi.registerFlag('dag-test-important-progress', { type: 'boolean', description: 'Offline controlled workload: write every Goal round, update only verified milestone rounds' });
  let contextExportSequence = 0;
  const prefix = Date.now();
  pi.registerProvider("dag-test", {
    api: "dag-test-api", baseUrl: "http://offline.invalid", apiKey: "offline-test-only",
    models: ['scripted', 'reasoned'].map((id) => ({ id, name: 'Offline scripted test (no LLM)', reasoning: id === 'reasoned', input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 4096 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [], timestamp: Date.now(), stopReason: "pending",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        try {
          const childLog = process.env.PI_DAG_CHILD === '1' ? process.env.PI_DAG_TEST_CHILD_CONTEXT_LOG : undefined;
          if (childLog) {
            const requestId = `${process.pid}-${prefix}-${++contextExportSequence}`;
            const exportRecord = (value: unknown) => { try { appendFileSync(childLog, JSON.stringify(value) + '\n'); } catch { /* Test telemetry cannot change provider behavior. */ } };
            exportRecord({ type: 'input', requestId, context });
            void stream.result().then((result) => exportRecord({ type: 'output', requestId, message: result })).catch(() => {});
          }
          if (pi.getFlag('dag-test-context-export') === true) {
            const requestId = `${prefix}-${++contextExportSequence}`;
            // Snapshot before the stream runs: these custom entries never enter model context.
            pi.appendEntry('dag-test.context-export', { requestId, provider: model.provider, model: model.id, context: JSON.parse(JSON.stringify(context)) });
            // result() observes completion without consuming or changing the event iterator,
            // and also captures native compaction calls that have no message_end event.
            void stream.result().then((result) => {
              pi.appendEntry('dag-test.output-export', { requestId, message: JSON.parse(JSON.stringify(result)) });
            }).catch(() => { /* Export instrumentation must not change scripted model behavior. */ });
          }
          if (pi.getFlag('dag-test-context-metrics') === true) {
            const markers = ['Execute concrete actions; preserve the requested end state', 'Preserve the full original objective'];
            const executionRules = (text: string) => markers.reduce((sum, marker) => sum + text.split(marker).length - 1, 0);
            const messages = context.messages.map((item) => {
              const text = typeof item.content === 'string' ? item.content : item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
              const sections = 'sections' in item ? Object.values(item.sections ?? {}).filter((value) => typeof value === 'string').join('\n') : '';
              return { role: item.role, ...('toolName' in item ? { toolName: item.toolName } : {}), textChars: text.length, textBytes: Buffer.byteLength(text), executionRules: executionRules(text), sectionExecutionRules: executionRules(sections), sectionsBytes: Buffer.byteLength(sections), compactWakeRules: text.split('Progress/nextStep are notes, not authority to narrow it.').length - 1, ...('toolsAdded' in item ? { toolsAddedBytes: Buffer.byteLength(JSON.stringify(item.toolsAdded) ?? '') } : {}), ...('details' in item ? { detailsBytes: Buffer.byteLength(JSON.stringify(item.details) ?? '') } : {}) };
            });
            pi.appendEntry('dag-test.context-metrics', { systemBytes: messages.filter((item) => item.role === 'system').reduce((sum, item) => sum + item.textBytes + item.sectionsBytes, 0), toolsBytes: messages.reduce((sum, item) => sum + (item.toolsAddedBytes ?? 0), 0), contextBytes: Buffer.byteLength(JSON.stringify(context)), messages });
          }
          await options?.onPayload?.({ testOnly: true }, model);
          if (options?.signal?.aborted) throw new Error("aborted");
          stream.push({ type: "start", partial: message });
          // Workflow metadata is also converted to user-role text. Scripted test commands stay
          // tied to the real input, while production models read both the input and checkpoint.
          const relevant = context.messages.filter((item) => {
            if (item.role !== 'user') return true;
            const text = typeof item.content === 'string' ? item.content : item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
            return !['Workflow state checkpoint', 'Goal state checkpoint', 'Goal contract (', 'No active Goal. Do not continue automatically.', 'Plan: read/search/ask', 'Normal:', 'Available Todo presets (', 'No Todo presets are available.', 'Profile and fragment guidance for this child run.'].some((prefix) => text.startsWith(prefix)) && !/^Goal #\d+ paused/.test(text);
          });
          const last = relevant.at(-1);
          const latestUser = relevant.findLast((item) => item.role === "user");
          const rawPrompt = latestUser?.role === "user" ? typeof latestUser.content === "string" ? latestUser.content : latestUser.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") : "";
          const prompt = rawPrompt.startsWith('Resume attempt from ') && rawPrompt.includes('\nCurrent continuation task:\n') ? rawPrompt.split('\nCurrent continuation task:\n').at(-1)! : rawPrompt;
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
            if (goalWork && prompt.includes('永久故障测试')) throw new Error('429 insufficient_quota: billing limit exhausted');
            if (goalWork && prompt.includes('provider断流测试') && flaky++ === 0) {
              message.stopReason = 'aborted'; message.errorMessage = 'provider stream disconnected';
              stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(); return;
            }
            const round = Number(/^Goal #\d+ (\d+)\//.exec(prompt)?.[1] ?? 0);
            if (goalWork && pi.getFlag('dag-test-repeated-overflow') === true && [1, 3, 5].includes(round) && !overflowRounds.has(round)) {
              overflowRounds.add(round); throw new Error('maximum context length exceeded');
            }
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
            else if (prompt === 'CONTROL LONG CALL') calls.push({ name: 'bash', arguments: { command: 'printf ORIGINAL-STATE > original-state.txt; sleep 45; printf UNEXPECTED > old-completed.txt', timeout: 60 } });
            else if (prompt === 'CONTROL REDIRECT') calls.push({ name: 'read', arguments: { path: 'original-state.txt' } });
            else if (prompt === 'CONTROL OLD QUEUE') calls.push({ name: 'write', arguments: { path: 'old-direction.txt', content: 'UNEXPECTED' } });
            else if (prompt === 'CONTROL QUESTION') calls.push({ name: 'subagent_send', arguments: { message: 'CONTROL decision?', question: true } });
            else if (prompt === 'CONTROL REDIRECT QUESTION') calls.push({ name: 'write', arguments: { path: 'redirect-question.txt', content: 'CONTROL-SELF-DECIDED' } });
            else if (prompt === 'CONTROL REPORT HOLD' || prompt === 'CONTROL FRESH REPORT HOLD') calls.push({ name: 'subagent_send', arguments: { message: prompt === 'CONTROL REPORT HOLD' ? 'CONTROL-PROGRESS' : 'FRESH-CURRENT-PROGRESS' } });
            else if (prompt.startsWith('子 Agent 报告') && prompt.includes('RECOVERY-CHILD-RESULT')) calls.push({ name: 'goal', arguments: { action: 'complete' } });
            else if (goalWork && prompt.includes('出错重试测试') && flaky >= 2) calls.push({ name: 'goal', arguments: { action: 'complete' } });
            else if (goalWork && prompt.includes('provider断流测试')) calls.push({ name: 'goal', arguments: { action: 'complete' } });
            else if (prompt.startsWith('子 Agent 报告') && prompt.includes('M3预算提问') && childRequest) calls.push({ name: 'subagent_send', arguments: { requestId: childRequest[1]!, message: '按指定范围完成' } });
            else if (prompt.startsWith('Goal #') && prompt.includes('空闲续跑测试')) {
              const dispatched = relevant.some((item) => item.role === 'toolResult' && item.toolName === 'subagent_spawn');
              calls.push(dispatched ? { name: 'goal', arguments: { action: 'complete' } } : { name: 'subagent_spawn', arguments: { task: 'HOLD-IDLE-ENABLE-CHILD' } });
            }
            else if (prompt.startsWith('Goal #') && prompt.includes('委派测试')) calls.push({ name: 'subagent_spawn', arguments: { task: 'TEST CALL subagent_send {"message":"M3预算提问","question":true}' } });
            else if (prompt.startsWith('Goal #') && prompt.includes('预算测试')) {
              if (pi.getFlag('dag-test-important-progress') === true) calls.push({ name: 'write', arguments: { path: `round-${round}.txt`, content: `verified-round-${round}` } });
              else calls.push({ name: 'goal', arguments: { action: 'update', progress: `离线预算进展-${sequence}`, nextStep: '预算测试下一步' } });
            }
            else if (prompt.startsWith('Goal #') && prompt.includes('研究测试')) calls.push({ name: 'goal', arguments: { action: 'update', progress: '同一份研究结论', nextStep: '研究测试下一步' } });
            else if (prompt.startsWith('Goal #') && prompt.includes('完成测试')) calls.push({ name: 'goal', arguments: { action: 'complete' } });
            else if (explicit) calls.push({ name: explicit[1]!, arguments: JSON.parse(explicit[2]!) });
            else if (prompt.startsWith('TEST CALLS ')) {
              const batch = JSON.parse(prompt.slice('TEST CALLS '.length));
              if (!Array.isArray(batch) || batch.length > 50) throw new Error('Invalid offline test call batch');
              for (const call of batch) calls.push({ name: call.name, arguments: call.arguments });
            }
            else if (prompt.includes("创建两件待办")) {
              calls.push({ name: "todo", arguments: { action: "create", subject: "检查入口" } }, { name: "todo", arguments: { action: "create", subject: "汇总结果", blockedBy: [1] } });
            } else if (prompt.includes("第一项标为完成")) calls.push({ name: "todo", arguments: { action: "update", id: 1, status: "completed" } });
            else if (prompt.includes("写入测试文件")) calls.push({ name: "write", arguments: { path: "should-not-exist.txt", content: "forbidden" } });
            else if (prompt.includes("查看待办")) calls.push({ name: "todo", arguments: { action: "list" } });
          }
          if (pi.getFlag('dag-test-important-progress') === true && prompt.startsWith('Goal #') && last?.role === 'toolResult' && last.toolName === 'write' && !last.isError) {
            const milestone = Number(/^Goal #\d+ (\d+)\//.exec(prompt)?.[1] ?? 0);
            if (milestone === 1 || milestone % 8 === 0) calls.push({ name: 'goal', arguments: { action: 'update', progress: `Verified milestone ${milestone}: written artifact checked` } });
          }
          if (last?.role === 'toolResult' && (prompt === 'CONTROL REPORT HOLD' || prompt === 'CONTROL FRESH REPORT HOLD') && last.toolName === 'subagent_send') calls.push({ name: 'bash', arguments: { command: 'sleep 45', timeout: 60 } });
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
            const hadOriginal = relevant.some((item) => item.role === 'user' && (typeof item.content === 'string' ? item.content : item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')) === 'CONTROL LONG CALL');
            const text = prompt === 'INHERIT SETTINGS SNAPSHOT' ? JSON.stringify({ model: model.id, thinking: options?.reasoning ?? 'off' }) : prompt === 'CONTROL REDIRECT' ? `CONTROL-REDIRECT-SUCCESS original-context=${hadOriginal}` : prompt === 'CONTROL REDIRECT QUESTION' ? 'CONTROL-QUESTION-REDIRECTED' : last?.role === "toolResult" ? `离线模拟已收到工具结果：${last.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")}` : "离线模拟：仅支持验收用语，不进行真实模型推理。";
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
