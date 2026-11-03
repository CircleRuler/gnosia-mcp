#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { autoShot, capture, signature } from './capture.js';
import { host } from './host.js';
import { advance, frames, inputOwningScreens, readTranscript, recordLine, scroll, sendKeys, transcriptSize, waitFor } from './input.js';
import { appendJournal, deleteMemory, readJournal, readMemory, readNotes, writeMemory, writeNotes } from './memory.js';
import { focusGame, gameInfo, launchGame, quitGame, windowState } from './steam.js';
import {
  actWindow, readRows, pluginAdvance, pluginClose, pluginFlushCommands, pluginPhase, pluginCommand, pluginCommands, pluginMove, pluginSelect,
  dwell, pluginPing, pluginScreens, pluginSpeakOpen, pluginState, pluginTarget, pluginUi,
  pluginSystemButton, pluginPath,
  pluginVoteConfirm, pluginVoteSelect, pluginVoteMoveChecked, pluginVoteProbe, pluginSetField, pluginTargetList,
  pluginDump, pluginCall0, pluginCallInt, pluginAreas, windowNow,
  pluginSetup, pluginSetAbil, pluginSetInput
} from './plugin.js';
import { PLAYBOOK } from './playbook.js';
import { TUTORIAL } from './tutorial.js';
import { SKILLS } from './skills.js';
import { LORE_INTRO, LORE_NOTES } from './lore.js';

const SERVER_VERSION = '0.1.0';

// Injected into the client's system prompt on connect. The playbook prompt has
// the full manual, but a prompt is only read when the model asks for it - this
// block is the part that must survive even when nobody reads the manual, because
// it is what stops a fresh agent from "just taking a screenshot and clicking".
const INSTRUCTIONS = `GNOSIA is played entirely through the in-process BepInEx plugin. Every fact comes from the game's own objects, not from pixels.

READING STATE (always first)
- gnosia_state: role, day, speaker, dialogue lines, selectable commands, crew list.
- gnosia_screens + gnosia_areas: which screens are up, and every text label on them.
- gnosia_board / gnosia_map / gnosia_log: roster, night map, transcript.
- gnosia_tutorial: the game's own 46-page help.

SCREENSHOTS ARE THE LAST RESORT
gnosia_screenshot costs ~1 MB, and a backgrounded window can hand back a stale frame. Never use it for something the state already carries: day counter, speaker, dialogue, command rows, target names, vote grid, save slots, roster, setting values. Reach for it only for genuine pixels (portraits, art, layout), and crop with a region instead of capturing "full".

NO MOUSE
There is no click tool and there should not be one: clicks need absolute coordinates, a foreground window and a live cursor, and they break the moment the user touches the machine. Every panel has a tool that calls that screen's own SelectTarget/Enter handler, which keeps working while the window sits in the background. gnosia_key exists but steals focus - use it only when the plugin genuinely cannot do the job, and say so first.

ONE PRESS, THEN THINK
A confirm is a decision. Press once, read the result, decide. Never chain presses to "see what happens", and never bundle open + pick + confirm into one step.

SPEAKING IS A DECISION
When the 发言 [W] button is on screen, speaking or staying silent is a CHOICE, so gnosia_advance stops instead of deciding for you. W opens the list; Enter with the list OPEN confirms its highlighted row. At a ROUND window with the list CLOSED, Enter is the game's silence path and must be sent explicitly with gnosia_pass. Never pass a reply window: closed-list Enter can select its first row. To speak: gnosia_speak, read the rows, then gnosia_command.

START WITH gnosia_playbook (the manual) and gnosia_status.

ORIENTATION, ONCE PER SESSION - contents first, bodies later
- gnosia_lore: the four-screen introduction. Why anyone is frozen, why the destination is forced, what the compression self-destruct means. Read it before the first loop.
- gnosia_skills: the 30 指令 by name. Read one body only when that command actually shows up in your list.
- gnosia_tutorial: the 46 help pages by title. Read one page only when a rule is in question.
Never pull all 30 bodies or all 46 pages into context "just in case"; the contents lists are the cheap part, the bodies are the expensive part.`;

const server = new McpServer({ name: 'gnosia-mcp', version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
const outputSchema = { data: z.unknown() };

const asText = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: { data: value }
});

const failureResult = (error: unknown) => ({
  ok: false,
  server_version: SERVER_VERSION,
  error: {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error)
  }
});

const execute = async (operation: () => unknown) => {
  try {
    return asText(await operation());
  } catch (error) {
    return { ...asText(failureResult(error)), isError: true };
  }
};

interface ToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// Same error handling, but the result is passed through untouched so tools can
// return real image content instead of a JSON-encoded copy of it.
const executeRaw = async (operation: () => Promise<ToolResult>): Promise<any> => {
  try {
    return await operation();
  } catch (error) {
    return { ...asText(failureResult(error)), isError: true };
  }
};

const annotations = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  act: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  risky: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
};

server.registerTool('gnosia_status', {
  description: 'Check whether GNOSIA is running, report its window geometry (client size and screen origin), the capture-host state and the Steam configuration. Call this first in a session.',
  inputSchema: {},
  outputSchema,
  annotations: annotations.read
}, async () => execute(async () => ({
  server_version: SERVER_VERSION,
  platform: process.platform,
  config: await gameInfo(),
  game: await windowState(),
  host: host.diagnostics
})));

