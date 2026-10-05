// 收件地址的线上协议：Atrium 的 secretary bridge（internal/platform/inbox.go）按这些行跟我们说话。
// 这里用一个假 ctx 起真的插件（真套接字、真登记、真口令），把两边约定的东西钉住：
// 首行裸 token、一条一行 JSON、sessionId 按 id 或前缀挑会话、没指名就拒投并说明原因、
// 投进会话的输入必须带 role:'user'（少了它下一轮模型请求会 422）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { apply } from "../src/index.js";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 起一个插件实例：假 ctx 里放几个活会话，返回它们的投递记录与清理函数。 */
async function startPlugin({ sessions, config = {} }) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-atrium-test-"));
  const delivered = [];
  const agents = sessions.map((id) => ({
    id,
    session: {},
    followup: (input) => delivered.push({ id, input }),
    steer: (input) => delivered.push({ id, input, steered: true }),
  }));
  let cleanup = () => {};
  const ctx = {
    agents: { roots: () => agents, list: () => agents },
    on: () => () => {},
    effect: (fn) => {
      cleanup = fn() ?? (() => {});
    },
  };
  apply(ctx, { home, ...config });

  const registry = path.join(home, "atrium", "inbox", `${process.pid}.json`);
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(registry)) {
    if (Date.now() > deadline) throw new Error("插件没在 5 秒内写登记");
    await sleep(20);
  }
  const info = JSON.parse(await fsp.readFile(registry, "utf8"));
  const key = JSON.parse(await fsp.readFile(info.keyFile, "utf8"));
  return { info, registry, token: key.token, delivered, stop: () => cleanup() };
}

/** 按协议说一轮话：首行鉴权，之后一行一条消息，逐行读回执（连上时插件先回一条握手）。 */
function talk(info, token, lines, auth = token) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(info.socketPath);
    const replies = [];
    let buffer = "";
    conn.on("connect", () => conn.write([auth, ...lines].join("\n") + "\n"));
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line !== "") replies.push(JSON.parse(line));
      }
      if (replies.length >= lines.length + 1) conn.end();
    });
    conn.on("close", () => resolve(replies));
    conn.on("error", reject);
  });
}

/** 等插件把话说完再断开（回执可能比连接关闭早到）。 */
async function talkAndWait(info, token, lines, auth) {
  const replies = await talk(info, token, lines, auth ?? token);
  await sleep(30);
  return replies;
}

test("指名会话：按 id 前缀挑，投进去的输入带 role:'user'", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111", "session-bbbb2222"] });
  try {
    const replies = await talkAndWait(p.info, p.token, [
      JSON.stringify({ message: "第一条", from: "atrium-secretary", sessionId: "session-bbbb" }),
    ]);
    assert.equal(replies[0].ok, true);
    assert.equal(replies[0].protocol, 1);
    assert.deepEqual(replies[1].sessions, ["session-bbbb2222"]);
    assert.equal(replies[1].deliverAs, "followUp");
    assert.equal(p.delivered.length, 1);
    assert.equal(p.delivered[0].id, "session-bbbb2222");
    assert.equal(p.delivered[0].input.role, "user");
    assert.match(p.delivered[0].input.content[0].text, /^\[atrium\] 外部消息 · 来自 atrium-secretary\n第一条$/);
  } finally {
    p.stop();
  }
});

test("没指名、插件也没配 session：拒投并把原因说清楚", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111"] });
  try {
    const replies = await talkAndWait(p.info, p.token, [JSON.stringify({ message: "一条" })]);
    assert.equal(replies[1].ok, false);
    assert.match(replies[1].error, /没有指定要投的会话/);
    assert.equal(p.delivered.length, 0);
  } finally {
    p.stop();
  }
});

test("插件配置里写了 session：消息不带 sessionId 也投给它", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111", "session-bbbb2222"], config: { session: "session-aaaa" } });
  try {
    const replies = await talkAndWait(p.info, p.token, [JSON.stringify({ message: "一条" })]);
    assert.deepEqual(replies[1].sessions, ["session-aaaa1111"]);
  } finally {
    p.stop();
  }
});

test("指名对不上活会话：报出对不上的那个，不投给任何人", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111"] });
  try {
    const replies = await talkAndWait(p.info, p.token, [JSON.stringify({ message: "一条", sessionId: "session-zzzz" })]);
    assert.equal(replies[1].ok, false);
    assert.match(replies[1].error, /没有对上的活会话：session-zzzz/);
    assert.equal(p.delivered.length, 0);
  } finally {
    p.stop();
  }
});

test("口令不对：拒收，不投", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111"] });
  try {
    const replies = await talkAndWait(p.info, p.token, [JSON.stringify({ message: "一条", sessionId: "session-aaaa" })], "错的口令");
    assert.equal(replies[0].ok, false);
    assert.equal(replies[0].error, "unauthorized");
    assert.equal(p.delivered.length, 0);
  } finally {
    p.stop();
  }
});

test("token 用 JSON 包一层也认（{type:auth, token:…}）", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111"] });
  try {
    const replies = await talkAndWait(
      p.info,
      p.token,
      [JSON.stringify({ message: "一", sessionId: "session-aaaa" })],
      JSON.stringify({ type: "auth", token: p.token }),
    );
    assert.equal(replies[0].ok, true);
    assert.deepEqual(replies[1].sessions, ["session-aaaa1111"]);
  } finally {
    p.stop();
  }
});

test("消息太长：拒收并说明", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111"] });
  try {
    const replies = await talkAndWait(p.info, p.token, [
      JSON.stringify({ message: "一".repeat(64 * 1024 + 1), sessionId: "session-aaaa" }),
    ]);
    assert.equal(replies[1].ok, false);
    assert.match(replies[1].error, /消息太长/);
  } finally {
    p.stop();
  }
});

test("不是 JSON 也不算数：拒收并说明", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111"] });
  try {
    const replies = await talkAndWait(p.info, p.token, ["{不是 JSON"]);
    assert.equal(replies[1].ok, false);
    assert.match(replies[1].error, /不是合法 JSON/);
  } finally {
    p.stop();
  }
});

test("登记里带着 pid、协议版本与活会话清单", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111", "session-bbbb2222"] });
  try {
    assert.equal(p.info.protocol, 1);
    assert.equal(p.info.pid, process.pid);
    assert.deepEqual(
      p.info.sessions.map((s) => s.id),
      ["session-aaaa1111", "session-bbbb2222"],
    );
  } finally {
    p.stop();
  }
});

test("登记、口令、套接字只给自己看（0600），停掉后都收走", async () => {
  const p = await startPlugin({ sessions: ["session-aaaa1111"] });
  assert.equal(fs.statSync(p.info.keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(p.info.socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(p.registry).mode & 0o777, 0o600);
  const files = [p.info.socketPath, p.info.keyFile, p.registry];
  p.stop();
  await sleep(30);
  for (const f of files) assert.equal(fs.existsSync(f), false, `${f} 应被收走`);
});
