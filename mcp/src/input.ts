import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig } from './config.js';
import { host } from './host.js';
import { CHANGE_THRESHOLD, resolveRegion, sigDiff } from './capture.js';
import {
  actWindow, type ActWindow, pluginAdvance, windowNow, pluginState, pluginScreens
} from './plugin.js';

export const KEY_CODES: Record<string, number> = {
  enter: 0x0d, return: 0x0d, space: 0x20, esc: 0x1b, escape: 0x1b, tab: 0x09,
  backspace: 0x08, delete: 0x2e, insert: 0x2d,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  pageup: 0x21, pagedown: 0x22, home: 0x24, end: 0x23,
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b
};
for (let i = 0; i < 26; i += 1) KEY_CODES[String.fromCharCode(97 + i)] = 0x41 + i;
for (let i = 0; i <= 9; i += 1) KEY_CODES[String(i)] = 0x30 + i;

export function normalizeKeys(keys: string[] | string): { names: string[]; vks: number[] } {
  const list = (Array.isArray(keys) ? keys : [keys])
    .flatMap((entry) => String(entry).split(/[+,\s]+/))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) throw new Error('At least one key is required');
  const vks = list.map((name) => {
    const code = KEY_CODES[name];
    if (code === undefined) {
      throw new Error(`Unknown key "${name}". Supported: ${Object.keys(KEY_CODES).join(', ')}`);
    }
    return code;
  });
  return { names: list, vks };
}

export interface KeyOptions {
  repeat?: number;
  holdMs?: number;
  settleMs?: number;
}

export async function sendKeys(keys: string[] | string, options: KeyOptions = {}): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const { names, vks } = normalizeKeys(keys);
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 40) throw new Error('repeat must be an integer within 1..40');
  const sequence = Array.from({ length: repeat }, () => vks).flat();
  const sequenceNames = Array.from({ length: repeat }, () => names).flat();

  const result = await host.call<{ foreground: boolean }>('key', {
    vks: sequence,
    names: sequenceNames,
    hold_ms: options.holdMs ?? 40,
    settle_ms: options.settleMs ?? cfg.timing.keySettleMs
  }, 30000);
  return {
    sent: sequenceNames,
    repeat,
    game_focused: result.foreground,
    warning: result.foreground ? undefined : 'GNOSIA was not the foreground window; inputs may have gone elsewhere. Call gnosia_focus and retry.'
  };
}

export interface ClickOptions {
  button?: 'left' | 'right';
  double?: boolean;
  settleMs?: number;
}

export async function click(x: number, y: number, options: ClickOptions = {}): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error('x and y are normalized client coordinates within 0..1 (e.g. 0.5,0.5 is the screen center)');
  }
  const before = await host.call<{ hash: string }>('signature', { region: null }, 15000);
  const result = await host.call<{ foreground: boolean; screen: { x: number; y: number } }>('click', {
    x, y,
    right: options.button === 'right',
    double: options.double === true,
    settle_ms: options.settleMs ?? cfg.timing.clickSettleMs
  }, 30000);
  const after = await host.call<{ hash: string }>('signature', { region: null }, 15000);
  const diff = sigDiff(before.hash, after.hash);
  return {
    clicked: { x, y, button: options.button ?? 'left', double: options.double === true },
    screen_point: result.screen,
    screen_changed: diff >= CHANGE_THRESHOLD,
    screen_diff: Math.round(diff * 10) / 10,
    game_focused: result.foreground
  };
}

export async function scroll(delta: number, x = 0.5, y = 0.5): Promise<Record<string, unknown>> {
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 5000) throw new Error('delta must be a non-zero wheel delta (120 per notch)');
  return host.call('wheel', { delta, x, y }, 15000);
}

export interface AdvanceOptions {
  maxPresses?: number;
  key?: string;
  quietMs?: number;
  timeoutMs?: number;
  stopOnNoChange?: number;
  /** Ignore the window on the very first line and keep walking (explicit "do not act"). */
  passWindow?: boolean;
}

/**
 * Press the advance key while the screen keeps responding. GNOSIA confirms
 * dialogue with Enter; when a choice list opens the screen stops changing, so
 * stopping on the first sterile press keeps the agent from confirming an
 * option it never chose.
 */
