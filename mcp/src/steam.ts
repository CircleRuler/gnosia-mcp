import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { host } from './host.js';

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STEAM_CANDIDATES = [
  String.raw`C:\Program Files (x86)\Steam\steam.exe`,
  String.raw`C:\Program Files\Steam\steam.exe`
];

const SYSTEM_ROOT = process.env.SystemRoot || String.raw`C:\Windows`;
const WINDOWS_POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// reg.exe is frequently blocked by endpoint policy, so the registry lookup goes
// through PowerShell instead, which the host already depends on.
async function querySteamExe(): Promise<string | null> {
  const script = String.raw`$ErrorActionPreference='SilentlyContinue';$v=(Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -Name SteamExe).SteamExe;if($v){[Console]::Out.Write($v)}`;
  try {
    const { stdout } = await execFileAsync(WINDOWS_POWERSHELL, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { windowsHide: true, timeout: 10000 });
    const value = stdout.trim().replace(/\//g, '\\');
    if (value && fs.existsSync(value)) return value;
  } catch { /* fall through to fixed paths */ }
  return null;
}

let steamExeCache: string | null | undefined;

export async function resolveSteamExe(): Promise<string | null> {
  if (steamExeCache !== undefined) return steamExeCache;
  const cfg = loadConfig();
  if (cfg.steamExe && fs.existsSync(cfg.steamExe)) { steamExeCache = cfg.steamExe; return steamExeCache; }
  const fromRegistry = await querySteamExe();
  steamExeCache = fromRegistry ?? STEAM_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
  return steamExeCache;
}

export async function listGamePids(): Promise<number[]> {
  const cfg = loadConfig();
  try {
    const { stdout } = await execFileAsync('tasklist.exe', [
      '/FI', `IMAGENAME eq ${cfg.processName}.exe`, '/FO', 'CSV', '/NH'
    ], { windowsHide: true, timeout: 8000 });
    const pids: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
      if (cells.length >= 2 && cells[0].toLowerCase() === `${cfg.processName.toLowerCase()}.exe`) {
        const pid = Number(cells[1]);
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

export interface WindowState {
  running: boolean;
  pid?: number;
  hwnd?: number;
  title?: string;
  client_width?: number;
  client_height?: number;
  client_x?: number;
  client_y?: number;
  minimized?: boolean;
  foreground?: boolean;
  window_width?: number;
  window_height?: number;
}

export async function windowState(): Promise<WindowState> {
  const info = await host.call<WindowState & { running: boolean }>('info', {}, 10000);
  if (!info.running) {
    const pids = await listGamePids();
    return { running: false, pid: pids[0] };
  }
  return info;
}

export async function focusGame(): Promise<Record<string, unknown>> {
  const result = await host.call<{ focused: boolean; geo: Record<string, unknown> }>('focus', {}, 10000);
  return { focused: result.focused, window: result.geo };
}

export interface LaunchOptions {
  timeoutMs?: number;
  focus?: boolean;
  waitReady?: boolean;
}

export async function launchGame(options: LaunchOptions = {}): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const timeoutMs = options.timeoutMs ?? cfg.timing.launchTimeoutMs;
  const started = Date.now();

  const existing = await windowState();
  if (existing.running) {
    if (options.focus !== false) await focusGame();
    return {
      launched: false,
      already_running: true,
      pid: existing.pid,
      window: existing,
      hint: 'GNOSIA already had a window; nothing was launched. Use gnosia_quit if you want a clean start.'
    };
  }

  const runningPids = await listGamePids();
  if (runningPids.length > 0) {
    throw new Error(`GNOSIA process ${runningPids.join(',')} is running without a usable window (probably still booting or minimized). Wait a few seconds and call gnosia_status.`);
  }

  const steamExe = await resolveSteamExe();
  if (!steamExe) {
    throw new Error('Steam executable not found. Set "steamExe" in gnosia.config.json (Steam is required for the Steam launch pipeline).');
  }

  const url = `steam://rungameid/${cfg.steamAppId}`;
  const child = spawn(steamExe, [url], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  let pid: number | undefined;
  const processDeadline = Date.now() + Math.min(60000, timeoutMs);
  while (Date.now() < processDeadline) {
    const pids = await listGamePids();
    if (pids.length > 0) { pid = pids[0]; break; }
    await sleep(400);
  }
  if (!pid) {
    throw new Error(`Steam accepted ${url} but no ${cfg.processName}.exe appeared within ${Math.round((Date.now() - started) / 1000)}s. Check that Steam is signed in and the game is installed.`);
  }

  const windowDeadline = Date.now() + timeoutMs;
  let state: WindowState = { running: false, pid };
  while (Date.now() < windowDeadline) {
    state = await windowState();
    if (state.running && (state.client_width ?? 0) > 0) break;
    await sleep(500);
  }
  if (!state.running) {
    throw new Error(`GNOSIA (pid ${pid}) started but never published a window within ${Math.round((Date.now() - started) / 1000)}s.`);
  }

  if (options.focus !== false) await focusGame();

  let ready: Record<string, unknown> | null = null;
  let visible = false;
  if (options.waitReady !== false) {
    // A freshly launched Unity build sits on a black frame for a while. Waiting
    // only for "stable" would happily return that black frame, so require the
    // picture to become non-black before settling on it.
    const visibleDeadline = Date.now() + Math.min(45000, timeoutMs);
    while (Date.now() < visibleDeadline) {
      const probe = await host.call<{ mean_luma: number }>('signature', { region: null }, 15000).catch(() => null);
      if (probe && probe.mean_luma > 3) { visible = true; break; }
      await sleep(500);
    }
    ready = await host.call('wait_stable', {
      timeout_ms: 20000,
      quiet_ms: 600
    }, 25000).catch(() => null);
  }

  return {
    launched: true,
    via: { steam_exe: steamExe, url },
    pid,
    window: state,
    frame_visible: visible,
    ready,
    waited_ms: Date.now() - started
  };
}

export async function quitGame(options: { force?: boolean; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const state = await windowState();
  if (!state.running) {
    const pids = await listGamePids();
    return { running: false, closed: true, note: pids.length ? `process ${pids.join(',')} alive without window` : 'not running' };
  }
  await host.call('close', {}, 10000).catch(async () => {
    if (options.force) await host.call('kill', {}, 10000);
  });

  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  while (Date.now() < deadline) {
    if ((await listGamePids()).length === 0) return { closed: true, graceful: true, pid: state.pid };
    await sleep(400);
  }

  if (options.force) {
    await host.call('kill', {}, 10000).catch(() => undefined);
    const pids = await listGamePids();
    return { closed: pids.length === 0, graceful: false, forced: true, remaining_pids: pids };
  }
  return {
    closed: false,
    graceful: false,
    pid: state.pid,
    note: 'GNOSIA ignored WM_CLOSE. Call gnosia_quit again with force:true if it must die now.'
  };
}

export async function gameInfo(): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const pids = await listGamePids();
  return {
    process_name: cfg.processName,
    steam_app_id: cfg.steamAppId,
    steam_exe: await resolveSteamExe(),
    pids,
    host_script: cfg.hostScript,
    host_script_exists: fs.existsSync(cfg.hostScript),
    capture_dir: cfg.captureDir,
    state_dir: cfg.stateDir,
    config_file: path.join(path.dirname(cfg.hostScript), '..', 'gnosia.config.json')
  };
}
