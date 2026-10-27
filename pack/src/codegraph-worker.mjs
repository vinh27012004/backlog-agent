// Tiến trình con của tool code_graph (codegraph.mjs): giữ engine của 2 app root dùng gần nhất, trả lời qua IPC.
// Không ghi stdout (helper bỏ qua nó); lỗi trả về theo mã như tool khác.
import { openEngine, runQuery } from './codegraph.mjs';

const engines = new Map();

process.on('message', ({ id, target, args }) => {
  try {
    let engine = engines.get(target.appRoot);
    if (engine) engines.delete(target.appRoot); else engine = openEngine(target.appRoot);
    engines.set(target.appRoot, engine);
    while (engines.size > 2) engines.delete(engines.keys().next().value);
    process.send({ id, result: runQuery(engine, target.base, args) });
  } catch (error) {
    process.send({ id, error: { code: error?.code ?? 'CODEGRAPH_FAILED', detail: error?.detail ?? String(error?.message ?? error).slice(0, 400) } });
  }
});
process.on('disconnect', () => process.exit(0));
