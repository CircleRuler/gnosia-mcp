# GNOSIA 逆向笔记（Assembly-CSharp.dll）

用 `dnfile` 读元数据、`dncil` 反 IL，对象是 `Gnosia_Data\Managed\Assembly-CSharp.dll`
（Unity Mono，3.5 MB，**1017 个类型 / 15048 个方法**）。目的：给 BepInEx 插件找钩子点，
把「听截图」换成「读对象」。

## 结论一览

| 要知道什么 | 从哪读 | 备注 |
| --- | --- | --- |
| 游戏全局存档状态 | `gnosia.Data.gd` → `gnosia.GameData` | **static public 字段**，直接拿实例 |
| 自己的身份 | `GameData.shujinkoYaku`（主人公役） | 名字直译就是「主角役」 |
| 天数 / 进度 | `GameData.nissiList` | 日次列表 |
| 可选的发言/行动 | `GameData.actions` / `actionsDid` / `actionsCanSelect` | `actionsCanSelect` 就是当前能选的项 |
| 在场名单 | `GameData.chara`、`personFromId`、`GetNameList()` | `chara` 是角色表 |
| 好感/信任矩阵 | `GameData.b_trust` / `b_hate` / `b_love` / `ba_*` / `GetInsideTrust()` | 数值全在这 |
| 当前台词文本 | `coreSystem.TextArea` 实例的 `strList` / `strNowList` | `TextArea` 是打字机本身 |
| 文本是否打完 | `TextArea.Finished()`、`GetChanged()` | 比我现在的像素 diff 精确得多 |
| 说话人 + 文本 + 历史 | `application.MessageLog` 的 `mesLogName_now` / `mesLogText_now` / `mesLogDialog_now` | 现成的对话记录 |
| 人狼推理 | `gnosia.Jinro`（`CheckJinro` / `IsBlack` / `IsWhite` / `CheckHatan` / `GetRate`） | 游戏自己的推理函数 |

## 关键类型

**`gnosia.Data`** — 静态入口，4 个 static public 字段：

```
sp, gd, Chara, Scenario
```

`gd` 即当前这局的 `GameData`，`Chara` 是角色定义表，`Scenario` 是剧本引擎。

**`gnosia.GameData`** — 109 个字段的存档态，重要的：

```
shujinkoYaku            自己的身份
nissiList               日次
actions / actionsDid / actionsCanSelect   发言与可选项
chara / personFromId    在场角色
knowTable               已知信息表
b_trust / b_hate / b_love / ba_*          关系矩阵
stateFlg / actionFlg / actionDoIt          状态位
```

方法里有一批有用的：`GetNameList()`、`GetAttr/GetAbil/GetHp`、`GetFriend()`、
`GetInsideTrust()`、`GainHate/RecalHate`、`RecalAllYakuBias`。

**`coreSystem.TextArea`** — 打字机组件（MonoBehaviour），字段：

```
textBase, textSpriteList, strList, strNowList, skip, maxLine, nowLine,
maxLength, changeArray, visible, font, size, logType, showTime, waitAfterHyoji
```

方法：`SetText`、`ClearText`、`SetVisible`、`Finished`、`GetChanged`、`SetTextarea`、
`UpdateText`。`Finished()` 直接告诉我「这段字打完了没有」。

**`application.MessageLog`** — 消息记录：

```
canLogMessage, lastLogType, mesLogText, mesLogText_now, mesLogName_now,
mesLogDialog_now, maxLogSize
```

方法：`RecordLog`、`RegistLog`、`UnregistLog`、`ClearLog`、`SetLogEnable`。

**`gnosia.ScenarioEngine`** — 剧本引擎单例：`Initialize / MyStart / MyUpdate / Stop` +
`scenarioEngineObj`。对话由 100 多个 `XxxScenario` 类（`JinroNormalScenario`、
`Setsu3Scenario`…）拼出来，`Jinro` 就是人狼。

**`application` 命名空间** — 全部界面：`DiscussMesScreen`（议论）、`VoteScreen`（投票）、
`DataVoteScreen`（票型）、`DataEngineerScreen` / `DataDoctorScreen`（报告）、
`YakuKekkaScreen`（身份结果）、`SelectTgtScreen`（选目标）、`DataJoinScreen`（名单）。

