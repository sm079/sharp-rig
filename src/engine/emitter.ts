// Minimal typed event emitter. `on` returns an unsubscribe function so UIs can tear down cleanly.

export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(event: K, ...[payload]: Events[K] extends void ? [] : [Events[K]]) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: Events[K] | undefined) => void)(payload);
      } catch (e) {
        console.error(`[studio] "${String(event)}" handler failed`, e);
      }
    }
  }
}
