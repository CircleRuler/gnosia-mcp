import http from 'node:http';
import { loadConfig } from './config.js';

export interface PluginState {
  ok: boolean;
  version?: string;
  in_game?: boolean;
  role?: string;
  role_cn?: string;
  day?: number;
  speaker?: string | null;
  text?: string;
  text_lines?: string[];
  choices?: Array<Record<string, unknown>>;
  roster?: unknown;
  hint?: string;
  error?: string;
  [key: string]: unknown;
}

function request(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`plugin did not answer within ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

export async function pluginPing(timeoutMs = 1500): Promise<{ up: boolean; body?: unknown; error?: string }> {
  const cfg = loadConfig();
  try {
    const res = await request(`http://127.0.0.1:${cfg.pluginPort}/ping`, timeoutMs);
    return { up: res.status === 200, body: JSON.parse(res.body) };
  } catch (error) {
    return { up: false, error: (error as Error).message };
  }
}

/**
 * Reads the in-process BepInEx plugin. This is the exact-state channel: role,
 * day, speaker, dialogue text and the currently selectable actions come straight
 * from the game objects, not from pixels.
 */
export async function pluginState(timeoutMs = 4000): Promise<PluginState | null> {
  const cfg = loadConfig();
  try {
    const res = await request(`http://127.0.0.1:${cfg.pluginPort}/state`, timeoutMs);
    if (res.status !== 200) return null;
    return JSON.parse(res.body) as PluginState;
  } catch {
    return null;
  }
}

export async function pluginAvailable(): Promise<boolean> {
  return (await pluginPing()).up;
}

/**
 * Direct action: tells the move screen which place to go to. This writes the
 * cursor and the confirm flag the game's own UI would set, so no synthetic mouse
 * event is involved - the game performs the move on its next update.
 */
