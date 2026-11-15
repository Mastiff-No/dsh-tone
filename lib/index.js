/**
 * dsh-tone —— Agent 语气档位旋钮
 *
 * 一句话：侧边一个小滑块，把 0-10 的语气档位写进系统提示，
 * 让 Agent 的口气真正跟着旋钮变，而不是只改一次静态人设文件。
 *
 * 三层：
 *   ① UI      —— lib/widget.js 画滑块（web 端走 tapIndex，桌面端走
 *                webserver/index-inject 的结构化 script 行）
 *   ② 存值    —— $DSH_HOME/dsh-tone.json  { enabled, tone, pos, levels }
 *   ③ 生效    —— systemPrompt.context() 注册一个动态上下文 provider，每轮求值
 *
 * 设计要点（踩过的坑）：
 *   · 对象级 inject 会推迟 apply()，桌面端注入表是宿主启动时一次性收集的 ——
 *     所以 apply() 第一件事就注册注入行，其余逻辑才放进 root.inject([...])。
 *   · 桌面端 script-src 行加载失败会 reject 掉 boot，所以用内联 script 行自己
 *     建标签、自己吞 onerror（跟 whale-widget 的 issue #154 同一套处理）。
 *   · 别用 agent/pre-step 注入：decision.messages 必须是完整 Message 结构
 *     （content 是块数组、source.kind 和 id 都要有），形状不对整轮就崩。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ID = 'dsh-tone'
const STATE_ROUTE = '/dsh-tone/state'
const SET_ROUTE = '/dsh-tone/set'
const WIDGET_ROUTE = '/dsh-tone/widget.js'
const INSPECT_ROUTE = '/dsh-tone/inspect'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'dsh-tone.json')
const LAST_APPLIED_FILE = path.join(path.dirname(STATE_FILE), 'dsh-tone-last.json')

// 写盘失败时把原因留下来，否则用户只看到 write-failed 不知道是盘满还是没权限
let WRITE_ERROR = ''

const TONE_MIN = 0
const TONE_MAX = 10
const TONE_DEFAULT = 7

// ---------------------------------------------------------------------------
// 四档文案（默认值，通用版：不含任何具体人格的私有元素，用户可自行改写）
// ---------------------------------------------------------------------------

/** 每档的 tone 上界：0-3 / 4-6 / 7-8 / 9-10 */
const LEVEL_BOUNDS = [3, 6, 8, 10]

/** 兜底四档：lib/levels.default.json 读不到时用这个 */
const FALLBACK_LEVELS = [
  { name: '公事公办', text: '公事公办：只给结论、数据、事实、步骤、路径。不用语气词、不发表情、不用拟声；不寒暄、不铺垫、不反问确认、不写情绪动作。' },
  { name: '克制', text: '克制：内容优先，正常回答。开头或结尾最多一句带人味的话，其余照常；不用拟声词、不主动开玩笑、不卖萌、不发表情。' },
  { name: '自然', text: '自然（默认）：日常口语，可以有语气词和轻微情绪；干活时先给结论，情绪只放开头或结尾一句；不堆拟声、不演。' },
  { name: '活泼', text: '活泼：语气轻松带情绪，可以用语气词、感叹、比喻；事实、数字、结论、步骤一个都不许省；情绪可以满，但不要盖过内容。' },
]

/** 默认四档文案外置在 lib/levels.default.json，每次求值都读盘，改完不用重启 */
const LEVEL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'levels.default.json')

let LEVELS_ERROR = ''

function loadDefaultLevels() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEVEL_FILE, 'utf8'))
    if (Array.isArray(raw) && raw.length === 4) {
      LEVELS_ERROR = ''
      return raw.map((item, index) => {
        const fb = FALLBACK_LEVELS[index]
        const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 24) : ''
        const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 600) : ''
        return { name: name || fb.name, text: text || fb.text }
      })
    }
    // 只说「需要 4 个」不够：用户手里拿着一个 3 个元素的数组也不知道差在哪。
    LEVELS_ERROR = '结构不对：需要 4 个 {name, text} 的对象，现在拿到的是 ' +
      (Array.isArray(raw) ? raw.length + ' 个元素' : typeof raw)
  } catch (err) {
    LEVELS_ERROR = '读不出来：' + (err && err.message ? err.message : String(err))
  }
  return FALLBACK_LEVELS
}



