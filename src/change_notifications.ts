import { randomUUID } from 'node:crypto';

/** Ephemeral account-scoped invalidation only; no note data or database polling. */
export class ChangeNotifications {
  private readonly epoch = randomUUID();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private pending = 0;

  cursor(owner: string): string { return `${this.epoch}:${this.versions.get(owner) ?? 0}`; }
  publish(owner: string): void {
    this.versions.set(owner, (this.versions.get(owner) ?? 0) + 1);
    for (const done of [...(this.listeners.get(owner) ?? [])]) done();
  }
  wait(owner: string, since: string, milliseconds: number, signal: AbortSignal): Promise<void> {
    if (since !== this.cursor(owner) || signal.aborted) return Promise.resolve();
    const listeners = this.listeners.get(owner) ?? new Set<() => void>();
    if (listeners.size >= 32 || this.pending >= 2048) {
      return Promise.reject(Object.assign(new Error('Too many change listeners'), {statusCode: 429}));
    }
    return new Promise(resolve => {
      const done = () => {
        if (!listeners.delete(done)) return;
        this.pending--;
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        if (listeners.size === 0) this.listeners.delete(owner);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      listeners.add(done);
      this.listeners.set(owner, listeners);
      this.pending++;
      signal.addEventListener('abort', done, {once: true});
    });
  }
  close(): void {
    for (const listeners of [...this.listeners.values()]) {
      for (const done of [...listeners]) done();
    }
  }
}