## 还没定的

1. **动作怎么触发**：读没问题了，但「选第 N 条发言」「投给某人」要调哪条链路还没定。
   候选是 `DiscussMesScreen` / `SelectTgtScreen` / `VoteScreen` 上的提交方法，
   或者 `GameData` 上的 action 执行函数。下一轮反这几类的方法体。
2. **`actionsCanSelect` 的元素类型**：目前按「未知类型统一 ToString」处理，
   第一版插件会把真实形状打出来，看到再定 schema。
3. **阶段判断**：`application.ScreenState` / `Screen` 里应该有当前场景枚举，还没细看。

## InterfaceScreen 的三个标志位（2026-11 用 IL 确认）

`EnterActionButton(int id)` 就是三个按钮的真实逻辑（switch 到按钮编号）：

| 按钮 | 效果 |
| --- | --- |
| 发言 | `isSpeak = true` |
| 确定 | `isDicision = true`（`select < 0` 且不是 -2 时改 `isData`） |
| 返回 | `select` 为 0/1 时 `isBack = true`，否则 `isWait = true` |

**三者互相独立。** `isSpeak` 是一次性请求：MyUpdate 在 `if (IsButtonPressed(3) || isSpeak)`
分支里把它清成 false 并重建命令列表。所以**提交命令时绝对不能顺手设 `isSpeak=true`**
——那等于又按了一次发言键，列表会在提交后被重建，把刚打开的目标列（`select+1`、
`selectNum[1]`）冲掉。表现是：怀疑没生效、目标列表不出现、某个角色名牌一直高亮
（`LookTargetChara` 每帧执行但列表没建好）。这是 11 月那次「快速怀疑」bug 的根因。

`MyUpdate` 的确认消费点（`select` 为 0 命令列 / 1 目标列都走）：

```
if (IsButtonPressed(0) || isDicision) -> isDicision = false; ... 读 selectPos[select]
```

命令列提交后同一帧里：`ad = actions[actionsCanSelect[selectPos[0]]]`；
`ad.needSelect > 0` 时游戏自己执行 `select += 1` 并把 `selectNum[1]` 填成人数
（`Count16(peopleFlg[1])`），名字写进 `com_Name`/`mainname`。**不需要外部写任何字段**，
等着读 `selectNum[1]` 就行。

`PointerEnterComand(index)`：只做高亮绘制 + `selectPos[select] = index`，无副作用；
但它会设 `isOnPointCommand`，且入口要求 `isMouseEnable && select == 0`。

### 目标列必须走 `PointerEnterTgt`，手写 selectPos 无效

目标列（`select == 1`）第一次建好后，`selectPos[1]` 会被 MyUpdate 归零（`IL_1759`
那段 `selectPos[select] = 0` 就在 `LookTargetChara` 之后）。所以外部直接
`selectPos[1] = 6` 看起来写入成功（响应里 `select_pos_set: true`），但画面永远停在
第一行，下一次截图和上一张逐字节相同——**高亮根本没动**。

正确做法是调游戏自己的 `PointerEnterTgt(index)`：

```
入口条件：isMouseEnable == true && select == 1 && index != selectPos[1] && !interfaceUpdate
动作：selectPos[1] = index -> LookTargetChara()（重画 NAME 名牌 + 立绘）-> interfaceUpdate = true
```

入口里 `interfaceUpdate` 为真就直接 return，所以调之前要先把它置 false。
另外它在同一 tick 里读 `mainname` 会拿到旧值（名牌下一帧才刷新），要报名字就等
state 再读一次，别用返回值。

这也是 `gnosia_target` 必须拆成「高亮 → 截图 → 确认」两步的底层原因：
高亮本身要有一帧让人看见，确认是另一回事。

### 同一个坑在命令列：`PointerEnterComand` 必须先调、后兜底

`PointerEnterComand(index)` 的入口同样有 `index != selectPos[select]` 就 return 的短路。
旧 `CommandCore` 的顺序是「先写 `selectPos[0] = index`，再调 `PointerEnterComand(index)`」，
于是调用时两者已经相等 → 直接 return → **黄色框根本没重绘**。