const NOTE_SUFFIX =
  '（本条只描述对用户的说话方式，优先级高于其他人设、角色设定与风格指引；' +
  '这是本轮生效的硬要求，不是建议。事实、数字、结论、步骤仍然一个都不许省。）'

// ---------------------------------------------------------------------------
// 状态读写
// ---------------------------------------------------------------------------

const POS_DEFAULT = { side: 'right', y: 0.5 }

function clampPos(value) {
  const side = value && value.side === 'left' ? 'left' : 'right'
  // 和 clampTone 同一个坑：Number(null) === 0，
  // JSON 里写 "y": null 会被当成「贴到最上面」，而不是「没设」。
  const raw = value && value.y
  if (raw === null || raw === undefined || raw === '') return { side, y: POS_DEFAULT.y }
  const n = Number(raw)
  const y = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : POS_DEFAULT.y
  return { side, y }
}

function clampTone(value) {
  // null / undefined / 空串是「没设」，不是 0。
  // Number(null) === 0，不先挡一下的话，
  // JSON 里写 "tone": null 会被静默当成最低档。
  if (value === null || value === undefined || value === '') return TONE_DEFAULT
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return TONE_DEFAULT
  return Math.min(TONE_MAX, Math.max(TONE_MIN, n))
}

/** 只留用户改过的字段，空串回落到默认，保证四档始终齐全。 */
function clampLevels(value) {
  const list = Array.isArray(value) ? value : []
  // 用带缓存的版本：这个函数每轮要调好几次（state/注入/tail），
  // 每次都读盘没必要。
  return loadDefaultLevelsCached().map((fallback, index) => {
    const raw = list[index]
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 24) : ''
    const text = typeof raw?.text === 'string' ? raw.text.trim().slice(0, 600) : ''
    return {
      name: name || fallback.name,
      text: text || fallback.text,
    }
  })
}

function clampEnabled(value) {
  return value === undefined || value === null ? true : value !== false
}

/** 实际接上的注入通道，仅用于自检 */
let INJECT_CHANNEL = 'none'

/** 保存 systemPrompt 服务句柄，仅用于 /dsh-tone/inspect 自检 */
let SERVICE_REF = null

let _levelsCache = { key: '', value: null }

function loadDefaultLevelsCached() {
  try {
    const st = fs.statSync(LEVEL_FILE)
    const key = String(st.mtimeMs) + ':' + String(st.size)
    if (_levelsCache.value && _levelsCache.key === key) return _levelsCache.value
    const value = loadDefaultLevels()
    _levelsCache = { key, value }
    return value
  } catch {
    return loadDefaultLevels()
  }
}

let STATE_ERROR = ''

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    STATE_ERROR = ''
    return {
      enabled: clampEnabled(parsed?.enabled),
      tone: clampTone(parsed?.tone),
      pos: clampPos(parsed?.pos),
      // 返回「实际生效的那一套」：没自定义时就是默认文案。
      // 否则 /state 给界面的内容与真正注入的内容不一致，预览会骗人。
      levels: parsed?.levelsCustom === true ? clampLevels(parsed?.levels) : clampLevels(null),
      levelsCustom: parsed?.levelsCustom === true,
      tempControl: parsed?.tempControl === true,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch (err) {
    // 状态文件坏了不能静默：否则用户改了档位、看着界面回默认值，
    // 会以为「插件不记设置」，其实是文件写坏了。
    const code = err && err.code
    if (code !== 'ENOENT') {
      // 文件不存在是正常首次启动，不算错误
      STATE_ERROR = '状态文件读不出来：' + (err && err.message ? err.message : String(err))
      // 把坏文件挪到一边留个证据：内容可能只是末尾多了个逗号，
      // 用户还能手工捐出自定义文案。直接覆盖就永久丢了。
      try {
        const broken = STATE_FILE + '.broken-' + Date.now()
        fs.renameSync(STATE_FILE, broken)
        STATE_ERROR += '（原文件已另存为 ' + path.basename(broken) + '）'
      } catch (e2) {
        // 另存失败也得说一句：不说的话用户会以为“已经帮我备份了”，
        // 而实际上那份文件还在原地、下次写盘就被覆盖了。
        STATE_ERROR += '（另存也失败了：' + (e2 && e2.message ? e2.message : String(e2))
          + '，原文件还在原地）'
      }
    } else {
      STATE_ERROR = ''
    }
    return {
      enabled: true,
      tone: TONE_DEFAULT,
      pos: { ...POS_DEFAULT },
      levels: clampLevels(null),
      levelsCustom: false,
      tempControl: false,
      updatedAt: null,
    }
  }
}

