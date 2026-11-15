/**
 * dsh-tone 冒烟测试 —— 用一个假的 DSH host 跑完整链路。
 * 重启前跑一次：node test/smoke.mjs
 * 它不碰真实状态文件（备份 + 恢复），也不依赖正在运行的 DSH。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, __LEVEL_BOUNDS, __levelIndexOf } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-tone.json')

// 测试会临时改写真实状态文件再恢复。正常跑完有 finally 兜底，
// 但 Ctrl+C / 被 kill 时 finally 不一定执行 —— 那样用户的档位就丢了。
// 所以再把恢复挂到进程退出信号上，同一份备份只恢复一次。
let STATE_BACKUP = null
let RESTORED = false
function restoreState() {
  if (RESTORED) return
  RESTORED = true
  try {
    if (STATE_BACKUP === null) { try { fs.unlinkSync(STATE) } catch {} }
    else fs.writeFileSync(STATE, STATE_BACKUP)
  } catch {}
}
process.on('exit', restoreState)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try { process.on(sig, () => { restoreState(); process.exit(130) }) } catch {}
}

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

function runAssemble(list) {
  if (!Array.isArray(list)) return
  const sec = list.find((x) => x && x.name === 'dsh-tone:level')
  if (sec && typeof sec.text === 'function') sec.text({})
}

async function callRoute(handler, method, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
  let destroyed = false
  const req = {
    method,
    on(ev, cb) {
      if (ev === 'data' && payload) setImmediate(() => cb(payload))
      if (ev === 'end') setImmediate(() => cb())
      return req
    },
    // 假的 request 也得有 destroy：readBody 在超限时会调它。
    destroy() { destroyed = true },
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
// 立刻记下来：如果测试中途被 kill，恢复时才有东西可写。
// 晚到 finally 才赋值的话，中途退出会走「删掉状态文件」那条分支。
STATE_BACKUP = before

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

    // 求值一次之后，/state 要能报出"上一轮真正注入的档位"
    const withLa = await callRoute(routes['/dsh-tone/state'], 'GET')
    const la = withLa.body && withLa.body.lastApplied
    ok('state 带 lastApplied', !!la && typeof la === 'object', JSON.stringify(la))
    ok('lastApplied.tone 是整数', !!la && Number.isInteger(la.tone), JSON.stringify(la))
    ok('lastApplied.chars > 0', !!la && la.chars > 0, JSON.stringify(la))
    ok('lastApplied.name 非空', !!la && typeof la.name === 'string' && la.name.length > 0, JSON.stringify(la))
  }

  console.log('\n[6.4] 停用时清空 lastApplied')
  {
    await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: true })
    runAssemble(sections)
    const before = (await callRoute(routes['/dsh-tone/state'], 'GET')).body.lastApplied
    ok('启用时有快照', !!before && before.tone !== null, JSON.stringify(before))
    await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: false })
    runAssemble(sections)
    const after = (await callRoute(routes['/dsh-tone/state'], 'GET')).body.lastApplied
    ok('停用后快照被清空', !!after && after.tone === null, JSON.stringify(after))
    await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: true })
    runAssemble(sections)
  }

  console.log('\n[6.45] levelsError 字段')
  {
    const st = (await callRoute(routes['/dsh-tone/state'], 'GET')).body
    ok('state 带 levelsError 字段', typeof st.levelsError === 'string', String(st.levelsError))
    // 正常状态下应该是空串（文件健康）
    ok('文件健康时 levelsError 为空', st.levelsError === '', st.levelsError)

    // 故意写坏默认文案文件，确认错误被捕获而不是抛出去
    const lvPath = new URL('../lib/levels.default.json', import.meta.url)
    const backup = fs.readFileSync(lvPath, 'utf8')
    try {
      fs.writeFileSync(lvPath, '{ 这不是 json', 'utf8')
      // 清缓存：mtime+size 变了，下一次读会自动重载
      const broken = (await callRoute(routes['/dsh-tone/state'], 'GET')).body
      ok('写坏后 levelsError 非空', typeof broken.levelsError === 'string' && broken.levelsError.length > 0, broken.levelsError)
      ok('写坏后仍能正常返回 state', !!broken && typeof broken.tone === 'number')
      ok('写坏后 levels 回落成 4 档', Array.isArray(broken.levels) && broken.levels.length === 4)
    } finally {
      fs.writeFileSync(lvPath, backup, 'utf8')
    }
    const fixed = (await callRoute(routes['/dsh-tone/state'], 'GET')).body
    ok('恢复后 levelsError 清零', fixed.levelsError === '', fixed.levelsError)
  }

  console.log('\n[6.48] stateError 字段')
  const idxSrc2 = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
  {
    const st = (await callRoute(routes['/dsh-tone/state'], 'GET')).body
    ok('state 带 stateError 字段', typeof st.stateError === 'string', String(st.stateError))
    ok('正常时 stateError 为空', st.stateError === '', st.stateError)
    // 写盘失败时不该只回一个 write-failed，得说清是盘满还是没权限
    ok('state 带 writeError 字段', typeof st.writeError === 'string', String(st.writeError))
    ok('写成功时 writeError 为空', st.writeError === '', String(st.writeError))

    // 把状态文件写坏，确认被捕获而不是把接口打挂
    const backup = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : null
    try {
      fs.writeFileSync(STATE, '{ 坏掉的状态文件', 'utf8')
      const broken = (await callRoute(routes['/dsh-tone/state'], 'GET')).body
      ok('写坏后 stateError 非空', typeof broken.stateError === 'string' && broken.stateError.length > 0, broken.stateError)
    // 坏文件不能直接丢：内容可能只是多了个逗号，
    // 用户还能从里面手工捐出自定义文案。
    ok('坏文件被另存（不直接丢）', /STATE_FILE \+ '\.broken-'/.test(idxSrc2))
      ok('写坏后仍返回合法 state', typeof broken.tone === 'number' && !!broken.pos)
    } finally {
      if (backup === null) { try { fs.unlinkSync(STATE) } catch {} }
      else fs.writeFileSync(STATE, backup, 'utf8')
    }
    const fixed = (await callRoute(routes['/dsh-tone/state'], 'GET')).body
    ok('恢复后 stateError 清零', fixed.stateError === '', fixed.stateError)
  }

  console.log('\n[6.55] set 路由的极端输入不能把状态弄坏')
  {
    const S = routes['/dsh-tone/set']
    const ST = routes['/dsh-tone/state']

    // 越界档位要被钳住，不能写进 -1 或 99
    await callRoute(S, 'POST', { tone: 99 })
    let d = (await callRoute(ST, 'GET')).body
    ok('tone=99 被钳到 10', d.tone === 10, 'tone=' + d.tone)

    await callRoute(S, 'POST', { tone: -5 })
    d = (await callRoute(ST, 'GET')).body
    ok('tone=-5 被钳到 0', d.tone === 0, 'tone=' + d.tone)

    // 非数字不能被当 0 写进去，也不该抛
    await callRoute(S, 'POST', { tone: 'abc' })
    d = (await callRoute(ST, 'GET')).body
    ok('tone="abc" 不崩溃且仍是合法数字',
      typeof d.tone === 'number' && d.tone >= 0 && d.tone <= 10, 'tone=' + d.tone)

    // 非法 side 回落，非法 y 被钳到 0..1
    await callRoute(S, 'POST', { pos: { side: 'diagonal', y: 42 } })
    d = (await callRoute(ST, 'GET')).body
    ok('pos.side 非法时回落', d.pos.side === 'right' || d.pos.side === 'left', 'side=' + d.pos.side)
    ok('pos.y 被钳到 0..1', d.pos.y >= 0 && d.pos.y <= 1, 'y=' + d.pos.y)

    // levels 元素数不对时不该被当成自定义
    await callRoute(S, 'POST', { levels: [{ name: 'a', text: 'b' }] })
    d = (await callRoute(ST, 'GET')).body
    ok('levels 只有 1 个时不认作自定义', d.levelsCustom === false, 'levelsCustom=' + d.levelsCustom)
    ok('levels 仍是 4 档', Array.isArray(d.levels) && d.levels.length === 4, 'len=' + (d.levels || []).length)

    // 同一个坑在 pos.y 上也有：Number(null) === 0，会把把手贴到顶部。
    await callRoute(S, 'POST', { pos: { y: null } })
    d = (await callRoute(ST, 'GET')).body
    ok('pos.y=null 回到默认 0.5（不是 0）', d.pos.y === 0.5, 'y=' + d.pos.y)

    // null 是「没设」，不能当成 0（公事公办）写进去。
    // Number(null) === 0，这一点极容易让人踩坑。
    await callRoute(S, 'POST', { tone: null })
    d = (await callRoute(ST, 'GET')).body
    ok('tone=null 回到默认 7（不是 0）', d.tone === 7, 'tone=' + d.tone)

    // 空对象不该把已有设置清掉
    await callRoute(S, 'POST', { tone: 7 })
    await callRoute(S, 'POST', {})
    d = (await callRoute(ST, 'GET')).body
    ok('POST 空对象不动已有值', d.tone === 7, 'tone=' + d.tone)

    // 字符串 tone 是明显传错了，不能静默改成默认档——
    // 调用方会以为设上了，实际变成了 7。
    const bad = await callRoute(S, 'POST', { tone: 'abc' })
    ok('字符串 tone 被拒（400）', bad.status === 400, 'status=' + bad.status)
    ok('拒绝原因说清楚', bad.body && bad.body.error === 'bad-tone', JSON.stringify(bad.body))
    d = (await callRoute(ST, 'GET')).body
    ok('被拒时没改档位', d.tone === 7, 'tone=' + d.tone)

    // 前端把 400 统一说成「JSON 不合法」是错的：bad-tone 也是 400。
    // 不先认 bad-tone 的话，用户会去查自己的 JSON。
    const wsrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
    ok('bad-tone 有自己的提示',
      /code === 'bad-tone'\)\s*return/.test(wsrc))
    // 服务端发什么 code，前端就得认识什么 code。
    // 不然新加一个错误码，用户看到的只是「HTTP 500」。
    {
      const ixi2 = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
      const codes = [...new Set([...ixi2.matchAll(/error: '([a-z-]+)'/g)].map((m) => m[1]))]
      ok('服务端至少有一个错误码', codes.length > 0)
      for (const c of codes) {
        ok('前端认识错误码 ' + c, wsrc.indexOf("code === '" + c + "'") >= 0)
      }
    }
    ok('bad-tone 提示排在通用 400 之前',
      wsrc.indexOf("code === 'bad-tone'") < wsrc.indexOf('status === 400 || code ==='))

    // 写盘应该是「临时文件 + 改名」，不能直接覆盖目标文件：
    // 中途崩溃会留下半个 JSON，用户的档位和文案就没了。
    const idxSrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
    ok('写盘用临时文件 + rename',
      /STATE_FILE \+ '\.tmp'/.test(idxSrc) && idxSrc.indexOf('renameSync') >= 0)
  }

  console.log('\n[6.52] inspect 分通道汇报')
  {
    const ins = (await callRoute(routes['/dsh-tone/inspect'], 'GET')).body
    ok('hasLevel 字段存在', typeof ins.hasLevel === 'boolean')
    ok('hasTail 字段存在', typeof ins.hasTail === 'boolean')
    ok('tailIsLast 字段存在', typeof ins.tailIsLast === 'boolean')
    // 两条通道要对称：section 有全文、tail 也不能只有布尔值
    // tailStatus 是给人看的结论：不在 / 在但不在最后 / 就在最后，
    // 三种不能混成一个 false。
    ok('inspect 带 tailStatus', typeof ins.tailStatus === 'string', String(ins.tailStatus))
    ok('tailStatus 是三种合法值之一',
      ['ok', 'not-last', 'missing'].indexOf(ins.tailStatus) >= 0, String(ins.tailStatus))
    ok('tail 带字数和预览', !ins.tail || (typeof ins.tail.chars === 'number' && typeof ins.tail.preview === 'string'))
    ok('hasMine 兼容旧字段', typeof ins.hasMine === 'boolean')
    ok('sections 是数组', Array.isArray(ins.sections))
  }

  console.log('\n[6.5] 收尾压一句（system-prompt/assemble）')
  const asmHook = hooks['system-prompt/assemble']
  ok('注册了 system-prompt/assemble', typeof asmHook === 'function')
  if (typeof asmHook === 'function') {
    // 假装别的插件先塞了一条，验证我们排在它后面
    const fake = () => Promise.resolve({ sections: [{ name: 'dsh-expression:companion', text: '主动斗图' }] })
    const out = await asmHook({}, {}, fake)
    const list = (out && out.sections) || []
    ok('push 了新 section', list.length === 2, 'len=' + list.length)
    const last = list[list.length - 1]
    ok('最后一个是 dsh-tone:tail', last && last.name === 'dsh-tone:tail', last && last.name)
    ok('tail 含档位数字', !!last && last.text.indexOf('/10') > 0)
    ok('tail 明确压过斗图', !!last && last.text.indexOf('斗图') > 0)
    // 停用时不该塞
    await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: false })
    const off = await asmHook({}, {}, () => Promise.resolve({ sections: [] }))
    ok('停用时不 push', (off.sections || []).length === 0, 'len=' + (off.sections || []).length)
    await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: true })
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

  // 文案是给别人装的，示例里不能出现只有原作者看得懂的词。
  // 这几个词来自开发这个插件的那台机器（端口号、路由名、测试结论），
  // 一旦漏进默认文案，别人看到就是一脸问号。加一条回归钉死。
  const LEAKS = ['5488', '405', 'POST /state', '四条路由', 'channel=section', '_bak/']
  for (let i = 0; i < levels.length; i += 1) {
    const hit = LEAKS.filter((w) => levels[i].text.includes(w))
    ok('第 ' + i + ' 档无项目专用黑话', hit.length === 0, hit.join(','))
  }

  // 界面那行说明是按「。」取第 2 句来的（widget.js levelDesc）。
  // 所以标题句里多写一个句号，就会把说明截成四个字 —— 这条防的就是这个。
  for (let i = 0; i < levels.length; i += 1) {
    const parts = levels[i].text.split('。')
    const desc = parts.slice(1).find((x) => x.trim().length >= 4) || ''
    ok('第 ' + i + ' 档的界面说明够长（≥8 字）', desc.trim().length >= 8, '「' + desc.trim() + '」' + desc.trim().length + ' 字')
  }

  console.log('\n[10] 绝不注册 agent/pre-step（那会把 DSH 弄崩）')
  // 2026-11-15 事故：往 decision.messages 里塞 role:"system" 的消息，
  // 会话事件是 type:"user/message" 但 data.role:"system"，类型和内容打架，
  // DSH 前端校验直接崩，13 分钟里连塞 63 条全炸。这条通道从此不许再开。
  ok('没有注册 agent/pre-step', typeof hooks['agent/pre-step'] === 'undefined')
  if (typeof hooks['agent/pre-step'] === 'function') {
    // 真注册了也不能改 messages：喂一条进去，出来必须一模一样。
    const seed = [{ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, id: 'seed-1' }]
    const out = await hooks['agent/pre-step']({}, async () => ({ kind: 'enter', messages: seed }))
    const list = out && out.messages
    ok('messages 条数不变', Array.isArray(list) && list.length === seed.length, 'in=' + seed.length + ' out=' + (list && list.length))
    ok('没有非 user/assistant 的条目', Array.isArray(list) && list.every((m) => m && (m.role === 'user' || m.role === 'assistant')), JSON.stringify((list || []).map((m) => m && m.role)))
  }
  // 源码层也守一道：不许再出现这个钩子名。
  const ixSrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
  ok('源码里不再注册 agent/pre-step', ixSrc.indexOf("'agent/pre-step'") < 0)

console.log('\n[16b] 档位切换时会点破「历史是旧档位写的」')
{
  // 换档说破现在走 section 通道（不再塞 messages），
  // 所以直接取 section 的文本来看。
  const toneText = () => {
    const sec = sections.find((x) => x && x.name === 'dsh-tone:level')
    return sec && typeof sec.text === 'function' ? sec.text({}) : ''
  }
  await callRoute(routes['/dsh-tone/set'], 'POST', { enabled: true, tone: 10 })
  const t1 = toneText()
  ok('第一次跑不该提「上一轮」', !t1.includes('上一轮还是'), t1.slice(-60))
  await callRoute(routes['/dsh-tone/set'], 'POST', { tone: 2 })
  const t2 = toneText()
  ok('换档后要说明上一轮是几档', t2.includes('上一轮还是 10/10'), t2.slice(-80))
  ok('并且换成 2/10', t2.includes('这一轮换成了 2'), t2.slice(-80))
  const t3 = toneText()
  ok('同一档连续两轮不再重复提', !t3.includes('上一轮还是'), t3.slice(-60))
  await callRoute(routes['/dsh-tone/set'], 'POST', { tone: 10 })
}

console.log('\n[16] 注入给模型的是纯文本，不带 markdown 记号')
{
  // 系统提示是纯文本管道，**加粗** 和 `代码` 不会被渲染，只会把记号本身塞给模型。
  const markdown = ['**', '`', '## ']
  const check = (label, text) => {
    for (const m of markdown) {
      ok(label + ' 不含 ' + JSON.stringify(m), !text.includes(m), text.includes(m) ? '出现了' : '')
    }
  }
  const snap = (await callRoute(routes['/dsh-tone/state'], 'GET')).body
  snap.levels.forEach((lv, i2) => check('第 ' + i2 + ' 档文案', lv.text))
  const insp = (await callRoute(routes['/dsh-tone/inspect'], 'GET')).body
  check('section 全文', insp.text || '')
  check('tail 预览', (insp.tail && insp.tail.preview) || '')
}

} finally {
  restoreState()

    console.log('\n[12] widget.js 真的读得到')
  // 上上轮踩过：一行注释把 const WIDGET_FILE 吃掉了，readWidgetSource 静默
  // 返回空串，界面面板凭空消失、没有任何报错。这条防的就是「读不到但不说」。
  try {
    const src = fs.readFileSync(new URL('../lib/widget.js', import.meta.url), 'utf8')
    ok('widget.js 文件存在且非空', src.length > 5000, src.length + ' 字节')
    ok('widget.js 里有挂载点', src.indexOf('dsh-tone-dock') >= 0)
    ok('widget.js 里有 API 地址', src.indexOf('/dsh-tone/state') >= 0)
  } catch (error) {
    ok('widget.js 文件存在且非空', false, String(error && error.message))
  }

  console.log('\n[13] index.js 的顶层常量都有定义')
  // 上轮踩过：一行注释把 const WIDGET_FILE 吃掉，语法照样合法、
  // node --check 照样通过，只有运行时才炸。这条静态扫一遍顶层标识符。
  try {
    const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    const defined = new Set([
      ...(src.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm) || []).map((m) => m.split(/\s+/)[1].replace('=', '')),
      ...(src.match(/^function\s+([A-Za-z_$][\w$]*)/gm) || []).map((m) => m.split(/\s+/)[1]),
    ])
    const CRITICAL = ['WIDGET_FILE', 'LEVEL_FILE', 'STATE_FILE', 'DSH_HOME', 'TONE_MAX', 'TONE_MIN']
    let miss = []
    for (const name of CRITICAL) if (!defined.has(name)) miss.push(name)
    ok('关键常量都有顶层定义', miss.length === 0, miss.length ? '缺：' + miss.join(', ') : '6/6')
  } catch (error) {
    ok('关键常量都有顶层定义', false, String(error && error.message))
  }

  console.log('\n[14] package.json 的 files 覆盖了全部代码文件')
  // Round 70 踩过：加了 test/diff.mjs 但忘了写进 files，
  // 本地测得到、npm pack 之后就没有了 —— 发布后才暴露。
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const files = Array.isArray(pkg.files) ? pkg.files : []
    const root = new URL('../', import.meta.url)
    const need = []
    for (const dir of ['lib', 'test']) {
      let names = []
      try { names = fs.readdirSync(new URL(dir + '/', root)) } catch { continue }
      for (const f of names) {
        if (f.endsWith('.bak') || f.indexOf('.bak_') >= 0 || f.startsWith('_')) continue
        need.push(dir + '/' + f)
      }
    }
    const missing = need.filter((rel) => {
      // files 里可能写目录（'lib/'）或具体文件
      return !files.some((entry) => entry === rel || (entry.endsWith('/') && rel.startsWith(entry)))
    })
    ok('files 覆盖 lib/ 与 test/ 下所有文件', missing.length === 0,
      missing.length ? '缺：' + missing.join(', ') : need.length + ' 个文件全覆盖')
    ok('files 里没有 .bak 备份', files.every((e) => e.indexOf('bak') < 0), files.filter((e) => e.indexOf('bak') >= 0).join(',') || '干净')
  } catch (error) {
    ok('files 覆盖 lib/ 与 test/ 下所有文件', false, String(error && error.message))
  }

  console.log('\n[15] widget.js 给用户看的文案里没有行话')
  // 连着几轮都在扫黑话（注入/section/压尾/分通道），每次都是手扫手比。
  // 这条把词表钉死。按行过滤掉纯注释行再扫 —— 比解析字符串字面量可靠，
  // 因为 JS 里的撇号和反引号会把简单正则骗过去（上一版就这么误报过）。
  try {
    const src = fs.readFileSync(new URL('../lib/widget.js', import.meta.url), 'utf8')
    const code = src.split(/\r?\n/).filter((ln) => {
      const t = ln.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    // 只扫含中文的行：用户能看到的文案一定带中文，
    // 纯英文的 'section' 比较（if (ch === 'section')）是逻辑不是文案。
    const JARGON = ['注入', 'section', '压尾', '分通道']
    const hits = []
    for (const ln of code) {
      if (!/[\u4e00-\u9fa5]/.test(ln)) continue
      for (const w of JARGON) {
        if (ln.indexOf(w) >= 0) hits.push(w + ' ← ' + ln.trim().slice(0, 50))
      }
    }
    ok('界面文案里没有行话词', hits.length === 0, hits.length ? hits.join(' | ') : code.length + ' 行代码全干净')
  } catch (error) {
    ok('界面文案里没有行话词', false, String(error && error.message))
  }

console.log('\n[17] 编辑区的每个按钮都绑了点击事件')
try {
  // Round 56 踩过：加了「从剪贴板导入」按钮，忘了在事件委托里加分支，
  // 按钮是死的，但 node --check 和当时所有测试都过。这条防的是同一类事。
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
  const btnIds = []
  const reBtn = /class="dsh-tone-btn[^"]*"\s+id="(dsh-tone-[a-z-]+)"/g
  let m
  while ((m = reBtn.exec(src)) !== null) btnIds.push(m[1])
  ok('扫到了编辑区按钮', btnIds.length >= 3, btnIds.join(', '))
  for (const id of btnIds) {
    // 两种绑法都算：事件委托里的 target.id 分支，
    // 或者直接 getElementById(...).addEventListener。
    const byDelegate = src.indexOf("target.id === '" + id + "'") >= 0
    const byDirect = src.indexOf("getElementById('" + id + "').addEventListener") >= 0
    ok('按钮 ' + id + ' 有点击处理',
      byDelegate || byDirect,
      byDelegate ? '事件委托' : (byDirect ? '直接绑定' : '两种都没找到'))
  }
} catch (error) {
  ok('扫到了编辑区按钮', false, String(error && error.message))
}

console.log('\n[17b] \u754c\u9762\u63cf\u8ff0\u5728\u81ea\u5b9a\u4e49\u6587\u6848\u4e0b\u4e5f\u4e0d\u4f1a\u7a7a')
try {
  // levelDesc \u6309\u300c\u3002\u300d\u53d6\u7b2c\u4e8c\u53e5\u3002\u7528\u6237\u81ea\u5b9a\u4e49\u7684\u6587\u6848\u53ef\u80fd\u5168\u662f\u77ed\u53e5\uff0c
  // \u90a3\u6837\u4e00\u5b57\u4e5f\u53d6\u4e0d\u5230\uff0c\u754c\u9762\u90a3\u884c\u5c31\u7a7a\u4e86\u3002\u8981\u6709\u56de\u843d\u3002
  const wsrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
  ok('levelDesc \u6709\u539f\u6587\u622a\u65ad\u56de\u843d', wsrc.indexOf('raw.slice(0, 40)') >= 0)
  ok('\u56de\u843d\u524d\u4f1a\u5148\u5224\u7a7a', wsrc.indexOf("if (!raw) return ''") >= 0)
} catch (error) {
  ok('levelDesc \u6709\u539f\u6587\u622a\u65ad\u56de\u843d', false, String(error && error.message))
}

console.log('\n[17c] \u7f16\u8f91\u5668\u4f1a\u63d0\u9192\u672a\u4fdd\u5b58\u7684\u6539\u52a8')
try {
  // \u6539\u4e86\u6587\u6848\u6ca1\u70b9\u4fdd\u5b58\u5c31\u5173\u9762\u677f\uff0c\u6539\u52a8\u4f1a\u4e22\u3002\u81f3\u5c11\u5f97\u6709\u4e00\u53e5\u63d0\u9192\u3002
  const wsrc2 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
  ok('\u6709\u672a\u4fdd\u5b58\u63d0\u793a\u7684\u5143\u7d20', wsrc2.indexOf('dsh-tone-dirty') >= 0)
  ok('\u8f93\u5165\u65f6\u4f1a\u6807\u810f', wsrc2.indexOf('\u6709\u672a\u4fdd\u5b58\u7684\u6539\u52a8') >= 0)
  ok('\u4fdd\u5b58\u65f6\u4f1a\u6e05\u6389\u63d0\u793a',
    wsrc2.indexOf("var dirty2 = document.getElementById('dsh-tone-dirty')") >= 0)
} catch (error) {
  ok('\u6709\u672a\u4fdd\u5b58\u63d0\u793a\u7684\u5143\u7d20', false, String(error && error.message))
}

console.log('\n[6.56] 坏 body 不能返回 200（否则用户以为保存了）')
try {
  // 这一块不在主 try 里，routes 不可见，自己建一个 host。
  const h3 = makeHost()
  apply(h3.host)
  const R3 = h3.routes
  const beforeTone = (await callRoute(R3['/dsh-tone/state'], 'GET')).body.tone
  const bad = await callRoute(R3['/dsh-tone/set'], 'POST', undefined)
  ok('空 body 返回 400', bad.status === 400, 'status=' + bad.status)
  // callRoute 会 JSON.stringify，所以传一个大对象就是大 body。
  const big = await callRoute(R3['/dsh-tone/set'], 'POST', { huge: 'x'.repeat(140 * 1024) })
  ok('超大 body 不返回 200', big.status !== 200, 'status=' + big.status)
  const afterTone = (await callRoute(R3['/dsh-tone/state'], 'GET')).body.tone
  ok('坏 body 不会改档位', afterTone === beforeTone, beforeTone + ' -> ' + afterTone)
} catch (error) {
  ok('空 body 返回 400', false, String(error && error.message))
}

console.log('\n[17d] \u4fdd\u5b58\u5931\u8d25\u8981\u8bf4\u4eba\u8bdd\uff0c\u4e0d\u8981\u53ea\u62a5 HTTP \u7801')
try {
  // \u300cHTTP 413\u300d\u5bf9\u7528\u6237\u6ca1\u610f\u4e49\uff1a\u4ed6\u8be5\u622a\u77ed\u5185\u5bb9\uff0c\u800c\u4e0d\u662f\u91cd\u8bd5\u3002
  const wsrc3 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
  ok('\u6709 describeErr \u8bd1\u5236\u51fd\u6570', wsrc3.indexOf('function describeErr') >= 0)
  ok('413 \u7ffb\u8bd1\u6210\u300c\u5185\u5bb9\u592a\u5927\u300d', wsrc3.indexOf('\u5185\u5bb9\u592a\u5927\u4e86') >= 0)
  ok('400 \u7ffb\u8bd1\u6210\u300c\u4e0d\u662f\u5408\u6cd5 JSON\u300d', wsrc3.indexOf('\u4e0d\u662f\u5408\u6cd5 JSON') >= 0)
  ok('\u8bfb\u4e0d\u5230 body \u4e5f\u4e0d\u4f1a\u518d\u629b', wsrc3.indexOf("catch(function () { return {}; })") >= 0)
} catch (error) {
  ok('\u6709 describeErr \u8bd1\u5236\u51fd\u6570', false, String(error && error.message))
}

console.log('\n[17e] \u51fa\u9519\u8981\u544a\u8bc9\u4eba\u600e\u4e48\u529e\uff0c\u4e0d\u8981\u53ea\u62a5\u9519\u56e0')
try {
  const w4 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
  ok('writeError \u4f1a\u88ab\u8bfb\u8fdb\u6765', w4.indexOf('state.writeError = d.writeError') >= 0)
  ok('writeError \u4f1a\u663e\u793a', w4.indexOf('\u4e0a\u4e00\u6b21\u4fdd\u5b58\u5199\u4e0d\u8fdb\u53bb') >= 0)
  ok('stateError \u7ed9\u51fa\u6062\u590d\u529e\u6cd5', w4.indexOf('dsh-tone.json \u4f1a\u91cd\u5efa\u9ed8\u8ba4\u503c') >= 0)
} catch (error) {
  ok('writeError \u4f1a\u88ab\u8bfb\u8fdb\u6765', false, String(error && error.message))
}

console.log('\n[17f] /state \u8fd4\u56de\u7684\u5b57\u6bb5\uff0c\u754c\u9762\u90fd\u771f\u7684\u5728\u7528')
try {
  // Round 58 \u52a0\u4e86 writeError \u5374\u6ca1\u5728 widget \u91cc\u8bfb\uff0c\u7528\u6237\u4e00\u76f4\u770b\u4e0d\u5230\u3002
  // \u8fd9\u6761\u628a\u300c\u670d\u52a1\u7aef\u6dfb\u4e86\u5b57\u6bb5\u300d\u548c\u300c\u754c\u9762\u771f\u7684\u7528\u4e0a\u300d\u7ed1\u5728\u4e00\u8d77\u3002
  const w5 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
  // 去掉注释行再查：字段名只出现在注释里等于没接。
  const w5code = w5.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  const FIELDS = ['enabled', 'tone', 'pos', 'levels', 'tempControl', 'channel',
    'lastApplied', 'levelsError', 'stateError', 'writeError']
  for (const f of FIELDS) {
    ok('/state \u5b57\u6bb5 ' + f + ' \u5728\u4ee3\u7801\u91cc\u771f\u88ab\u8bfb', w5code.indexOf(f) >= 0)
  }
} catch (error) {
  ok('/state \u5b57\u6bb5\u90fd\u88ab\u754c\u9762\u4f7f\u7528', false, String(error && error.message))
}

console.log('\n[17g] \u56db\u6863\u53d6\u503c\u53ea\u6709\u4e00\u4e2a\u5165\u53e3')
try {
  // \u8fd9\u6bb5\u5224\u65ad\u539f\u672c\u5728\u56db\u4e2a\u5730\u65b9\u5404\u5199\u4e86\u4e00\u904d\uff0c\u6539\u4e00\u5904\u5c31\u5f97\u6539\u56db\u5904\u3002
  // \u73b0\u5728\u6536\u5230 resolveLevels / levelFor\uff0c\u8fd9\u6761\u9632\u7684\u662f\u53c8\u957f\u51fa\u7b2c\u4e94\u4efd\u3002
  const isrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
  ok('\u6709 resolveLevels', isrc.indexOf('function resolveLevels(') >= 0)
  ok('\u6709 levelFor', isrc.indexOf('function levelFor(') >= 0)
  const dup = isrc.split('levelsCustom === true && state?.levels').length - 1
  ok('\u5224\u65ad\u53ea\u5728 resolveLevels \u91cc\u5199\u4e00\u6b21', dup <= 1, '\u51fa\u73b0 ' + dup + ' \u6b21')
} catch (error) {
  ok('\u6709 resolveLevels', false, String(error && error.message))
}

console.log('\n[17h] package.json \u58f0\u660e\u4e86\u8fd0\u884c\u65f6\u8981\u6c42')
try {
  const pj = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  // \u7528\u4e86 systemPrompt.section / system-prompt/assemble / agent/pre-step\uff0c
  // \u4e0d\u58f0\u660e\u7684\u8bdd\u522b\u4eba\u5728\u66f4\u65e7\u7684 DSH \u4e0a\u88c5\u4e86\u4f1a\u9759\u9ed8\u5931\u6548\u3002
  ok('engines.dsh \u5df2\u58f0\u660e',
    typeof pj.engines === 'object' && typeof pj.engines.dsh === 'string',
    JSON.stringify(pj.engines))
  ok('engines.node \u5df2\u58f0\u660e',
    typeof pj.engines === 'object' && typeof pj.engines.node === 'string')
  ok('scripts \u91cc\u4e09\u4e2a\u811a\u672c\u90fd\u5728',
    ['test', 'demo', 'diff'].every((k) => typeof pj.scripts?.[k] === 'string'))
} catch (error) {
  ok('engines.dsh \u5df2\u58f0\u660e', false, String(error && error.message))
}

console.log('\n[17i] README \u63d0\u5230\u7684\u811a\u672c\u90fd\u4f1a\u88ab\u6253\u8fdb\u5305\u91cc')
try {
  const root = path.join(HERE, '..')
  const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const rd = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const files = pj.files || []
  // README \u544a\u8bc9\u7528\u6237\u8dd1  node test/xxx.mjs \u3001bash verify.sh\uff0c
  // \u4f46\u6ca1\u5199\u8fdb files \u7684\u8bdd\u88c5\u5b8c\u5c31\u627e\u4e0d\u5230\u2014\u2014\u6307\u5f15\u843d\u7a7a\u3002
  const wanted = []
  const re = /(?:node |bash )(test\/[a-z]+\.mjs|verify\.sh)/g
  let m
  while ((m = re.exec(rd)) !== null) if (wanted.indexOf(m[1]) < 0) wanted.push(m[1])
  ok('README \u91cc\u81f3\u5c11\u63d0\u5230\u4e00\u4e2a\u53ef\u8dd1\u811a\u672c', wanted.length > 0, wanted.join(', '))
  for (const w of wanted) {
    ok('「' + w + '」在 files 里', files.indexOf(w) >= 0, files.join(', '))
  }
} catch (error) {
  ok('README \u811a\u672c\u90fd\u5728\u5305\u91cc', false, String(error && error.message))
}

console.log('\n[17j] verify.sh \u7684\u7ae0\u8282\u7f16\u53f7\u6ca1\u91cd\u590d')
try {
  // \u5b83\u662f\u7ed9\u4eba\u8dd1\u7684\u811a\u672c\uff0c\u7ae0\u8282\u4e71\u5e8f\u4e0d\u4f1a\u62a5\u9519\uff0c\u53ea\u4f1a\u8ba9\u4eba\u8bfb\u4e0d\u61c2\u3002
  const vs = fs.readFileSync(path.join(HERE, '..', 'verify.sh'), 'utf8')
  const nums = []
  const re = /echo "===== ([0-9]+[a-z]?)\./g
  let m
  while ((m = re.exec(vs)) !== null) nums.push(m[1])
  ok('verify.sh \u91cc\u81f3\u5c11\u6709 5 \u4e2a\u7ae0\u8282', nums.length >= 5, nums.join(','))
  const dup = nums.filter((n, i) => nums.indexOf(n) !== i)
  ok('\u7ae0\u8282\u7f16\u53f7\u6ca1\u91cd\u590d', dup.length === 0, 'dup=' + dup.join(','))
  ok('\u7b2c\u4e00\u4e2a\u7ae0\u8282\u662f 0\uff08\u6e05\u5355\u81ea\u68c0\uff09', nums[0] === '0', nums[0])
} catch (error) {
  ok('verify.sh \u7ae0\u8282\u7f16\u53f7\u6ca1\u91cd\u590d', false, String(error && error.message))
}

console.log('\n[17k] README \u76ee\u5f55\u548c\u7ae0\u8282\u5bf9\u5f97\u4e0a')
try {
  // \u76ee\u5f55\u624b\u5199\uff0c\u65b0\u589e\u4e00\u8282\u5c31\u4f1a\u6f0f\u3002\u8fd9\u6761\u9632\u7684\u662f\u76ee\u5f55\u548c\u6b63\u6587\u8131\u8282\u3002
  const rd = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8')
  const heads = []
  for (const ln of rd.split('\n')) {
    const h = /^## (.+)$/.exec(ln)
    if (h) heads.push(h[1].trim())
  }
  // \u300c\u76ee\u5f55\u300d\u81ea\u5df1\u4e0d\u5217\u81ea\u5df1\uff0cLicense \u4e0d\u5217\uff08\u5927\u5bb6\u90fd\u77e5\u9053\uff09
  const shouldList = heads.filter((h) => h !== '目录' && h !== 'License')
  const tocBlock = rd.slice(rd.indexOf('## 目录'), rd.indexOf('## 它解决\u4ec0\u4e48'))
  const missing = shouldList.filter((h) => tocBlock.indexOf('[' + h + ']') < 0)
  ok('\u76ee\u5f55\u6ca1\u6f0f\u7ae0\u8282', missing.length === 0, '\u7f3a: ' + missing.join(' / '))
  ok('\u76ee\u5f55\u91cc\u6ca1\u591a\u4f59\u9879',
    (tocBlock.match(/^- \[/gm) || []).length === shouldList.length,
    '\u76ee\u5f55 ' + (tocBlock.match(/^- \[/gm) || []).length + ' vs \u7ae0\u8282 ' + shouldList.length)
} catch (error) {
  ok('\u76ee\u5f55\u6ca1\u6f0f\u7ae0\u8282', false, String(error && error.message))
}

console.log('\n[17l] levelsError \u4f1a\u8bf4\u660e\u5dee\u5728\u54ea')
try {
  // \u53ea\u8bf4\u300c\u9700\u8981 4 \u4e2a\u300d\u65f6\uff0c\u624b\u91cc\u62ff\u7740 3 \u4e2a\u5143\u7d20\u7684\u4eba\u4e5f\u731c\u4e0d\u51fa\u5dee\u5728\u54ea\u3002
  const lf = path.join(HERE, '..', 'lib', 'levels.default.json')
  const orig = fs.readFileSync(lf, 'utf8')
  try {
    fs.writeFileSync(lf, JSON.stringify([{ name: 'a', text: 'b' }]))
    const h = makeHost()
    apply(h.host)
    const r = await callRoute(h.routes['/dsh-tone/state'], 'GET')
    const err = String(r.body.levelsError || '')
    ok('levelsError \u975e\u7a7a', err.length > 0, err)
    ok('\u91cc\u9762\u5199\u4e86\u5b9e\u9645\u62ff\u5230\u51e0\u4e2a', err.indexOf('1 \u4e2a\u5143\u7d20') >= 0, err)
  } finally {
    fs.writeFileSync(lf, orig)
  }
} catch (error) {
  ok('levelsError \u975e\u7a7a', false, String(error && error.message))
}

  console.log('\n[17m2] 用户可编辑的文字不能直接进 innerHTML')
  {
    // 档位名字是用户自己写的，拼进 innerHTML 就是注入面。
    const w7 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
    ok('la.name 走过 escapeHtml',
      /escapeHtml\(la\.name/.test(w7), '上一轮那行里的档位名')
  }
  console.log('\n[17n] README 记录了所有对外字段')
  // 加了新字段却忘记写进 README 是这个项目里反复出现的漏洞：
  // 文档不会报错、不会变红，只有真的有人照着它查的时候才会发现。
  {
    const rd = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8')
    const EXPOSED = [
      'channel', 'hasService', 'hasMine', 'hasLevel', 'hasTail', 'tailIsLast',
      'tailStatus', 'tail', 'sections', 'text', 'lastApplied',
      'levelsError', 'stateError', 'writeError', 'tempControl', 'levelsCustom',
    ]
    for (const f of EXPOSED) {
      ok('README 提到字段 ' + f, rd.indexOf(f) >= 0)
  }
  {
    // 发版时最容易忘的就是 CHANGELOG：代码改了、
    // package.json 的版本也动了，只有更新记录还停在上一版。
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
    const clog = fs.readFileSync(path.join(HERE, '..', 'CHANGELOG.md'), 'utf8')
    ok('CHANGELOG 有当前版本的一节',
      clog.indexOf('## ' + pkg.version) >= 0, 'version=' + pkg.version)
    }
  }


  console.log('\n[17l4] NOTE_SUFFIX 两边一致')
  {
    // 这段在 index.js（真正注入）和 widget.js（本地预览）各写一份。
    // 分叉了就会让预览和真实注入对不上——上一次就是这么出的事。
    const ixi2 = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
    const wi2 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
    // 不去拼整段文字（两边拼法不同：一个用 + 拼，一个写在一行）。
    // 只要两边都含同一个关键短语，就说明没分叉。
    const KEY = '这是本轮生效的硬要求，不是建议'
    ok('index.js 的 NOTE_SUFFIX 是新版', ixi2.indexOf(KEY) >= 0)
    ok('widget.js 的 NOTE_SUFFIX 也是新版', wi2.indexOf(KEY) >= 0)
  }
  console.log('\n[17l3] 前后端的档位边界要一致')
  {
    // 这个数组在两个文件里各写了一份（前端不能 import 后端模块）。
    // 改一边忘了另一边，就会出现“滑块说这是 7 档、提示即是另一档”。
    const wi = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
    const ixi = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
    const wb = (wi.match(/var BOUNDS = \[([^\]]+)\]/) || [])[1]
    const ib = (ixi.match(/const LEVEL_BOUNDS = \[([^\]]+)\]/) || [])[1]
    ok('两边都找得到边界数组', !!wb && !!ib, 'widget=' + wb + ' index=' + ib)
    ok('两边数值一致', wb === ib, 'widget=' + wb + ' index=' + ib)
    // 温度表也是各写一份，同样的风险。
    const wt = (wi.match(/var TEMPS = \[([^\]]+)\]/) || [])[1]
    const it = (ixi.match(/const TEMPERATURE_BY_LEVEL = \[([^\]]+)\]/) || [])[1]
    ok('两边都找得到温度表', !!wt && !!it, 'widget=' + wt + ' index=' + it)
    ok('两边温度表一致', wt === it, 'widget=' + wt + ' index=' + it)
  }

  console.log('\n[17l7] 600 字上限的提示必须和保存逻辑一致')
  {
    // 编辑器本身不截断，原样把 text 发给 /dsh-tone/set；但服务端 writeState()
    // 会走 clampLevels()，text 被 trim().slice(0, 600) 之后才写盘 —— 实测 700 字
    // 存进去，盘上只剩 600 字。所以提示不能反过来声称「能保存，注入会变长」，
    // 更不能让人以为超出的部分还能生效。
    const w9 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
    ok('不再声称超出后只是变长', w9.indexOf('注入会变长') < 0)
    ok('说清超出会被截断或只保留前 600 字',
      w9.indexOf('截断') >= 0 || w9.indexOf('只保留前 600 字') >= 0)
  }

  console.log('\n[17l6] applyState 里 renderTone 必须在 renderLast 之前')
  {
    // 顺序反了的话，第一次加载时 state.tone 还是初始值 7，
    // 而 lastApplied 是 10，就会在滑块明明停在 10 时写「你已改成 7」。
    const w8 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
    // 只看 applyState 函数体：别处（如 30 秒轮询那段）也有 renderLast，
    // 用整文件 indexOf 会被更靠前的那一处带偏。
    const a8 = w8.indexOf('function applyState(')
    const b8 = w8.indexOf('function load()', a8)
    const body = a8 >= 0 && b8 > a8 ? w8.slice(a8, b8) : ''
    const iTone = body.indexOf('renderTone(Number(d.tone), false);')
    const iLast = body.indexOf('renderLast(d.lastApplied);')
    ok('applyState 里 renderTone 在 renderLast 之前', iTone > 0 && iLast > 0 && iTone < iLast,
      'tone@' + iTone + ' last@' + iLast)
  }

  console.log('\n[17l5] 滑块拿到不是数的档位也不能崩')
  {
    // 服务端老版本或字段缺失时，Number(undefined) === NaN。
    // NaN 灌进滑块和标签会让整个面板显示不了正常档位名。
    const w8 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
    ok('renderTone 防 NaN', w8.indexOf('if (!isFinite(n0)) n0 = 7') >= 0)
  }

  console.log('\n[17l2] 读不到设置要说出来')
  {
    // 滑块上显示 7 与“你的设置就是 7”在界面上长得一模一样。
    // 不说的话，用户会把默认值当成自己的设置。
    const w6 = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
    ok('load 失败时会告知用户', w6.indexOf('读不到设置') >= 0)
  }
  console.log('\n[17m] 开关控件的文案要跟着变')
  // 这四个都是开关：开与关是两个动作，文案只写一半的话，
  // 用户点完不知道再点一次是收起。
  {
    const TOGGLES = ['dsh-tone-en', 'dsh-tone-temp', 'dsh-tone-edit', 'dsh-tone-peek']
    const w5src = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')
    for (const id of TOGGLES) {
      const at = w5src.indexOf("getElementById('" + id + "')")
      ok('开关 ' + id + ' 能找到', at >= 0)
      if (at < 0) continue
      // 只看附近一段，足够覆盖它的处理函数。
      // 两种表达都算：改文字（textContent）或改样式类（.on）。
      // 例如启用开关靠 .on 表示状态，不需要文字。
      const chunk = w5src.slice(at, at + 1600)
      const hasText = /(textContent|innerHTML)\s*=/.test(chunk)
      const hasClass = /classList\.(add|remove|toggle)\(/.test(chunk)
      ok('开关 ' + id + ' 有状态反馈', hasText || hasClass,
        hasText ? 'textContent' : hasClass ? 'classList' : '两者都没有')
    }
  }

console.log('\n[18] getSectionOrder \u8fd4\u56de undefined \u65f6\u4e0d\u5d29\u3001\u56de\u843d 10200')
try {
  // \u5bbf\u4e3b\u5bfc\u51fa\u4e86\u8fd9\u4e2a\u51fd\u6570\uff0c\u4f46\u5e38\u91cf\u540d\u6539\u4e86 / \u5185\u90e8\u67e5\u8868\u5931\u8d25\uff0c
  // \u5c31\u4f1a\u8fd4\u56de undefined\u3002undefined + 10 = NaN\uff0c\u6392\u5e8f\u91cc a.order - b.order \u6052\u4e3a NaN\u3002
  const h2 = makeHost()
  h2.host.inject = ((orig) => function (deps, fn) {
    const sys = {
      section(s) { h2.sections.push(s); return () => {} },
      context(c) { return () => {} },
      getSectionOrder() { return undefined },
      async assemble() { return { sections: [] } },
    }
    fn({ webServer: { register() { return () => {} }, tapIndex() { return () => {} } }, systemPrompt: sys })
    return () => {}
  })(h2.host.inject)
  let threw2 = null
  try { apply(h2.host) } catch (e) { threw2 = e }
  ok('apply \u4e0d\u5d29', threw2 === null, threw2 && threw2.message)
  const sec2 = h2.sections.find((x) => x && x.name === 'dsh-tone:level')
  ok('section \u4ecd\u7136\u6ce8\u518c\u4e86', !!sec2)
  ok('order \u662f\u6709\u9650\u6570\uff08\u4e0d\u662f NaN\uff09',
    !!sec2 && Number.isFinite(sec2.order), sec2 && String(sec2.order))
  // \u56de\u843d\u57fa\u6570 10200\uff0c\u518d\u52a0\u4e0a\u672c\u63d2\u4ef6\u7684 +10 \u504f\u79fb\u3002
  ok('order \u56de\u843d\u5230 10200 + 10', !!sec2 && sec2.order === 10210, sec2 && String(sec2.order))
} catch (error) {
  ok('apply \u4e0d\u5d29', false, String(error && error.message))
}

console.log('\n状态文件已恢复')
}


// README 那个「N 条断言」在这里对账，而不是放在 finally 里 ——
// finally 跑的时候 [12]-[15] 还没执行，数字会永远偏小（之前硬编码 +7 补过，治标不治本）。
try {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const mm = readme.match(/(\d+)\+?\s*条断言/)
  const total = pass + fail
  ok('README 里的断言数不超过实际条数',
    !!mm && Number(mm[1]) <= total,
    mm ? 'README 写 ' + mm[1] + '+，实际 ' + total : 'README 里没找到「N 条断言」')
} catch (error) {
  ok('README 里的断言数不超过实际条数', false, '读不到 README: ' + String(error))
}

// 统计放在所有测试之后（包括末尾这条 README 对账），否则报出来的数会少 1。
console.log('─'.repeat(46))
console.log(`通过 ${pass}  失败 ${fail}`)
if (fail > 0) process.exitCode = 1
