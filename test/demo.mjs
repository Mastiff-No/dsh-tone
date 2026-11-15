/**
 * dsh-tone 效果预览 —— 不启动 DSH，直接打印「模型这一轮会看到什么」。
 *
 * 用法：node test/demo.mjs [0-10]
 *
 * 为什么要有这个：三条注入通道分散在三处代码里，改完只能靠重启 + 聊两句
 * 凭感觉判断。这里用假 host 把链路跑一遍，把最终上下文原样打出来，
 * 字号、位置、重叠全都看得见。
 *
 * 它跑在临时 DSH_HOME 里，不碰你的真实状态文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tone-demo-'))
process.env.DSH_HOME = TMP

const { apply } = await import('../lib/index.js')

const tone = Math.max(0, Math.min(10, Number(process.argv[2] ?? 7) || 0))
fs.writeFileSync(path.join(TMP, 'dsh-tone.json'),
  JSON.stringify({ enabled: true, tone, pos: { side: 'right', y: 0.5 } }))

const hooks = {}
const sections = []
const host = {
  on(name, fn) { hooks[name] = fn; return () => {} },
  inject(deps, fn) {
    fn({
      webServer: { register() { return () => {} }, tapIndex() { return () => {} } },
      systemPrompt: { section(s) { sections.push(s); return () => {} }, context() { return () => {} } },
    })
    return () => {}
  },
  effect() { return () => {} },
}
apply(host)

const line = (s) => console.log(s)
const rule = () => line('─'.repeat(72))

// ── ① system prompt 里的 section ──────────────────────────────────────────
rule()
line('① systemPrompt.section()  —— 常驻，每轮都在')
rule()
let total = 0
for (const sec of sections) {
  const text = typeof sec.text === 'function' ? sec.text({}) : sec.text
  if (!text) continue
  total += text.length
  line(`[${sec.name}]  order=${sec.order}  ${text.length} 字`)
  line(text)
  line('')
}

// ── ② system-prompt/assemble 的收尾压句 ───────────────────────────────────
rule()
line('② system-prompt/assemble  —— 在别人的 section 之后补一条')
rule()
const fakeAssembly = {
  sections: [
    { name: 'main', order: 0, text: '（你的主提示词）' },
    { name: 'dsh-tone:level', order: 10210, text: '（上面第①条）' },
    { name: 'dsh-expression:companion', order: 99999, text: '（别的插件压在这儿的 168 字）' },
  ],
}
const assembled = hooks['system-prompt/assemble']
  ? await hooks['system-prompt/assemble']({}, {}, async () => fakeAssembly)
  : fakeAssembly
for (const sec of assembled.sections) {
  const text = typeof sec.text === 'function' ? sec.text({}) : sec.text
  const isOurs = sec.name.indexOf('dsh-tone') === 0
  if (isOurs) total += text.length
  line(`${isOurs ? '→ ' : '  '}[${sec.name}]  ${text.length} 字${isOurs ? '   ← 我们插的' : ''}`)
}
line('')
line('顺序很重要：末尾那句如果被别人抢走，前面写多少都会被最后一句盖过去。')
line('')

// ── ③ agent/pre-step 的消息 ───────────────────────────────────────────────
rule()
line('③ agent/pre-step  —— 塞在 messages 最末尾，离生成点最近')
rule()
const seed = [
  { role: 'system', content: [{ type: 'text', text: '（系统提示，略）' }], source: { kind: 'system-prompt' }, id: 's0' },
  { role: 'user', content: [{ type: 'text', text: '（用户消息，略）' }], source: { kind: 'user' }, id: 'u1' },
]
const decision = hooks['agent/pre-step']
  ? await hooks['agent/pre-step']({}, async () => ({ kind: 'enter', messages: seed.slice() }))
  : { kind: 'enter', messages: seed }
const added = decision.messages[decision.messages.length - 1]
if (added && added.id && String(added.id).indexOf('dsh-tone') === 0) {
  const text = added.content.map((c) => c.text || '').join('')
  total += text.length
  line(`[${added.role}]  ${text.length} 字`)
  line(text)
} else {
  line('（没注入 —— 插件停用中？）')
}
line('')

// ── 合计 ─────────────────────────────────────────────────────────────────
rule()
line(`三条通道合计 ${total} 字（约 ${Math.round(total / 1.7)} token）`)
rule()
line('三条各司其职：① 说全（档位定义、示例、禁用词）')
line('              ② 抢最后一句（压过「主动斗图」这类建议）')
line('              ③ 临门一脚（短提醒，离生成点最近）')

const SYS_BASE = (() => {
  const a = process.argv.find((x) => x.indexOf('--sysbase=') === 0)
  const n = a ? Number(a.split('=')[1]) : NaN
  // 5621 是实测值：/dsh-tone/inspect 里 22 个 section 的字数合计。
  // 换插件组合或 DSH 版本会变，用 --sysbase=N 传新的。
  return Number.isFinite(n) && n > 0 ? n : 5621
})()

// ── 占比：它在真实上下文里到底占多少 ────────────────────────────────────
// 用户最容易误判的地方：以为「档位加了 500 字，语气就该大变」。
// 实际一轮对话里，我们的注入只占百分之几，剩下全是历史对话。
rule()
line('在真实一轮对话里的占比（估算）')
const SCENARIOS = [
  { name: '刚开始聊（4 轮）', turns: 4, perTurn: 200 },
  { name: '聊了一会儿（20 轮）', turns: 20, perTurn: 400 },
  { name: '长对话（60 轮）', turns: 60, perTurn: 500 },
]
for (const sc of SCENARIOS) {
  const history = sc.turns * sc.perTurn
  // 系统提示基准默认用 5621（本机实测的 22 个 section 合计）。
  // 注意它不含工具 schema —— 那部分由宿主单独发，量级可能更大，
  // 所以真实占比只会比这里算出来的更低。
  const sysBase = SYS_BASE
  const all = total + history + sysBase
  const pct = ((total / all) * 100).toFixed(1)
  line(`  ${sc.name}：历史约 ${history} 字 + 系统提示约 ${sysBase} 字 → 我们占 ${pct}%`)
}
line('')
line('这就是为什么「档位影响有限」—— 不是注入没生效，是它在上下文里本来就很轻。')
line('注意：系统提示按 ' + SYS_BASE + ' 字算（本机实测的 section 合计，不含工具 schema），')
line('真实占比只会比这更低 —— 这只是量级判断，不是精确测量。')
line('想让档位更重，靠加字数没用（占比只会从 3% 涨到 4%），')
line('只能靠放在离生成点最近的位置（② 和 ③ 就是干这个的）。')

fs.rmSync(TMP, { recursive: true, force: true })
