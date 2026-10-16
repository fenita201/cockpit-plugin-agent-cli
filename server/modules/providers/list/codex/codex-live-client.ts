import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import type { AnyRecord } from '@/shared/index.js';

/** Used by the Codex runtime to stream notifications and answer server requests over stdio. */
export class CodexLiveClient {
  private child;
  private reader;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: AnyRecord): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private failure: Error | null = null;
  private stderr = '';

  constructor(onMessage: (message: AnyRecord) => void, onFailure: (error: Error) => void) {
    const launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    this.child = spawn(process.execPath, [launcher, 'app-server'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on('line', (line) => {
      let message: AnyRecord;
      try { message = JSON.parse(line); } catch { return; }
      // Server requests also carry ids. Dispatch those before matching replies.
      if (message.method) { onMessage(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed'));
      else pending.resolve(message.result ?? {});
    });
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      onFailure(error);
    };
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + String(chunk)).slice(-2000); });
    this.child.on('error', fail);
    this.child.on('close', (code) => fail(new Error(`Codex app-server exited (${code}): ${this.stderr.trim()}`)));
    this.child.stdin.on('error', fail);
    this.child.stdout.on('error', fail);
  }

  call(method: string, params: AnyRecord): Promise<AnyRecord> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method} within 30 seconds`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  write(message: AnyRecord): void {
    if (!this.failure) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.reader.close();
    this.child.kill();
    // A stuck child must not survive a stopped conversation indefinitely.
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    timer.unref();
    this.child.once('close', () => clearTimeout(timer));
  }
}
