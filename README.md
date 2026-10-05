# dsh-atrium

DSH（DeepSeek Harness）侧的 Atrium 合集：**秘书会话的收件插件**（Atrium 的事件投进你在看的 DSH 会话）、DSH 当执行者与秘书时的一次性准备说明、以及相关技能。

不跟 Atrium 搭配时也可以单独用（插件只是把外部文本投进当前会话）。

## 现在到哪了

2026-10-05 做完穿刺（`src/spike.js`），结论：

- **插件能装进 DSH profile 并生效**：`dsh plugin --profile <name> add file:<目录>` 装包，再在 `~/.dsh/profiles/<name>/cordis.patch.yml` 里加一条 `insert`（`- id: <名字> / name: <包名>`），`apply(ctx)` 就有完整 harness API。
- **能看到活会话**：`export const inject = ['agents']` + `ctx.agents.list()` 拿到实时 agent，`ctx.on('session/event', (session, event) => …)` 拿得到每个会话事件与 `session.id`。
- **能把外部文本投成一条用户消息并起新的一轮**：`agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })`；事件序列是 `agent/inbox/spliced → turn/start`，也就是说 agent 会像收到用户消息一样处理它（这正是秘书要的）。
- **必须让出发布期**：在 `session/event` 处理器里同步调用 `followup()` 会报 `session append cannot reenter while another append is being published`；用 `setTimeout(…, 0)` 让当前这次 append 发布完再投就可以。
- **headless 宿主是一次性的**：`dsh --profile headless` 在它自己那一轮 `turn/end` 后就把进程收掉（注入的 turn 2 已经开始，进程仍退出）。秘书要的是常驻会话，所以插件装在长命宿主（桌面/web profile）里，不是 headless。

穿刺怎么跑：`src/spike.js` 的插件在第一轮 `turn/end` 后投一条「第二轮：请只回复「注入成功」四个字」，观察 stdout 的 JSON 事件里是否出现 `turn_start turn=2`。

## 计划

- `src/index.js`：秘书收件插件——登记一个收件地址（Unix socket + 口令文件，形状照 Atrium 的 pi-inbox），收到文本后按上面的方式投进会话；同时给会话署名（Atrium 侧秘书身份）。
- Atrium 侧要配一个收件地址适配（`internal/platform/dshinbox.go`）与 `atrium secretary bridge --dsh`。
- 详细背景与验收见 Atrium 仓库的 issue #872、#874。
