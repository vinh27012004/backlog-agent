import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { appendActivityRecords, createEventSanitizer, projectCliActivity } from './cli-activity.mjs';
import { readCliTranscriptView, protocolPrompt, operatorChatPrompt } from './cli-supervisor.mjs';
import { resolveCodexExecutable } from './codex-cli.mjs';
import { createSubagentUsageTracker } from './codex-subagent-usage.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const idOk = id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
// Codex reports null when no tier override applies, which runs at the default tier.
export const serviceTierOf = value => value === null || value === undefined ? 'default' :
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'unknown';
export const agentStatus = status => ({ active:'RUNNING', running:'RUNNING', completed:'COMPLETED',
  errored:'FAILED', failed:'FAILED', shutdown:'STOPPED', interrupted:'STOPPED', idle:'WAITING',
  pendingInit:'WAITING', notLoaded:'UNKNOWN' }[typeof status === 'object' ? status?.type : status] ?? 'UNKNOWN');

// A thread/read response can legitimately be large; one oversized line must not cost the transport.
const MAX_LINE_BYTES = 32 * 1024 * 1024;
// Full thread reads block the event loop while parsing, so they are cached and run one at a time.
const TRANSCRIPT_MAX_AGE_MS = 5_000, TRANSCRIPT_MAX_RETRY_MS = 600_000;

/** Splits a byte stream into lines, scanning each chunk once so a long line stays linear. */
export function createLineFramer(onLine, onOversize, maxBytes = MAX_LINE_BYTES) {
  let parts = [], size = 0, skipping = false;
  const reset = () => { parts = []; size = 0; };
  return chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0, end;
    while ((end = bytes.indexOf(10, start)) >= 0) {
      const piece = bytes.subarray(start, end); start = end + 1;
      if (skipping) { skipping = false; continue; }
      if (size + piece.length > maxBytes) { reset(); onOversize(); continue; }
      const line = parts.length ? Buffer.concat([...parts, piece], size + piece.length) : piece;
      reset(); onLine(line.toString('utf8'));
    }
    if (skipping || start === bytes.length) return;
    const rest = bytes.subarray(start);
    if (size + rest.length > maxBytes) { reset(); skipping = true; onOversize(); return; }
    parts.push(rest); size += rest.length;
  };
}