export async function pluginMove(place: number, timeoutMs = 6000): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  try {
    const res = await request(`http://127.0.0.1:${cfg.pluginPort}/action/move?place=${place}`, timeoutMs);
    return JSON.parse(res.body) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** True when a menu, prompt or map is waiting for a choice: blind Enter is unsafe then. */
export function hasPendingChoice(state: PluginState | null): boolean {
  if (!state) return false;
  const list = state.command_list as { left?: unknown[]; right?: unknown[] } | undefined;
  const hasList = Boolean(list && ((list.left?.length ?? 0) > 0 || (list.right?.length ?? 0) > 0));
  const hasPrompt = Boolean(state.command);
  const hasMap = Boolean(state.map);
  return hasList || hasPrompt || hasMap;
}

async function call(pathAndQuery: string, timeoutMs = 6000): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  try {
    const res = await request(`http://127.0.0.1:${cfg.pluginPort}${pathAndQuery}`, timeoutMs);
    return JSON.parse(res.body) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Advances one line of dialogue from inside the process.
 *
 * The plugin exposes a virtual Enter through Harmony: it answers the game's own
 * "is this button held" query for a few dozen milliseconds. Nothing is sent to
 * the window, so the game never has to be focused and the user keeps typing.
 */
export function pluginAdvance(): Promise<Record<string, unknown>> {
  return call('/action/advance', 5000);
}

/** The 8-ish commands available this round, as a list. */
export async function pluginCommands(): Promise<{ open: boolean; items: string[]; raw?: string }> {
  const state = await pluginState();
  const raw = typeof state?.command === 'string' ? state.command : '';
  const items = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  return { open: items.length > 0, items, raw };
}

/**
 * Moves the highlight onto command row `index` WITHOUT confirming. The game
 * renders the cursor and the com_Name/com_Desc caption, so a screenshot taken
 * after this shows exactly which line is about to be said - that is what a
 * human player would see before pressing the button.
 */
export function pluginSelect(index: number): Promise<Record<string, unknown>> {
  return call(`/action/select?index=${index}`, 5000);
}

/**
 * Picks command row `index` and confirms it. The plugin writes selectPos[column],
 * which is the only field the screen actually reads - `select` itself is the
 * column and is recomputed from the mouse position every frame.
 */
export function pluginCommand(index: number): Promise<Record<string, unknown>> {
  return call(`/action/command?index=${index}`, 8000);
}

/**
 * Casts the day's vote in two explicit steps. VoteScreen follows the same shape
 * as every other screen: selectTgt is the row, isDicision is the confirm. They
 * are separate calls on purpose - moving and committing in one shot is invisible
 * to a human watching, which is exactly the shortcut that caused trouble before.
 */
/**
 * Moves the vote cursor through VoteScreen's own SelectTarget(x, y). Voting is a
 * two-axis grid (selectTgt = x*6 + y); writing selectTgt alone used to cast the
 * right vote while leaving the cursor on somebody else.
 */
export function pluginVoteSelect(index: number): Promise<Record<string, unknown>> {
  return call(`/action/vote?index=${index}`, 5000);
}

/**
 * Moves the vote cursor and reports where it actually landed.
 *
 * VoteScreen is a 6-row grid: x = index / 6, y = index % 6. SelectTarget bails
 * while the screen is still animating, and the old code confirmed the vote without
 * checking - so a fast call silently voted for whoever the cursor was already on
 * (row 0). Callers must verify select_x/select_y before confirming.
 */
export function pluginVoteMoveChecked(index: number): Promise<Record<string, unknown>> {
  return call(`/action/vote?index=${index}`, 5000);
}

/**
 * The 发言 target column, resolved to character names.
 *
 * The column draws faces and never repaints the name plate, so reading `mainname`
 * gives the speaker or null. The plugin walks the same bitmask the game does and
 * returns the names in row order.
 */
export function pluginTargetList(): Promise<Record<string, unknown>> {
  return call('/action/targets', 5000);
}

/** Raises the vote screen's confirm flag - the 确定 button on its own. */
export function pluginVoteConfirm(): Promise<Record<string, unknown>> {
  return call('/action/vote?confirm=1', 5000);
}

/**
 * Reads the vote screen without touching it: current cursor cell plus whether the
 * confirm flag is already raised. `is_dicision: true` on arrival means a press
 * from the previous screen leaked through and the vote may already be cast.
 */
export function pluginVoteProbe(): Promise<Record<string, unknown>> {
  return call('/action/vote', 5000);
}

/** Writes one field on one live screen, e.g. clearing a stray VoteScreen flag. */
export function pluginSetField(screen: string, field: string, value: string): Promise<Record<string, unknown>> {
  return call(`/action/set?screen=${encodeURIComponent(screen)}&field=${encodeURIComponent(field)}&value=${encodeURIComponent(value)}`, 5000);
}

/** Text areas of every live screen, as key -> value (`/screens` only returns keys). */
export function pluginAreas(): Promise<Record<string, unknown>> {
  return call('/areas', 5000);
}

/** Raw field dump of one live screen. `has_instance:false` means it is not up. */
export function pluginDump(type: string, limit = 300): Promise<Record<string, unknown>> {
  return call(`/dump?type=${encodeURIComponent(type)}&find=1&limit=${limit}`, 6000);
}

/** Invokes a screen method that takes no arguments (EnterSelect, MoveCursor...). */
export function pluginCall0(screen: string, method: string, arg?: string): Promise<Record<string, unknown>> {
  const tail = arg === undefined ? '' : `&arg=${encodeURIComponent(arg)}`;
  return call(`/action/call0?screen=${encodeURIComponent(screen)}&method=${encodeURIComponent(method)}${tail}`, 5000);
}

/**
 * Invokes a screen method that takes ONE int, and answers the handler's
 * `Input.GetMouseButtonDown(0)` check so the same code path runs as a real
 * press. Despite the plugin route being called "click", nothing moves the
 * physical cursor: this is how MakeLoopScreen::EnterTriButton is driven.
 */
export function pluginCallInt(screen: string, method: string, index: number): Promise<Record<string, unknown>> {
  return call(`/action/click?screen=${encodeURIComponent(screen)}&method=${encodeURIComponent(method)}&index=${index}`, 6000);
}

/** 初期条件設定: people / gnosia count / per-role counts / your own role. Repaints itself. */
export function pluginSetup(params: { people?: number; gnosia?: number; roles?: string; self?: number }): Promise<Record<string, unknown>> {
  const parts: string[] = [];
  if (params.people !== undefined) parts.push(`people=${params.people}`);
  if (params.gnosia !== undefined) parts.push(`gnosia=${params.gnosia}`);
  if (params.roles !== undefined) parts.push(`roles=${encodeURIComponent(params.roles)}`);
  if (params.self !== undefined) parts.push(`self=${params.self}`);
  return call(`/action/setup?${parts.join('&')}`, 6000);
}

/** Character creation stats. Repaints abil / abilleft through the screen's own SetText. */
export function pluginSetAbil(values: string, left?: number): Promise<Record<string, unknown>> {
  const tail = left === undefined ? '' : `&left=${left}`;
  return call(`/action/setabil?values=${encodeURIComponent(values)}${tail}`, 6000);
}

/** Writes a text input (name field) without touching the OS keyboard. */
export function pluginSetInput(screen: string, text: string): Promise<Record<string, unknown>> {
  return call(`/action/setinput?screen=${encodeURIComponent(screen)}&text=${encodeURIComponent(text)}`, 5000);
}

/**
 * Opens the 发言 window exactly once.
 *
 * The key is a toggle: one frame opens it, the next closes it again. Pressing it
 * twice in a row is what made the list flash open and vanish, so this refuses to
 * press while the list already has content, and verifies afterwards instead of
 * assuming a fixed delay.
 */
/** The command column's text, one entry per row. Empty means "no rows read". */
export function readRows(state: PluginState | null): string[] {
  const raw = typeof state?.command === 'string' ? state.command : '';
  return raw.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * `nowPhase` on InterfaceScreen - kept for diagnostics only, do NOT read it as a
 * UI flag.
 *
 * The IL settles it: `nowPhase` is just `mydata.baseData.phase`, i.e. the script
 * phase number of the current scene, copied in on every change. It starts at 255
 * and counts up as the scene progresses (observed 0, 1, 2 in a single round), so
 * "phase >= 1" is true for most of a normal day and says nothing about a panel.
 * Treating it as "the game is asking me to pick" made `advance` stop dead on the
 * player's own spoken line. The real flag is `select`, see `windowNow`.
 */
export async function pluginPhase(timeoutMs = 3000): Promise<number | null> {
  const dump = await call('/dump?type=application.InterfaceScreen&find=1&limit=200', timeoutMs);
  if (dump.ok !== true) return null;
  const fields = dump.instance_fields as Record<string, { v?: unknown }> | undefined;
  const raw = fields?.nowPhase?.v;
  const phase = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(phase) ? phase : null;
}

export interface WindowProbe {
  /** True only when the game is really offering rows right now. */
  live: boolean;
  rows: string[];
  phase: number | null;
  /** How liveness was decided: a highlighted row, the 发言 press, the 发言 button, or neither. */
  source: 'select' | 'press' | 'speak' | 'none';
}

/**
 * Is a command window open right now?
 *
 * `select` is the honest flag: `MyUpdate` resets it to -1 on every frame that has
 * no column on screen, and a column that IS on screen always keeps one row
 * highlighted, so `select >= 0` cannot go stale the way the text areas do.
 *
 * The 发言 press stays as a fallback for the moment a window is being built (the
 * column is drawn but `select` has not landed yet). There the press is judged by
 * what changed, not by whether text exists: a press in plain dialogue is a no-op,
 * so the only way the rows can change is that a real window opened. Reading "the
 * text is non-empty" was the old test, and leftover text made it answer "yes"
 * forever, which is how a panel got left drawn on screen.
 */
export async function windowNow(): Promise<WindowProbe> {
  const state = await pluginState();
  const phase = await pluginPhase();
  const before = readRows(state);
  const iface = (state?.interface ?? {}) as Record<string, unknown>;
  const select = Number(iface.select ?? -1);
  const speak = (iface.speak ?? {}) as { button_visible?: boolean; menu_open?: boolean; options?: string[] };
  const speakAvailable = speak.button_visible === true || speak.menu_open === true;

  if (Number.isFinite(select) && select >= 0) {
    return { live: true, rows: before, phase, source: 'select' };
  }

  await call('/action/press?action=3&ms=16', 4000);
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 110));
    const next = await pluginState();
    const now = readRows(next);
    const speakNow = ((next?.interface ?? {}) as Record<string, unknown>).speak as
      { button_visible?: boolean; menu_open?: boolean; options?: string[] } | undefined;
    const rows = now.length > 0 ? now : (Array.isArray(speakNow?.options) ? speakNow!.options! : []);
    if (rows.length > 0) {
      // Let the slide-in finish so a screenshot taken next shows the list.
      await dwell(180);
      return { live: true, rows, phase, source: 'press' };
    }
  }
  // The button is up even if the rows could not be read: that still means the
  // game is waiting for a spoken line, so it must not be walked through.
  return { live: speakAvailable, rows: [], phase, source: speakAvailable ? 'speak' : 'none' };
}

