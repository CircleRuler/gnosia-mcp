import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config.js';

const SYSTEM_ROOT = process.env.SystemRoot || String.raw`C:\Windows`;
const WINDOWS_POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

export interface HostResponse<T = Record<string, unknown>> {
  ok: boolean;
  result?: T;
  error?: string;
}

/**
 * Long-lived Windows PowerShell worker that owns the GDI/SendInput handles.
 * Keeping it resident makes capture+input round trips ~10-60ms instead of the
 * ~700ms a cold PowerShell start would cost on every call.
 */
export class GameHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starting: Promise<void> | null = null;
  private stderrTail: string[] = [];
  private startingSince = 0;

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  get diagnostics(): Record<string, unknown> {
    return {
      host_pid: this.pid,
      host_alive: this.alive,
      pending_calls: this.pending.size,
      startup_ms: this.startingSince ? Date.now() - this.startingSince : 0,
      stderr_tail: this.stderrTail.slice(-6)
    };
  }

  async ensure(): Promise<void> {
    if (this.alive) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<void> {
    const cfg = loadConfig();
    if (process.platform !== 'win32') {
      throw new Error('gnosia-mcp only runs on Windows: it drives the game through Win32 capture and SendInput.');
    }
    if (!fs.existsSync(cfg.hostScript)) throw new Error(`Host script missing: ${cfg.hostScript}`);
    if (!fs.existsSync(WINDOWS_POWERSHELL)) throw new Error(`Windows PowerShell not found at ${WINDOWS_POWERSHELL}`);

    this.startingSince = Date.now();
    const child = spawn(WINDOWS_POWERSHELL, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', cfg.hostScript,
      '-CaptureDir', cfg.captureDir
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    child.stdin.setDefaultEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));
    child.stderr.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (!text) return;
      this.stderrTail.push(text.slice(0, 400));
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    child.on('exit', (code) => {
      const error = new Error(`Game host exited (code ${code}). It restarts on the next call.`);
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
    });

    const ready = await this.call<{ pong: boolean }>('ping', {}, 20000).catch((error: Error) => {
      throw new Error(`Game host failed to start: ${error.message}${this.stderrTail.length ? ` | ${this.stderrTail.join(' | ')}` : ''}`);
    });
    if (!ready.pong) throw new Error('Game host did not answer ping');
    this.startingSince = 0;
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      message = JSON.parse(text);
    } catch {
      this.stderrTail.push(`unparsable: ${text.slice(0, 200)}`);
      return;
    }
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result ?? {});
    else pending.reject(new Error(`${pending.command}: ${message.error ?? 'unknown host error'}`));
  }

  async call<T = Record<string, unknown>>(command: string, args: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    if (!this.alive) {
      // Joining an in-flight startup keeps concurrent tool calls from spawning
      // a second PowerShell worker.
      if (this.starting) await this.starting;
      else await this.ensure();
    }
    const child = this.child;
    if (!child || child.exitCode !== null) throw new Error('Game host is not running');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Game host timed out after ${timeoutMs}ms on "${command}"`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, command });
      try {
        child.stdin.write(JSON.stringify({ id, cmd: command, args }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    try { await this.call('quit_host', {}, 3000); } catch { /* best effort */ }
    try { child.stdin.end(); } catch { /* already closed */ }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.child = null;
  }
}

export const host = new GameHost();

export function shutdownHost(): void {
  void host.shutdown();
}
