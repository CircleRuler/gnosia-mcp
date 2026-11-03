import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, regionByName, type Region } from './config.js';
import { host } from './host.js';

export interface RegionInput {
  region?: string;
  rect?: { x: number; y: number; w: number; h: number };
}

export function resolveRegion(input: RegionInput): { name: string; region: Region | null } {
  if (input.rect) {
    const { x, y, w, h } = input.rect;
    for (const [key, value] of Object.entries({ x, y, w, h })) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`rect.${key} must be a normalized number within 0..1 (got ${value})`);
      }
    }
    if (w <= 0 || h <= 0) throw new Error('rect.w and rect.h must be greater than 0');
    if (x + w > 1.0001 || y + h > 1.0001) throw new Error('rect must stay inside the 0..1 client area');
    return { name: 'custom', region: { x, y, w, h } };
  }
  const name = input.region ?? 'full';
  return { name, region: name === 'full' ? null : regionByName(name) };
}

export function pruneCaptures(): void {
  const cfg = loadConfig();
  try {
    const files = fs.readdirSync(cfg.captureDir)
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .map((name) => {
        const full = path.join(cfg.captureDir, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(cfg.maxCaptures)) {
      try { fs.unlinkSync(stale.full); } catch { /* keep going */ }
    }
  } catch { /* pruning is best-effort */ }
}

export interface CaptureMeta {
  path: string;
  width: number;
  height: number;
  region: string;
  scale: number;
  hash: string;
  mean_luma: number;
  changed_since_last_capture: boolean;
  capture_method: string;
  client_width: number;
  client_height: number;
  minimized: boolean;
  foreground: boolean;
  bytes: number;
  /** Set when the frame may not match the real screen - see capture(). */
  warning?: string;
  /** True when the game window is behind another window. */
  maybe_stale: boolean;
}

export interface CaptureResult {
  meta: CaptureMeta;
  image: { type: 'image'; data: string; mimeType: string };
}

export async function capture(options: RegionInput & { scale?: number } = {}): Promise<CaptureResult> {
  const cfg = loadConfig();
  const { name, region } = resolveRegion(options);
  const scale = options.scale ?? cfg.defaultScale;
  if (!(scale > 0.05 && scale <= 2)) throw new Error('scale must be between 0.05 and 2');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
  const file = path.join(cfg.captureDir, `${stamp}_${name}.png`);

  const raw = await host.call<Omit<CaptureMeta, 'region' | 'scale' | 'bytes' | 'maybe_stale' | 'warning'>>('capture', {
    region: region ?? null,
    scale,
    save: true,
    path: file
  }, 20000);

  const bytes = fs.statSync(raw.path).size;
  if (raw.mean_luma < 1.5 && raw.minimized) {
    throw new Error('Captured a black frame because the window is minimized. Call gnosia_focus, then retry.');
  }

  // A backgrounded window can hand back the last frame it presented: Windows
  // stops compositing it, and a GDI copy then returns old pixels that look like
  // a perfectly valid screenshot. That is how a leftover panel was "not there"
  // in three captures while the user was staring at it on the monitor. Say so
  // instead of letting the caller trust the image.
  const maybeStale = raw.minimized === false && raw.foreground === false;

  // Prune here, not in one tool. Every caller of capture() writes a ~1MB PNG, and
  // the only place that used to prune was gnosia_screenshot - so command/target/
  // vote/state piled up past the cap (318 files, 358MB at the time of writing).
  pruneCaptures();

  return {
    meta: {
      ...raw,
      region: name,
      scale,
      bytes,
      maybe_stale: maybeStale,
      warning: maybeStale
        ? 'the game window is NOT foreground, so this frame can be the last one it presented rather than the current screen. Trust the plugin state first; use gnosia_focus if a guaranteed fresh frame is needed.'
        : undefined
    },
    image: {
      type: 'image',
      data: fs.readFileSync(raw.path).toString('base64'),
      mimeType: 'image/png'
    }
  };
}

/**
 * A screenshot taken as a side effect of an action.
 *
 * Off by default. The plugin already returns the facts - command name, target
 * name, vote cell, window kind - and a backgrounded window hands back the last
 * frame it presented, so an automatic image is often stale, costs ~1MB of base64
 * and competes for context with the text that matters. Turn it on with
 * GNOSIA_AUTO_CAPTURE=1 to get a visual trail; gnosia_screenshot remains the
 * explicit way to look at the screen.
 */
export async function autoShot(options: RegionInput & { scale?: number } = {}): Promise<CaptureResult | null> {
  const cfg = loadConfig();
  if (!cfg.autoCapture) return null;
  return capture(options).catch(() => null);
}

export async function signature(regionInput: RegionInput = {}): Promise<{ hash: string; mean_luma: number; changed_since_last_capture: boolean; diff_since_last_capture: number }> {
  const { region } = resolveRegion(regionInput);
  return host.call('signature', { region: region ?? null }, 15000);
}

// Mean absolute difference between two 32x18 luma grids produced by the host.
// Below the threshold a "change" is just a blinking cursor or a breathing
// portrait, not new content.
export const CHANGE_THRESHOLD = 2.0;

export function sigDiff(a: string, b: string): number {
  const left = String(a ?? '').split('|')[0];
  const right = String(b ?? '').split('|')[0];
  if (!left || left.length !== right.length) return 255;
  let sum = 0;
  for (let i = 0; i < left.length; i += 2) {
    const x = parseInt(left.slice(i, i + 2), 16);
    const y = parseInt(right.slice(i, i + 2), 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return 255;
    sum += Math.abs(x - y);
  }
  return sum / (left.length / 2);
}