function writeState(patch) {
  const prev = readState()
  const input = patch && typeof patch === 'object' ? patch : {}
  const payload = {
    enabled: 'enabled' in input ? clampEnabled(input.enabled) : prev.enabled,
    tone: 'tone' in input ? clampTone(input.tone) : prev.tone,
    pos: 'pos' in input ? clampPos(input.pos) : prev.pos,
    levels: 'levels' in input ? clampLevels(input.levels) : prev.levels,
    levelsCustom: 'levels' in input
      ? (Array.isArray(input.levels) && input.levels.length === 4)
      : prev.levelsCustom === true,
    tempControl: 'tempControl' in input ? input.tempControl === true : prev.tempControl === true,
    updatedAt: new Date().toISOString(),
  }
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true })
    // 先写临时文件再改名：直接往目标文件写，中途崩溃会留下半个 JSON，
    // 用户的档位和自定义文案就没了。rename 在同一分区上是原子的。
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, STATE_FILE)
    WRITE_ERROR = ''
    return payload
  } catch (error) {
    WRITE_ERROR = error && error.message ? String(error.message) : String(error)
    return null
  }
}

// ---------------------------------------------------------------------------
// 语气提示（每轮注入 system 的那一小段）
// ---------------------------------------------------------------------------

function levelIndexOf(tone) {
  for (let i = 0; i < LEVEL_BOUNDS.length; i += 1) {
    if (tone <= LEVEL_BOUNDS[i]) return i
  }
  return LEVEL_BOUNDS.length - 1
}

/** 档位 → 采样温度。低温把分布压尖、更像"最可能的说法"（公文腔就是那个），所以低档要压低；高温把分布摊平才有余地换口气，高档才放。 */
const TEMPERATURE_BY_LEVEL = [0.45, 0.72, 0.95, 1.12]

function temperatureForTone(tone) {
  const index = levelIndexOf(tone)
  const value = TEMPERATURE_BY_LEVEL[index]
  return typeof value === 'number' ? value : 0.95
}

/** 上一轮真正注入的档位快照（toneNote 每次求值时刷新） */
let LAST_APPLIED = loadLastApplied()

// 为什么要另存一个文件：这是运行态，不是用户设置。
// 但它必须跨重启存活——否则重启后打开面板，
// 明明刚聊过，却显示「还没用过」。
function loadLastApplied() {
  try {
    const d = JSON.parse(fs.readFileSync(LAST_APPLIED_FILE, 'utf8'))
    if (d && typeof d.tone === 'number') {
      return { tone: d.tone, name: String(d.name || ''), chars: Number(d.chars) || 0, at: Number(d.at) || 0 }
    }
  } catch { /* 没有或坏了就从空开始，不影响注入 */ }
  return { tone: null, name: '', chars: 0, at: 0 }
}

function saveLastApplied(la) {
  try {
    fs.writeFileSync(LAST_APPLIED_FILE + '.tmp', JSON.stringify(la), 'utf8')
    fs.renameSync(LAST_APPLIED_FILE + '.tmp', LAST_APPLIED_FILE)
  } catch { /* 存不上只影响界面回显，不影响注入 */ }
}
// pre-step 专用的「上一轮档位」。不能复用 LAST_APPLIED：section 通道每轮组装
// system prompt 时也会调 toneNote()，那会在 pre-step 之前就把快照刷成本轮的值，
// 于是「档位刚换过」永远检测不到。这个变量只在 pre-step 里动。
let PREV_NOTE_TONE = null
// pre-step 往 messages 末尾塞的那条（短版提醒）。inspect 只看 sections 看不到它，
// 单独记一份，否则用户没法确认「注入末句」这项到底上没上。