server.registerTool('gnosia_launch', {
  description: 'Start GNOSIA through the Steam pipeline (steam://rungameid/1608290), wait for the game window, focus it, wait until the picture is no longer black, then wait for the first settled frame. If a window already exists nothing is relaunched. The frame itself is only attached when auto-capture is on (GNOSIA_AUTO_CAPTURE=1); read gnosia_state afterwards instead of asking for a picture.',
  inputSchema: {
    timeout_ms: z.number().int().min(10000).max(300000).optional(),
    focus: z.boolean().optional(),
    wait_ready: z.boolean().optional()
  },
  outputSchema,
  annotations: annotations.act
}, async ({ timeout_ms, focus, wait_ready }) => executeRaw(async () => {
  const result = await launchGame({ timeoutMs: timeout_ms, focus, waitReady: wait_ready });
  const shot = await autoShot();
  const payload = { ...result, screenshot_path: shot?.meta.path ?? null };
  if (!shot) return asText(payload) as ToolResult;
  return {
    content: [shot.image, { type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: { data: payload }
  };
}));

server.registerTool('gnosia_focus', {
  description: 'Bring the GNOSIA window to the foreground and un-minimize it. Only needed to make a screenshot trustworthy - every plugin action (advance, speak, command, target, vote, ui) runs inside the process and works while the window is in the background, so do not call this before acting.',
  inputSchema: {},
  outputSchema,
  annotations: annotations.act
}, async () => execute(() => focusGame()));

server.registerTool('gnosia_state', {
  description: 'Exact game state read straight out of the game process by the BepInEx plugin, with no OCR and no guessing: your own role (raw enum plus Chinese name), day, current speaker, the dialogue lines, the actions you can select right now, and the crew id list. Text only by default: pass screenshot:true for an image, or call gnosia_screenshot when you really need to look at the screen. If the plugin is not running it says so.',
  inputSchema: {
    screenshot: z.boolean().optional().describe('Also return a screenshot. Default false - the state text is what matters; images go stale when the game is not focused.'),
    region: z.enum(['full', 'dialogue', 'dialogue_center', 'choices', 'top', 'bottom', 'left', 'right']).optional(),
    scale: z.number().min(0.1).max(2).optional()
  },
  outputSchema,
  annotations: annotations.read
}, async ({ screenshot, region, scale }) => executeRaw(async () => {
  const state = await pluginState();
  if (!state) {
    return asText({
      ok: false,
      plugin_reachable: false,
      error: 'the in-process plugin did not answer on 127.0.0.1; is GNOSIA running with gnosia-plugin installed?',
      fallback: 'use gnosia_screenshot'
    }) as ToolResult;
  }
  if (screenshot === false) return asText(state) as ToolResult;
  const shot = screenshot === true
    ? await capture({ region: region ?? 'full', scale }).catch(() => null)
    : await autoShot({ region: region ?? 'full', scale });
  const payload = { ...state, screenshot_path: shot?.meta.path ?? null };
  if (!shot) return asText(payload) as ToolResult;
  return {
    content: [shot.image, { type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: { data: payload }
  };
}));

server.registerTool('gnosia_screenshot', {
  description: 'Capture the game window as a PNG. LAST RESORT: gnosia_state and gnosia_areas already carry the day counter, speaker, dialogue, command rows, target names, vote grid, save slots and every other text label, and a window that is not foreground can hand back a stale frame. Use it only for things that are genuinely pixels (portraits, art, layout, a marker whose position matters), and crop with region/rect instead of capturing "full" - a full frame is ~1 MB and competes with the state text for context.',
  inputSchema: {
    region: z.enum(['full', 'dialogue', 'dialogue_center', 'choices', 'top', 'bottom', 'left', 'right']).optional(),
    rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional()
      .describe('Custom normalized rect (0..1) that overrides region, e.g. {x:0.1,y:0.1,w:0.5,h:0.3}'),
    scale: z.number().min(0.1).max(2).optional().describe('Resize factor applied after cropping. Lower = fewer tokens, less legible small text.'),
    save: z.boolean().optional().describe('Keep the PNG on disk (default true) under the capture directory.')
  },
  outputSchema,
  annotations: annotations.read
}, async ({ region, rect, scale, save }) => executeRaw(async () => {
  const shot = await capture({ region, rect, scale });
  const meta = {
    ...shot.meta,
    saved: save !== false
  };
  return {
    content: [
      shot.image,
      { type: 'text', text: JSON.stringify(meta, null, 2) }
    ],
    structuredContent: { data: meta }
  };
}));

server.registerTool('gnosia_move', {
  description: 'Move to a place on the ship map by its place id, by writing the game\'s own cursor and confirm state through the plugin - no synthetic mouse click. Get the reachable ids from gnosia_state (map.places); place 5 is the meeting room and only appears when a meeting can be attended. Returns the resulting state.',
  inputSchema: {
    place: z.number().int().min(0).max(999).describe('Place id from gnosia_state -> map.places[].place')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ place }) => executeRaw(async () => {
  const result = await pluginMove(place);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const state = await pluginState();
  const payload = { action: result, state };
  const shot = await autoShot();
  if (!shot) return asText(payload) as ToolResult;
  return {
    content: [shot.image, { type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: { data: payload }
  };
}));

server.registerTool('gnosia_speak', {
  description: 'Open the 发言 list by pressing W and return the exact entries. This is the ONLY way the list appears: it does not pop up by itself, and Enter never opens it. With the list open Enter confirms the highlighted row; only at a ROUND window with the list closed is gnosia_pass the explicit silence path (a reply window can treat Enter as its first row). Call gnosia_speak whenever gnosia_advance stops with window.kind = "speak" (button up, list closed) or "round"/"report"/"reply" and you intend to speak. Opening the list commits nothing - pick a row afterwards with gnosia_command. The window is left open for visible_ms so a human watching can read it first.',
  inputSchema: {
    visible_ms: z.number().int().min(0).max(5000).optional().describe('How long to leave the list on screen before returning (default 1200ms)')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ visible_ms }) => executeRaw(async () => {
  const opened = await pluginSpeakOpen();
  const stay = visible_ms ?? 1200;
  if (opened.opened && stay > 0) await dwell(stay);
  const state = await pluginState();
  const payload = {
    open: opened.opened,
    commands: opened.items,
    pressed: opened.pressed,
    hint: opened.opened
      ? 'Pick one with gnosia_command {index}. Commands that need a target open a target list afterwards.'
      : 'The game is not offering a command list right now - this is a plain dialogue line, not your turn. Keep calling gnosia_advance. Leftover text in the command area is NOT a list; only nowPhase (reported as window.live) says whether one is open.',
    round: (state?.interface as Record<string, unknown> | undefined)?.round,
    // Leftover text from a window that is already gone. It is NOT a list: call
    // gnosia_close_panel to let the game clear it instead of reading it as rows.
    leftover_text: !opened.live && typeof state?.command === 'string' && state.command.trim().length > 0,
    window: actWindow(state ?? null, opened.items, opened.live, opened.phase)
  };
  const shot = await autoShot();
  if (!shot) return asText(payload);
  return {
    content: [shot.image, { type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: { data: payload }
  };
}));

server.registerTool('gnosia_command', {
  description: 'Press ONE row in the 发言 list - exactly the "点怀疑" step, nothing more. The list must already be open: call gnosia_speak first. This tool deliberately does NOT open the list itself, because opening and picking in one shot is what made the panel flash past a human eye. Inside, the highlight moves onto the row first, then the row is confirmed. If the command needs a target, MyUpdate opens the target column by itself; the reply reports target_list_open=true and the row count - pick the person with gnosia_target.',
  inputSchema: {
    index: z.number().int().min(0).max(20).describe('Row index from gnosia_speak (0-based)'),
    visible_ms: z.number().int().min(0).max(5000).optional().describe('How long to leave the highlighted list on screen before confirming (default 900ms)')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ index, visible_ms }) => executeRaw(async () => {
  const list = await pluginCommands();
  if (!list.open) {
    return asText({
      error: 'the 发言 list is not open. Call gnosia_speak first - opening the list and picking a row are two separate presses on purpose.',
      state: await pluginState()
    });
  }
  // Move the cursor onto the row without committing: the game renders the
  // highlight and the com_Name caption, so a capture here shows exactly which
  // line is about to be said.
  const highlighted = await pluginSelect(index);
  const stay = visible_ms ?? 900;
  if (stay > 0) await dwell(stay);
  const beforeShot = await autoShot();

  const result = await pluginCommand(index);

  // After the commit, MyUpdate itself switches to the target column (select+1)
  // and fills selectNum[1] with the number of people. Poll for that instead of
  // guessing a fixed delay - a fixed sleep is what used to capture a flash.
  let targetRows = 0;
  for (let i = 0; i < 14; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const probe = await pluginState();
    const iface = (probe?.interface ?? {}) as Record<string, unknown>;
    targetRows = Number(iface.select_num1 ?? 0);
    if (targetRows > 0) break;
  }
  if (targetRows === 0) {
    await waitFor({ mode: 'stable', quietMs: 400, timeoutMs: 3000 }).catch(() => null);
  }
  await dwell(300);

  const state = await pluginState();
  const payload = {
    said: list.items[index] ?? null,
    said_caption: (highlighted as Record<string, unknown>)?.selected_name ?? null,
    target_list_open: targetRows > 0,
    target_rows: targetRows,
    next_step: targetRows > 0
      ? 'The target column is open. Pick the person with gnosia_target {index} (confirm=false to look, confirm=true to commit).'
      : 'This command needs no target - it was executed directly.',
    action: result,
    state
  };
  const afterShot = await autoShot();
  const content: Array<Record<string, unknown>> = [];
  if (beforeShot) content.push(beforeShot.image);
  if (afterShot) content.push(afterShot.image);
  content.push({ type: 'text', text: JSON.stringify(payload, null, 2) });
  return {
    content,
    structuredContent: { data: payload }
  };
}));

server.registerTool('gnosia_target', {
  description: 'Pick the person a command points at (怀疑 / 袒护 / 投票给此人 ...). Call it with confirm=false first to see who the index points at - the reply carries the name and the full row list - then call again with confirm=true once you are satisfied. `targets` lists every row in order, so you can pick by name instead of guessing. The names are resolved from the row mask inside the game, not from the name plate (the target column draws faces only).',
  inputSchema: {
    index: z.number().int().min(0).max(20).describe('Row in the target list, 0-based'),
    confirm: z.boolean().optional().describe('Confirm the pick (default false = only move the highlight)'),
    visible_ms: z.number().int().min(0).max(5000).optional().describe('How long to leave the highlight on screen (default 1000ms)')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ index, confirm, visible_ms }) => executeRaw(async () => {
  // Row -> name comes from the game's own bitmask (plugin /action/targets), not
  // from the name plate: the target column is faces only.
  const table = await pluginTargetList().catch(() => ({} as Record<string, unknown>));
  const rows = Number(table.rows ?? 0);
  const asNames = (value: unknown): Array<string | null> => Array.isArray(value) ? (value as Array<string | null>) : [];
  const names0 = asNames(table.names0);
  const names1 = asNames(table.names1);
  const names: Array<string | null> = names0.length === rows ? names0 : (names1.length === rows ? names1 : (names1.length ? names1 : names0));
  const picked = typeof names[index] === 'string' ? names[index] : null;

  const result = await pluginTarget(index, confirm === true);
  const stay = visible_ms ?? 1000;
  if (stay > 0) await dwell(stay);
  if (confirm === true) {
    // Same lesson as gnosia_command: a fixed sleep captures mid-transition
    // flash frames after the confirm closes the panel. Settle first.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await waitFor({ mode: 'stable', quietMs: 400, timeoutMs: 3500 }).catch(() => null);
    await dwell(300);
  } else {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const state = await pluginState();
  // The plugin reads the NAME plate on the same tick it moves the cursor, so
  // `action.name` is usually still the previous person (or null). By the time
  // the screenshot is taken the plate has repainted - prefer that reading so
  // the reply says who is actually highlighted.
  const liveName = ((state as Record<string, any>)?.textareas?.mainname as string | undefined) ?? null;
  // Cross-check / fallback: the column's own text areas hold the same list in two
  // halves (tgt_ll then tgt_lr). They are blank while the column is not up, which
  // is why reading them alone used to look broken.
  const nameCells = [((state as Record<string, any>)?.textareas?.tgt_ll as string | undefined) ?? '', ((state as Record<string, any>)?.textareas?.tgt_lr as string | undefined) ?? '']
    .join('\n').split('\n').map((line) => line.trim()).filter(Boolean);
  // No splice: a narrowing `every` would turn the array into null[] for the
  // compiler. Pick the source once instead.
  const resolved: Array<string | null> = names.some((name) => name !== null) || nameCells.length !== rows
    ? names
    : nameCells;
  const payload = {
    // Prefer the bitmask name: it is computed from the row, so it cannot be a
    // stale plate. liveName stays as a cross-check when the game does repaint.
    target: picked || liveName || result.name || null,
    targets: resolved.length ? resolved : undefined,
    confirmed: confirm === true,
    action: result,
    state
  };
  const shot = await autoShot();
  if (!shot) return asText(payload);
  return {
    content: [shot.image, { type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: { data: payload }
  };
}));

server.registerTool('gnosia_vote', {
  description: 'Vote for the person at `index`, in two explicit steps like every other panel: confirm=false (default) only moves the vote cursor and reports the cell it landed on - check cursor_reached, then call again with confirm=true to actually cast it. Get the list from gnosia_vote_list first; index is a position in the voting list and index 0 is usually yourself.',
  inputSchema: {
    index: z.number().int().min(0).max(30).describe('Row in the voting list (0-based); do not vote for yourself'),
    confirm: z.boolean().optional().describe('false (default) = only move the cursor; true = cast the vote'),
    visible_ms: z.number().int().min(0).max(5000).optional().describe('How long to hold the cursor on screen (default 900ms)')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ index, confirm, visible_ms }) => executeRaw(async () => {
  // Arriving with the confirm flag already raised means a press from the previous
  // screen leaked through - that is exactly how a run once cast a vote for row 0
  // with nobody picked. Clear the flag before moving the cursor, and report it.
  const probe = await pluginVoteProbe();
  const strayConfirm = probe.is_dicision === true;
  if (strayConfirm) {
    await pluginSetField('VoteScreen', 'isDicision', 'False');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // VoteScreen is a 6-row grid; SelectTarget is a no-op while the screen animates.
  // Confirming without checking therefore casts the vote for whatever row the
  // cursor was already on - which is how an earlier run silently voted for row 0.
  // Move, read back the landing cell, retry until it matches, then confirm.
  const wantX = Math.floor(index / 6);
  const wantY = index % 6;
  let moved: Record<string, unknown> = {};
  let reached = false;
  const attempts: Array<Record<string, unknown>> = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    moved = await pluginVoteMoveChecked(index);
    const gotX = Number(moved.select_x);
    const gotY = Number(moved.select_y);
    attempts.push({ attempt: attempt + 1, x: gotX, y: gotY });
    if (gotX === wantX && gotY === wantY) {
      reached = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const stay = visible_ms ?? 900;
  if (stay > 0) await dwell(stay);
  const pickShot = await autoShot();

  let action: Record<string, unknown> = { ...moved, cursor_reached: reached, attempts };
  if (confirm === true && !reached) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        index,
        confirmed: false,
        error: 'the vote cursor never reached that row (screen was animating); nothing was cast',
        attempts,
        state: await pluginState()
      }, null, 2) }],
      structuredContent: { data: { index, confirmed: false, reached, attempts } }
    };
  }
  if (confirm === true) {
    action = { moved, cursor_reached: reached, attempts, confirmed: await pluginVoteConfirm() };
    await new Promise((resolve) => setTimeout(resolve, 600));
    await waitFor({ mode: 'stable', quietMs: 400, timeoutMs: 3500 }).catch(() => null);
    await dwell(300);
  }
  const payload = {
    index,
    confirmed: confirm === true,
    stray_confirm_cleared: strayConfirm,
    next_step: confirm === true
      ? 'Vote cast.'
      : strayConfirm
        ? 'The confirm flag was already up when this screen opened (a leaked press). It has been cleared - check the list again and only confirm if the cursor is on the right person.'
        : 'Check cursor_reached and the cell; if it is the right person, call gnosia_vote again with confirm=true.',
    action,
    state: await pluginState()
  };
  const content: Array<Record<string, unknown>> = [];
  if (pickShot) content.push(pickShot.image);
  if (confirm === true) {
    const afterShot = await autoShot();
    if (afterShot) content.push(afterShot.image);
  }
  content.push({ type: 'text', text: JSON.stringify(payload, null, 2) });
  return {
    content,
    structuredContent: { data: payload }
  };
}));

server.registerTool('gnosia_step', {
  description: 'Advance exactly ONE line: press Enter once, wait, then report what appeared. It refuses to press when a choice is on screen - target column, vote grid, map, room, a yes/no dialog, or an open 发言 column - because Enter there means "confirm the highlight" or "say nothing this round", and pressing through those silently skips the scene. Use this instead of gnosia_advance whenever every line matters: one call, one line, then think.',
  inputSchema: {
    wait_ms: z.number().int().min(200).max(5000).optional().describe('How long to wait after the press (default 900ms)')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ wait_ms }) => execute(async () => {
  const before = await pluginState();
  const screens = await pluginScreens();
  const list = ((screens.screens as Array<Record<string, unknown>> | undefined) ?? []);
  const types = list.map((screen) => String(screen.type ?? ''));

  // A yes/no dialog needs an explicit answer, not Enter.
  if (types.includes('YesNoDialogScreen')) {
    const dialog = list.find((screen) => screen.type === 'YesNoDialogScreen');
    return {
      stopped: 'dialog',
      dialog: ((dialog?.areas as Record<string, string> | undefined)?.mes ?? ''),
      can_select: dialog?.can_select ?? null,
      hint: 'Answer it: /action/set?screen=YesNoDialogScreen&field=isYes|isNo&value=True. Nothing was pressed.'
    };
  }

  const blocking = await inputOwningScreens();
  if (blocking.length > 0) {
    return {
      stopped: 'screen_owns_input',
      blocked_by: blocking,
      hint: 'Answer this screen with its own tool (gnosia_vote / gnosia_ui / gnosia_target). Nothing was pressed.'
    };
  }

  const command = String((before?.command as string | undefined) ?? '').trim();
  if (command) {
    return {
      stopped: 'can_act',
      speaker: before?.speaker ?? null,
      text: before?.text ?? '',
      commands: command.split('\n').map((line) => line.trim()).filter(Boolean),
      hint: 'The 发言 column is open. Choosing nothing is also an option: gnosia_pass stays silent, gnosia_command picks a row. Nothing was pressed.'
    };
  }

  const previous = `${before?.speaker ?? ''}|${before?.text ?? ''}`;
  await pluginSystemButton(0, 50);
  await new Promise((resolve) => setTimeout(resolve, wait_ms ?? 900));
  const after = await pluginState();
  recordLine(after as { day?: number; speaker?: string | null; text?: string });
  const line = `${after?.speaker ?? ''}|${after?.text ?? ''}`;
  return {
    stopped: line === previous ? 'no_change' : 'advanced',
    speaker: after?.speaker ?? null,
    text: after?.text ?? '',
    changed: line !== previous,
    hint: line === previous
      ? 'Nothing moved. Something else is waiting - check gnosia_screens.'
      : 'Read it, then call gnosia_step again.'
  };
}));

server.registerTool('gnosia_watch', {
  description: 'Poll the game for N seconds and record every distinct line. For text that scrolls on its own (the opening crawl after 新游戏, or any auto-advancing scene) this is the only way to read it: a single Enter cuts the whole block. Press nothing while it runs.',
  inputSchema: {
    seconds: z.number().int().min(1).max(120).optional().describe('How long to watch (default 12s)')
  },
  outputSchema,
  annotations: annotations.read
}, async ({ seconds }) => execute(async () => {
  const end = Date.now() + (seconds ?? 12) * 1000;
  const lines: Array<{ speaker: string | null; text: string }> = [];
  let last = '';
  while (Date.now() < end) {
    const state = await pluginState(2000).catch(() => null);
    if (state) {
      const text = String(state.text ?? '');
      const speaker = (state.speaker as string | null) ?? null;
      const key = `${speaker ?? ''}|${text}`;
      if (key !== last && (text || speaker)) {
        lines.push({ speaker, text });
        last = key;
        recordLine(state as { day?: number; speaker?: string | null; text?: string });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return {
    watched_seconds: seconds ?? 12,
    count: lines.length,
    lines,
    hint: lines.length <= 1
      ? 'Only one line appeared: the scene is waiting for a press, not scrolling. Use gnosia_step.'
      : 'These were all shown without pressing anything.'
  };
}));

server.registerTool('gnosia_map', {
  description: 'The night map (Move2Screen): every room you can walk to tonight, where it sits on the screen, and whether it carries the 感叹号 marker. That marker is a data bit, not a guess - `placeUsed[placeId] & 128` - and it means "something happens in this room tonight". Rooms with 255 in placeUsed are closed tonight. Call this before picking a room instead of pressing through the map: the map owns its cursor, and entering walks into whatever row 0 is.',
  inputSchema: {
    include_names: z.boolean().optional().describe('Walk the cursor over each room to read its real name (default true). Takes ~3s and puts the cursor back afterwards.')
  },
  outputSchema,
  annotations: annotations.read
}, async ({ include_names }) => execute(async () => {
  const dump = await pluginDump('application.Move2Screen');
  if (dump.has_instance !== true) {
    return {
      map_screen: false,
      note: 'The night map is not up right now. It only exists at night, after the 告别 and the "X was put into cold sleep" notice.'
    };
  }
  const fields = (dump.instance_fields ?? {}) as Record<string, { v?: unknown }>;
  const selectList = ((fields.selectList?.v as number[] | undefined) ?? []).map(Number);
  const placeXY = ((fields.placeXY?.v as string[] | undefined) ?? []);
  const placeDesc = ((fields.placeDesc?.v as string[] | undefined) ?? []);
  const usedRaw = await pluginPath('gnosia.GameData', 'placeUsed');
  const used = ((usedRaw.value as number[] | undefined) ?? []).map(Number);

  const parseXY = (text: string | undefined): [number, number] => {
    const hit = /\(([-0-9.]+),\s*([-0-9.]+)\)/.exec(text ?? '');
    return hit ? [Number(hit[1]), Number(hit[2])] : [0, 0];
  };

  const rooms = selectList.map((placeId, slot) => {
    const [x, y] = parseXY(placeXY[placeId]);
    const bits = Number(used[placeId] ?? 0);
    return {
      place_id: placeId,
      slot,
      x,
      y,
      reachable: true,
      event: (bits & 128) !== 0,
      used_bits: bits,
      description: (placeDesc[placeId] ?? '').replace(/\n/g, ' ').trim().slice(0, 80),
      name: null as string | null
    };
  });

  // Position labels: y grows downwards in this map's local coordinates, so the
  // smallest y is the top row. Verified against the room the player called
  // "top-left" (place 5 at 162,139).
  // Ranks, not min/max thirds: the rooms are not on a regular grid, so a third of
  // the pixel range puts unrelated rooms in the same band. With 9 rooms this is
  // 3 per row and 3 per column, which is what the map actually looks like.
  const byY = [...rooms].sort((a, b) => a.y - b.y);
  const byX = [...rooms].sort((a, b) => a.x - b.x);
  const bandOf = (sorted: typeof rooms, room: (typeof rooms)[number]) => {
    const pos = sorted.findIndex((item) => item.place_id === room.place_id);
    return Math.min(2, Math.floor((pos * 3) / sorted.length));
  };
  for (const room of rooms) {
    (room as Record<string, unknown>).corner = `${['上', '中', '下'][bandOf(byY, room)]}${['左', '中', '右'][bandOf(byX, room)]}`;
  }

  const originalTgt = Number(fields.selectTgt?.v ?? -1);
  const originalX = Number(fields.selectX?.v ?? 0);
  if (include_names !== false) {
    for (const room of rooms) {
      await pluginSetField('Move2Screen', 'selectX', String(room.slot));
      await pluginSetField('Move2Screen', 'selectTgt', String(room.place_id));
      await pluginCall0('Move2Screen', 'MoveCursor');
      await new Promise((resolve) => setTimeout(resolve, 200));
      // /screens returns only the area KEYS; /areas is the key -> value map.
      const areasRes = await pluginAreas();
      const map = ((areasRes.screens as Array<Record<string, unknown>> | undefined) ?? [])
        .find((screen) => screen.type === 'Move2Screen');
      const pname = ((map?.areas as Record<string, unknown> | undefined)?.pname ?? '') as string;
      if (typeof pname === 'string' && pname.trim()) room.name = pname.trim();
    }
    if (originalTgt >= 0) {
      await pluginSetField('Move2Screen', 'selectX', String(originalX));
      await pluginSetField('Move2Screen', 'selectTgt', String(originalTgt));
      await pluginCall0('Move2Screen', 'MoveCursor');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const state = await pluginState();
  const role = String(((state as Record<string, unknown> | null)?.role_cn ?? '') || ((state as Record<string, unknown> | null)?.role ?? ''));

  // Who is standing in which room. The 感叹号 alone cannot tell "夕里子's counter"
  // from "someone else's story event" - she uses the same marker. The occupant can:
  // 夕里子 is a person in the room, and the room is hers because she is in it, not
  // because of where it sits on the map. Position was the wrong key: the top-centre
  // room sometimes hosts somebody else's mandatory story beat.
  const crew = (((state as Record<string, unknown> | null)?.crew as Array<{ name?: string }> | undefined) ?? []);
  const occupantsByPlace = new Map<number, string[]>();
  for (let i = 0; i < crew.length; i += 1) {
    const res = await pluginPath('gnosia.GameData', `chara.${i}.place`);
    const place = Number(res.value);
    if (!Number.isFinite(place) || place === 255) continue;
    const list = occupantsByPlace.get(place) ?? [];
    const who = String(crew[i]?.name ?? `chara ${i}`);
    list.push(who);
    occupantsByPlace.set(place, list);
  }

  for (const room of rooms) {
    const occupants = occupantsByPlace.get(room.place_id) ?? [];
    (room as Record<string, unknown>).occupants = occupants;
    if (!room.event) continue;
    if (occupants.includes('夕里子')) {
      // One room, one person, but two different things under the same 感叹号:
      // her standing service (respec / event-CG replay) and one main-line scene.
      // Do NOT try to tell them apart in code - the marker carries nothing that
      // separates them. Just say what the room can be, and rely on the fact that
      // within one save the nature does not flip: once it has been the service,
      // it stays the service for that save.
      (room as Record<string, unknown>).kind = 'yoriko';
      (room as Record<string, unknown>).note = '夕里子的房间：可能是洗点 / 事件 CG 回放（特殊功能），也可能是她的一次主线剧情。同一存档里一旦触发过特殊功能，之后都会是特殊功能，可以不去；还没确认过就进去看一眼。';
    } else {
      (room as Record<string, unknown>).kind = 'story';
    }
  }

  // Nothing is filtered out any more: a room that looks like 夕里子's counter can
  // still be a mandatory story beat, and swallowing it silently is how a run gets
  // stuck. Both kinds stay in the list, tagged.
  const eventRooms = rooms.filter((room) => room.event);
  return {
    map_screen: true,
    day: (state as Record<string, unknown> | null)?.day ?? null,
    role: role || null,
    rooms,
    event_rooms: eventRooms.map((room) => ({ place_id: room.place_id, slot: room.slot, name: room.name, corner: (room as Record<string, unknown>).corner })),
    hint: eventRooms.length
      ? `今晚有 ${eventRooms.length} 个带感叹号的房间：${eventRooms.map((room) => {
        const label = room.name ?? ('place ' + room.place_id);
        const kind = (room as Record<string, unknown>).kind;
        return kind === 'yoriko' ? `${label}（夕里子房，见 note）` : label;
      }).join('、')}。要进去就先写 selectX=slot、selectTgt=place_id、MoveCursor()，再 isDicision=true。`
      : '今晚没有带感叹号的房间。',
    note: 'event = placeUsed[placeId] & 128；255 = 今晚不开放。occupants 是该房间当前的人（chara[i].place），夕里子所在且带感叹号的房间 kind=yoriko（只作提醒，不作区分），其余 kind=story。两类都保留，不做屏蔽。'
  };
}));

server.registerTool('gnosia_vote_list', {
  description: 'Who can be voted for right now, in voting-screen order, plus the running tally. Use it before gnosia_vote. Only meaningful while the vote screen is up (gnosia_screens reports VoteScreen).',
  inputSchema: {},
  outputSchema,
  annotations: annotations.read
}, async () => execute(async () => {
  const names = ['namelist0', 'namelist1', 'namelist2'];
  const screens = await pluginScreens();
  const up = (screens.screens as Array<{ type: string }> | undefined)?.some((s) => s.type === 'VoteScreen') ?? false;
  const state = await pluginState();
  const areas = (state?.textareas ?? {}) as Record<string, string>;
  const rows: Array<{ index: number; name: string }> = [];
  for (const key of names) {
    const chunk = areas[key];
    if (!chunk) continue;
    for (const line of chunk.split('\n')) {
      const name = line.trim();
      if (name) rows.push({ index: rows.length, name });
    }
  }
  return { vote_screen: up, voters: rows, note: up ? 'Pick with gnosia_vote {index}.' : 'No vote screen on display right now.' };
}));

server.registerTool('gnosia_screens', {
  description: 'List the screens currently on display with their cursor state (title, save slots, room menu, voting, data panels...). Use it with gnosia_ui to drive menus without clicking: this is how title/load/room navigation is done.',
  inputSchema: {},
  outputSchema,
  annotations: annotations.read
}, async () => execute(() => pluginScreens()));

server.registerTool('gnosia_ui', {
  description: 'Move the cursor on any screen and optionally confirm, by calling that screen\'s own SelectTarget/Enter logic. Covers every menu: TitleScreen (0 新游戏, 1 继续游戏), LoadSlotScreen (0..2 save slots), MyRoomScreen, VoteScreen, DataScreen. For YesNoDialogScreen (二选一, yes_no:true in gnosia_screens) index 0 = 是 and index 1 = 否; call once with confirm:false to light the button, then again with confirm:true. Get the screen name and select_max from gnosia_screens first.',
  inputSchema: {
    screen: z.string().min(3).describe('Screen type name from gnosia_screens, e.g. TitleScreen, LoadSlotScreen or YesNoDialogScreen'),
    index: z.number().int().min(0).max(64).describe('Item index to highlight; on YesNoDialogScreen 0 = 是, 1 = 否'),
    confirm: z.boolean().optional().describe('Also confirm the selection (default false = only move the cursor)')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ screen, index, confirm }) => execute(async () => {
  const result = await pluginUi(screen, index, confirm === true);
  await new Promise((resolve) => setTimeout(resolve, confirm ? 1500 : 400));
  const screens = await pluginScreens();
  return { action: result, screens };
}));

server.registerTool('gnosia_areas', {
  description: 'Every text label of every screen on display, as key -> string. This is the cheapest way to read what is written on a screen: dialogue, choices, save-slot summaries, character-creation fields, the 初期条件設定 numbers, tutorial bodies. Prefer it over gnosia_screenshot - it cannot be stale, costs nothing, and keeps the exact characters. gnosia_screens only returns the KEY names; this returns the values.',
  inputSchema: {},
  outputSchema,
  annotations: annotations.read
}, async () => execute(() => pluginAreas()));

server.registerTool('gnosia_field', {
  description: 'Read one field by dotted path, with numbers indexing into lists/arrays: "chara.3.yaku", "baseData.takashiAbil", "placeUsed". Type defaults to gnosia.GameData; any live screen type works too (application.MakeLoopScreen -> "yakuNum"). This is how to see per-character roles, claim flags, and the setting screens\' arrays without a screenshot or a field dump.',
  inputSchema: {
    type: z.string().optional().describe('Type or screen name, default gnosia.GameData (e.g. application.MakeLoopScreen)'),
    path: z.string().min(1).describe('Dotted field path, e.g. chara.0.p_yaku or baseData.takashiSex')
  },
  outputSchema,
  annotations: annotations.read
}, async ({ type, path }) => execute(() => pluginPath(type ?? 'gnosia.GameData', path)));

server.registerTool('gnosia_field_write', {
  description: 'Write one top-level field on a live screen (plugin /action/set). Meant for control flags the game itself consumes, e.g. isEnter (confirm on SexSelWindow / ColorSelWindow / TakashiSetScreen), selectX + selectTgt before MoveCursor, isDicision. It writes data, NOT the picture: if the screen only repaints from its own handler, the display will lag behind the value - prefer the screen\'s own mover (gnosia_ui / gnosia_call) whenever one exists.',
  inputSchema: {
    screen: z.string().min(3).describe('Screen name as gnosia_screens reports it, e.g. TakashiSetScreen'),
    field: z.string().min(1).describe('Top-level field name, e.g. isEnter'),
    value: z.string().describe('Value as text; converted to the field type (true/false, numbers, enum names)')
  },
  outputSchema,
  annotations: annotations.risky
}, async ({ screen, field, value }) => execute(() => pluginSetField(screen, field, value)));

server.registerTool('gnosia_call', {
  description: 'Call a method on a live screen directly, without any real input: index omitted -> a no-argument method (arg reaches a one-string overload); index given -> a method that takes ONE int, with the screen\'s own Input.GetMouseButtonDown answer armed so the same handler runs as a real press. Use it for handlers no other tool covers, e.g. MakeLoopScreen EnterTriButton(2 = 身份左移 / 3 = 身份右移), or InputFieldEndEdit on the creation screen. This is not a mouse click: no coordinates, no cursor, no window focus.',
  inputSchema: {
    screen: z.string().min(3).describe('Screen name from gnosia_screens'),
    method: z.string().min(1).describe('Method name, e.g. EnterTriButton or InputFieldEndEdit'),
    index: z.number().int().min(0).max(64).optional().describe('Argument for a (int) method; omit for a no-arg method'),
    arg: z.string().optional().describe('String argument for a one-string overload (only when index is omitted)')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ screen, method, index, arg }) => execute(async () => {
  const result = index === undefined
    ? await pluginCall0(screen, method, arg)
    : await pluginCallInt(screen, method, index);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { action: result, areas: await pluginAreas() };
}));

server.registerTool('gnosia_setup', {
  description: 'Write the 初期条件設定 (MakeLoopScreen: 人数 / 古诺希亚 / 每个职业 / 你的身份) and repaint it through the game\'s own CountMura + SetButtons + ChangeNum. `roles` is comma-separated BY ARRAY INDEX, not by the order shown on screen: 0 unused, 1 工程师, 2 医生, 3 守护天使, 4 留舰者, 5 乘客 (derived - leave it out), 6 BUG, 7 古诺希亚, 8 AC主义者. So "15 people, 6 Gnosia, every role once" = people:15, gnosia:6, roles:"0,1,1,1,1,0,1,6,1". `self` is an index into yakuSelect [0,5,7,1,2,3,4,6,8]: 0 = 随机, 1 = 乘客, 2 = 古诺希亚. Caveat: the 你的身份 label only repaints when the screen switches identity - see the playbook for the two-click trick.',
  inputSchema: {
    people: z.number().int().min(5).max(15).optional(),
    gnosia: z.number().int().min(0).max(15).optional().describe('Gnosia count; also lands in yakuNum[7]'),
    roles: z.string().optional().describe('Per-index counts, e.g. "0,1,1,1,1,0,1,6,1"'),
    self: z.number().int().min(0).max(8).optional().describe('Index into yakuSelect: 0 随机, 1 乘客, 2 古诺希亚')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ people, gnosia, roles, self }) => execute(async () => {
  const result = await pluginSetup({ people, gnosia, roles, self });
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { action: result, areas: await pluginAreas() };
}));

server.registerTool('gnosia_setabil', {
  description: 'Set the six starting stats on the character-creation screen and repaint the panel through the screen\'s own SetText. values is comma-separated in stat order, e.g. "8,7,5,5,5,5"; left is the unspent point counter (0 when every point is spent). Writing the array on its own leaves the old numbers on screen - this tool refreshes both abil and abilleft.',
  inputSchema: {
    values: z.string().describe('Six comma-separated stats, e.g. 8,7,5,5,5,5'),
    left: z.number().int().min(0).max(30).optional().describe('Remaining points, normally 0')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ values, left }) => execute(async () => {
  const result = await pluginSetAbil(values, left);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { action: result, areas: await pluginAreas() };
}));

server.registerTool('gnosia_setinput', {
  description: 'Write a text input on a screen (e.g. the name field on TakashiSetScreen) through the field\'s own setter, without stealing the keyboard. Follow it with gnosia_call {method:"InputFieldEndEdit", arg:"<same text>"} to commit the value to the screen.',
  inputSchema: {
    screen: z.string().min(3).describe('Screen name, e.g. TakashiSetScreen'),
    text: z.string().describe('Text to put in the input field')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ screen, text }) => execute(async () => {
  const result = await pluginSetInput(screen, text);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { action: result, areas: await pluginAreas() };
}));

server.registerTool('gnosia_close_panel', {
  description: 'Clear a leftover command column (the five lines that keep floating after a window closed) the way the game itself does, by pressing 发言 while no window is being offered. It refuses while a real window is open, because there the press would act on your turn. force:true falls back to writing the screen flags directly - that hides the panel background but does NOT clear its text, so only use it when nothing is drawn.',
  inputSchema: {
    force: z.boolean().optional().describe('Write the screen flags instead of the game-native clean-up (leaves the command text in place)')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ force }) => executeRaw(async () => {
  const result = force ? await pluginClose() : await pluginFlushCommands();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const state = await pluginState();
  const shot = await autoShot();
  const payload = {
    action: result,
    phase: (await pluginPhase()) ?? null,
    state: state
      ? {
        day: state.day,
        command: state.command,
        select: (state.interface as Record<string, unknown> | undefined)?.select,
        select_num0: (state.interface as Record<string, unknown> | undefined)?.select_num0,
        round_sprites: (state.interface as Record<string, unknown> | undefined)?.round_visible_sprites
      }
      : null
  };
  if (!shot) return asText(payload);
  return {
    content: [shot.image, { type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: { data: payload }
  };
}));

server.registerTool('gnosia_key', {
  description: 'Send real keystrokes to the game window. LAST RESORT, and it steals focus from whatever the user is typing: the plugin covers dialogue (gnosia_advance / gnosia_step), commands (gnosia_speak + gnosia_command), targets (gnosia_target), votes (gnosia_vote) and every menu (gnosia_ui) without touching the keyboard. Keys: enter, space, esc, tab, up/down/left/right, backspace, pageup/pagedown, home/end, ctrl, shift, alt, a-z, 0-9, f1-f12.',
  inputSchema: {
    keys: z.union([z.string(), z.array(z.string())]).describe('One key, or a chord/sequence such as ["down","enter"]'),
    repeat: z.number().int().min(1).max(40).optional(),
    hold_ms: z.number().int().min(10).max(1000).optional(),
    settle_ms: z.number().int().min(0).max(5000).optional()
  },
  outputSchema,
  annotations: annotations.act
}, async ({ keys, repeat, hold_ms, settle_ms }) => execute(() => sendKeys(keys, { repeat, holdMs: hold_ms, settleMs: settle_ms })));

server.registerTool('gnosia_advance', {
  description: 'Advance the meeting one line at a time. Before every press it checks two things: whether a command window is really drawn (`select >= 0`, stops with stopped_because "can_act" and window.kind = round | report | reply), and whether the current screen owns its own cursor (vote / map / room / dialog / menu - stops with "screen_owns_input" and lists them in blocked_by). Enter on one of those means "confirm the highlighted row", and the highlight starts at row 0: pressing through is how a vote once got cast for row 0 before anyone was picked, and how the map walked straight into the player\'s own room. Those screens must be answered with gnosia_vote / gnosia_ui, never by advancing. Stopping is NOT a recommendation to speak: at a round window both 发言 and silence are legal, and silence costs no 注意度. When the 发言 button is up but the list has not been opened, it stops with window.kind = "speak" and presses nothing - call gnosia_speak to open the list, then read the rows and pick.',
  inputSchema: {
    max_presses: z.number().int().min(1).max(60).optional(),
    key: z.string().optional(),
    quiet_ms: z.number().int().min(100).max(3000).optional().describe('How long the screen must stay unchanged to count as settled (default 380ms).'),
    stop_on_no_change: z.number().int().min(1).max(3).optional(),
    pass_window: z.boolean().optional().describe('Deprecated and ignored: generic reply-window passing is unsafe because closed-list Enter can select row 0. Use gnosia_pass only at a ROUND window.')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ max_presses, key, quiet_ms, stop_on_no_change, pass_window }) => execute(() => advance({
  maxPresses: max_presses,
  key,
  quietMs: quiet_ms,
  stopOnNoChange: stop_on_no_change,
  passWindow: pass_window
})));

server.registerTool('gnosia_pass', {
  description: 'Stay silent for one ROUND. It presses Enter once WITHOUT opening the 发言 list, the game\'s own "say nothing this round" path: no command is committed and 注意度 does not rise. Use it only when gnosia_advance stopped with window.kind = "round". It refuses reply/report/speak prompts: in a reply window closed-list Enter can select the first row instead of declining.',
  inputSchema: {},
  outputSchema,
  annotations: annotations.act
}, async () => execute(async () => {
  // Same rule as advance: on a screen that owns its cursor, Enter confirms the
  // highlighted row (row 0 = yourself at the vote). Silence must never do that.
  const blocking = await inputOwningScreens();
  if (blocking.length > 0) {
    return {
      passed: false,
      refused: true,
      reason: `Enter means "confirm the highlighted row" on ${blocking.map((s) => s.type).join(', ')}, so nothing was pressed.`,
      blocked_by: blocking,
      hint: 'Answer this screen explicitly: gnosia_vote after gnosia_vote_list, gnosia_ui for a dialog or menu.',
      state: await pluginState()
    };
  }
  // Do not use windowNow() here: its fallback probe presses W, which would open
  // the very list that passing is supposed to leave closed. The current state
  // already carries the speak button, cursor and ROUND sprites we need.
  const before = await pluginState();
  const iface = (before?.interface ?? {}) as Record<string, unknown>;
  const speak = (iface.speak ?? {}) as { button_visible?: boolean; menu_open?: boolean };
  const select = Number(iface.select ?? -1);
  const offered = speak.button_visible === true || speak.menu_open === true || (Number.isFinite(select) && select >= 0);
  const phase = typeof iface.now_phase === 'number' ? iface.now_phase : null;
  const currentWindow = actWindow(before ?? null, readRows(before ?? null), offered, phase);
  if (speak.menu_open === true || (Number.isFinite(select) && select >= 0)) {
    return {
      passed: false,
      refused: true,
      reason: 'The 发言 list is open; Enter would confirm its highlighted row instead of passing.',
      window_before: currentWindow,
      hint: 'Choose explicitly with gnosia_command, or close the list before calling gnosia_pass.',
      state: before
    };
  }
  if (currentWindow.kind !== 'round') {
    return {
      passed: false,
      refused: true,
      reason: currentWindow.kind === 'report'
        ? 'A 报告 window is mandatory; staying silent is not a valid substitute.'
        : currentWindow.kind === 'reply'
          ? 'A reply window can treat closed-list Enter as its first row, so passing here is unsafe.'
          : 'No ROUND silence window is active, so nothing was pressed.',
      window_before: currentWindow,
      hint: 'Use gnosia_speak and gnosia_command to answer explicitly, or gnosia_advance to reach a ROUND window.',
      state: before
    };
  }
  // /action/advance deliberately refuses when the 发言 button is visible. Pass
  // is the explicit exception: after the guards above, send one short virtual
  // Enter directly, with the list closed, to take the game's own silence path.
  const result = await pluginSystemButton(0, 50);
  await new Promise((resolve) => setTimeout(resolve, 600));
  return {
    passed: result.ok === true,
    window_before: currentWindow,
    press: result,
    hint: result.ok === true
      ? 'Stayed silent. Nothing was committed, so attention did not rise.'
      : 'The input hook did not accept the press; nothing was committed.',
    state: await pluginState()
  };
}));

server.registerTool('gnosia_menu', {
  description: 'Open the in-game system menu (读取 / 存档 / 技能 / 玩法 / 返回标题). Deliberately gated: the game only expects the system key while the 菜单 button is actually drawn, and pressing it while a script is still running can cut the scene short. So this refuses unless state.interface.buttons.menu is true - call gnosia_advance until the dialogue settles and the buttons appear. Normal play should never need force.',
  inputSchema: {
    force: z.boolean().optional().describe('Press the system key even when the 菜单 button is not on screen. Diagnostics only - it can break the scene that is playing.')
  },
  outputSchema,
  annotations: annotations.act
}, async ({ force }) => execute(async () => {
  const before = await pluginState();
  const iface = (before?.interface ?? {}) as Record<string, unknown>;
  const buttons = (iface.buttons ?? {}) as Record<string, boolean>;
  if (!buttons.menu && force !== true) {
    return {
      opened: false,
      refused: true,
      reason: 'the 菜单 button is not on screen right now',
      buttons,
      hint: 'Call gnosia_advance until the dialogue settles - the button is drawn when the game is really waiting for input. Firing the system key mid-script can skip or break the scene, so this tool will not do it unless you pass force.'
    };
  }
  const press = await pluginSystemButton(6);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const screens = await pluginScreens();
  const list = (screens.screens as Array<{ type: string }> | undefined) ?? [];
  return {
    opened: list.some((s) => s.type === 'GameMenuScreen'),
    forced: !buttons.menu,
    buttons,
    press,
    screens: list.map((s) => s.type),
    state: await pluginState()
  };
}));

const DOA_CN: Record<string, string> = {
  doa_Seizon: '存活',
  doa_Shokei: '已处刑（投票出局）',
  doa_Kamare: '被咬死（夜间被杀）',
  doa_Cold: '冷冻睡眠中',
  doa_Dead: '死亡'
};

const ROLE_CN: Record<string, string> = {
  y_Murabito: '船员',
  y_Uranai: '工程师',
  y_Reibai: '医生',
  y_Kari: '守护天使',
  y_Kyojin: 'AC追随者',
  y_Jinro: '古诺希亚',
  y_Fox: '虫(BUG)',
  y_Lover: '留舰者',
  y_Unknown: '未知'
};

server.registerTool('gnosia_log', {
  description: 'Transcript of this run as the server saw it: every line that appeared while advancing, in order, with the speaker. The game has no 记录/回放 screen (menu is 读取 / 技能 / 设置 / 玩法 / 返回标题), so this is the only way to look back at "who said what". It only contains lines that were actually advanced through, and it resets when the MCP process restarts.',
  inputSchema: {
    limit: z.number().int().min(1).max(400).optional(),
    speaker: z.string().optional().describe('Only lines from this speaker, e.g. 塞思')
  },
  outputSchema,
  annotations: annotations.read
}, async ({ limit, speaker }) => execute(async () => {
  // The game does have a short replay: Tab opens MessageLogScreen, whose testlog
  // text area holds the real, complete last lines (speaker on its own line, then
  // the sentence). That is strictly better than our own buffer when it is open,
  // so prefer it and fall back to the advance-time transcript otherwise.
  const screens = await pluginScreens();
  const list = (screens.screens as Array<{ type: string }> | undefined) ?? [];
  if (list.some((screen) => screen.type === 'MessageLogScreen')) {
    const state = await pluginState();
    const raw = ((state?.textareas ?? {}) as Record<string, string>).testlog ?? '';
    const crew = (state?.crew as Array<{ name: string }> | undefined) ?? [];
    const names = new Set(crew.map((person) => person.name));
    const parsed: Array<{ speaker: string | null; text: string }> = [];
    let current: string | null = null;
    for (const line of raw.split('\n')) {
      const clean = line.replace(/<[^>]*>/g, '').trim();
      if (!clean) continue;
      if (names.has(clean)) {
        current = clean;
        continue;
      }
      // 括号里的是主角内心独白，不属于上一个说话人。
      const aside = /^（.*）$/.test(clean);
      parsed.push({ speaker: aside ? null : current, text: clean });
    }
    const kept = speaker ? parsed.filter((row) => row.speaker === speaker) : parsed;
    return {
      source: 'MessageLogScreen（游戏自带回放，Tab 打开）',
      total_recorded: parsed.length,
      filtered_by: speaker ?? null,
      lines: kept.slice(-(limit ?? 40)),
      note: '这是游戏自己的记录，比 advance 缓冲更全。关闭 Tab 面板后就回退到缓冲区。'
    };
  }
  return {
    source: 'advance 缓冲',
    total_recorded: transcriptSize(),
    filtered_by: speaker ?? null,
    lines: readTranscript(limit ?? 40, speaker),
    note: '游戏回放面板（Tab）没开着，所以用的是 advance 时攒下的记录；打开 Tab 面板再调一次可以拿到更完整的历史。'
  };
}));

server.registerTool('gnosia_board', {
  description: 'What the Q (当前状况) and E (当前设定) panels show, as data: the roster with who is still alive / frozen / dead, which role each person has publicly claimed, what your own investigation found about each person (工程师/医生 results), your own role, and this round\'s settings (head count + which roles are in play). Read this instead of holding Q and squinting at the screen. It never reveals hidden roles - only what the panels would legitimately show you.',
  inputSchema: {},
  outputSchema,
  annotations: annotations.read
}, async () => execute(async () => {
  const state = await pluginState();
  const crew = (state?.crew as Array<{ id: number; name: string; state: string }> | undefined) ?? [];
  const claim: string[] = [];
  for (let i = 0; i < crew.length; i++) {
    const got = await pluginPath('gnosia.GameData', `chara.${i}.p_yaku`);
    const raw = got.ok ? String(got.value ?? '') : '';
    claim.push(ROLE_CN[raw] ?? raw ?? '');
  }
  const seenRaw = await pluginPath('gnosia.GameData', 'chara.0.knowledge');
  const seen = Array.isArray(seenRaw.value) ? (seenRaw.value as string[]) : [];
  const counts: Record<string, unknown> = {};
  for (const field of ['aliveNum', 'deadNum', 'coldNum']) {
    const got = await pluginPath('gnosia.GameData', field);
    if (got.ok) counts[field] = got.value;
  }
  const yakuRaw = await pluginPath('gnosia.GameData', 'yakuAliveNum');
  const yaku = Array.isArray(yakuRaw.value) ? (yakuRaw.value as Array<number | string>) : [];
  const ROLE_ORDER = ['（未使用）', '工程师', '医生', '守护天使', '留舰者', '船员', 'AC追随者', '古诺希亚', '虫(BUG)'];
  const inPlay = yaku
    .map((n, i) => ({ role: ROLE_ORDER[i] ?? String(i), count: Number(n) }))
    .filter((row) => row.count > 0 && row.role !== '（未使用）');

  return {
    day: state?.day ?? null,
    my_role: state?.role_cn ?? null,
    counts,
    settings: { total: crew.length, roles_in_play: inPlay },
    people: crew.map((person, i) => ({
      index: i,
      name: person.name,
      status: DOA_CN[person.state] ?? person.state,
      claimed: claim[i] || null,
      my_investigation: seen[i] && seen[i] !== 'y_Unknown' && i !== 0 ? (ROLE_CN[seen[i]] ?? seen[i]) : null
    })),
    confirmed_gnosia: crew
      .map((person, i) => (i !== 0 && seen[i] === 'y_Jinro' ? person.name : null))
      .filter((name): name is string => Boolean(name)),
    note: 'claimed = 头像右上角（自报身份，可能说谎，且每天重置）；my_investigation = 头像左下角（自己查到的结果，仅工程师与医生有值；查到「人类」不会落库，所以只有确认古诺希亚时这里才有内容）。'
  };
}));

server.registerTool('gnosia_wait', {
  description: 'Wait on the game: mode "stable" until the picture stops changing (text finished typing, transition done), mode "change" until anything changes, mode "duration" for a fixed sleep.',
  inputSchema: {
    mode: z.enum(['stable', 'change', 'duration']),
    quiet_ms: z.number().int().min(100).max(5000).optional(),
    timeout_ms: z.number().int().min(500).max(120000).optional(),
    duration_ms: z.number().int().min(50).max(120000).optional(),
    region: z.string().optional()
  },
  outputSchema,
  annotations: annotations.read
}, async ({ mode, quiet_ms, timeout_ms, duration_ms, region }) => execute(() => waitFor({
  mode, quietMs: quiet_ms, timeoutMs: timeout_ms, durationMs: duration_ms, region
})));

server.registerTool('gnosia_frames', {
  description: 'Capture a short burst of frames and return them as one labelled contact sheet (#1..#N). Another last-resort visual tool: it is several megabytes and only worth it for motion that carries no text - a transition, a sprite whose position is the answer. Any line that vanished can be read from gnosia_log or gnosia_areas instead.',
  inputSchema: {
    count: z.number().int().min(2).max(9).optional(),
    interval_ms: z.number().int().min(80).max(5000).optional(),
    region: z.string().optional(),
    scale: z.number().min(0.1).max(1).optional()
  },
  outputSchema,
  annotations: annotations.read
}, async ({ count, interval_ms, region, scale }) => executeRaw(async () => {
  const result = await frames({ count, intervalMs: interval_ms, region, scale });
  const file = String(result.path ?? '');
  if (!file) return asText(result) as ToolResult;
  const { default: fs } = await import('node:fs');
  return {
    content: [
      { type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify(result, null, 2) }
    ],
    structuredContent: { data: result }
  };
}));

server.registerTool('gnosia_quit', {
  description: 'Close GNOSIA gracefully with WM_CLOSE (Steam notices the exit). Set force:true only when the game ignores the close request.',
  inputSchema: {
    force: z.boolean().optional(),
    timeout_ms: z.number().int().min(2000).max(60000).optional()
  },
  outputSchema,
  annotations: annotations.risky
}, async ({ force, timeout_ms }) => execute(() => quitGame({ force, timeoutMs: timeout_ms })));

server.registerTool('gnosia_health', {
  description: 'Diagnose the whole pipeline: host process, game process, window, capture method, black-frame risk, Steam executable. Use it when a screenshot looks stale or the plugin stops answering.',
  inputSchema: {},
  outputSchema,
  annotations: annotations.read
}, async () => execute(async () => {
  const checks: Array<Record<string, unknown>> = [];
  const info = await gameInfo();
  checks.push({ name: 'platform', ok: process.platform === 'win32', detail: process.platform });
  checks.push({ name: 'steam_exe', ok: Boolean(info.steam_exe), detail: info.steam_exe ?? 'not found' });
  checks.push({ name: 'host_script', ok: Boolean(info.host_script_exists), detail: info.host_script });

  let state: Record<string, unknown> = {};
  try {
    state = await windowState() as unknown as Record<string, unknown>;
  } catch (error) {
    checks.push({ name: 'host', ok: false, detail: (error as Error).message });
  }
  checks.push({ name: 'game_process', ok: Boolean((info.pids as number[]).length), detail: info.pids });
  checks.push({
    name: 'window',
    ok: Boolean(state.running) && Number(state.client_width ?? 0) > 0,
    detail: state.running ? `${state.client_width}x${state.client_height} at ${state.client_x},${state.client_y}${state.minimized ? ' (minimized)' : ''}` : 'no window'
  });

  const plugin = await pluginPing();
  checks.push({
    name: 'plugin',
    ok: plugin.up,
    detail: plugin.up
      ? { port: loadConfig().pluginPort, response: plugin.body }
      : `${loadConfig().pluginPort}: ${plugin.error ?? 'no answer'} (exact state unavailable, screenshots still work)`
  });

  if (state.running) {
    try {
      const probe = await capture({ region: 'full', scale: 0.25 });
      const black = probe.meta.mean_luma < 3;
      checks.push({ name: 'capture', ok: !black, detail: { method: probe.meta.capture_method, mean_luma: probe.meta.mean_luma, size: `${probe.meta.width}x${probe.meta.height}` } });
      if (black) {
        checks.push({ name: 'capture_hint', ok: false, detail: 'Frames are nearly black: focus the window, or start the game in borderless/windowed mode instead of exclusive fullscreen.' });
      }
    } catch (error) {
      checks.push({ name: 'capture', ok: false, detail: (error as Error).message });
    }
  }

  const failed = checks.filter((check) => check.ok === false);
  return {
    ok: failed.length === 0,
    failed: failed.map((check) => check.name),
    checks,
    host: host.diagnostics,
    next_steps: failed.length === 0 ? [] : [
      'gnosia_launch if the process is missing',
      'gnosia_focus if the window exists but is minimized or unfocused',
      'gnosia_status for raw geometry'
    ]
  };
}));

server.registerTool('gnosia_notes_read', {
  description: 'Read your running scratchpad for the current session: current loop, role, suspicions, claims made by each crew member, plan for the next vote.',
  inputSchema: {},
  outputSchema,
  annotations: annotations.read
}, async () => execute(() => readNotes()));

server.registerTool('gnosia_notes_write', {
  description: 'Update the session scratchpad. GNOSIA is a deduction game that spans many loops, so write down who claimed what, who lied, and what you still need to check.',
  inputSchema: {
    content: z.string().min(1).max(16000),
    mode: z.enum(['replace', 'append']).optional()
  },
  outputSchema,
  annotations: annotations.act
}, async ({ content, mode }) => execute(() => writeNotes({ content, mode })));

server.registerTool('gnosia_memory_read', {
  description: 'Read long-term knowledge about this game that survives across sessions (character facts, role patterns, meta-progression unlocks). Optional query filters by key, value or tag.',
  inputSchema: { query: z.string().max(100).optional() },
  outputSchema,
  annotations: annotations.read
}, async ({ query }) => execute(() => readMemory(query)));

server.registerTool('gnosia_memory_write', {
  description: 'Store or update one durable fact, e.g. key "Setsu", value "remembers previous loops and can be trusted", tags ["character"].',
  inputSchema: {
    key: z.string().min(1).max(80),
    value: z.string().min(1).max(2000),
    tags: z.array(z.string().max(30)).max(8).optional()
  },
  outputSchema,
  annotations: annotations.act
}, async ({ key, value, tags }) => execute(() => writeMemory({ key, value, tags })));

server.registerTool('gnosia_memory_delete', {
  description: 'Delete one long-term knowledge entry by key.',
  inputSchema: { key: z.string().min(1).max(80) },
  outputSchema,
  annotations: annotations.act
}, async ({ key }) => execute(() => deleteMemory(key)));

server.registerTool('gnosia_journal_read', {
  description: 'Read the tail of the gameplay journal: a timestamped list of what the agent observed and decided.',
  inputSchema: { last_n: z.number().int().min(1).max(200).optional() },
  outputSchema,
  annotations: annotations.read
}, async ({ last_n }) => execute(() => readJournal(last_n)));

server.registerTool('gnosia_journal_append', {
  description: 'Append one entry to the gameplay journal. Use it for loop results, votes, night results and mistakes worth not repeating.',
  inputSchema: {
    text: z.string().min(1).max(600),
    type: z.enum(['loop', 'vote', 'observation', 'decision', 'error', 'milestone']).optional()
  },
  outputSchema,
  annotations: annotations.act
}, async ({ text, type }) => execute(() => appendJournal({ text, type })));

server.registerTool('gnosia_lore', {
  description: 'The four-screen introduction that plays once after a new save is created - the game\'s own statement of why anyone is frozen, why the destination is forced, and what the compression self-destruct means. Read it before the first loop; it is the frame every later rule hangs on. Returns all four screens plus the play-relevant notes. While the crawl is actually on screen the live copy is in gnosia_areas (title / title2 / title3 / title4).',
  inputSchema: {
    screen: z.number().int().min(1).max(4).optional().describe('Only one screen (1-4). Omit for all four.'),
    notes_only: z.boolean().optional().describe('Return only the play-relevant summary, skip the verbatim text')
  },
  outputSchema,
  annotations: annotations.read
}, async ({ screen, notes_only }) => execute(async () => {
  const screens = notes_only === true
    ? []
    : LORE_INTRO.filter((entry) => screen === undefined || entry.screen === screen);
  const areas = await pluginAreas().catch(() => null);
  return {
    total_screens: LORE_INTRO.length,
    screens,
    notes: LORE_NOTES,
    live: areas
  };
}));

server.registerTool('gnosia_skills', {
  description: 'The 30 指令 (commands) the 发言 list can offer, with the game\'s own description of each: what it does, which stats it scales with, and what it costs you. Call with no arguments for the table of contents (name + requirement only, 30 rows); pass index for one entry in full; pass query to search names and bodies. Read the contents once at the start of a run, then look up a single entry when it actually appears in the command list - do not pull all 30 bodies into context. This is the only source for command descriptions: ignore state.command_list, which is just the 指令一览 panel\'s two-column text and empty everywhere else.',
  inputSchema: {
    index: z.number().int().min(0).max(29).optional().describe('One command by its index in the 指令一览 list (0-based)'),
    query: z.string().optional().describe('Keyword in the name or description, e.g. 怀疑 / 注意度 / 逻辑性'),
    full: z.boolean().optional().describe('Also return the full body for every match (expensive - only when you really need it)')
  },
  outputSchema,
  annotations: annotations.read
}, async ({ index, query, full }) => execute(async () => {
  if (index !== undefined) {
    const entry = SKILLS.find((skill) => skill.index === index);
    return entry ?? { ok: false, error: `no skill with index ${index} (0..29)` };
  }
  const needle = (query ?? '').trim();
  const hits = needle.length === 0
    ? SKILLS
    : SKILLS.filter((skill) => [skill.name, skill.requirement ?? '', ...skill.lines].join('\n').includes(needle));
  const rows = hits.map((skill) => ({
    index: skill.index,
    name: skill.name,
    requirement: skill.requirement,
    ...(full === true ? { lines: skill.lines } : {})
  }));
  return {
    mode: needle.length === 0 && full !== true ? 'contents' : 'search',
    total: SKILLS.length,
    matches: rows.length,
    skills: rows,
    hint: 'Pass index for one command in full. The command list you can actually pick from at a given moment is in gnosia_state / gnosia_speak.'
  };
}));

server.registerTool('gnosia_tutorial', {
  description: 'The game\'s own 玩法 (HELP) text: all 46 pages across 5 chapters, verbatim. Call with no arguments for the full table of contents (46 titles only - cheap). Then read the one page you need with chapter+page, or search with query. Rules questions (注意度, 身份, 能力值, 议论的细则, 夜间环节, FAQ) should be answered from here, not from memory.',
  inputSchema: {
    query: z.string().optional().describe('Keyword to search in page titles and bodies, e.g. 注意度 / 隐蔽性 / 投票.'),
    chapter: z.number().int().min(1).max(5).optional().describe('1 基本规则, 2 界面说明, 3 故事的推进方法, 4 常见问题１, 5 常见问题２'),
    page: z.number().int().min(1).max(12).optional(),
    limit: z.number().int().min(1).max(46).optional().describe('Max matches to return (default 8)'),
    full: z.boolean().optional().describe('Return the whole page body for every match instead of a two-line preview')
  },
  outputSchema,
  annotations: annotations.read
}, async ({ query, chapter, page, limit, full }) => execute(async () => {
  const needle = (query ?? '').trim();
  const chapters = TUTORIAL.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.chapter] = (acc[entry.chapter] ?? 0) + 1;
    return acc;
  }, {});
  // No filter at all = table of contents. Titles only: the point is to let the
  // caller choose a page without paying for 46 bodies it will not read.
  if (needle.length === 0 && chapter === undefined && page === undefined) {
    return {
      mode: 'contents',
      total: TUTORIAL.length,
      chapters,
      contents: TUTORIAL.map((entry) => ({
        chapter: entry.chapter,
        chapter_index: entry.chapter_index,
        page: entry.page,
        title: entry.title
      })),
      hint: 'Read one page with chapter+page, or search with query.'
    };
  }
  let hits = TUTORIAL.filter((entry) => {
    if (chapter !== undefined && entry.chapter_index !== chapter) return false;
    if (page !== undefined && entry.page !== page) return false;
    if (needle.length === 0) return true;
    const haystack = [entry.title, ...entry.body].join('\n');
    return haystack.includes(needle);
  });
  const total = hits.length;
  if (hits.length > (limit ?? 8)) hits = hits.slice(0, limit ?? 8);
  return {
    mode: 'pages',
    query: needle || null,
    total_matches: total,
    returned: hits.length,
    chapters,
    pages: hits.map((entry) => ({
      chapter: entry.chapter,
      chapter_index: entry.chapter_index,
      page: entry.page,
      title: entry.title,
      body: full === true ? entry.body : entry.body.slice(0, 2)
    }))
  };
}));

server.registerPrompt('gnosia_playbook', {
  title: 'How to play GNOSIA through this server',
  description: 'Game rules, the control loop, and a tactic checklist for playing GNOSIA with gnosia-mcp.'
}, async () => ({
  messages: [{
    role: 'user',
    content: { type: 'text', text: PLAYBOOK }
  }]
}));

await server.connect(new StdioServerTransport());
console.error(`gnosia-mcp ${SERVER_VERSION} listening on stdio (config: ${JSON.stringify({ steam_app_id: loadConfig().steamAppId })})`);

const shutdown = () => {
  try { void host.shutdown(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