选第 0 行（怀疑）时看不出来，选第 1 行（袒护）就露馅：画面高亮停在「怀疑」，
实际执行的是「袒护」。功能对、观感错，正是用户最反感的那类 bug。

正确顺序（已改）：

```
isMouseEnable = true; interfaceUpdate = false;
PointerEnterComand(index);        // 让它自己写行号 + 重绘黄框 + 移箭头
if (selectPos[0] != index) selectPos[0] = index;   // 仅当入口没满足时兜底
```

两条通用规律，以后碰任何 `PointerEnterXxx` 都适用：

1. **永远不要抢在它前面写目标字段**，它的去重短路会让你误以为调用成功了。
2. 它渲染的是「调用那一刻」的画面，返回值里的文本区同 tick 读还是旧值，要报名字得等下一帧读 state。


## 所有「多选项界面」的光标与确认路径（2026-11 全量审计）

用 `scripts/audit-screens.py`（字段/处理器）和 `scripts/audit-movers.py`（移动器参数个数）
扫了 55 个 Screen 类型，有选项的界面归成这张表：

| 界面 | 光标字段 | 移动器 | 确认 |
| --- | --- | --- | --- |
| InterfaceScreen 命令列 | `selectPos[0]` | `PointerEnterComand(int)` | `isDicision` |
| InterfaceScreen 目标列 | `selectPos[1]` | `PointerEnterTgt(int)` | `isDicision` |
| VoteScreen | `selectTgt = x*6+y` | `SelectTarget(x,y)` | `isDicision` |
| SelectTgtScreen | `selectTgt = x*6+y` | `SelectTarget(x,y)` | `isDicision` |
| DataJoinSelScreen | `selectTgt = x*maxY+y` | `SelectTarget(x,y)` | `isDicision` |
| Move2Screen | `selectTgt=place, selectX=idx` | `SelectTarget(place,index)` | `isDicision` |
| **YesNoDialogScreen** | 无（`isYes`/`isNo`） | `PointerEnter(id)` 只显示按钮 | `isYes` / `isNo` |
| MyRoomScreen | `selectTgt` | `SelectTarget(int)` | `isDicision` |
| TitleScreen | `selectTgt` | `SelectTarget(int)` | `enterSelect` |
| LoadSlotScreen / GameMenu* | `selectTgt` | `SelectTarget(int)` | `isDicision` |
| ResultScreen | 无 | — | `isDicision` / `isData` |
| GalleryScreen | `selectTgt` | `SelectTargetTitle(int)` | `isDicision` |
| MakeLoopScreen | `selectTgt` | `SelectTargetCursor(int)` / `SelectButton(int)` | `isDicision` |
| ParamChangeScreen | `selectTgt` | `SelectTargetColorBar(int)` | `isDicision` |

**通用规则（比表更重要）**

1. 每个移动器入口都有 `index != 当前值` 就 return 的短路。**先写字段、再调移动器 = 永远不重绘**。
   必须反过来：先调移动器，只有它没动成时才手写兜底。
2. 二维界面不能统一按 6 拆：VoteScreen/SelectTgtScreen 是 `x*6+y`，DataJoinSelScreen 是
   `x*maxY+y`，Move2Screen 干脆是 `(地点 id, 索引)` 两个不同语义的参数。
3. `YesNoDialogScreen` 也拿来当「继续」提示框。`m_canSelect=false` 表示只有一个按钮；
   真正的二选一才是 true。消费前有 `waitTime > 0.3` 的防抖。
4. **`IsButtonPressed(0)` 在 YesNo 上等于「是」**，所以盲按 Enter 会自动答是。
   见到 `yes_no:true` 必须停下来显式选，不能用 `gnosia_advance`。

## 借鉴自 LLM_API 的部分

- 主线程桥：HTTP 线程入队 + `ManualResetEventSlim` 等待，`Update()` 每帧最多消化 16 条。
- 启动方式：BepInEx 直接给 `BaseUnityPlugin`（本身就是 MonoBehaviour），
  不用像密教那样自己 `new GameObject` + `Assembly.GetType` 找入口。
- 输出用手写紧凑 JSON，不引 Newtonsoft，省体积也省依赖。
- 错误信息写成给模型看的下一步指令，而不是堆栈。