/**
 * 取当前生效的四档：用户改过就用用户的，否则用默认文案文件。
 *
 * 原本这段判断在四个地方各写了一遍（toneNote / toneReminder / tail 钩子 / pre-step），
 * 改一处就得改四处。
 */
function resolveLevels(state) {
  return state?.levelsCustom === true && state?.levels && state.levels.length === 4
    ? state.levels
    : loadDefaultLevelsCached()
}

/** 取某个档位对应的档位对象。拿不到就回落中间档，永远不返回 undefined。 */
function levelFor(state, tone) {
  return resolveLevels(state)[levelIndexOf(tone)] || loadDefaultLevelsCached()[2]
}

/**
 * 状态 → 给模型的一句话。刻意写得很短：每轮都发，多一句就是长久的 token 成本。
 * 关掉时返回空串，让 provider 不产出任何内容。
 */
function toneNote(state) {
  if (!state || state.enabled === false) {
    // 停用时清空快照：否则界面会一直挂着"上一轮实际注入 10/10"，
    // 让人以为还在生效 —— 这正是最误导人的一种状态。
    LAST_APPLIED = { tone: null, name: '', chars: 0, at: 0 }
    saveLastApplied(LAST_APPLIED)
    PREV_NOTE_TONE = null
    return ''
  }
  const tone = clampTone(state?.tone)
  const level = levelFor(state, tone)

  // 档位刚换过就说破：上下文里的示范比指令强得多，前面几轮是按旧档位写的，
  // 不点明的话模型会继续照着那个口吻说下去，看起来就像"档位没生效"。
  const prev = PREV_NOTE_TONE
  const switchNote = typeof prev === 'number' && prev !== tone
    ? `（上一轮还是 ${prev}/${TONE_MAX}，这一轮换成了 ${tone}；`
      + '前面几轮的口气不要跟着学，从这一句起重新开始。）'
    : ''
  // 别的插件（如 dsh-meme）会在 system prompt 里教"主动斗图"，
  // 它排在我们后面、压过档位。低档位时在正文里正面否掉。
  const noMeme = tone <= 6
    ? '\n本档不使用表情、图片或 [表情: …] 标记，也不调用发图工具。'
    : ''

  const text = `【语气档位 ${tone}/${TONE_MAX}·${level.name}】${level.text}${NOTE_SUFFIX}`
    + (switchNote ? '\n' + switchNote : '')
    + noMeme
  // 更新在读取之后：同一轮里 section 和 tail 会各调一次，
  // 第二次就不会再说破了（prev 已经是本轮的值）。
  PREV_NOTE_TONE = tone
  LAST_APPLIED = { tone, name: level.name, chars: text.length, at: Date.now() }
  saveLastApplied(LAST_APPLIED)
  return text
}



// ---------------------------------------------------------------------------
// 前端 widget：独立文件，改完刷新页面即可生效，不用重启 DSH
// ---------------------------------------------------------------------------
const WIDGET_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'widget.js')