/** Kept for callers that only need the rows. */
export async function probeWindow(): Promise<string[]> {
  const probe = await windowNow();
  return probe.live ? probe.rows : [];
}

export async function pluginSpeakOpen(timeoutMs = 2500): Promise<{
  opened: boolean;
  pressed: boolean;
  attempts: number;
  items: string[];
  phase: number | null;
  live: boolean;
}> {
  const probe = await windowNow();
  if (!probe.live) {
    return { opened: false, pressed: probe.source === 'press', attempts: 1, items: [], phase: probe.phase, live: false };
  }
  if (probe.rows.length > 0) {
    // The text objects are filled before the slide-in animation finishes; hold
    // one beat so a capture right after this shows the finished list, not a
    // half-drawn one.
    await dwell(300);
    return {
      opened: true, pressed: probe.source === 'press', attempts: 1,
      items: probe.rows, phase: probe.phase, live: true
    };
  }

  // The phase says a window is waiting but no rows were read yet: press 发言 to
  // make the game build the column, then read it.
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let rows = probe.rows;
  while (Date.now() < deadline && rows.length === 0) {
    attempts += 1;
    await call('/action/press?action=3&ms=16', 4000);
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      rows = readRows(await pluginState());
      if (rows.length > 0) break;
    }
  }
  if (rows.length > 0) await dwell(300);
  return {
    opened: rows.length > 0, pressed: attempts > 0, attempts,
    items: rows, phase: probe.phase, live: true
  };
}

