/**
 * dsh-atrium — Atrium 的秘书收件地址（DSH 侧）。
 *
 * 让本机其他进程（Atrium 的 secretary bridge）把事件投进这个 DSH 进程里的会话，
 * 会话像收到用户消息一样处理它（起新的一轮）。
 *
 * 登记：$DSH_HOME/atrium/inbox/<pid>.json（0600），含 socketPath、keyFile 与会话清单
 * 口令：$TMPDIR/dsh-atrium-<uid>/<pid>.key（0600，内含 token）
 * 套接字：$TMPDIR/dsh-atrium-<uid>/<pid>.sock（0600）
 * 协议：首行鉴权（裸 token，或 {"type":"auth","token":"…"}），之后一行一条
 *   {"message":"…","as":"user|external","from":"…","deliverAs":"auto|followUp|steer","sessionId":"…"}
 *   不是 JSON 对象的整行按纯文本消息处理；每行回一条回执 {"ok":true,…} / {"ok":false,"error":"…"}
 * 投递：`agent.followup()` 排队并唤醒驱动器（下一轮），`agent.steer()` 插进当前这一步。
 *
 * 两条穿刺得来的约束（src/spike.js）：
 * 1. 在 session/event 处理器里同步投递会撞上「session append cannot reenter while another append is being published」，
 *    必须让出发布期（setTimeout 0）。
 * 2. 没有 `inject: ['agents']` 时拿 `ctx.agents` 会直接抛，异常在事件处理器里被吞掉——什么都看不到。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const name = "dsh-atrium";
export const inject = ["agents"];

const PROTOCOL = 1;
const MAX_MESSAGE_CHARS = 64 * 1024;
const MAX_LINE_CHARS = MAX_MESSAGE_CHARS + 4096;
const AUTH_TIMEOUT_MS = 5_000;
const SOCKET_PATH_LIMIT = 100;

function log(text) {
  process.stderr.write(`dsh-atrium: ${text}\n`);
}

function dshHome(config) {
  for (const value of [config?.home, process.env.DSH_HOME]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return path.join(os.homedir(), ".dsh");
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** 按行读一个套接字：yield 每一行（不含换行），连接结束时把残余的一行也给出去。 */
async function* readLines(conn) {
  let buffer = "";
  for await (const chunk of conn) {
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_LINE_CHARS) throw new Error("一行太长");
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      yield line;
    }
  }
  if (buffer !== "") yield buffer;
}

