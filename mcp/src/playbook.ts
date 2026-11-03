export const PLAYBOOK = `# GNOSIA — operating manual for this MCP server

You are playing GNOSIA (Petit Depotto, Steam app id 1608290) through an in-process BepInEx plugin.
The plugin exposes the game's own objects, so role, day, speaker, dialogue, selectable commands,
roster and the night map are read as data — never OCR'd from a picture — and every action is the
screen's own handler being called, not synthetic input. The game UI on this machine is Chinese.

## 0. Read data, not pixels

There is a strict order of trust. Work down it, and only fall to the next row when the one above
genuinely cannot answer.

| Need | Use |
| --- | --- |
| role / day / speaker / dialogue / commands | \`gnosia_state\` |
| which screens are up, cursors, yes_no flags | \`gnosia_screens\` |
| any text written on a screen | \`gnosia_areas\` |
| one array or per-character field | \`gnosia_field\` |
| night map, roster, vote grid, transcript | \`gnosia_map\` / \`gnosia_board\` / \`gnosia_vote_list\` / \`gnosia_log\` |
| what a command does, what it costs | \`gnosia_skills\` — **never** \`command_list\` |
| rules | \`gnosia_tutorial\` |
| portraits, art, layout, a marker's position | \`gnosia_screenshot\` |

Screenshots are the last row for a reason: a full frame is ~1 MB, it competes for context with the
text that actually matters, and **a window that is not foreground hands back the last frame it
presented** — a picture that looks perfectly valid and is minutes old. Never screenshot to read the
day counter, the speaker, the dialogue, the command rows, a name, a vote tally or a setting value:
all of those are in \`gnosia_state\` / \`gnosia_areas\` / \`gnosia_field\` as exact strings.

## 0.1 Do not drive this game with a mouse

There is no click tool, on purpose. A click needs absolute coordinates, a foreground window and a
live cursor, and it breaks the moment the user touches the machine. Every panel here has a tool
that calls that screen's own \`SelectTarget\` / \`EnterSelect\` handler, which keeps working while the
window is in the background:

- menus, title, save slots, dialogs → \`gnosia_ui\`
- a method no tool covers (e.g. \`EnterTriButton\`) → \`gnosia_call\`
- a control flag the game consumes itself → \`gnosia_field_write\`

\`gnosia_key\` sends real keystrokes and **steals focus from whatever the user is typing**. It exists
for the case where the plugin truly cannot reach something; say so before using it.

If you find a screen that no tool can drive, report it — do not "just click for now".

## 0.2 One press, then think

A confirm is a decision, not a step. Press once, read what came back, then decide. Never chain
presses to see what happens, and never bundle open + pick + confirm into one call: every attempt at
bundling made the panel flash past the human watching, and sometimes burned the turn.

## 1. What the game is

GNOSIA is a social-deduction (werewolf-like) game wrapped in a time loop. A crew is trapped on a
ship; some of them have been replaced by "Gnosia", aliens that imitate people. Each loop you are
handed a role, argue, vote someone into cold sleep, survive the night, and repeat until one side
wins.

Roles (中文 / English):
- 船员 / Crew — no power. Win by removing every Gnosia.
- 古诺希亚 / Gnosia — kill one crew member each night. Win when the crew can no longer outvote them.
- 工程师 / Engineer — each night scans one person and learns whether that person is Gnosia.
- 医生 / Doctor — each night autopsies one cold-slept body and learns whether it was Gnosia.
- 守护天使 / Guardian Angel — each night protects one person from the Gnosia attack.
- AC追随者 / AC Follower — a human who sides with the Gnosia and wins with them.
- 虫 / BUG — a third faction. It wins by still being alive when the game ends; everyone else
  loses to it. It only appears in some loops.

Loop shape:
1. 议论 / Discussion — several rounds of statements, accusations and role claims. You pick a
   stance or a claim from the 发言 menu.
2. 投票 / Vote — the room cold-sleeps one person; majority decides. Cold sleep is elimination,
   not death, and it is the crew's only weapon.
3. 夜 / Night — Gnosia attack; Engineer scans; Doctor autopsies; Guardian Angel protects.
4. Morning: the body is announced, results come back, next discussion starts.
The loop ends when one faction has won. Stats and meta-progression persist across loops.

## 2. Screen map (stock 1920x1080 borderless window)

- Top-left: 第N天 — the day counter.
- Top-right buttons: 发言 [W] (open the statement/claim menu), 参考数据 [A] (open the reference panel).
- Bottom-left: NAME box with the current speaker.
- Bottom: the dialogue text, with [Enter] in the bottom-right corner.
- 发言 menu: a list of statements you can make, with 确定 [Enter] to confirm and 返回 [Z] to cancel.
  Arrow keys / mouse move the highlight.
- 参考数据 panel: on the left your own 身份 (role, e.g. BUG), 关系好的人 / 关系差的人; on the right
  the buttons 航行日志 (ship log), 工程师报告 (engineer report), 投票结果 (vote results),
  医生报告 (doctor report), 乘客信息 (crew roster), plus 关闭信息 [A] and 返回 [Z].
  This panel is how you read the roster, the vote record and the dead players' reports — use it.
- Esc does nothing inside these panels; use A (close) or Z (back) instead.
- The dialogue box moves between scenes (sometimes centred, sometimes bottom-anchored). That is a
  layout fact, not a reason to screenshot: \`gnosia_state.text\` / \`gnosia_areas\` hold the same lines
  wherever the box is drawn.

## 3. Control loop (do this, in this order)

**Everything is driven through the plugin. Do not use the mouse.** The plugin calls the game's own
handlers, so nothing depends on window focus, coordinates, or where the physical cursor happens to be.

0. **Orientation, once per session** — three cheap reads before the first press:
   - \`gnosia_lore\` — the four-screen introduction: cold sleep, the 0.78 line, the forced
     destination, the compression self-destruct. It is the frame every later rule hangs on.
   - \`gnosia_skills\` — **contents only**: the 30 指令 by name + requirement. Read a body
     (\`{index}\`) when that command actually shows up in your list, not before.
   - \`gnosia_tutorial\` — **contents only**: the 46 help pages by title. Read a page
     (\`{chapter, page}\`) when a rule is in question.
   These are tables of contents, not reading homework. Pulling all 30 bodies and all 46 pages
   "just in case" costs more context than a whole day of play and buries the state you need.
1. \`gnosia_status\` — is the game running? \`gnosia_launch\` if not (Steam pipeline).
2. \`gnosia_state\` — exact state from memory, not OCR:
   - \`role_cn\` (虫(BUG), 船员, 古诺希亚 ...), \`day\` / \`day_text\`
   - \`speaker\` / \`text\` — who said what, verbatim
   - \`crew[]\` — every person with \`state\` (\`doa_Seizon\` alive, \`doa_Shokei\` cold-slept)
   - \`interface.speak\` — \`{button_visible, menu_open, options[]}\`. The 发言 button is the game's
     own "you may speak now"; \`options\` is what the list contains once W has opened it.
     \`button_visible:true, menu_open:false\` = the list exists but is **closed** — and Enter on
     that screen does not advance, it answers with the highlighted row.
   - \`window.live\` — true when the ROUND counter is drawn **or** the 发言 button is up. Do not
     read \`nowPhase\` as a UI flag: it is the scene's script phase number, starts at 255 and
     counts up through an ordinary day.
   - \`textareas\` — every on-screen label; \`skl\` is the command you last used
3. \`gnosia_advance\` — advances dialogue one line at a time, inside the process.
   It **stops before pressing** the moment any command row is offered
   (\`stopped_because: "can_act"\`, plus \`window.kind\`):
   - \`round\` — one of the five formal rounds, ROUND n/5 on screen, eight standing commands
   - \`report\` — a 报告 window. No ROUND counter, but it is mandatory: skipping it changes how
     the rest of the day plays out.
   - \`speak\` — the 发言 button is up but the list has not been opened. **This is the most
     commonly missed stop.** It happens in ordinary story dialogue (塞思 asks a question), not
     only in the five rounds. Do not press Enter: call \`gnosia_speak\` (it presses W), read the
     rows, and pick one.
   - \`reply\` — someone just spoke and you may react (few rows: 反驳 / 寻求同意 / 一起袒护 ...).
     Optional, and it is not your formal turn.
   Call it repeatedly; never press Enter yourself on a discussion screen.
4. **Your turn** (any of the three window kinds). Three separate presses, in this order,
   one tool call each - never merge them:
   - \`gnosia_speak\` — press 发言, returns the exact command rows for this round
   - \`gnosia_command {index}\` — press that row (e.g. 怀疑). This tool refuses to open the list
     itself: if 发言 is not open it tells you to call \`gnosia_speak\` first. Judge the result from
     \`target_list_open\` and the returned row names, not from a picture (auto-capture is off by
     default). Commands that need a target (怀疑/袒护/投票给此人) open the target column
     automatically - that is the game's own doing, not a shortcut.
   - \`gnosia_target {index, confirm:false}\` — press the person (e.g. 吉娜): moves the highlight and
     returns the name, so you can check who you are about to accuse. Then repeat with \`confirm:true\`.
   - There are five rounds per day. Not speaking forfeits the round, so always act.
   - **Vote phase** (\`gnosia_screens\` shows VoteScreen): \`gnosia_vote_list\` gives the order
     (index 0 is you - never vote for yourself), then \`gnosia_vote {index}\` to move the cursor,
     check \`cursor_reached\`, then \`gnosia_vote {index, confirm:true}\` to actually cast it.
     After the tally the game may open a runoff among tied names; vote again the same way.
5. **Menus** (title, save slots, room, vote, data panels): \`gnosia_screens\` → \`gnosia_ui\`.
   e.g. \`{screen:"TitleScreen", index:1, confirm:true}\` = 继续游戏,
   then \`{screen:"LoadSlotScreen", index:0, confirm:true}\` = first save.
   Reading the slots: \`gnosia_state.textareas\` has \`slot0/1/2\` with name, loop count and date.
   **二选一 (YesNoDialogScreen)**: \`gnosia_screens\` marks it \`yes_no:true\`. Answer with
   \`gnosia_ui {screen:"YesNoDialogScreen", index:0}\` (是) or \`index:1\` (否) - confirm:false first
   lights the button, then the same call with \`confirm:true\`. **Never press Enter here**: 是 is
   wired to the same action as Enter, so a blind advance answers 是 for you.
6. \`gnosia_close_panel\` — escape hatch if a panel looks wrong.
7. Record: \`gnosia_journal_append\`, keep \`gnosia_notes_write\` current.

Hard rules:
- **Never blind-press on a discussion screen.** Enter there forfeits your round. Use \`gnosia_advance\`
  (which self-guards) and act only via \`gnosia_speak\` + \`gnosia_command\`.
- **One press per tool call.** 发言 → command row → target person are three separate calls. Every
  attempt to bundle them (open+pick in one shot, or pick+target+confirm) made the panel flash past
  the human watching and sometimes wasted the round. Do not look for a shortcut tool; there is none.
- Opening 发言 is a toggle: one frame opens it, another closes it. \`gnosia_speak\` already handles this;
  do not press 发言 twice.
- **Command lines that stay on screen after the window is gone.** The five rows are drawn from four
  text areas that only the game's own \`UnvisibleCommands()\` clears; the frame loop just hides the
  panel background. So anything that "closes" the window by writing \`select = -1\` leaves the lines
  floating forever. \`gnosia_close_panel\` avoids this by pressing 发言 (the game's own path) and it
  refuses while a real window is open. Never use \`force: true\` unless nothing is drawn at all.
- **A screenshot of a backgrounded window can be a stale frame.** Windows stops compositing it and
  hands back the last frame it presented - the picture then looks perfectly valid and is minutes old.
  \`capture.meta.maybe_stale\` flags it. When a capture disagrees with the plugin, trust the plugin
  (\`window.live\`, the command rows) or call \`gnosia_focus\` for a guaranteed fresh frame.
- In the game, 发言 only sets \`isSpeak\` and 确定 only sets \`isDicision\`. They are independent -
  that is why a commit must never touch \`isSpeak\`, or the list reopens right after the pick.
- \`select\` in the game is the *column* (0 = commands, 1 = targets) and is recomputed from the
  physical mouse. Only \`selectPos[column]\` (the row) matters — that is what \`gnosia_command\` writes.
- **Voting is a two-axis grid** (\`selectTgt = selectX*6 + selectY\`). \`gnosia_vote\` goes through the
  screen's own \`SelectTarget(x,y)\`, so the cursor really lands on the person. Never write
  \`selectTgt\` by hand: the vote would count while the marker stayed on someone else.
- **Every panel here has its own mover that refuses a no-op.** If you write the target field first,
  the game's \`PointerEnter*\`/\`SelectTarget\` sees "no change" and returns without redrawing - the
  screen then shows the old selection while the action uses the new one. Always let the game move
  the cursor, never pre-write it.
- If a command needs a target and you skip it, the statement is wasted. Always finish with
  \`gnosia_target confirm:true\`.
- \`gnosia_key\` still exists but needs the window focused (it steals focus, which interrupts the
  user's typing). Use it only when the plugin genuinely cannot do the job, and tell the user first.

## 4. Deduction checklist

At the start of each loop:
- Read your own 身份 in 参考数据 before anything else. Your entire strategy depends on it.
- Note the roster from 乘客信息, and check \`gnosia_memory_read\` for what you learned about them.

During discussion:
- Keep a claim table: who claimed 工程师 / 医生 / 守护天使, and who contradicted them.
- Two people claiming the same unique role means at least one is Gnosia or the AC Follower.
- Silence is information: crew under pressure accuse; Gnosia steer the vote without leading it.
- Prefer voting out the person whose story does not fit, not the loudest accuser.

As crew-side roles:
- Engineer: scan the person whose story is hardest to verify; announce early enough to matter.
- Doctor: a confirmed Gnosia body validates a whole accusation chain — check 医生报告 every day.
- Guardian Angel: protect the person whose information the crew needs tomorrow, not yourself.

As Gnosia:
- Vote with the majority on a crew member, never defend a partner directly.
- Let a crew member build a case for you; agreeing with a wrong accusation is cheaper than inventing one.

As AC Follower:
- You win with the Gnosia. Protect them by lending credibility to their claims, not open defence.

As BUG:
- You win by surviving. Vote with whoever is winning, avoid becoming the swing vote that gets
  investigated next, and never draw attention to being unaligned.

## 4.5 注意度: why silence is the default

The in-game 玩法 says it plainly (基本规则 → 议论的细则(注意度), and 常见问题１ 第 1 条):
every 发言 raises 注意度, 怀疑/袒护 raise it the most, and a player who talks too much is
the one people suspect. Letting it fall to zero is also dangerous - a completely silent
player gets suspected too - so the target is "speak when you have information, otherwise
stay quiet".

- A stop at a round window is a **choice**, not an instruction to speak. \`gnosia_pass\` is the
  silence path: Enter without opening the list, nothing committed, no 注意度.
- Rough budget: five rounds with ~15 people means a fair share is 1-2 lines a day. Speaking
  in three rounds straight reads as 太啰嗦.
- Spend a line only when it buys something: a role claim, a vote target, or a rebuttal that
  prevents a wrong freeze. "Just chatting" is never free.
- Read the source instead of guessing: \`gnosia_tutorial\` has all 46 pages of the in-game help
  (search by keyword, or read a chapter/page). 注意度, 能力值, 身份, 夜间环节, FAQ are all there.

## 4.6 The system key: only when the menu button is drawn

\`action=6\` is a system key, not a global "menu" key. InterfaceScreen reads it as
"open the system menu"; TakashiSetScreen reads the very same button as "finish
character creation"; GameMenuScreen reads it as "activate the highlighted row".

Open the menu with \`gnosia_menu\`, which refuses unless the 菜单 button is really on
screen (\`state.interface.buttons.menu\`). Mechanically the menu opens whenever the
script queue is empty and the SE state is idle, but those moments also occur inside
transitions the game does not expect to be interrupted - firing the key there can
cut a scene short, which is exactly how a run gets broken. So: advance until the
buttons appear, then open the menu. The raw press route still exists for
diagnostics; normal play must not use it.

## 4.7 Enter is not "next" on a screen that owns its cursor

The meeting is one screen (InterfaceScreen) where Enter means "next line". The
vote grid, the map, MyRoomScreen, target pickers, dialogs and the menus are a
different kind of screen: there Enter means **confirm the highlighted row**, and
the highlight starts at row 0 - yourself at the vote, your own room on the map.

"Advancing" into one of those is how two runs went wrong: a vote was cast for
row 0 before anybody was picked, and the map walked straight into the player's
own room so the night was spent trying to get back out.

Two rules follow:

- \`gnosia_advance\` refuses to press on those screens and returns
  \`stopped_because: "screen_owns_input"\` with the list in \`blocked_by\`. That is
  a stop, not a failure: answer the screen explicitly - \`gnosia_vote\` after
  \`gnosia_vote_list\`, \`gnosia_ui\` for dialogs and menus. On MyRoomScreen the rows
  are 0 睡觉 / 1 指令一览 / 2 升级 / 3 退出房间.
- the virtual button itself is capped at two frames. Every screen polls the same
  "is this button held" query, so a long hold outlives the screen that needed it
  and is read by the next one as a fresh press.

If \`gnosia_vote\` reports \`stray_confirm_cleared: true\`, the confirm flag was
already up when the vote screen opened - a leaked press. Trust the cursor report
(\`cursor_reached\`) before confirming, and check the tally afterwards.

## 4.8 The night map: 感叹号 is a data bit

At night the game asks where to go. The map draws a 感叹号 over rooms that have
something in them tonight. That marker is readable without looking at pixels:

- \`placeUsed\` is a 32-byte array indexed by **place id**. \`255\` = the room is
  closed tonight; anything below that = you may walk in.
- \`(placeUsed[placeId] & 128) != 0\` = this room has an event tonight (the 感叹号).
- \`placeXY[placeId]\` / \`placeDesc[placeId]\` are also indexed by place id, not by
  the room's slot in the list - mixing those two up produces coordinates of
  \`(0,0)\` and descriptions that belong to another room.

Call \`gnosia_map\` instead of reading this by hand: it returns every open room with
its name, its nine-grid corner, and whether it carries the marker.

One exception worth knowing: 夕里子's room carries the same marker. It can be her
counter (respec / event-CG replay) or one specific main-line scene, and nothing in
the data separates the two - so do not try to decide it in code. \`gnosia_map\` only
tags it \`kind: "yoriko"\` with a reminder and **keeps it in** \`event_rooms\`.

What does settle it: within one save the nature does not flip. Once that room has
been the service, it stays the service for the rest of that save and can be
skipped; until it has been seen once, walk in and look.

The key is the occupant, not the position. \`chara[i].place\` says who is standing
where; a room whose occupants include 夕里子 is hers, and the very same room with
somebody else in it is an ordinary story event.

Walking into a room is three writes, because \`SelectTarget(place, slot)\` takes two
arguments and the call route only carries one: \`selectX = slot\`,
\`selectTgt = place_id\`, \`MoveCursor()\`, then \`isDicision = true\`.

## 4.9 The target column is faces, not names

After a command like 怀疑 the game asks who. That column draws portraits and does
not always repaint the name plate, so reading \`mainname\` gives the speaker, the
previous target, or nothing.

The rows come from a bitmask instead. \`peopleFlg[1]\` (or \`[0]\` when the action
needs everybody) has one bit per character, and row *n* is the *n*-th set bit
counted from 1 - exactly the loop \`LookTargetChara\` runs. \`gnosia_target\` returns
the whole list as \`targets\` plus the picked name, so pick by name, not by index
arithmetic.

\`gnosia_map\` and this both read \`gnosia.Data.Chara\` for the id -> name table.
\`gnosia.GameData\` has no such static field; asking the wrong type yields an empty
map and every row comes back null.

## 4.10 Character creation (TakashiSetScreen)

Reached from 标题 → 新游戏 (0) → CreateSlotScreen (slot 0/1/2) → 覆盖? 是. Everything below is data
writes plus the screen's own handlers - no typing, no clicking.

\`selectTgt\` packs a two-axis cursor: \`<10\` is the name row (0 name, 1 sex), \`10..69\` is the stat
grid (tens digit = row+1, ones digit = column), \`70\` is the colour chip, \`71\` is 开始. Confirm
(\`isEnter\`) branches on it: 1 opens \`SexSelWindow\`, 70 opens \`ColorSelWindow\`, 71 opens the
\`RegistWindow\` 确定 dialog.

1. \`gnosia_setinput {screen:"TakashiSetScreen", text:"<name>"}\`
2. \`gnosia_call {screen:"TakashiSetScreen", method:"InputFieldEndEdit", arg:"<name>"}\`
   — this is what commits the name into the \`namae\` text area. Without it the box shows the name
   while \`namae\` stays empty.
3. Sex: \`gnosia_ui {screen:"TakashiSetScreen", index:1, confirm:false}\` then
   \`gnosia_field_write {screen:"TakashiSetScreen", field:"isEnter", value:"true"}\`.
   In \`SexSelWindow\` rows are 0 男 / 1 女 / 2 泛: move with \`gnosia_ui\`, commit with
   \`gnosia_field_write {field:"isEnter"}\`.
4. Colour: \`gnosia_ui {screen:"TakashiSetScreen", index:70}\` + \`isEnter\` →
   \`ColorSelWindow\` is 3 rows x 4 columns, moved by \`SelectTarget(x,y)\`. \`gnosia_ui\` encodes its
   index as \`x*6+y\`, so pass \`index: x*6+y\` (e.g. 蓝 = column 2, row 1 → 13). Colours in order:
   红 橙 黄 黄绿 / 绿 青 蓝 紫 / 粉 棕 黑 白. Commit with \`isEnter\`.
5. Stats: \`gnosia_setabil {values:"8,7,5,5,5,5", left:0}\`. The screen only repaints its number column
   from its own +/- handler, so writing \`takashiAbil\` alone leaves 5/5/5/5/5/5 on screen while the
   save already holds the new numbers - this tool repaints both labels.
6. Start: \`gnosia_field_write {screen:"TakashiSetScreen", field:"isStart", value:"true"}\` →
   \`RegistWindow\` appears → \`gnosia_ui {screen:"RegistWindow", index:0, confirm:true}\` (0 是, 1 否).
   Do **not** press the system key (action 6) here: on this screen it is not "menu", it is "finish".

After 是 the opening crawl plays. It has four text areas - \`title\`, \`title2\`, \`title3\`, \`title4\` -
and \`gnosia_areas\` returns the first three in one call. It auto-advances, so read it, do not screenshot
it, and do not press through it.

## 4.11 初期条件設定 (MakeLoopScreen)

The per-loop setup screen. \`gnosia_setup\` writes it and calls the game's own \`CountMura\` +
\`SetButtons\` + \`ChangeNum\`, so 人数 / 古诺希亚 / 有-没有 all repaint.

\`yakuNum\` is indexed by role enum, **not** by the order shown on screen:

\`\`\`
0 unused   1 工程师   2 医生   3 守护天使   4 留舰者
5 乘客 (derived)   6 BUG   7 古诺希亚   8 AC主义者
\`\`\`

\`CountMura\` computes \`yakuNum[5] = people - yakuNum[1..4] - yakuNum[6] - yakuNum[7] - yakuNum[8]\`;
\`ChangeNum\` writes the 人数 line as \`people + "\\n" + yakuNum[7]\`. So "15 people, 6 Gnosia, every
role once" is \`people:15, gnosia:6, roles:"0,1,1,1,1,0,1,6,1"\` → 6 + 6 + 3 乘客.

**你的身份 is the one label that does not follow the data.** It is rewritten only when the screen
switches identity, so writing \`self\` leaves the old role on screen. The screen's own switcher is
\`EnterTriButton(2)\` = left, \`(3)\` = right, and it moves exactly one step per call - it only keeps
walking while the landed role has count <=0 and the index is >0. \`yakuNum[5]\` is rewritten to the
total every frame, so 乘客 always has a count and always stops the walk. To reach 随机 (index 0):

1. \`gnosia_call {method:"EnterTriButton", index:2}\` until the label reads 乘客 (index 1),
2. call it **once more** — the step from 1 to 0 lands on 随机 and repaints,
3. then \`gnosia_setup\` with the real role counts and **without \`self\`**, so the index is not reset.

Useful indices: 0 随机, 1 乘客, 2 古诺希亚; \`yakuSelect = [0,5,7,1,2,3,4,6,8]\`.

## 4.12 The 发言 button: speaking and passing are both decisions

The 发言 [W] button in the top-right corner means "you may say something now". It is **not**
limited to the five discussion rounds — it also appears in ordinary story dialogue, e.g. when
塞思 asks 你认为应当把人类从这个宇宙中消灭吗？.

| input | what it does |
| --- | --- |
| W (action 3) | opens the speech list. Nothing is committed. This is the only way the list appears. |
| Enter with the list OPEN | confirms the highlighted row. |
| Enter at a ROUND window with the list CLOSED | declines to speak and lets the discussion continue. |
| Enter at a reply window, even with the list CLOSED | can select the first row; never use it as a generic pass. |

A blind Enter is therefore not "next": depending on the window it either answers for the player
or chooses silence. Both layers stop \`advance\` when the button is up so neither choice happens
by accident:

- the plugin's \`/action/advance\` returns \`stopped_because: "screen_owns_input"\` with
  \`blocked_by:["speak_available"]\` when the button is up, and presses nothing;
- the MCP's \`gnosia_advance\` reports the window kind and presses nothing.

At a **ROUND** stop, choose explicitly: \`gnosia_pass\` to stay silent, or
\`gnosia_speak\` → read \`items\` → \`gnosia_command {index}\` to speak. \`gnosia_pass\` sends
one short Enter directly rather than calling the guarded advance route, and never probes with W.
At a **reply**, ordinary \`speak\` or mandatory \`report\` prompt it refuses; answer those explicitly.
The old \`advance(pass_window:true)\` reply shortcut is disabled: testing showed that a closed
reply list can still consume Enter as its first row.

**Do not read \`command_list\` at all.** It is the 指令一览 (GameMenuSkillScreen) two-column list —
left/right are the 18 visible rows of that panel, and it is empty everywhere else, which is why it
looked "broken" during a discussion. Nothing needs it:

- the 30 command descriptions → \`gnosia_skills\` (already recorded in full, contents + body)
- the list you can actually pick from right now → \`state.command\` / \`interface.speak.options\`

Reading \`command_list\` as "the commands I can use" is what made the stop condition say "never".

## 5. Persistence






- \`gnosia_notes_write\` — the current loop: role, claims, suspicions, next vote plan. Overwrite freely.
- \`gnosia_memory_write\` — durable facts that should outlive the session: character behaviour,
  confirmed tells, unlocked events, loop conditions you are chasing.
- \`gnosia_journal_append\` — append-only history of what happened and what you decided.

Start every session with \`gnosia_memory_read\` and \`gnosia_notes_read\`; finish each loop with a
journal entry. GNOSIA rewards players who remember what happened twenty loops ago.`;
