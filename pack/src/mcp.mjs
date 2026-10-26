// Server MCP tối thiểu qua stdio (05 §3): mỗi message một dòng JSON-RPC 2.0, stdout chỉ chứa JSON-RPC.
import { callTool } from './tools.mjs';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function createServer(runtime, { write, version = '0.1.0' }) {
  const tools = runtime.definitions();
  const byName = new Map(tools.map(t => [t.name, t]));
  const pending = new Map();      // id → AbortController (cho notifications/cancelled)
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (message && Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) return;   // response của client
      return error(message?.id ?? null, -32600, 'Invalid request');
    }
    const { id, method, params } = message;
    const isNotification = !Object.hasOwn(message, 'id');
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply(id, { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'team_runtime', version } });
      }
      case 'notifications/initialized': return undefined;
      case 'notifications/cancelled': pending.get(params?.requestId)?.abort(); return undefined;
      case 'ping': return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: Boolean(t.readOnly), openWorldHint: false } })) });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return error(id, -32602, `Unknown tool ${params?.name}`);
        const controller = new AbortController();
        pending.set(id, controller);
        try {
          const result = await callTool(runtime, tool, params?.arguments, { signal: controller.signal });
          return reply(id, result);
        } finally {
          pending.delete(id);
        }
      }
      default:
        if (isNotification) return undefined;
        return error(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    // Nhận một dòng text; JSON hỏng → -32700.
    async line(text) {
      if (!text.trim()) return;
      let message;
      try { message = JSON.parse(text); } catch { return error(null, -32700, 'Parse error'); }
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) return error(message?.id ?? null, -32600, 'Request too large');
      return handle(message);
    }
  };
}