// 读不到时返回 null（不是空串）：空串是合法内容，调用方分不出「文件空」和「读失败」。
function readWidgetSource() {
  try { return fs.readFileSync(WIDGET_FILE, 'utf8') } catch { return null }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * @param {any} root - host cordis context
 */
// 这两个给测试用：确认「边界数组的长度」和「文案有几种」没跑偏。
// 不导出的话测试只能重写一遍逻辑，那就测不到真实代码了。
export const __LEVEL_BOUNDS = LEVEL_BOUNDS
export function __levelIndexOf(tone) { return levelIndexOf(tone) }

export function apply(root) {
  if (!root || typeof root !== 'object') return

  const disposers = []
  if (typeof root.effect === 'function') {
    root.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* a dead disposer must not block the rest */ }
      }
    })
  }

  // ① 桌面端注入行 —— 必须最先注册：宿主启动时一次性收集这张表，晚一步就永远进不去。
  //    用内联 script 行自己建标签、自己吞 onerror（script-src 行加载失败会 reject boot）。
  if (typeof root.on === 'function') {
    try {
      const dispose = root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === WIDGET_ROUTE) return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_ROUTE) >= 0) return
          }
          table.push({
            kind: 'script',
            placement: 'body',
            text:
              '(function(){try{var d=document.body||document.head||document.documentElement;' +
              'if(!d)return;var s=document.createElement("script");s.src="' + WIDGET_ROUTE + '";' +
              's.onerror=function(){};d.appendChild(s)}catch(e){}})()',
          })
        } catch { /* never break the boot over a widget row */ }
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch { /* older hosts may not expose this event */ }
  }

  // ①.5 采样温度 —— agent/request 是 waterfall，只锁 provider/model/reasoningEffort，
  //      temperature 可以自由替换（LlmCallConfig extends LlmCallControls）。
  //      这比提示词硬：温度决定模型敢不敢收敛到"最可能的公文腔"。
  if (typeof root.on === 'function') {
    try {
      const dispose = root.on('agent/request', async (_payload, next) => {
        const config = await next()
        try {
          const state = readState()
          if (state.enabled === false) return config
          // 默认不改采样：用户自己调好的 temperature 不该被插件悄悄覆盖，
          // 必须在界面上显式勾选「采样温度跟随档位」才接管。
          if (state.tempControl !== true) return config
          const temperature = temperatureForTone(state.tone)
          if (typeof temperature !== 'number') return config
          return { ...config, temperature }
        } catch {
          return config
        }
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch { /* host without the hook keeps the prompt-only channel */ }
  }

  // ② 语气档位注入 —— 走 DSH 原生的 runtime context（systemPrompt.context）。
  //    官方给「每轮动态上下文」准备的通道：注册一个 provider 函数，每次组装提示时
  //    求值，宿主自己把它包成 <system-reminder> 快照消息，还按内容去重。
  //    ⚠️ 别去碰 agent/pre-step 那条 waterfall：它的 decision.messages 必须是完整
  //    Message（content 是块数组、source.kind 和 id 都要有），形状不对就抛
  //    "Cannot read properties of undefined (reading 'kind')"。
  try {
    root.inject(['systemPrompt'], (ctx) => {
      try {
        const service = ctx?.systemPrompt
        if (!service) return
        SERVICE_REF = service
        const provider = () => {
          try { return toneNote(readState()) } catch { return '' }
        }
        // 主通道：写进 system prompt 本体（权重高，是真正的"指令"）。
        // 挂在 persona-suffix 之后，靠近末尾。
        let primaryOk = false
        if (typeof service.section === 'function') {
          try {
            // getSectionOrder 有可能返回 undefined（常量名改了、或者宿主没导出），
            // undefined + 10 = NaN，排序会变成未定义行为。必须兜住。
            const raw = typeof service.getSectionOrder === 'function'
              ? service.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
              : null
            const base = Number.isFinite(raw) ? raw : 10200
            if (!Number.isFinite(raw)) {
              try { console.warn('[dsh-tone] getSectionOrder 拿不到 persona-suffix 的序位，回落 10200') } catch {}
            }
            const dispose = service.section({
              name: 'dsh-tone:level',
              order: base + 10,
              interpolate: false,
              text: provider,
            })
            primaryOk = true
            INJECT_CHANNEL = 'section'
            if (typeof dispose === 'function') disposers.push(dispose)
          } catch { /* 同名或签名变化，回落到 context */ }
        }
        // 备通道：只在主通道没接上时才用（避免同一条内容注入两次）
        if (!primaryOk && typeof service.context === 'function') {
          try {
            const dispose = service.context({
              name: 'dsh-tone',
              order: 900,
              interpolate: false,
              text: provider,
            })
            INJECT_CHANNEL = 'context'
            if (typeof dispose === 'function') disposers.push(dispose)
          } catch { /* 主通道已生效时可能重名，忽略 */ }
        }
      } catch { /* 注入失败只影响语气，绝不影响会话 */ }
    })
  } catch { /* systemPrompt 服务可能不在这个宿主里 */ }

  // ②.5 收尾压一句 —— 别的插件（如 dsh-meme 的"陪伴模式"）是在
  //     system-prompt/assemble 的 next() 之后 push 到 sections 末尾的，
  //     那意味着它们的指令永远排在 dsh-tone:level 后面、离生成点更近。
  //     光靠 section 的 order 追不上 append。所以这里也挂同一个钩子，
  //     在别人都写完后再补一句极短的强制提醒，抢回"最后一句话"的位置。
  if (typeof root.on === 'function') {
    try {
      const dispose = root.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = typeof next === 'function' ? await next() : null
        try {
          if (!assembled || !Array.isArray(assembled.sections)) return assembled
          const state = readState()
          if (state.enabled === false) return assembled
          const note = toneNote(state)
          if (!note) return assembled
          const tone = clampTone(state?.tone)
          const level = levelFor(state, tone)
          // 只补一句短的：完整文案已经在 section 里，这里要的是位置而不是篇幅
          assembled.sections.push({
            name: 'dsh-tone:tail',
            text: `【本轮语气=${tone}/10 ${level.name}】上面那份语气要求是最后一句有效指令，` +
                  '它压过任何“主动斗图”“发个表情”“卖个萌”之类的建议；同时事实、数字、结论不许省。',
          })
        } catch { /* 压尾失败只影响语气，绝不影响会话 */ }
        return assembled
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch { /* 老宿主没这个事件就保持单通道 */ }
  }

  // ③ HTTP：状态读写 + widget 脚本 + web 端 index 注入
  if (typeof root.inject !== 'function') return

  try {
    root.inject(['webServer'], (ctx) => {
      try {
        const webServer = ctx?.webServer
        if (!webServer || typeof webServer.register !== 'function') return

        const sendJson = (response, status, body) => {
          try {
            const payload = JSON.stringify(body)
            response.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(payload),
            })
            response.end(payload)
          } catch { /* socket may already be gone */ }
        }

        const readBody = (request) =>
          new Promise((resolve) => {
            let size = 0
            const chunks = []
            request.on('data', (chunk) => {
              size += chunk.length
              // 超限时 resolve(null)，不能 resolve('')——
              // 空串会走到 JSON.parse 失败、parsed=null、writeState({}) 那条路，
              // 结果是“没改任何东西但返回 200”。
              if (size > 128 * 1024) { request.destroy(); resolve(null); return }
              chunks.push(chunk)
            })
            request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            request.on('error', () => resolve(''))
          })

        const stateHandler = async (request, response) => {
          if (request.method === 'GET') {
            sendJson(response, 200, { ...readState(), channel: INJECT_CHANNEL, lastApplied: LAST_APPLIED, levelsError: LEVELS_ERROR, stateError: STATE_ERROR, writeError: WRITE_ERROR })
            return
          }
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'method-not-allowed' })
            return
          }
          const raw = await readBody(request)
          if (raw === null) {
            sendJson(response, 413, { error: 'payload-too-large', limit: 128 * 1024 })
            return
          }
          let parsed = null
          try { parsed = JSON.parse(raw) } catch { parsed = null }
          if (parsed === null) {
            // 空 body 或坏 JSON 都不能当“什么都没改”处理：
            // 那会让用户以为保存成功了。
            sendJson(response, 400, { error: 'bad-json' })
            return
          }
          // 传了 tone 但不是数字时不能静默 clamp 成默认档：
          // 调用方会以为设上了，实际变成了 TONE_DEFAULT。
          // 读文件时容错是一回事，用户主动 POST 过来的坏值应该报错。
          // 但 null 是「没设」的意思，不是坏值，放行。
          if ('tone' in parsed && parsed.tone !== null && typeof parsed.tone !== 'number') {
            sendJson(response, 400, { error: 'bad-tone', reason: 'tone 必须是 0-10 的数字' })
            return
          }
          const written = writeState(parsed && typeof parsed === 'object' ? parsed : {})
          if (!written) {
            sendJson(response, 500, { error: 'write-failed', reason: WRITE_ERROR, ...readState() })
            return
          }
          sendJson(response, 200, written)
        }

        const widgetHandler = (request, response) => {
          try {
            const source = readWidgetSource()
            // 读不到时返回 null。原来这里不判断，null/'' 会以 200 + 空体发出去，
            // 浏览器拿到一个空脚本、什么都不报，用户只看到面板没了。
            if (source === null) {
              response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              response.end('widget.js 读取失败：文件不存在或读不出来')
              return
            }
            response.writeHead(200, {
              'content-type': 'application/javascript; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(source),
            })
            response.end(source)
          } catch (err) {
            // widget.js 读不出来（被删了、权限不对、磁盘满）时，
            // 原来这里是静默什么都不做，浏览器会一直转圈等响应。
            // 给一个明确的 500 + 原因，至少让人知道是这个文件的问题。
            try {
              const msg = 'widget.js 读取失败：' + (err && err.message ? err.message : String(err))
              response.writeHead(500, {
                'content-type': 'text/plain; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(msg),
              })
              response.end(msg)
            } catch { /* socket may already be gone */ }
          }
        }

        const inspectHandler = async (request, response) => {
          const out = { channel: INJECT_CHANNEL, hasService: false, hasMine: false, hasLevel: false, hasTail: false, sections: [], error: null }
          try {
            out.hasService = !!SERVICE_REF && typeof SERVICE_REF.assemble === 'function'
            if (out.hasService) {
              const asm = await SERVICE_REF.assemble({})
              const list = Array.isArray(asm && asm.sections) ? asm.sections : []
              out.sections = list.map((sec) => ({
                name: sec.name,
                order: sec.order,
                chars: String(sec.text || '').length,
              }))
              const mine = list.find((sec) => sec.name === 'dsh-tone:level')
              const tail = list.find((sec) => sec.name === 'dsh-tone:tail')
              // hasLevel / hasTail 分开报：两条通道可能只有一条成功
              // （比如别家插件的钩子顺序把 tail 挤掉了），混成一个布尔值会误判。
              out.hasLevel = !!mine
              out.hasTail = !!tail
              out.hasMine = !!mine
              out.tailIsLast = !!tail && list[list.length - 1] === tail
              // 光给两个布尔，用户得自己拼：「不在」和「在但不在最后」是两回事。
              // 直接给一个人能读的结论，省得他对着 false 猜。
              out.tailStatus = !tail
                ? 'missing'
                : (list[list.length - 1] === tail ? 'ok' : 'not-last')
              // tail 原来只报「在不在、是不是最后」，用户看不到它写了什么。
              // 和 tail 一样给一份预览，两条通道才算对称。
              out.tail = tail
                ? { chars: String(tail.text || '').length, preview: String(tail.text || '').slice(0, 120) }
                : null
              if (mine) out.text = String(mine.text || '')
            }
          } catch (e) {
            out.error = String((e && e.message) || e)
          }
          sendJson(response, 200, out)
        }

        const guard = (handler) => async (request, response) => {
          try { await handler(request, response) } catch {
            try { sendJson(response, 500, { error: 'internal' }) } catch { /* gone */ }
          }
        }

        for (const [route, handler] of [
          [STATE_ROUTE, guard((req, res) => {
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
            return stateHandler(req, res)
          })],
          [SET_ROUTE, guard((req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
            return stateHandler(req, res)
          })],
          [WIDGET_ROUTE, guard(widgetHandler)],
          [INSPECT_ROUTE, guard((req, res) => {
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
            return inspectHandler(req, res)
          })],
        ]) {
          const dispose = webServer.register({ kind: 'exact', path: route, handler })
          if (typeof dispose === 'function') disposers.push(dispose)
        }

        // web 形态（浏览器打开 dsh web）走 tapIndex；桌面端走上面 ① 的结构化行，两条并存、各自去重。
        if (typeof webServer.tapIndex === 'function') {
          const dispose = webServer.tapIndex((html) => {
            try {
              if (typeof html !== 'string' || html.indexOf(WIDGET_ROUTE) !== -1) return html
              const tag = '<script defer src="' + WIDGET_ROUTE + '"></script>'
              if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
              return html + tag
            } catch { return html }
          })
          if (typeof dispose === 'function') disposers.push(dispose)
        }
      } catch { /* a route failure must not take the plugin down */ }
    })
  } catch { /* inject may be unavailable on a bare context */ }
}

export default { name: PACKAGE_ID, apply }
