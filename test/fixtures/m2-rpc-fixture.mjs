import { spawn } from 'node:child_process';
const emit = record => process.stdout.write(`${JSON.stringify(record)}\n`);
let buffer = '';
let active = false;
let queued = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    const response = data => emit({type:'response', id:command.id, success:true, data});
    if (command.type === process.env.PI_DAG_TEST_FAIL_COMMAND) {
      emit({type:'response',id:command.id,success:false,error:`fixture ${command.type} rejected`}); continue;
    }
    if (command.type === process.env.PI_DAG_TEST_STALL_COMMAND || command.type === 'prompt' && command.message === 'STALL_DIRECTION') {
      emit({type:'tool_execution_start',toolCallId:'stall-command',toolName:`stall:${command.type}`});
      continue;
    }
    if (command.type === 'get_state') response({isStreaming:active,pendingMessageCount:queued,isCompacting:false});
    else if (command.type === 'get_available_thinking_levels') response({levels:['off','low']});
    else if (command.type === 'abort') {
      active = false;
      emit({type:'message_end',message:{role:'assistant',content:[],stopReason:'aborted'}});
      emit({type:'agent_end',messages:[]}); emit({type:'agent_settled'}); response({});
    }
    else if (command.type === 'clear_queue') { queued=0; response({}); }
    else if (command.type === 'prompt') {
      if (command.message === 'LATE_REPORT_DIRECTION') {
        response({disposition:'queued'});
        setTimeout(() => {
          emit({type:'extension_ui_request',method:'notify',message:'pi-dag-child-message:OLD-BATCH-REPORT'});
          emit({type:'tool_execution_start',toolCallId:'old-batch',toolName:'old-batch-seen'});
        }, 20);
        continue;
      }
      if (command.message === 'CONSUME_REPORT_DIRECTION') {
        emit({type:'message_start',message:{role:'user',content:'LATE_REPORT_DIRECTION'}});
        emit({type:'message_start',message:{role:'user',content:'CONSUME_REPORT_DIRECTION'}});
        emit({type:'extension_ui_request',method:'notify',message:'pi-dag-child-message:NEW-BATCH-REPORT'});
        response({disposition:'started'}); continue;
      }
      if (command.message === 'HANDLED') { response({disposition:'handled'}); continue; }
      active = true;
      emit({type:'agent_start'});
      response({disposition:'started'});
      const end = (text, stopReason='stop') => {
        emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason,errorMessage:stopReason==='error'?'fixture model error':undefined}});
        emit({type:'agent_end',messages:[],willRetry:false});
      };
      const settled = () => { active=false; emit({type:'agent_settled'}); };
      if (command.message === 'EXIT') setTimeout(() => process.exit(0), 10);
      else if (command.message === 'HUGE') { end('🦊\u2028\u2029' + 'bounded output '.repeat(12000)); settled(); }
      else if (command.message === 'ERROR') { end('partial retained', 'error'); settled(); }
      else if (command.message === 'INTERIM') {
        end('first agent_end is not completion');
        queued=1;
        emit({type:'agent_settled'}); // defensive check must see queued work
        setTimeout(() => {
          queued=0; emit({type:'agent_start'}); end('followup really finished'); settled();
        }, 150);
      } else if (command.message === 'DESCENDANT') {
        const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
        end(`descendant=${child.pid}`);
      } else if (command.message === 'BAD EVENT') emit({type:'message_end',message:{role:'assistant',content:{invalid:true}}});
      else if (command.message === 'BAD JSON') process.stdout.write('not json\n');
      else if (command.message === 'OVERSIZED') process.stdout.write('x'.repeat(1100000));
      else if (command.message === 'ACTIVITY') {
        emit({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'reason'}});
        emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'result'}});
        emit({type:'tool_execution_start',toolCallId:'one',toolName:'very_long_tool_name'});
        emit({type:'tool_execution_start',toolCallId:'two',toolName:'read'});
        emit({type:'tool_execution_end',toolCallId:'one',toolName:'very_long_tool_name'});
        emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'tool is still active'}});
        setTimeout(()=> { emit({type:'tool_execution_end',toolCallId:'two',toolName:'read'}); end('done'); settled(); }, 100);
      }
      else if (command.message === 'HOLD') { /* deliberately no completion */ }
      else if (command.message.startsWith('ENV:')) { end(`env ${command.message.slice(4)}=${process.env[command.message.slice(4)] ?? ''}`); settled(); }
      else { end(command.message); settled(); }
    } else response({});
  }
});
process.stdin.on('end',()=>process.exit(0));
