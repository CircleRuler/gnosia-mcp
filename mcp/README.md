# mcp — gnosia-mcp

给 AI 客户端用的那一半。stdio MCP 服务器，把插件暴露的 HTTP 接口包装成工具，
并负责“该不该按”“什么时候停”这些判断。

## 构建

```bash
npm ci
npm run build      # tsc -> dist/
npm run typecheck
npm run smoke      # 连真游戏跑一遍冒烟（需要游戏已启动）
node scripts/inspect.mjs   # 只读自检：工具清单 / instructions / playbook 长度
```

## 结构

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 工具注册、`instructions`、错误包装 |
| `src/plugin.ts` | 插件 HTTP 客户端 + `actWindow` / `windowNow` 这些判定 |
| `src/input.ts` | `advance` 的推进与停止逻辑 |
| `src/capture.ts` `src/host.ts` | 截图（最后手段） |
| `src/steam.ts` | 启动 / 聚焦 / 关闭游戏 |
| `src/memory.ts` | notes / memory / journal 三类持久化 |
| `src/playbook.ts` | 操作手册（作为 prompt 提供） |
| `src/skills.ts` `src/tutorial.ts` `src/lore.ts` | 游戏内文本快照，见根 README 的版权说明 |

## 判断逻辑为什么在这里

插件只会“照做”，MCP 才知道“能不能做”。例如：

- `actWindow()` 把 `ROUND 计数`、`发言按钮`、`命令行` 合成一个 `{can_act, kind}`，`advance` 见 `live` 就停
- `gnosia_vote` 拆成“移光标 → 核对 `cursor_reached` → 再确认”，避免把票投给默认行
- `gnosia_command` 拒绝自己开列表，逼调用方先 `gnosia_speak`

所以插件和 MCP 必须**成对升级**：插件新增字段时，MCP 不认识就等于没有。