export function apply(ctx, config) {
  const home = dshHome(config);
  const registryDir = path.join(home, "atrium", "inbox");
  fs.mkdirSync(registryDir, { recursive: true, mode: 0o700 });

  const pid = process.pid;
  const preferred = path.join(os.tmpdir(), `dsh-atrium-${uid()}`, `${pid}.sock`);
  const socketDir =
    Buffer.byteLength(preferred) <= SOCKET_PATH_LIMIT
      ? path.dirname(preferred)
      : path.join("/tmp", `dsh-atrium-${uid()}`);
  const socketPath = path.join(socketDir, `${pid}.sock`);
  const keyPath = path.join(socketDir, `${pid}.key`);
  const registryPath = path.join(registryDir, `${pid}.json`);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

  const token = crypto.randomBytes(32).toString("hex");
  writePrivate(keyPath, JSON.stringify({ protocol: PROTOCOL, token }));

  const agents = () => ctx.agents.roots?.() ?? ctx.agents.list?.() ?? [];

  const describe = (agent) => {
    let cwd = "";
    try {
      cwd = agent.session?.meta?.cwd ?? "";
    } catch {
      cwd = "";
    }
    return { id: agent.id, cwd };
  };

  const writeRegistry = () => {
    writePrivate(
      registryPath,
      JSON.stringify({
        protocol: PROTOCOL,
        pid,
        profile: typeof config?.profile === "string" ? config.profile : "",
        socketPath,
        keyFile: keyPath,
        startedAt: Date.now(),
        sessions: agents().map(describe),
      }),
    );
  };

  // 挑会话：消息里的 sessionId（id 或前缀）优先，其次插件配置里的 session。
  // 两边都没写就**不投**：投给全部根会话会把一条事件撒进每个人开着的对话里（默认拒绝比默认广播安全）。
  const wanted = (want) => want || (typeof config?.session === "string" ? config.session : "");
  const targets = (by) => agents().filter((agent) => agent.id === by || agent.id.startsWith(by));

  const render = (message) => {
    if ((message.as ?? "external") === "user") return message.message;
    const header = ["[atrium] 外部消息", message.from ? `来自 ${message.from}` : undefined]
      .filter(Boolean)
      .join(" · ");
    return `${header}\n${message.message}`;
  };

  // 投递让出发布期：事件处理器里同步 append 会被会话拒掉。
  const deliver = (message) =>
    new Promise((resolve) => {
      setTimeout(() => {
        const by = wanted(message.sessionId);
        if (by === "") {
          resolve({ ok: false, error: "没有指定要投的会话：消息里带 sessionId，或在插件配置里写 session" });
          return;
        }
        let list;
        try {
          list = targets(by);
        } catch (err) {
          resolve({ ok: false, error: String(err?.message ?? err) });
          return;
        }
        if (list.length === 0) {
          resolve({ ok: false, error: "没有对上的活会话：" + by });
          return;
        }
        const input = { role: "user", content: [{ type: "text", text: render(message) }], source: { kind: "user" } };
        const delivered = [];
        for (const agent of list) {
          try {
            if (message.deliverAs === "steer") agent.steer(input);
            else agent.followup(input);
            delivered.push(agent.id);
          } catch (err) {
            resolve({ ok: false, error: String(err?.message ?? err), delivered });
            return;
          }
        }
        resolve({ ok: true, sessions: delivered, deliverAs: message.deliverAs ?? "followUp" });
      }, 0);
    });

  const parseMessage = (line) => {
    if (!line.startsWith("{")) return { message: line };
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { error: "不是合法 JSON" };
    }
    if (parsed === null || typeof parsed !== "object" || typeof parsed.message !== "string") {
      return { error: "消息要带 message 字段" };
    }
    if (parsed.message.length > MAX_MESSAGE_CHARS) return { error: "消息太长" };
    return parsed;
  };

  const serve = async (conn) => {
    const iter = readLines(conn)[Symbol.asyncIterator]();
    const reply = (payload) => {
      try {
        conn.write(JSON.stringify(payload) + "\n");
      } catch {
        // 连接已经断了
      }
    };
    try {
      conn.setTimeout(AUTH_TIMEOUT_MS, () => conn.destroy());
      const first = await iter.next();
      if (first.done) return;
      let presented = first.value.trim();
      if (presented.startsWith("{")) {
        try {
          presented = JSON.parse(presented).token ?? "";
        } catch {
          presented = "";
        }
      }
      if (presented !== token) {
        reply({ ok: false, error: "unauthorized" });
        return;
      }
      conn.setTimeout(0);
      reply({ ok: true, protocol: PROTOCOL, pid });
      for (;;) {
        const next = await iter.next();
        if (next.done) return;
        const line = next.value;
        if (line === "") continue;
        const message = parseMessage(line);
        if (message.error) {
          reply({ ok: false, error: message.error });
          continue;
        }
        reply(await deliver(message));
      }
    } catch (err) {
      reply({ ok: false, error: String(err?.message ?? err) });
    } finally {
      try {
        conn.end();
      } catch {
        // 幂等
      }
    }
  };

  const server = net.createServer((conn) => {
    serve(conn);
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      server.close();
    } catch {
      // 已经关掉
    }
    for (const file of [socketPath, registryPath, keyPath]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 幂等清理
      }
    }
  };

  const refresh = ctx.on("session/event", (session, event) => {
    if (event?.type !== "agent/created" && event?.type !== "agent/disposed" && event?.type !== "turn/start") return;
    try {
      writeRegistry();
    } catch {
      // 登记刷新失败不影响投递
    }
  });

  server.on("error", (err) => log(`收件地址起不来 ${err?.message ?? err}`));
  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
      writeRegistry();
      log(`收件地址 ${socketPath}`);
    } catch (err) {
      log(`登记失败 ${err?.message ?? err}`);
    }
  });

  ctx.effect(() => () => {
    refresh?.();
    close();
  });
}
