// Hàng đợi sự kiện cho wait_for_update (05 §5.15), có cursor để root không bỏ lỡ sự kiện.
export class EventQueue {
  constructor() {
    this.events = [];
    this.seq = 0;
    this.waiters = new Set();
  }

  push(type, data = {}) {
    // seq/type/at đặt sau data: data không được ghi đè loại sự kiện (ITEM_NEW từng mang `type` của item).
    const event = { ...data, seq: ++this.seq, type, at: new Date().toISOString() };
    this.events.push(event);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    for (const wake of this.waiters) wake();
    return event;
  }

  since(cursor) { return this.events.filter(e => e.seq > cursor); }

  async wait(cursor, timeoutMs, signal) {
    if (this.since(cursor).length || signal?.aborted) return this.since(cursor);
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    return this.since(cursor);
  }
}
