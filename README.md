# dsh-atrium

DSH（DeepSeek Harness）侧的 Atrium 合集：**秘书收件插件**——让 Atrium 的事件投进你正在用的 DSH 会话，会话像收到用户消息一样处理它。

不跟 Atrium 搭配也能单独用：任何本机进程都能通过收件地址往这个 DSH 进程的会话里投消息。

## 装

```sh
dsh plugin --profile <profile> add file:/path/to/dsh-atrium
```

再在这个 profile 的 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加一条（默认模板里是空数组 `[]`，替换即可）：

```yaml
- insert:
    - id: dsh-atrium
      name: '@liuser/dsh-atrium'
```

装完 `dsh: warning: @liuser/dsh-atrium declares no dsh.bundle — installed as a plain dependency, not a profile layer` 是正常的：cordis 插件不是组合包，所以不会作为 profile 层被选中，要的就是上面那条 insert。

**改代码后要重装或覆盖**：pnpm 对 `file:` 依赖是硬链接/复制进 profile 的 `node_modules`，源文件改完不重装，profile 里还是旧内容（踩过一次：改出语法错、修好、profile 里仍是坏的那份，报 `atrium-spike (@liuser/dsh-atrium): failed to import`）。

## 收件地址

| 是什么 | 在哪 |
| --- | --- |
| 登记（0600） | `$DSH_HOME/atrium/inbox/<pid>.json`，含 `socketPath`、`keyFile`、`sessions[{id, cwd}]` |
| 口令（0600） | `$TMPDIR/dsh-atrium-<uid>/<pid>.key`，内含 `token` |
| 套接字（0600） | `$TMPDIR/dsh-atrium-<uid>/<pid>.sock` |

协议（与 Atrium 的 pi-inbox 同形，Atrium 侧一套客户端可以共用）：

- 首行鉴权：裸 token，或 `{"type":"auth","token":"…"}`；回 `{"ok":true,"protocol":1,"pid":…}` 或 `{"ok":false,"error":"unauthorized"}`。
- 之后一行一条消息：`{"message":"…","as":"user|external","from":"…","deliverAs":"auto|followUp|steer","sessionId":"…"}`；不是 JSON 对象的整行按纯文本处理。`as=external`（缺省）会加一行 `[atrium] 外部消息 · 来自 <from>` 抬头。
- 每行回一条回执：`{"ok":true,"sessions":[...],"deliverAs":"followUp"}` 或 `{"ok":false,"error":"…"}`。
- 挑会话：消息里的 `sessionId`（id 或前缀）优先，其次插件配置里的 `session`；两边都没写**不投**（默认拒绝，免得一条事件撒进每个人开着的对话里）。
- 投递语义：`deliverAs=followUp`（缺省）排队并唤醒驱动器，起新的一轮；`steer` 插进当前这一步。

一条最小的投递（Node）：

```js
import * as fs from "node:fs";
import * as net from "node:net";
const reg = JSON.parse(fs.readFileSync(process.env.HOME + "/.dsh/atrium/inbox/<pid>.json", "utf8"));
const token = JSON.parse(fs.readFileSync(reg.keyFile, "utf8")).token;
const sock = net.connect(reg.socketPath);
sock.on("connect", () => {
  sock.write(token + "\n");
  sock.write(JSON.stringify({ message: "任务 t1 已交付", from: "atrium" }) + "\n");
});
sock.on("data", (c) => process.stdout.write(c));
```

## 已验证的机制（2026-10-05，DSH 0.2.0-rc.2）

`src/spike.js` 与 `src/index.js` 都在真机上跑过，下面是实测结论：

- **插件能装进 profile 并生效**：`apply(ctx)` 拿到完整 harness API。
- **能看到活会话**：`export const inject = ['agents']` + `ctx.agents.list()`（`roots()` 给根会话）+ `ctx.on('session/event', (session, event) => …)`。不声明 `inject: ['agents']` 时 `ctx.agents` 会直接抛，异常在事件处理器里被吞掉，什么都看不到。
- **能把外部文本投成用户消息并起新一轮**：`agent.followup({ role: 'user', content: [{type:'text',text}], source: {kind:'user'} })`。事件序列 `… → turn/end → agent/inbox/spliced → turn/start`；**必须带 `role: 'user'`**，少了它会话能收下，但下一次模型请求会 422：`Failed to deserialize the JSON body into the target type: messages[n]: missing field 'role'`。
- **必须让出发布期**：在 `session/event` 处理器里同步投递会报 `Error: session append cannot reenter while another append is being published`；`setTimeout(…, 0)` 之后投就正常。
- **headless 宿主是一次性的**：`dsh --profile headless` 在自己那轮之后收进程。秘书要常驻会话，插件装在长命宿主（桌面 / web profile）里。

一次完整的投递实录（headless + 插件，第一轮还在跑时从套接字投一条）：

```
登记 sessions=[{"id":"session-700ef460-…","cwd":""}]
回执 {"ok":true,"protocol":1,"pid":91497}
回执 {"ok":true,"sessions":["session-700ef460-…"],"deliverAs":"followUp"}
# dsh --json 的 stdout：
{"type":"status","phase":"turn_start","turn":1} … {"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"status","phase":"turn_start","turn":2}
{"type":"text","text":"收到"}
{"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"completed"}}
{"type":"final","text":"收到"}
```

`cwd` 目前取不到（`session.header.cwd` 是空的取值对象），所以挑会话请用 `sessionId` 前缀。

## 还没做

- Atrium 侧：`internal/platform/dshinbox.go` 与 `atrium secretary bridge --dsh`（Atrium 仓库 issue #872）。
- 桌面 profile 里的验证：插件装进 `desktop` profile 后，能不能看到并注入你正在看的那个会话（同一个 API，宿主换成 Electron 持有的进程）。
- 秘书身份署名（现在投进去的消息只带 `from`）。
