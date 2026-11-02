// Above the largest match observed (about 1,070 rows), so a whole match normally stays visible.
export const ACTIVITY_RECORD_LIMIT = 1500;
// A row can hold 12,000 characters; long rows must not outgrow the state file or the snapshot limit.
export const ACTIVITY_RECORD_CHARS = 2 * 1024 * 1024;

export function appendActivityRecords(existing, added) {
  const merged = [...existing];
  for (const { itemId, ...row } of added) {
    if (itemId === undefined || row.phase === 'STARTED') { merged.push(itemId === undefined ? row : { ...row, itemId }); continue; }
    // One row per item: the finished row takes the started row's place and keeps its start time.
    const index = merged.findLastIndex(other => other.itemId === itemId && other.phase === 'STARTED' &&
      other.category === row.category && other.path === row.path);
    if (index < 0) merged.push(row);
    else merged[index] = { ...row, startedAt: merged[index].timestamp };
  }
  const records = merged.slice(-ACTIVITY_RECORD_LIMIT);
  let chars = 0, first = records.length;
  while (first > 0) {
    const row = records[first - 1];
    chars += (row.summary?.length ?? 0) + (row.path?.length ?? 0);
    if (chars > ACTIVITY_RECORD_CHARS) break;
    first -= 1;
  }
  return first ? records.slice(first) : records;
}

// Provider events are evidence, not an operating-system audit of every action.
export function createEventSanitizer(protocol = '') {
  const secrets = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/secret|password|token|authorization|api.?key|cookie/i.test(key) && typeof item === 'string' && item.length >= 4) secrets.add(item);
      else if (typeof item === 'object') visit(item);
    }
  };
  try { visit(JSON.parse(protocol.slice(protocol.indexOf('{')))); } catch {}
  const clean = value => {
    let text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    for (const secret of secrets) {
      for (const variant of [secret, JSON.stringify(secret).slice(1,-1), encodeURIComponent(secret)]) text = text.split(variant).join('[REDACTED]');
    }
    // Only the first 12000 characters survive, so the patterns need not scan an unbounded input.
    return text.slice(0, 65536).replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:ghp|github_pat|gm_live|gm_player|gm_team)_[A-Za-z0-9_\-^\\]+/g, '[REDACTED]')
      .replace(/(["']?(?:password|secret|token|authorization|apiKeySecret|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
      // Any URL scheme can carry user:password, including database connection strings.
      .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]*:[^\s/@]+@/gi, '$1[REDACTED]@')
      .slice(0, 12000);
  };
  return clean;
}

export function projectCliActivity(event, clean = createEventSanitizer()) {
  const item = event.item ?? {};
  const phase = item.status === 'failed' || event.type === 'turn.failed' ? 'FAILED' :
    event.type?.endsWith('.started') ? 'STARTED' : event.type?.endsWith('.completed') ? 'COMPLETED' : 'OBSERVED';
  const timestamp = new Date().toISOString();
  const source = 'CLI_OBSERVED';
  const records = [];
  // Item ids repeat across threads, so a thread's id is part of the key when the provider reports one.
  const itemId = item.id === undefined || item.id === null ? undefined : [event.threadId, item.id].filter(Boolean).join(':');
  const add = (category, fields) => records.push({ category, timestamp, source, phase, ...(itemId === undefined ? {} : { itemId }), ...fields });
  let detail = null;
  if (['command_execution','mcp_tool_call'].includes(item.type)) {
    const toolName = item.type === 'command_execution' ? 'shell' : clean([item.server,item.tool].filter(Boolean).join('/'));
    detail = { name: toolName, phase, input: clean(item.command ?? item.arguments ?? {}),
      output: clean(item.aggregated_output ?? item.result ?? item.error ?? ''), exitCode: item.exit_code ?? null };
    add('tool', { toolName, operation: item.type, summary: detail.input });
  }
  if (item.type === 'file_change') {
    for (const change of (Array.isArray(item.changes) ? item.changes : []).slice(0,100)) {
      add('filesystem', { path: clean(change.path), access: 'WRITE', operation: clean(change.kind ?? 'CHANGE'), summary: 'File change reported by CLI; reads are not monitored.' });
    }
  }
  if (event.type === 'thread.started' || event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'turn.failed') {
    add('agent', { agentId: 'team_orchestrator', parentAgentId: null, operation: event.type, summary: event.type });
  }
  // Only explicit HTTP telemetry is counted as network evidence. A URL in a
  // command or tool argument does not prove that a request happened.
  const telemetry = (item.result?.structuredContent ?? item.result?.structured_content)?.networkActivity;
  for (const entry of (Array.isArray(telemetry) ? telemetry : []).slice(0,100)) {
    try {
      const url = new URL(entry.url);
      if (!['http:','https:'].includes(url.protocol) || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(entry.method)) continue;
      add('network', { source: 'MCP_REPORTED', operation: 'HTTP', method: entry.method,
        origin: url.origin, path: clean(url.pathname), httpStatus: Number.isInteger(entry.httpStatus) ? entry.httpStatus : null,
        summary: 'Explicit MCP HTTP telemetry.' });
    } catch {}
  }
  return { records, detail };
}
