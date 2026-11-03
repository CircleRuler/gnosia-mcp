import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GnosiaConfig {
  processName: string;
  steamAppId: string;
  steamExe: string | null;
  pluginPort: number;
  captureDir: string;
  stateDir: string;
  hostScript: string;
  maxCaptures: number;
  // Take a screenshot as a side effect of every action tool. Off by default.
  autoCapture: boolean;
  defaultScale: number;
  regions: Record<string, Region>;
  timing: {
    launchTimeoutMs: number;
    keySettleMs: number;
    clickSettleMs: number;
    stableQuietMs: number;
    stableTimeoutMs: number;
  };
}

const DEFAULT_CONFIG: GnosiaConfig = {
  processName: 'Gnosia',
  steamAppId: '1608290',
  steamExe: null,
  // Loopback port of the in-process BepInEx plugin (gnosia-plugin).
  pluginPort: 48711,
  captureDir: path.join(ROOT, 'captures'),
  stateDir: path.join(ROOT, '.state'),
  hostScript: path.join(ROOT, 'host', 'gnosia-host.ps1'),
  maxCaptures: 120,
  autoCapture: process.env.GNOSIA_AUTO_CAPTURE === '1',
  defaultScale: 0.6,
  // Normalized against the game's client area (0..1). GNOSIA moves its dialogue
  // box between scenes, so "dialogue" is the common bottom band; use "full" when
  // the text is somewhere else.
  regions: {
    full: { x: 0, y: 0, w: 1, h: 1 },
    dialogue: { x: 0.02, y: 0.55, w: 0.96, h: 0.45 },
    dialogue_center: { x: 0.17, y: 0.28, w: 0.68, h: 0.38 },
    choices: { x: 0.05, y: 0.25, w: 0.9, h: 0.7 },
    top: { x: 0, y: 0, w: 1, h: 0.35 },
    bottom: { x: 0, y: 0.6, w: 1, h: 0.4 },
    left: { x: 0, y: 0, w: 0.45, h: 1 },
    right: { x: 0.55, y: 0, w: 0.45, h: 1 }
  },
  timing: {
    launchTimeoutMs: 120000,
    keySettleMs: 220,
    clickSettleMs: 450,
    stableQuietMs: 380,
    stableTimeoutMs: 6000
  }
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = out[key];
    out[key] = current && typeof current === 'object' && !Array.isArray(current)
      ? deepMerge(current, value)
      : value;
  }
  return out as T;
}

let cached: GnosiaConfig | null = null;

export function configPath(): string {
  return process.env.GNOSIA_MCP_CONFIG
    ? path.resolve(process.env.GNOSIA_MCP_CONFIG)
    : path.join(ROOT, 'gnosia.config.json');
}

export function loadConfig(): GnosiaConfig {
  if (cached) return cached;
  const file = configPath();
  let cfg = DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg = deepMerge(DEFAULT_CONFIG, raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
      } catch { /* read-only checkout: defaults still work */ }
    } else {
      throw new Error(`Cannot parse ${file}: ${(error as Error).message}`);
    }
  }
  cfg.captureDir = path.resolve(ROOT, cfg.captureDir);
  cfg.stateDir = path.resolve(ROOT, cfg.stateDir);
  cfg.hostScript = path.resolve(ROOT, cfg.hostScript);
  for (const dir of [cfg.captureDir, cfg.stateDir]) fs.mkdirSync(dir, { recursive: true });
  cached = cfg;
  return cfg;
}

export function regionByName(name: string): Region {
  const regions = loadConfig().regions;
  const region = regions[name];
  if (!region) {
    throw new Error(`Unknown region "${name}". Known regions: ${Object.keys(regions).join(', ')}`);
  }
  return region;
}
