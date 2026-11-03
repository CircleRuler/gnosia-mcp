# plugin — GnosiaApi.dll

跑在游戏进程里的那一半。BepInEx 5（x64）插件，用反射读写 GNOSIA 的屏幕对象和存档数据，
在 `127.0.0.1:48711` 暴露一组纯 HTTP 接口给 `mcp/` 使用。

## 构建

```powershell
.\build-gnosia.ps1                                  # 只编译到 build\
.\build-gnosia.ps1 -Install                         # 编译并复制到游戏 BepInEx\plugins
.\build-gnosia.ps1 -GameDir "D:\Games\GNOSIA" -Install
```

编译器用的是 Unity 自带的 Mono（`MonoBleedingEdge`），**不需要 .NET SDK**；
引用程序集直接取游戏自己的 `Gnosia_Data\Managed`。

## 接口

| 路由 | 作用 |
| --- | --- |
| `/screens` `/areas` `/state` `/dump` | 读界面、文本区、完整状态 |
| `/action/advance` | 按一次 Enter（**会先拒绝**在拥有光标的界面上按键） |
| `/action/press?action=N` | 注入一次虚拟按键（0 确定 / 3 发言 / 6 系统键） |
| `/action/vote` | 投票界面：读光标 / 取消 |
| `/action/ui?screen=&index=&confirm=` | 调该界面的 `SelectTarget` |
| `/action/click?screen=&method=&index=` | 调该界面的 `(int)` 方法 |
| `/action/set` `/action/path` | 写 / 读任意字段 |
| `/action/setup` `/action/setabil` `/action/setinput` | 初期条件設定 / 建角能力 / 文本输入 |

## 几个已经踩过的坑

- **Enter 在拥有光标的界面上不是“继续”**，是“确认高亮行”。`/action/advance` 现在会先检查
  投票 / 地图 / 房间 / 二选一 / 各种菜单，命中就返回 `stopped_because: "screen_owns_input"`，一个键都不按。
- **发言列表要按 W 才会出现**。`interface.speak.button_visible` 是“现在可以发言”的唯一可靠信号，
  `command` 文本区在菜单关闭后还会残留旧值。
- **`command_list` 是指令一览（GameMenuSkillScreen）的两列**，议论界面为空，不要拿它当“当前可用指令”。
- **写字段不会重绘**。建角的能力值、初期条件設定的人数都需要调游戏自己的方法（`SetText` /
  `CountMura` / `SetButtons`）才会更新画面，光写 `baseData` 会“数据对、画面错”。

更多逆向细节见 [docs/reverse-engineering.md](docs/reverse-engineering.md)。
