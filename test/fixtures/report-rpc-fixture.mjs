// Test-only RPC child that speaks the protocol without a provider or network.
// It lets tests verify that whole (multi-megabyte) reports survive the pipe.
const emit = record => process.stdout.write(`${JSON.stringify(record)}\n`);
let buffer = '';
let active = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    const response = data => emit({ type: 'response', id: command.id, success: true, data });
    if (command.type === 'get_state') response({ isStreaming: active, pendingMessageCount: 0, isCompacting: false });
    else if (command.type === 'get_available_thinking_levels') response({ levels: ['off', 'low'] });
    else if (command.type === 'prompt') {
      active = true;
      emit({ type: 'agent_start' });
      response({ disposition: 'started' });
      const end = text => {
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
        emit({ type: 'agent_end', messages: [], willRetry: false });
      };
      const settled = () => { active = false; emit({ type: 'agent_settled' }); };
      if (command.message === 'REPORT') {
        emit({ type: 'extension_ui_request', id: 'report-1', method: 'notify', message: 'pi-dag-child-message:' + 'r'.repeat(60000) });
        end('report delivered'); settled();
      } else if (command.message === 'BIGREPORT') {
        emit({ type: 'extension_ui_request', id: 'report-1', method: 'notify', message: 'pi-dag-child-message:' + 'r'.repeat(1100000) });
        end('report delivered'); settled();
      } else if (command.message === 'BIGOUTPUT') {
        end('o'.repeat(1100000)); settled();
      } else if (command.message === 'BIGQUESTION') {
        emit({ type: 'extension_ui_request', id: 'q-1', method: 'input', title: 'pi-dag-child-question:' + 'q'.repeat(1100000) });
      } else { end(command.message); settled(); }
    } else if (command.type === 'extension_ui_response') {
      const answer = String(command.value ?? '');
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `answered:${answer.length}` }], stopReason: 'stop' } });
      emit({ type: 'agent_end', messages: [], willRetry: false });
      active = false; emit({ type: 'agent_settled' });
    } else response({});
  }
});
process.stdin.on('end', () => process.exit(0));