export function createAppServerSupervisor({ workspace, directory, runtime, save: persist = () => {},
  onSession = () => {}, onExit = () => {}, sessionsDirectory = null }, dependencies = {}) {
  const launch = dependencies.spawn ?? spawn;
  const platform = dependencies.platform ?? process.platform;
  const killProcess = dependencies.kill ?? process.kill.bind(process);
  const now = dependencies.now ?? Date.now;
  // Telemetry is rebuilt from Codex after a restart, so it is coalesced; lifecycle changes save at once.
  let saveTimer = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = null; persist(); };
  const saveSoon = () => { if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; try { persist(); } catch { /* the next save reports it */ } },
      dependencies.saveDelayMs ?? 1_000);
    saveTimer.unref?.(); };
  mkdirSync(directory, { recursive: true });
  runtime.provider = 'codex'; runtime.transport = 'app-server';
  runtime.subagents ??= []; runtime.activityRecords ??= [];
  // A new supervisor cannot own the previous transport. Preserve thread identity,
  // but never treat its persisted running state as a live turn.
  const interrupted = runtime.sessionId || runtime.dispatchUncertain ||
    ['RUNNING', 'STARTING', 'WAITING_APPROVAL'].includes(runtime.status);
  runtime.status = runtime.status === 'STOPPED' ? 'STOPPED' : interrupted ? 'INTERRUPTED' : 'IDLE';
  runtime.pid = null;
  runtime.dispatchUncertain = false;
  runtime.approvals = []; // Request IDs belong to one live transport, never replay them.
  let child = null, boot = null, stopping = false, sequence = 0, clean = createEventSanitizer();
  let turnId = null, dispatching = false, refreshTimer=null, refreshing=false; const completedTurns = new Set();
  const pending = new Map(), approvals = new Map(), streaming = new Map(), transcripts = new Map();
  let threadReads = Promise.resolve();
  const owned = id => id === runtime.sessionId || runtime.subagents.some(agent => agent.sessionId === id);
  // Root thread usage excludes descendants; their own Codex session files carry it.
  const subagentUsage = dependencies.subagentUsage ?? createSubagentUsageTracker({ sessionsDirectory });
  const snapshot = () => ({ ...runtime, transcriptPath: runtime.transcriptPath ?? null,
    subagentUsage: subagentUsage.poll(runtime.sessionId) });
  const send = message => { if (!child?.stdin?.writable) fail('APP_SERVER_DISCONNECTED'); child.stdin.write(JSON.stringify(message) + '\n'); };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('APP_SERVER_TIMEOUT'), { code:'APP_SERVER_TIMEOUT' })); }, 30000);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); } catch(error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const record = (threadId, item) => {
    if (!owned(threadId)) return;
    const path = threadId === runtime.sessionId ? runtime.transcriptPath : join(directory, threadId + '.ndjson');
    appendFileSync(path, JSON.stringify(item) + '\n', { mode: 0o600 });
  };
  const observeSubagentActivity = (item, parentId = runtime.sessionId) => {
    if (!['SubAgentActivity', 'subAgentActivity'].includes(item?.type)) return false;
    const sessionId = item.agent_thread_id ?? item.agentThreadId;
    if (!idOk(sessionId) || sessionId === runtime.sessionId) return true;
    let agent = runtime.subagents.find(value => value.sessionId === sessionId);
    if (!agent) {
      const path = typeof item.agent_path === 'string' ? item.agent_path : item.agentPath;
      agent = { sessionId, parentId, name:typeof path === 'string' ? path.split('/').filter(Boolean).at(-1) : sessionId.slice(0, 8),
        agentPath:path ?? null, status:'WAITING', model:'Unknown', task:'Task details unavailable' };
      runtime.subagents.push(agent);
    }
    const kind = String(item.kind ?? '').toLowerCase();
    agent.status = ({ started:'RUNNING', running:'RUNNING', completed:'WAITING', failed:'FAILED',
      errored:'FAILED', stopped:'STOPPED', shutdown:'STOPPED' })[kind] ?? agent.status;
    agent.updatedAt = new Date().toISOString();
    return true;
  };
  const observeCollabAgentToolCall = (item, parentId = runtime.sessionId) => {
    if (item?.type !== 'collabAgentToolCall') return false;
    for (const sessionId of item.receiverThreadIds ?? []) {
      if (!idOk(sessionId) || sessionId === runtime.sessionId) continue;
      let agent = runtime.subagents.find(value => value.sessionId === sessionId);
      if (!agent) { agent = { sessionId, parentId, name:sessionId.slice(0,8), status:'UNKNOWN' }; runtime.subagents.push(agent); }
      agent.task = clean(item.prompt ?? agent.task ?? '').slice(0, 4000); agent.model = item.model ?? agent.model ?? 'Unknown';
      const status = agentStatus(item.agentsStates?.[sessionId]?.status);
      if (status !== 'UNKNOWN') agent.status = status;
      agent.updatedAt = new Date().toISOString();
    }
    return true;
  };
  const handle = message => {
    if (message.id !== undefined && !message.method) {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(new Error('APP_SERVER_RPC_FAILED'), { code:'APP_SERVER_RPC_FAILED' }));
      else request.resolve(message.result); return;
    }
    const p = message.params ?? {}, method = message.method;
    if (message.id !== undefined && method) {
      if (!owned(p.threadId)) { send({ id:message.id, error:{code:-32602,message:'Unknown match thread'} }); return; }
      const supported = ['item/commandExecution/requestApproval','item/fileChange/requestApproval',
        'item/permissions/requestApproval','mcpServer/elicitation/request','item/tool/requestUserInput'];
      if (!supported.includes(method)) { send({id:message.id,error:{code:-32601,message:'Unsupported server request'}}); return; }
      const key = randomUUID(); approvals.set(key, { id:message.id, method, params:p });
      runtime.approvals.push({ id:key, method, threadId:p.threadId, turnId:p.turnId,
        description:clean(p.reason ?? p.message ?? p.command ?? method), details:clean(p),
        decisions: method.includes('permissions') ? ['accept','decline'] : method.includes('requestUserInput') ? ['respond'] :
          method.includes('elicitation') ? ['accept','decline','cancel'] :
            (p.availableDecisions ?? ['accept','acceptForSession','decline','cancel']).filter(x => typeof x === 'string'),
        createdAt:new Date().toISOString() });
      runtime.status = 'WAITING_APPROVAL'; save(); return;
    }
    if (method === 'serverRequest/resolved') {
      for (const [key, value] of approvals) if (value.id === p.requestId) { approvals.delete(key); runtime.approvals = runtime.approvals.filter(x => x.id !== key); }
      if (!approvals.size && runtime.status === 'WAITING_APPROVAL') runtime.status = turnId ? 'RUNNING' : 'IDLE'; save(); return;
    }
    if (!owned(p.threadId)) return;
    if(method==='model/rerouted' && p.threadId===runtime.sessionId && typeof p.toModel==='string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(p.toModel)){runtime.model=p.toModel;save();return;}
    if(method==='thread/settings/updated' && p.threadId===runtime.sessionId && p.threadSettings){runtime.serviceTier=serviceTierOf(p.threadSettings.serviceTier);save();return;}
    if (method === 'thread/status/changed') {
      const agent = runtime.subagents.find(a => a.sessionId === p.threadId);
      if (agent) { agent.status = agentStatus(p.status); agent.updatedAt = new Date().toISOString(); saveSoon(); } return;
    }
    if(method==='item/agentMessage/delta'){const key=p.threadId+':'+p.itemId;streaming.set(key,{timestamp:new Date().toISOString(),type:'AGENT_MESSAGE_STREAMING',role:'ASSISTANT',text:clean(((streaming.get(key)?.text)||'')+(p.delta||''))});return;}
    if (method === 'item/started' || method === 'item/completed') {
      if(method==='item/completed')streaming.delete(p.threadId+':'+p.item?.id);
      const item = p.item ?? {};
      observeSubagentActivity(item, p.threadId);
      observeCollabAgentToolCall(item, p.threadId);
      const normalized = { type:method.replace('/','.'), threadId:p.threadId, item:{ ...item,
        type:({commandExecution:'command_execution',mcpToolCall:'mcp_tool_call',fileChange:'file_change',agentMessage:'agent_message'})[item.type] ?? item.type,
        aggregated_output:item.aggregatedOutput, exit_code:item.exitCode } };
      const projected = projectCliActivity(normalized, clean);
      const entry = { timestamp:new Date().toISOString(), type:normalized.type.toUpperCase()+':'+normalized.item.type.toUpperCase(),
        role:item.type === 'agentMessage' ? 'ASSISTANT' : projected.detail ? 'TOOL' : 'SYSTEM',
        text:clean(item.type === 'agentMessage' ? item.text : projected.detail ? projected.detail.name+' · '+projected.detail.phase : item.type), detail:projected.detail };
      record(p.threadId, entry);
      runtime.activity = {type:entry.type,observedAt:entry.timestamp,status:method==='item/started'?'IN_PROGRESS':'COMPLETED'};
      runtime.activityRecords = appendActivityRecords(runtime.activityRecords, projected.records); saveSoon();
    }
    if (method === 'thread/tokenUsage/updated') {
      const total=p.tokenUsage?.total;
      if (total) {
        runtime.appServerUsage ??= {};
        const fields={inputTokens:total.inputTokens,cachedInputTokens:total.cachedInputTokens,outputTokens:total.outputTokens,reasoningTokens:total.reasoningOutputTokens};
        if (Object.values(fields).every(n=>Number.isSafeInteger(n)&&n>=0)) {
          const previous=runtime.appServerUsage[p.threadId] ?? (p.threadId===runtime.sessionId ? runtime.tokenUsage : null) ?? {};
          runtime.appServerUsage[p.threadId]=fields;
          // Root rows hold the root thread only; descendant usage comes from subagentUsage.
          if(p.threadId===runtime.sessionId){
            runtime.modelUsage ??= Object.values(previous).some(n=>n>0)?[{model:'Unknown',source:'CLI_OBSERVED',...previous}]:[];
            const delta=Object.fromEntries(Object.keys(fields).map(k=>[k,Math.max(0,fields[k]-(previous[k]??0))]));
            if(Object.values(delta).some(n=>n>0)){const model=runtime.model??'Unknown',serviceTier=runtime.serviceTier??'default';let row=runtime.modelUsage.find(r=>r.model===model&&(r.serviceTier??'default')===serviceTier);if(!row){row={model,serviceTier,source:'CLI_OBSERVED'};runtime.modelUsage.push(row);}for(const k of Object.keys(delta))row[k]=(row[k]??0)+delta[k];}
            runtime.tokenUsage=Object.fromEntries(Object.keys(fields).map(k=>[k,runtime.modelUsage.reduce((sum,row)=>sum+(row[k]??0),0)]));
          }
          saveSoon();
        }
      }
    }
    if(method==='turn/completed' && p.threadId===runtime.sessionId){completedTurns.add(p.turn?.id);turnId=null;runtime.status=p.turn?.status==='failed'?'FAILED':'IDLE';runtime.endedAt=new Date().toISOString();save();onExit({kind:runtime.operationKind,operationId:runtime.operationId,exitCode:runtime.status==='FAILED'?1:0});}
  };
  const startServer = async () => {
    if (boot) return boot;
    boot = (async()=>{
      const args=['app-server','--listen','stdio://'];
      const executable=dependencies.executable ?? runtime.codexExecutable ?? resolveCodexExecutable();
      const windows=platform==='win32';
      const argv=windows?['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/windows-cli-job.ps1',import.meta.url)),
        '-OwnerPid',String(process.pid),'-Launch',Buffer.from(JSON.stringify({executable,cwd:workspace,arguments:args})).toString('base64')]:args;
      runtime.lastExitCode=null;runtime.lastExitSignal=null;runtime.lastStderr=null;
      child=launch(windows?'pwsh.exe':executable,argv,{cwd:workspace,windowsHide:true,shell:false,detached:!windows,stdio:['pipe','pipe','pipe']});
      runtime.pid=child.pid;runtime.containment=windows?'STARTING':'UNAVAILABLE';save();
      let transportLost=false;const lost=({exitCode=null,signal=null,spawnError=null}={})=>{if(transportLost)return;transportLost=true;clearInterval(refreshTimer);refreshTimer=null;runtime.lastExitCode=Number.isInteger(exitCode)?exitCode:null;runtime.lastExitSignal=typeof signal==='string'?signal:null;if(spawnError)runtime.lastStderr=clean(spawnError);if(!stopping){runtime.lastError='APP_SERVER_DISCONNECTED';runtime.lastErrorAt=new Date().toISOString();}for(const req of pending.values()){clearTimeout(req.timer);req.reject(Object.assign(new Error('APP_SERVER_DISCONNECTED'),{code:'APP_SERVER_DISCONNECTED'}))}pending.clear();approvals.clear();runtime.approvals=[];runtime.pid=null;runtime.status=stopping?'STOPPED':'INTERRUPTED';save();child=null;boot=null;if(!stopping&&turnId){turnId=null;onExit({kind:runtime.operationKind,operationId:runtime.operationId,exitCode:1});}};
      child.on('error',error=>lost({spawnError:error?.code??error?.message??'APP_SERVER_SPAWN_FAILED'}));child.on('exit',(exitCode,signal)=>lost({exitCode,signal}));child.stdin.on('error',()=>{runtime.lastError='APP_SERVER_STDIN_FAILED';runtime.lastErrorAt=new Date().toISOString();save()});
      child.stderr.on('data',chunk=>{const text=clean(chunk.toString('utf8')).replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();if(text)runtime.lastStderr=((runtime.lastStderr?runtime.lastStderr+' | ':'')+text).slice(-2000);saveSoon()});
      child.stdout.on('data',createLineFramer(line=>{try{const message=JSON.parse(line);if(message.type==='MTM_CONTAINMENT_READY'){runtime.containment='WINDOWS_JOB_OBJECT';save()}else handle(message)}catch{runtime.lastError='APP_SERVER_EVENT_INVALID';save()}},()=>{runtime.lastError='APP_SERVER_LINE_TOO_LARGE';runtime.lastErrorAt=new Date().toISOString();saveSoon()}));
      refreshTimer=setInterval(async()=>{if(refreshing||!runtime.sessionId)return;refreshing=true;const before=JSON.stringify(runtime.subagents);try{for(const agent of runtime.subagents){if(['COMPLETED','FAILED','STOPPED'].includes(agent.status))continue;const result=await rpc('thread/read',{threadId:agent.sessionId,includeTurns:false}),status=agentStatus(result.thread?.status),model=result.model??result.thread?.model;if(status!=='UNKNOWN')agent.status=status;if(typeof model==='string'&&/^[A-Za-z0-9_.:/-]{1,128}$/.test(model))agent.model=model;}}catch{runtime.lastError='SUBAGENT_REFRESH_UNAVAILABLE';}finally{refreshing=false;if(JSON.stringify(runtime.subagents)!==before)saveSoon();}},5000);refreshTimer.unref?.();
      await rpc('initialize',{clientInfo:{name:'mtm_player',version:'1.0.0'},capabilities:{experimentalApi:true}});send({method:'initialized'});
      if(windows&&runtime.containment!=='WINDOWS_JOB_OBJECT')fail('WINDOWS_JOB_LAUNCH_FAILED');
    })();
    try { await boot; } catch(error){child?.kill();boot=null;throw error}
  };
  return {
    snapshot, reconcile:snapshot,
    async dispatch(operation,frame){
      if(dispatching||turnId||runtime.dispatchUncertain)fail('CLI_ORCHESTRATOR_BUSY');dispatching=true;stopping=false;
      try {
        const message=frame.spawn?.message??frame.followup?.message;if(typeof message!=='string')fail('INVALID_CLI_ORCHESTRATOR_FRAME');clean=createEventSanitizer(message);
        await startServer();
        const selectedModel=frame.spawn?.model??frame.followup?.model;
        if(selectedModel!==undefined && (typeof selectedModel!=='string'||!/^[A-Za-z0-9_.:/-]{1,128}$/.test(selectedModel)))fail('INVALID_ORCHESTRATOR_MODEL');
        const selectedEffort=frame.spawn?.reasoningEffort??frame.followup?.reasoningEffort;
        if(selectedEffort!==undefined&&!['low','medium','high'].includes(selectedEffort))fail('INVALID_REASONING_EFFORT');
        const approvalMode=runtime.approvalMode??'auto_review';
        if(!['auto_review','user'].includes(approvalMode))fail('INVALID_APPROVAL_MODE');
        const config={...(selectedModel?{model:selectedModel}:{}),...(selectedEffort?{config:{model_reasoning_effort:selectedEffort}}:{}),cwd:workspace,approvalPolicy:'on-request',approvalsReviewer:approvalMode,sandbox:'danger-full-access'};
        const result=await rpc(runtime.sessionId?'thread/resume':'thread/start',runtime.sessionId?{...config,threadId:runtime.sessionId,excludeTurns:false}:config);
        if(!idOk(result.thread?.id))fail('INVALID_APP_SERVER_THREAD');
        runtime.sessionId=result.thread.id;runtime.model=typeof result.model==='string'&&/^[A-Za-z0-9_.:/-]{1,128}$/.test(result.model)?result.model:null;runtime.serviceTier=serviceTierOf(result.serviceTier);
        for(const priorTurn of result.thread?.turns??[])for(const priorItem of priorTurn.items??[]){observeSubagentActivity(priorItem,runtime.sessionId);observeCollabAgentToolCall(priorItem,runtime.sessionId);}
        runtime.transcriptPath=join(directory,runtime.sessionId+'.ndjson');onSession(runtime.sessionId);
        runtime.operationId=operation.id;runtime.operationKind=operation.kind;runtime.startedAt=new Date().toISOString();save();
        runtime.dispatchUncertain=true;save();const turn=await rpc('turn/start',{threadId:runtime.sessionId,...(selectedModel?{model:selectedModel}:{}),...(selectedEffort?{effort:selectedEffort}:{}),input:[{type:'text',text:protocolPrompt(frame,operation.kind),text_elements:[]}]});
        turnId=turn.turn?.id;if(!turnId)fail('INVALID_APP_SERVER_TURN');runtime.dispatchUncertain=false;if(completedTurns.has(turnId)){turnId=null;}else{runtime.status=approvals.size?'WAITING_APPROVAL':'RUNNING';}save();
        return {target:frame.spawn?.task_name??frame.followup?.target,sessionId:runtime.sessionId};
      }finally{dispatching=false}
    },
    async chat({id,message}){
      if(dispatching||turnId||runtime.dispatchUncertain)fail('CLI_ORCHESTRATOR_BUSY');
      const prompt=operatorChatPrompt(message);if(typeof id!=='string'||id.length<1||id.length>128)fail('INVALID_ORCHESTRATOR_CHAT_ID');
      if(!runtime.sessionId)fail('ORCHESTRATOR_SESSION_UNAVAILABLE');dispatching=true;stopping=false;
      try{
        clean=createEventSanitizer();await startServer();
        const approvalMode=runtime.approvalMode??'auto_review';if(!['auto_review','user'].includes(approvalMode))fail('INVALID_APPROVAL_MODE');
        const config={cwd:workspace,approvalPolicy:'on-request',approvalsReviewer:approvalMode,sandbox:'danger-full-access',threadId:runtime.sessionId,excludeTurns:false};
        const result=await rpc('thread/resume',config);if(!idOk(result.thread?.id)||result.thread.id!==runtime.sessionId)fail('INVALID_APP_SERVER_THREAD');runtime.serviceTier=serviceTierOf(result.serviceTier);
        runtime.transcriptPath=join(directory,runtime.sessionId+'.ndjson');
        record(runtime.sessionId,{timestamp:new Date().toISOString(),type:'OPERATOR_MESSAGE',role:'USER',text:clean(message.trim())});
        runtime.operationId=id;runtime.operationKind='CHAT';runtime.startedAt=new Date().toISOString();runtime.endedAt=null;save();
        runtime.dispatchUncertain=true;save();const turn=await rpc('turn/start',{threadId:runtime.sessionId,input:[{type:'text',text:prompt,text_elements:[]}]});
        turnId=turn.turn?.id;if(!turnId)fail('INVALID_APP_SERVER_TURN');runtime.dispatchUncertain=false;
        if(completedTurns.has(turnId))turnId=null;else runtime.status=approvals.size?'WAITING_APPROVAL':'RUNNING';save();
        return{status:'CHAT_SENT',messageId:id,sessionId:runtime.sessionId};
      }finally{dispatching=false}
    },
    async decide({id,decision,content}){
      const request=approvals.get(id),view=runtime.approvals.find(x=>x.id===id);if(!request||!view)fail('APPROVAL_EXPIRED');
      if(!view.decisions.includes(decision))fail('INVALID_APPROVAL_DECISION');let result;
      if(request.method.includes('permissions'))result={permissions:decision==='accept'?request.params.permissions:{},scope:'turn'};
      else if(request.method.includes('elicitation'))result={action:decision,content:decision==='accept'?(content??{}):null};
      else if(request.method.includes('requestUserInput'))result={answers:content??{}};
      else result={decision};
      if(request.sent)fail('APPROVAL_ALREADY_SENT');send({id:request.id,result});request.sent=true;view.decisions=[];view.description='Decision sent — waiting for Codex';save();return {status:'APPROVAL_SENT'};
    },
    async transcript(id,{maxAgeMs=TRANSCRIPT_MAX_AGE_MS}={}){
      if(!owned(id))fail('UNKNOWN_AGENT_SESSION');
      if(id===runtime.sessionId){const view=readCliTranscriptView(runtime);return {...view,items:[...(view.items||[]),...[...streaming].filter(([key])=>key.startsWith(id+':')).map(([,item])=>item)].slice(-200)};}
      const agent=runtime.subagents.find(a=>a.sessionId===id),at=now();
      let entry=transcripts.get(id);
      // A follow-up can run and return to the same status between reads; updatedAt still moves.
      if(entry?.view&&entry.status===agent.status&&entry.updatedAt===agent.updatedAt&&(!['RUNNING','UNKNOWN'].includes(agent.status)||at-entry.readAt<maxAgeMs))return entry.view;
      if(entry?.reading)return entry.reading;
      if(entry?.retryAt>at){if(entry.view)return entry.view;fail('TRANSCRIPT_TEMPORARILY_UNAVAILABLE');}
      if(!entry){entry={failures:0,retryAt:0};transcripts.set(id,entry);}
      const current=entry,updatedAt=agent.updatedAt;
      current.reading=(async()=>{
        try{
          const read=threadReads.then(()=>rpc('thread/read',{threadId:id,includeTurns:true}));threadReads=read.catch(()=>{});
          const result=await read;
          const items=[];for(const turn of result.thread?.turns??[])for(const item of turn.items??[]){if(item.type==='agentMessage')items.push({timestamp:null,type:'AGENT_MESSAGE',role:'ASSISTANT',text:clean(item.text)})}
          const status=agentStatus(result.thread?.status),model=result.model??result.thread?.model,before=agent.status+agent.model;
          if(status!=='UNKNOWN')agent.status=status;if(typeof model==='string'&&/^[A-Za-z0-9_.:/-]{1,128}$/.test(model))agent.model=model;
          if(agent.status+agent.model!==before)saveSoon();
          Object.assign(current,{view:{status:'READY',items:items.slice(-200)},status:agent.status,updatedAt,readAt:now(),failures:0,retryAt:0});
          return current.view;
        }catch(error){
          // A disconnect is not caused by the read; a timeout or oversized reply would repeat, so it backs off.
          if(error.code!=='APP_SERVER_DISCONNECTED'){current.failures++;current.retryAt=now()+Math.min(TRANSCRIPT_MAX_RETRY_MS,30_000*2**(current.failures-1));}
          if(current.view)return current.view;throw error;
        }finally{current.reading=null;}
      })();
      return current.reading;
    },
    async stop(){stopping=true;clearInterval(refreshTimer);refreshTimer=null;if(child){if(turnId)try{await rpc('turn/interrupt',{threadId:runtime.sessionId,turnId})}catch{};
      const pid=child.pid;
      if(platform==='win32')await new Promise((resolve,reject)=>{const killer=launch('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',reject);killer.on('exit',code=>code===0?resolve():reject(new Error('APP_SERVER_STOP_FAILED')))});
      else { try { killProcess(-pid,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH')throw error; } }
      }
      turnId=null;runtime.dispatchUncertain=false;runtime.status='STOPPED';runtime.pid=null;runtime.approvals=[];approvals.clear();for(const agent of runtime.subagents)if(!['COMPLETED','FAILED'].includes(agent.status))agent.status='STOPPED';save();return {treeStopped:true};}
  };
}