/** Small helper so tools can hold a state on screen long enough to be watched. */
export function dwell(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Picks (and optionally confirms) a target after 怀疑/袒护/投票. */
export function pluginTarget(index: number, confirm = false): Promise<Record<string, unknown>> {
  return call(`/action/target?index=${index}&confirm=${confirm ? 1 : 0}`, 6000);
}

/** Drives any screen's own button handler (needs a pending state from /screens). */
export function pluginUi(screen: string, index: number, confirm = false): Promise<Record<string, unknown>> {
  return call(`/action/ui?screen=${encodeURIComponent(screen)}&index=${index}&confirm=${confirm ? 1 : 0}`, 8000);
}

export function pluginScreens(): Promise<Record<string, unknown>> {
  return call('/screens', 5000);
}

/**
 * Inject one of the game's own controller buttons.
 *
 * Button 6 is the system key. It is NOT a global "menu" key: InterfaceScreen
 * treats it as "open the system menu", while TakashiSetScreen treats the very
 * same button as "finish creating the character". Only press it through
 * gnosia_menu, which checks that the 菜单 button is actually on screen first -
 * firing it while a script is still running can cut a scene short.
 */
export function pluginSystemButton(action: number, ms = 140): Promise<Record<string, unknown>> {
  return call(`/action/press?action=${action}&ms=${ms}`, 5000);
}

/** Reads a dotted path out of a live object, numbers indexing into lists. */
export function pluginPath(type: string, path: string): Promise<Record<string, unknown>> {
  return call(`/action/path?type=${encodeURIComponent(type)}&path=${encodeURIComponent(path)}`, 5000);
}

/** Raw, last-resort panel wipe. Only safe when nothing is on screen - see below. */
export function pluginClose(): Promise<Record<string, unknown>> {
  return call('/action/close', 5000);
}

/**
 * Clears a leftover command column the way the game itself does.
 *
 * Why this exists: MyUpdate hides the column's BACKGROUND sprites every frame,
 * but the five lines live in four separate text areas that only the screen's own
 * UnvisibleCommands() ever clears. Writing `select = -1` (what /action/close
 * does) therefore lifts the panel off the text and leaves the lines floating on
 * screen for the rest of the session - usable, but visibly wrong.
 *
 * Pressing 发言 is the game's own entry into that path, and doing it while no
 * window is being offered is a no-op apart from the clean-up. The first press is
 * enough when the game rebuilds the column; if the strings come back unchanged
 * (the toggle put it back), a second press closes it properly.
 *
 * It refuses to run while a real window is open: there the press would act on
 * the turn instead of tidying up.
 */
export async function pluginFlushCommands(): Promise<Record<string, unknown>> {
  const before = await pluginState();
  const phase = await pluginPhase();
  const rowsBefore = readRows(before);
  const iface = (before?.interface ?? {}) as Record<string, unknown>;
  const select = Number(iface.select ?? -1);

  // Same rule as windowNow(): a highlighted row means a column is really drawn.
  // `nowPhase` is the script's phase counter, not a UI flag, so it cannot be used
  // to refuse - it is >= 1 through most of a normal day.
  if (Number.isFinite(select) && select >= 0) {
    return {
      ok: false,
      refused: true,
      phase,
      select,
      commands: rowsBefore,
      note: 'a command window is open right now - pressing 发言 there would act on your turn instead of tidying up. Nothing was touched.'
    };
  }

  const presses: Array<{ press: number; rows: string[] }> = [];
  let rows = rowsBefore;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await call('/action/press?action=3&ms=16', 4000);
    await dwell(280);
    const next = readRows(await pluginState());
    presses.push({ press: attempt, rows: next });
    // A different list means 发言 opened a real window - stop, do not toggle it
    // back off. An unchanged list means the toggle only re-showed it, so the
    // second press is the one that closes it.
    if (next.length === 0) {
      rows = next;
      break;
    }
    if (next.join('|') !== rows.join('|')) {
      rows = next;
      break;
    }
    rows = next;
  }

  return {
    ok: rows.length === 0,
    phase,
    before: rowsBefore,
    after: rows,
    presses: presses.length,
    note: rows.length === 0
      ? 'the leftover command text is gone - the game cleared its own text areas'
      : 'the text is still in place. Take a screenshot: if the lines are still drawn, this needs the patched plugin (UnvisibleCommands in Close), which loads on the next game start.'
  };
}

