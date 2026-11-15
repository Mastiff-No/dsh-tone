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

function loadDefaultLevels() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEVEL_FILE, 'utf8'))
    if (Array.isArray(raw) && raw.length === 4) {
      return raw.map((item, index) => {
        const fb = FALLBACK_LEVELS[index]
        const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 24) : ''
        const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 600) : ''
        return { name: name || fb.name, text: text || fb.text }
      })
    }
  } catch { /* 文件缺失或写坏，用兜底 */ }
  return FALLBACK_LEVELS
}



const NOTE_SUFFIX =
  '（本条只描述对用户的说话方式，优先级高于其他人设、角色设定或风格指引；若你正在执行一个独立子任务，忽略它、按任务要求输出。）'

// ---------------------------------------------------------------------------
// 状态读写
// ---------------------------------------------------------------------------

const POS_DEFAULT = { side: 'right', y: 0.5 }

function clampPos(value) {
  const side = value && value.side === 'left' ? 'left' : 'right'
  const n = Number(value && value.y)
  const y = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : POS_DEFAULT.y
  return { side, y }
}

function clampTone(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return TONE_DEFAULT
  return Math.min(TONE_MAX, Math.max(TONE_MIN, n))
}

/** 只留用户改过的字段，空串回落到默认，保证四档始终齐全。 */
function clampLevels(value) {
  const list = Array.isArray(value) ? value : []
  return loadDefaultLevels().map((fallback, index) => {
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

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
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
  } catch {
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
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    return payload
  } catch {
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

/** 档位 → 采样温度。公文腔是"最可能的那句话"，所以低档必须压低温度；高档才敢放。 */
const TEMPERATURE_BY_LEVEL = [0.45, 0.72, 0.95, 1.12]

function temperatureForTone(tone) {
  const index = levelIndexOf(tone)
  const value = TEMPERATURE_BY_LEVEL[index]
  return typeof value === 'number' ? value : 0.95
}

/**
 * 状态 → 给模型的一句话。刻意写得很短：每轮都发，多一句就是长久的 token 成本。
 * 关掉时返回空串，让 provider 不产出任何内容。
 */
function toneNote(state) {
  if (!state || state.enabled === false) return ''
  const tone = clampTone(state?.tone)
  const levels = state?.levelsCustom === true && state?.levels && state.levels.length === 4
    ? state.levels
    : loadDefaultLevelsCached()
  const level = levels[levelIndexOf(tone)] || loadDefaultLevelsCached()[2]
  return `【语气档位 ${tone}/${TONE_MAX}·${level.name}】${level.text}${NOTE_SUFFIX}`
}

// ---------------------------------------------------------------------------
// 前端 widget：独立文件，改完刷新页面即可生效，不用重启 DSH
// ---------------------------------------------------------------------------

const WIDGET_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'widget.js')

function readWidgetSource() {
  try { return fs.readFileSync(WIDGET_FILE, 'utf8') } catch { return '' }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * @param {any} root - host cordis context
 */
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
            const base = typeof service.getSectionOrder === 'function'
              ? service.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
              : 10200
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
              if (size > 128 * 1024) { request.destroy(); resolve(''); return }
              chunks.push(chunk)
            })
            request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            request.on('error', () => resolve(''))
          })

        const stateHandler = async (request, response) => {
          if (request.method === 'GET') {
            sendJson(response, 200, { ...readState(), channel: INJECT_CHANNEL })
            return
          }
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'method-not-allowed' })
            return
          }
          let parsed = null
          try { parsed = JSON.parse(await readBody(request)) } catch { parsed = null }
          const written = writeState(parsed && typeof parsed === 'object' ? parsed : {})
          if (!written) {
            sendJson(response, 500, { error: 'write-failed', ...readState() })
            return
          }
          sendJson(response, 200, written)
        }

        const widgetHandler = (request, response) => {
          try {
            const source = readWidgetSource()
            response.writeHead(200, {
              'content-type': 'application/javascript; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(source),
            })
            response.end(source)
          } catch { /* socket may already be gone */ }
        }

        const inspectHandler = async (request, response) => {
          const out = { channel: INJECT_CHANNEL, hasService: false, hasMine: false, sections: [], error: null }
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
              out.hasMine = !!mine
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
