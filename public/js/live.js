// Invalidation notices never contain messages and never trigger a mutation or send.
export function createLiveUpdates({ refresh, canRefresh, EventSourceImpl = globalThis.EventSource, delayMs = 120 }) {
  let source = null, timer = null, dirty = false, running = false, stopped = true, connected = false, failures = 0;
  const schedule = (delay = delayMs) => {
    if (!stopped && timer === null) timer = setTimeout(flush, delay);
  };
  async function flush() {
    timer = null;
    if (stopped || !dirty || running) return;
    if (!canRefresh()) { schedule(1000); return; }
    running = true; dirty = false;
    try { await refresh(); failures = 0; }
    catch { dirty = true; failures++; }
    finally { running = false; if (dirty) schedule(failures ? Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)) : delayMs); }
  }
  const invalidate = () => { dirty = true; schedule(); };
  return {
    get connected() { return connected; },
    invalidate,
    start() {
      if (source || !EventSourceImpl) return;
      stopped = false;
      const current = source = new EventSourceImpl('/api/events');
      current.addEventListener('connected', () => { if (source !== current) return; connected = true; invalidate(); });
      current.addEventListener('invalidate', () => { if (source === current) invalidate(); });
      current.addEventListener('error', () => { if (source === current) connected = false; });
    },
    stop() {
      stopped = true; connected = false; source?.close(); source = null;
      clearTimeout(timer); timer = null;
    },
  };
}
