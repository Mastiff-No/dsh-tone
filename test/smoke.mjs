/**
 * dsh-tone 冒烟测试 —— 用一个假的 DSH host 跑完整链路。
 * 重启前跑一次：node test/smoke.mjs
 * 它不碰真实状态文件（备份 + 恢复），也不依赖正在运行的 DSH。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-tone.json')

let pass = 0
let fail = 0

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name) }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

function makeHost() {
  const routes = {}
  const hooks = {}
  const sections = []
  const contexts = []
  const table = []
  const host = {
    on(name, fn) { hooks[name] = fn; return () => {} },
    inject(deps, fn) {
      const webServer = {
        register(r) { routes[r.path] = r.handler; return () => {} },
        tapIndex() { return () => {} },
      }
      const systemPrompt = {
        section(s) { sections.push(s); return () => {} },
        context(c) { contexts.push(c); return () => {} },
        // 让 /dsh-tone/inspect 能真跑：返回当前已注册的 section
        async assemble() {
          return { sections: sections.map((sec) => ({ name: sec.name, order: sec.order, text: typeof sec.text === 'function' ? sec.text({}) : sec.text })) }
        },
      }
      fn({ webServer, systemPrompt })
      return () => {}
    },
    effect() { return () => {} },
  }
  return { host, routes, hooks, sections, contexts, table }
}

async function callRoute(handler, method, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
  const req = {
    method,
    on(ev, cb) {
      if (ev === 'data' && payload) setImmediate(() => cb(payload))
      if (ev === 'end') setImmediate(() => cb())
      return req
    },
  }
  let status = 0
  let raw = ''
  const res = {
    writeHead(s) { status = s; return res },
    end(b) { raw = b; return res },
  }
  await handler(req, res)
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { parsed = { raw: String(raw).slice(0, 120) } }
  return { status, body: parsed }
}

const before = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : null

try {
  console.log('\n[1] apply() 不抛错')
  const { host, routes, hooks, sections } = makeHost()
  let threw = null
  try { apply(host) } catch (e) { threw = e }
  ok('apply 正常返回', threw === null, threw && threw.message)

  console.log('\n[2] 路由注册')
  for (const p of ['/dsh-tone/state', '/dsh-tone/set', '/dsh-tone/widget.js']) {
    ok('注册 ' + p, typeof routes[p] === 'function')
  }

  console.log('\n[3] GET /dsh-tone/state')
  const st = await callRoute(routes['/dsh-tone/state'], 'GET')
  ok('HTTP 200', st.status === 200, 'status=' + st.status)
  for (const k of ['enabled', 'tone', 'pos', 'levels', 'levelsCustom', 'channel']) {
    ok('返回字段 ' + k, Object.prototype.hasOwnProperty.call(st.body || {}, k))
  }
  ok('levels 是四档', Array.isArray(st.body?.levels) && st.body.levels.length === 4)
  ok('tone 在 0..10', Number.isInteger(st.body?.tone) && st.body.tone >= 0 && st.body.tone <= 10)

  console.log('\n[4] POST /dsh-tone/set 语义')
  const empty = await callRoute(routes['/dsh-tone/set'], 'POST', { levels: [] })
  ok('levels=[] → levelsCustom=false', empty.body?.levelsCustom === false, String(empty.body?.levelsCustom))
  const four = await callRoute(routes['/dsh-tone/set'], 'POST', {
    levels: [{ name: 'A', text: 'a' }, { name: 'B', text: 'b' }, { name: 'C', text: 'c' }, { name: 'D', text: 'd' }],
  })
  ok('levels=[4] → levelsCustom=true', four.body?.levelsCustom === true, String(four.body?.levelsCustom))
  const reset = await callRoute(routes['/dsh-tone/set'], 'POST', { levels: null })
  ok('levels=null → levelsCustom=false', reset.body?.levelsCustom === false, String(reset.body?.levelsCustom))
  ok('恢复默认后 name[0] 是「公事公办」', reset.body?.levels?.[0]?.name === '公事公办', reset.body?.levels?.[0]?.name)

  const clamped = await callRoute(routes['/dsh-tone/set'], 'POST', { tone: 99 })
  ok('tone=99 被钳到 10', clamped.body?.tone === 10, String(clamped.body?.tone))
  const neg = await callRoute(routes['/dsh-tone/set'], 'POST', { tone: -5 })
  ok('tone=-5 被钳到 0', neg.body?.tone === 0, String(neg.body?.tone))

  const off = await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: false })
  ok('enabled=false 生效', off.body?.enabled === false, String(off.body?.enabled))
  const on = await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: true })
  ok('enabled=true 生效', on.body?.enabled === true, String(on.body?.enabled))

  const bad = await callRoute(routes['/dsh-tone/set'], 'GET')
  ok('GET /set → 405', bad.status === 405, 'status=' + bad.status)

  console.log('\n[5] widget.js 可读')
  const w = await callRoute(routes['/dsh-tone/widget.js'], 'GET')
  ok('HTTP 200', w.status === 200, 'status=' + w.status)

  console.log('\n[6] system prompt 通道')
  ok('注册了 section 或 context', sections.length > 0 || Object.keys(hooks).length > 0)
  if (sections.length > 0) {
    const sec = sections[0]
    const text = typeof sec.text === 'function' ? sec.text({}) : sec.text
    ok('section 有 name', typeof sec.name === 'string' && sec.name.length > 0)
    ok('section text 是字符串', typeof text === 'string')
    ok('section text 含档位头', text.indexOf('【语气档位') === 0, text.slice(0, 20))
    ok('section text 含优先级声明', text.indexOf('优先级高于其他人设') > 0)
  }

  console.log('\n[7] agent/request 温度通道')
  const reqHook = hooks['agent/request']
  if (typeof reqHook === 'function') {
    const expected = { 0: 0.45, 3: 0.45, 5: 0.72, 8: 0.95, 10: 1.12 }

    // 默认不接管采样：用户自己调好的 temperature 不该被插件悄悄覆盖
    // 先把 tempControl 明确置为 false，避免被真实状态文件里的用户设置干扰
    await callRoute(routes['/dsh-tone/set'], 'POST', { tempControl: false })
    let probe = await reqHook({}, () => Promise.resolve({ provider: 'p', model: 'm', temperature: 0.7 }))
    ok('默认 tempControl=false 时不动 temperature', probe.temperature === 0.7, String(probe.temperature))
    const st0 = await callRoute(routes['/dsh-tone/state'], 'GET')
    ok('state 里带 tempControl 字段', st0.body && st0.body.tempControl === false, JSON.stringify(st0.body && st0.body.tempControl))

    await callRoute(routes['/dsh-tone/set'], 'POST', { tempControl: true })
    const st1 = await callRoute(routes['/dsh-tone/state'], 'GET')
    ok('tempControl 可开启', st1.body && st1.body.tempControl === true, JSON.stringify(st1.body && st1.body.tempControl))

    for (const tone of Object.keys(expected)) {
      await callRoute(routes['/dsh-tone/set'], 'POST', { tone: Number(tone), enabled: true, tempControl: true })
      const res = await reqHook({}, () => Promise.resolve({ provider: 'p', model: 'm', temperature: 0.7 }))
      ok('tone=' + tone + ' → temperature=' + expected[tone], res.temperature === expected[tone], String(res.temperature))
      ok('tone=' + tone + ' 保留 provider/model', res.provider === 'p' && res.model === 'm')
    }
    await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: false, tempControl: true })
    const offRes = await reqHook({}, () => Promise.resolve({ provider: 'p', model: 'm', temperature: 0.7 }))
    ok('停用时温度不变', offRes.temperature === 0.7, String(offRes.temperature))

    // 关掉 tempControl 应当立即放手
    await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: true, tone: 10, tempControl: false })
    const releaseRes = await reqHook({}, () => Promise.resolve({ provider: 'p', model: 'm', temperature: 0.7 }))
    ok('关掉 tempControl 后不接管', releaseRes.temperature === 0.7, String(releaseRes.temperature))
    await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: true })
  } else {
    ok('注册了 agent/request', false, 'hook 缺失')
  }

  console.log('\n[8] /dsh-tone/inspect 自检')
  {
    ok('注册了 inspect 路由', typeof routes['/dsh-tone/inspect'] === 'function')
    if (typeof routes['/dsh-tone/inspect'] === 'function') {
      const got = await callRoute(routes['/dsh-tone/inspect'], 'GET')
      ok('inspect 返回 200', got.status === 200, String(got.status))
      ok('inspect 能拿到 systemPrompt 服务', got.body.hasService === true)
      ok('section 真的注册进去了', got.body.hasMine === true, JSON.stringify(got.body.sections?.map(x => x.name)))
      ok('inspect 回带注入正文', typeof got.body.text === 'string' && got.body.text.indexOf('语气档位') !== -1)
      const bad = await callRoute(routes['/dsh-tone/inspect'], 'POST', {})
      ok('inspect 只认 GET', bad.status === 405, String(bad.status))
    }
  }

  console.log('\n[8b] /state 返回的是实际生效的文案（预览不能骗人）')
  {
    // 清掉自定义：应该回落到 levels.default.json 的内容
    await callRoute(routes['/dsh-tone/set'], 'POST', { levels: null })
    const live = await callRoute(routes['/dsh-tone/state'], 'GET')
    const fileLevels = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'lib', 'levels.default.json'), 'utf8'))
    ok('levelsCustom=false 时 state.levels 等于默认文件',
      JSON.stringify(live.body.levels) === JSON.stringify(fileLevels),
      JSON.stringify(live.body.levels?.[0]?.name))

    // 写自定义后：state.levels 应该就是那套自定义
    const custom = fileLevels.map((l, i) => ({ name: l.name + i, text: l.text + ' [custom' + i + ']' }))
    await callRoute(routes['/dsh-tone/set'], 'POST', { levels: custom })
    const customLive = await callRoute(routes['/dsh-tone/state'], 'GET')
    ok('自定义后 state.levels 等于自定义',
      JSON.stringify(customLive.body.levels) === JSON.stringify(custom.map(c => ({ name: c.name.slice(0, 24), text: c.text.slice(0, 600) }))),
      JSON.stringify(customLive.body.levels?.[0]?.name))
    ok('自定义后 levelsCustom=true', customLive.body.levelsCustom === true)

    await callRoute(routes['/dsh-tone/set'], 'POST', { levels: null })
  }

  console.log('\n[9] 默认文案文件')
  const levels = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'lib', 'levels.default.json'), 'utf8'))
  ok('四档', Array.isArray(levels) && levels.length === 4)
  for (let i = 0; i < levels.length; i += 1) {
    ok('第 ' + i + ' 档 name ≤ 24 字', levels[i].name.length <= 24, String(levels[i].name.length))
    ok('第 ' + i + ' 档 text ≤ 600 字', levels[i].text.length <= 600, String(levels[i].text.length))
    ok('第 ' + i + ' 档 text 非空', levels[i].text.trim().length > 0)
  }
} finally {
  if (before === null) { try { fs.unlinkSync(STATE) } catch {} }
  else fs.writeFileSync(STATE, before)
  console.log('\n状态文件已恢复')
  console.log('─'.repeat(46))
  console.log(`通过 ${pass}  失败 ${fail}`)
  if (fail > 0) process.exitCode = 1
}
