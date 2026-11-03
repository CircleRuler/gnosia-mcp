# gnosia-mcp

让 AI agent 真正玩《GNOSIA》（Petit Depotto / Steam appid 1608290）的本地 MCP。

不截图、不模拟鼠标、不需要视觉模型：状态从游戏内部对象直接读，动作用游戏自己的 handler 执行。

```
┌─────────────────────────┐
│  AI 客户端（WorkBuddy /  │
│  Claude Code / Codex…）  │
└───────────┬─────────────┘
            │ MCP (stdio)
┌───────────▼─────────────┐
│  gnosia-mcp             │  Node 进程：工具定义、判断逻辑、说明书
│  mcp/src/*.ts           │
└───────────┬─────────────┘
            │ HTTP 127.0.0.1:48711
┌───────────▼─────────────┐
│  GnosiaApi.dll          │  BepInEx 插件：反射读写游戏对象
│  plugin/src/*.cs        │  跑在游戏进程里
└───────────┬─────────────┘
            │
┌───────────▼─────────────┐
│  GNOSIA（Unity）         │
└─────────────────────────┘
```

两层必须配对使用：MCP 只负责“怎么说”，插件负责“怎么做”。插件新增字段（例如 `interface.speak`）时，MCP 不认识就发挥不出作用。

## 为什么不用截图

| | 截图 + 键鼠 | 本项目 |
| --- | --- | --- |
| 读天数/台词/人名 | OCR，错字、漏行 | 直接读文本区，逐字准确 |
| 读票型/阵营 | 基本做不到 | `chara[].p_yaku`、`knowledge` |
| 窗口在后台 | 拿到过期帧 | 不受影响 |
| 抢焦点 | 会打断用户输入 | 不需要前台 |
| 每回合成本 | 一张图 ~1MB | 一段 JSON |

## 快速开始

### 方式一：Release 包（推荐）

1. 下载 Release 里的 `gnosia-mcp-bundle.zip`
2. 解压到游戏根目录，与 `Gnosia.exe` 同级，覆盖合并
   （包含 BepInEx 5.4.23 x64、`doorstop_config.ini`、`winhttp.dll`、`BepInEx/plugins/GnosiaApi.dll`）
3. 注册 MCP（见下）
4. 启动游戏，客户端里应能看到 `gnosia_state` 等工具

### 方式二：从源码

```powershell
git clone <this repo> gnosia-mcp
cd gnosia-mcp\mcp
npm ci
npm run build

cd ..\plugin
.\build-gnosia.ps1 -Install -GameDir "C:\Program Files (x86)\Steam\steamapps\common\GNOSIA"
```

`build-gnosia.ps1` 用 Unity 自带的 Mono 编译器 + 游戏自己的 Managed 程序集编译，**不需要 .NET SDK**。前提是本机装过 Unity（有 `MonoBleedingEdge`）。

### 注册 MCP

WorkBuddy / Claude Code 这类客户端，在 MCP 配置里加：

```json
{
  "mcpServers": {
    "gnosia": {
      "command": "node",
      "args": ["<repo>/mcp/dist/index.js"],
      "env": {
        "GNOSIA_MCP_CONFIG": "<repo>/mcp/gnosia.config.json"
      }
    }
  }
}
```

`install.ps1` 会自动完成这一步（会先备份原配置）。

## 工具

| 组 | 工具 |
| --- | --- |
| 读状态 | `gnosia_state` `gnosia_screens` `gnosia_areas` `gnosia_field` `gnosia_board` `gnosia_log` |
| 推进对话 | `gnosia_advance` `gnosia_step` `gnosia_pass` `gnosia_watch` |
| 发言 | `gnosia_speak` `gnosia_command` `gnosia_target` |
| 投票 | `gnosia_vote_list` `gnosia_vote` |
| 菜单/夜晚 | `gnosia_ui` `gnosia_map` `gnosia_move` `gnosia_menu` `gnosia_close_panel` |
| 建角/设定 | `gnosia_setup` `gnosia_setabil` `gnosia_setinput` `gnosia_call` `gnosia_field_write` |
| 资料 | `gnosia_skills`（30 条指令）`gnosia_tutorial`（46 页帮助）`gnosia_lore`（开场 4 屏） |
| 会话 | `gnosia_notes_*` `gnosia_memory_*` `gnosia_journal_*` |

连上之后先读 `gnosia_playbook`（prompt），里面是完整的操作手册和踩过的坑。

## 设计上比较在意的几件事

- **Enter 不是“继续”**。在投票、地图、房间、二选一这些界面，它是“确认高亮行”，而高亮默认在第一项。`gnosia_advance` 会拒绝在这些界面按键。
- **发言要按 W**。发言列表不会自己弹出来，Enter 只会替你选掉第一项。插件现在会报 `interface.speak.button_visible`，MCP 会停在 `window.kind = "speak"`。
- **一次一按**。把“开列表 + 选行 + 确认”合成一次调用，会让人眼看着面板一闪而过，也容易浪费回合。
- **截图是最后手段**。文字类信息全部有对应字段；只有立绘、布局、标记位置才需要看像素。

## 构建

```powershell
# MCP
cd mcp
npm ci
npm run build        # tsc -> dist/
npm run typecheck

# 插件
cd plugin
.\build-gnosia.ps1                 # 只编译到 build/
.\build-gnosia.ps1 -Install        # 编译并复制到 BepInEx\plugins
.\build-gnosia.ps1 -GameDir "D:\Games\GNOSIA" -Install
```

## 目录

```
mcp/     MCP 服务器（TypeScript）
  src/     index.ts 工具注册 · playbook.ts 操作手册 · plugin.ts 插件客户端
           input.ts 推进逻辑 · steam.ts 启动 · memory.ts 跨会话记忆
  scripts/ smoke.mjs 冒烟 · inspect.mjs 只读自检
plugin/  BepInEx 插件（C#）
  src/     GnosiaApi.cs
  docs/    reverse-engineering.md 逆向笔记
  scripts/ dump-il.py 等逆向辅助脚本
```

## 关于仓库里的游戏文本

`mcp/src/tutorial.ts`（46 页帮助）、`mcp/src/skills.ts`（30 条指令）、`mcp/src/lore.ts`（开场 4 屏）
是从**本项目作者自有的游戏副本**中读出的原文，放在这里是为了让 agent 不必反复查游戏内菜单。

- 文本著作权归 GNOSIA 的开发/发行方所有，本项目仅作**兼容性参考**使用，不做商业分发
- 如果你要再分发，请自行确认合规；不想要它们可以删掉这三个文件，对应工具会返回空列表
- 仓库**不包含**游戏本体、存档、素材、解包资源

## 许可证

源码 MIT。BepInEx 为 LGPL-2.1，随 Release 一起分发，许可证见其自身发布包。
GNOSIA 及相关名称、素材归各自权利人所有，本项目为非官方工具，与作者、发行商无隶属关系。