export interface TranscriptLine {
  day: number | null;
  speaker: string | null;
  text: string;
  at: string;
}

// Every line the meeting actually showed, in order.
//
// The game has no proper replay (Tab opens a short MessageLogScreen), so the
// transcript is kept here. It goes to disk, not just memory: each MCP session is a
// new process, and a partial log per call would be useless for reasoning about a
// day of discussion.
const TRANSCRIPT_FILE = path.join(os.tmpdir(), 'gnosia-transcript.jsonl');
const TRANSCRIPT_LIMIT = 800;

export interface TranscriptLine {
  day: number | null;
  speaker: string | null;
  text: string;
  at: string;
}

// The game embeds TMP markup in its lines (<color="yellow">…</color>).
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

function readTranscriptFile(limit: number): TranscriptLine[] {
  try {
    const raw = fs.readFileSync(TRANSCRIPT_FILE, 'utf8').split('\n').filter(Boolean);
    const lines: TranscriptLine[] = [];
    for (const row of raw.slice(-limit * 2)) {
      try {
        lines.push(JSON.parse(row) as TranscriptLine);
      } catch {
        // skip a torn line
      }
    }
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

export function recordLine(state: { day?: number; speaker?: string | null; text?: string } | null | undefined): void {
  if (!state) return;
  const text = stripTags(state.text ?? '');
  if (!text) return;
  const speaker = state.speaker ?? null;
  const tail = readTranscriptFile(1);
  const last = tail[tail.length - 1];
  if (last && last.text === text) return;
  const line: TranscriptLine = {
    day: typeof state.day === 'number' ? state.day : null,
    speaker,
    text,
    at: new Date().toISOString()
  };
  try {
    fs.appendFileSync(TRANSCRIPT_FILE, `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    // a transcript that cannot be written must not break the game loop
  }
}

export function readTranscript(limit = 40, speaker?: string): TranscriptLine[] {
  const all = readTranscriptFile(TRANSCRIPT_LIMIT);
  const filtered = speaker ? all.filter((line) => line.speaker === speaker) : all;
  return filtered.slice(-limit);
}

export function transcriptSize(): number {
  return readTranscriptFile(TRANSCRIPT_LIMIT).length;
}

export async function clearTranscript(): Promise<void> {
  try {
    fs.writeFileSync(TRANSCRIPT_FILE, '', 'utf8');
  } catch {
    // best effort
  }
}

// ---- screen guard ---------------------------------------------------------
//
// Screens that are part of the meeting itself: Enter there means "next line".
const DIALOGUE_SCREENS = new Set([
  'InterfaceScreen', 'BgScreen', 'CharaScreen', 'ColorScreen',
  'FadeScreen', 'Fade2Screen', 'LightBallScreen', 'CopyScreen', 'Copy2Screen'
]);

// Screens that own their own cursor. Enter there is not "advance" - it is
// "confirm the highlighted row", and the highlight starts at row 0. Pressing
// through one of these is exactly what cast a vote for row 0 before anybody was
// picked, and what walked from the map straight into the player's own room.
const INPUT_OWNING_SCREENS = new Set([
  'VoteScreen', 'Move2Screen', 'MyRoomScreen', 'SelectTgtScreen', 'SelectScreen',
  'YesNoDialogScreen', 'ResultScreen', 'MessageLogScreen',
  'GameMenuScreen', 'GameMenuSkillScreen', 'GameMenuHelpScreen', 'GameMenuLoadScreen',
  'GameMenuSaveScreen', 'GameMenuOptionScreen', 'GameMenuKeyConfigScreen',
  'CreateSlotScreen', 'LoadSlotScreen', 'SaveSlotScreen', 'TitleScreen',
  'MakeLoopScreen', 'TakashiSetScreen', 'SexSelWindow', 'ColorSelWindow', 'RegistWindow'
]);

export interface ScreenBrief {
  type: string;
  select?: number;
  select_max?: number;
  yes_no?: boolean;
  can_select?: boolean;
  areas?: Record<string, string>;
}

// Anything the player is supposed to answer explicitly, not scroll past.
export async function inputOwningScreens(): Promise<ScreenBrief[]> {
  const res = await pluginScreens().catch(() => null);
  const list = ((res?.screens as ScreenBrief[] | undefined) ?? []);
  return list.filter((screen) => {
    const type = String(screen.type ?? '');
    if (DIALOGUE_SCREENS.has(type)) return false;
    // A yes/no dialog with m_canSelect = false is a notice ("X was put into cold
    // sleep"), not a question: it only needs one Enter. Treating it as a choice
    // would stop the run on every single notice.
    if (type === 'YesNoDialogScreen' && screen.can_select === false) return false;
    if (INPUT_OWNING_SCREENS.has(type)) return true;
    return Number(screen.select_max ?? 0) > 0 || screen.yes_no === true;
  }).map((screen) => ({
    type: screen.type,
    select: screen.select,
    select_max: screen.select_max,
    yes_no: screen.yes_no,
    can_select: screen.can_select,
    areas: screen.areas
  }));
}

export async function advance(options: AdvanceOptions = {}): Promise<Record<string, unknown>> {
  const maxPresses = options.maxPresses ?? 12;
  if (!Number.isInteger(maxPresses) || maxPresses < 1 || maxPresses > 60) throw new Error('max_presses must be 1..60');

  const started = Date.now();
  const log: Array<Record<string, unknown>> = [];
  let stopped = 'max_presses';
  let window: ActWindow | null = null;
  let blockedBy: ScreenBrief[] | null = null;
  let passedSignature: string | null = null;

  // Everything below goes through the plugin, which raises a virtual Enter inside
  // the process. No SendInput, so the game is never brought to the foreground and
  // the user can keep typing in another window.
  for (let i = 0; i < maxPresses; i += 1) {
    const before = await pluginState(2500);
    if (!before) {
      stopped = 'plugin_unavailable';
      break;
    }
    // The line already on screen when we get here is part of the transcript too -
    // otherwise every advance that stops on a window would lose the sentence that
    // triggered it.
    recordLine(before as { day?: number; speaker?: string | null; text?: string });

    // Ask the game whether it is waiting for a command pick. windowNow() trusts
    // InterfaceScreen.nowPhase first and only falls back to the 发言 press, so a
    // window that has already closed can no longer be reported as open just
    // because its old text is still sitting in the text area.
    const probe = await windowNow();
    const items = probe.rows;
    if (probe.live) {
      const signature = `${probe.phase}:${items.join('|')}`;
      const verdict = actWindow(before, items, true, probe.phase);
      // A reaction window stays valid for several lines: the same five rows keep
      // being offered until the topic moves on. "Pass" therefore means "decline
      // this particular window", not "press enter once", otherwise every line
      // would stop again on the same list. Round and 报告 windows are never
      // passed - those are mandatory and skipping one changes the whole day.
      const passable = verdict.kind === 'reply';
      if (options.passWindow && passable && (passedSignature === null || passedSignature === signature)) {
        passedSignature = signature;
        // Deliberately NO /action/close here. That endpoint only writes
        // select = -1; it hides the column's background but leaves its five text
        // lines on screen, because nothing except the game's own
        // UnvisibleCommands() clears those text areas. Declining is done by
        // walking on: with no row highlighted Enter cannot commit anything.
        await delay(300);
      } else {
        stopped = 'can_act';
        window = verdict;
        break;
      }
    }

    // Do NOT press Enter on a screen that is waiting for a pick. That press is
    // read as "confirm the highlighted row", and the highlight starts at 0.
    const blocking = await inputOwningScreens();
    if (blocking.length > 0) {
      stopped = 'screen_owns_input';
      blockedBy = blocking;
      break;
    }

    const pressed = await pluginAdvance();
    if (pressed.ok !== true) {
      // The plugin now refuses a blind Enter on screens that own their cursor,
      // so an ok:false is usually that guard firing (a race with the check above),
      // not a dead plugin.
      stopped = typeof pressed.stopped_because === 'string' ? String(pressed.stopped_because) : 'plugin_unavailable';
      break;
    }
    await delay(650);

    const after = await pluginState(2500);
    const changed = (after?.text ?? '') !== (before.text ?? '') || (after?.speaker ?? '') !== (before.speaker ?? '');
    if (changed) {
      recordLine(after as { day?: number; speaker?: string | null; text?: string } | null);
    }
    log.push({
      press: i + 1,
      changed,
      speaker: after?.speaker ?? null,
      text: (after?.text ?? '').slice(0, 60)
    });

    if (!changed) {
      stopped = 'no_change';
      break;
    }
  }

  const hint = stopped === 'can_act'
    ? window?.kind === 'round'
      ? 'Your turn inside ROUND n/5 - and this is a CHOICE, not an instruction to talk. Every 发言 raises 注意度 (怀疑/袒护 raise it the most), and the tutorial is explicit that being talkative is what gets you accused. If you have already spoken a lot today, call gnosia_pass and stay silent. To speak instead: gnosia_speak, then gnosia_command.'
      : window?.kind === 'report'
        ? 'This is a 报告 window - it draws no ROUND counter but it is mandatory. Skipping it changes how the whole day plays out. Call gnosia_speak and report.'
        : window?.kind === 'reply'
          ? 'Someone just spoke and you may react (no ROUND counter, few rows like 反驳/寻求同意). This is optional: reacting also raises 注意度, and gnosia_pass declines it without committing anything.'
          : 'The game is waiting for a pick but no rows could be read yet. Call gnosia_speak to open the column and see them.'
    : stopped === 'screen_owns_input'
      ? `Stopped on ${(blockedBy ?? []).map((s) => s.type).join(', ')} - Enter there would confirm the highlighted row instead of advancing, so nothing was pressed. Pick explicitly: gnosia_vote (after gnosia_vote_list) on the vote screen, gnosia_ui for a menu or dialog, and on MyRoomScreen the rows are 0 睡觉 / 1 指令一览 / 2 升级 / 3 退出房间.`
    : stopped === 'no_change'
      ? 'The screen stopped reacting - a menu or a modal is probably open. Take a screenshot and decide.'
      : 'Still advancing. Call gnosia_advance again to keep going.';

  return {
    presses: log.length,
    stopped_because: stopped,
    blocked_by: blockedBy,
    window: window
      ? {
        kind: window.kind,
        commands: window.commands,
        round_sprites: window.round_sprites,
        live: window.live,
        phase: window.phase
      }
      : null,
    total_ms: Date.now() - started,
    log,
    next_step: hint
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(options: {
  mode: 'stable' | 'change' | 'duration';
  quietMs?: number;
  timeoutMs?: number;
  durationMs?: number;
  region?: string;
}): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const { region } = resolveRegion({ region: options.region });
  if (options.mode === 'duration') {
    const duration = Math.min(Math.max(options.durationMs ?? 1000, 50), 120000);
    await new Promise((resolve) => setTimeout(resolve, duration));
    return { waited: true, duration_ms: duration };
  }
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? cfg.timing.stableTimeoutMs, 500), 120000);
  if (options.mode === 'stable') {
    return host.call('wait_stable', {
      region: region ?? null,
      timeout_ms: timeoutMs,
      quiet_ms: options.quietMs ?? cfg.timing.stableQuietMs
    }, timeoutMs + 8000);
  }
  const baseline = await host.call<{ hash: string }>('signature', { region: region ?? null }, 15000);
  return host.call('wait_change', {
    region: region ?? null,
    baseline: baseline.hash,
    tolerance: CHANGE_THRESHOLD,
    timeout_ms: timeoutMs
  }, timeoutMs + 8000);
}

export async function frames(options: {
  count?: number;
  intervalMs?: number;
  region?: string;
  scale?: number;
  cols?: number;
} = {}): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const { name, region } = resolveRegion({ region: options.region });
  const count = Math.min(Math.max(options.count ?? 4, 2), 9);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
  const file = path.join(cfg.captureDir, `${stamp}_frames-${name}.png`);
  const result = await host.call<{ path: string; width: number; height: number; frames_changed: boolean; hashes: string[] }>('frames', {
    region: region ?? null,
    count,
    interval_ms: Math.min(Math.max(options.intervalMs ?? 500, 80), 5000),
    scale: options.scale ?? 0.5,
    cols: options.cols ?? (count <= 4 ? 2 : 3),
    save: true,
    path: file
  }, 60000);
  return { ...result, region: name, note: 'Frames are ordered left-to-right, top-to-bottom and labelled #1..#N.' };
}