/**
 * Every command row the game is currently offering, whether or not the panel is
 * drawn. The rows live in two text areas (com_L / com_R) when the list is
 * two-column, and in the single `command` block when it is one column.
 */
export function commandRows(state: PluginState | null): string[] {
  const list = state?.command_list as { left?: unknown[]; right?: unknown[] } | undefined;
  const columns = [...(list?.left ?? []), ...(list?.right ?? [])]
    .map((row) => String(row))
    .filter((row) => row.length > 0);
  return columns.length > 0 ? columns : readRows(state);
}

export interface ActWindow {
  can_act: boolean;
  /** "round" = the five formal rounds, "report" = 报告 phase, "reply" = reacting to someone,
   *  "speak" = the 发言 button is up but the list has not been opened with W yet. */
  kind: 'round' | 'report' | 'reply' | 'speak' | 'none';
  commands: string[];
  round_sprites: number;
  command_rows: number;
  /** True only when the game itself is waiting for a pick (phase flag or probe). */
  live: boolean;
  phase: number | null;
}

/**
 * Describes the window the player is being offered, if any.
 *
 * `live` must come from windowNow(). It is passed in explicitly because the
 * command text and selectNum[0] survive the window and would otherwise describe
 * a list that is no longer there.
 */
export function actWindow(
  state: PluginState | null,
  items?: string[],
  live?: boolean,
  phase: number | null = null
): ActWindow {
  const iface = state?.interface as {
    round_visible_sprites?: number;
    speak?: { button_visible?: boolean; menu_open?: boolean; options?: string[] };
  } | undefined;
  const speak = iface?.speak;
  // The 发言 button is the game's own "you may speak now". It appears BEFORE the
  // list does - the list only exists after W - so it has to count as a live
  // window by itself. Otherwise advance would silently choose for the player:
  // Enter confirms a row when the list is open, declines a ROUND when the list
  // is closed, and can select a reply's first row even when that list is closed.
  const speakAvailable = speak?.button_visible === true || speak?.menu_open === true;
  const speakRows = Array.isArray(speak?.options) ? speak.options : [];
  const commands = items && items.length > 0 ? items : (speakRows.length > 0 ? speakRows : commandRows(state));
  const rows = commands.length;
  const sprites = Number(iface?.round_visible_sprites ?? 0);
  // Without an explicit answer, trust the ROUND counter and the 发言 button.
  const isLive = live ?? (sprites > 0 || speakAvailable);
  let kind: ActWindow['kind'] = 'none';
  if (isLive) {
    if (sprites > 0) {
      kind = 'round';
    } else if (commands.some((row) => row.includes('报告'))) {
      kind = 'report';
    } else if (speakAvailable && rows === 0) {
      kind = 'speak';
    } else if (rows > 0) {
      kind = 'reply';
    }
  }
  return {
    can_act: isLive, kind, commands, round_sprites: sprites,
    command_rows: rows, live: isLive, phase
  };
}

/** Kept for callers that only need the yes/no answer. */
export function isMyTurn(state: PluginState | null): boolean {
  return actWindow(state).can_act;
}


