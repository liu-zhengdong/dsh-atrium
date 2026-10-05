/** Atrium × DSH 穿刺：turn/end 之后让出发布期，投一条 user 消息，再把会话历史读回来核对。 */
export const name = 'dsh-atrium-spike'
export const inject = ['agents', 'sessions']

export function apply(ctx, config) {
  const delay = Number(config?.delayMs ?? 0)
  const text = config?.text ?? '第二轮：请只回复「注入成功」四个字'
  let fired = false
  const seen = []
  const off = ctx.on('session/event', (session, event) => {
    seen.push(event.type)
    if (fired || event.type !== 'turn/end') return
    fired = true
    const agents = ctx.agents.list()
    const id = session.id
    process.stderr.write(`dsh-atrium-spike: turn/end session=${id} 活着的 agent ${agents.length} 个\n`)
    setTimeout(() => {
      for (const a of agents) {
        const agent = a.agent ?? a
        try {
          agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
          process.stderr.write(`dsh-atrium-spike: 已投递 ${JSON.stringify(text)}\n`)
        } catch (e) {
          process.stderr.write(`dsh-atrium-spike: 投递失败 ${e}\n`)
        }
      }
    }, delay)
    // 投递之后把会话历史读回来：注入的那条是不是真进了模型看到的消息里
    setTimeout(() => {
      try {
        const s = ctx.sessions.get(id)
        const msgs = s.deriveMessages()
        process.stderr.write(`dsh-atrium-spike: 历史 ${msgs.length} 条，末尾 3 条：\n`)
        for (const m of msgs.slice(-3)) {
          const t = (m.content ?? []).map((c) => c.type === 'text' ? c.text : `<${c.type}>`).join('').replace(/\s+/g, ' ').slice(0, 90)
          process.stderr.write(`  [${m.role}] ${t}\n`)
        }
      } catch (e) {
        process.stderr.write(`dsh-atrium-spike: 读历史失败 ${e}\n`)
      }
      process.stderr.write(`dsh-atrium-spike: 事件序列尾 ${seen.slice(-6).join(' → ')}\n`)
    }, delay + 4000)
  })
  return { dispose() { off?.() } }
}
