/**
 * 档位差异对比 —— 看两个档位到底差多少。
 *
 * 用法：node test/diff.mjs [a] [b]
 *   默认对比最低档（0）和最高档（10）。
 *
 * 为什么要有这个：档位「影响有限」很多时候不是注入没生效，
 * 而是两档文案本来就说的是同一件事。这个脚本把两档按句子切开，
 * 分别列出「只在 A 有」「只在 B 有」「两边一样」，最后给一个区分度。
 * 区分度太低就说明该改文案了，而不是该加通道。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const levels = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'lib', 'levels.default.json'), 'utf8'))

const BOUNDS = [3, 6, 8, 10]
const idxOf = (t) => BOUNDS.findIndex((b) => t <= b)

const a = Math.max(0, Math.min(10, Number(process.argv[2] ?? 0) || 0))
const b = Math.max(0, Math.min(10, Number(process.argv[3] ?? 10) || 0))
const la = levels[idxOf(a)]
const lb = levels[idxOf(b)]

if (la === lb) {
  console.log(`\n${a} 和 ${b} 落在同一个档位（${la.name}），没有可比的东西。`)
  process.exit(0)
}

// 按句号/问号/感叹号/换行切句，但引号里的标点不切
// （否则示例句会被劈成两半，看起来像语法错误）
function split(s) {
  const out = []
  let buf = ''
  let quote = false
  for (const ch of s) {
    if (ch === '「' || ch === '“') quote = true
    if (ch === '」' || ch === '”') { quote = false; buf += ch; continue }
    if (quote) { buf += ch; continue }
    if (ch === '。' || ch === '！' || ch === '？' || ch === '\n') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter((x) => x.length >= 4)
}

const sa = split(la.text)
const sb = split(lb.text)
const setA = new Set(sa)
const setB = new Set(sb)

const onlyA = sa.filter((s) => !setB.has(s))
const onlyB = sb.filter((s) => !setA.has(s))
const both = sa.filter((s) => setB.has(s))

const total = new Set([...sa, ...sb]).size
const distinct = new Set([...onlyA, ...onlyB]).size
const score = total === 0 ? 0 : Math.round((distinct / total) * 100)

const rule = () => console.log('─'.repeat(64))

console.log('')
rule()
console.log(`A = ${a} 档 · ${la.name}（${la.text.length} 字）`)
console.log(`B = ${b} 档 · ${lb.name}（${lb.text.length} 字）`)
rule()

console.log(`\n只在 A（${onlyA.length} 句）：`)
onlyA.forEach((s) => console.log('  - ' + s))

console.log(`\n只在 B（${onlyB.length} 句）：`)
onlyB.forEach((s) => console.log('  + ' + s))

console.log(`\n两边一样（${both.length} 句）：`)
both.forEach((s) => console.log('    ' + s))

console.log('')
rule()
console.log(`区分度 ${score}%  （${distinct} / ${total} 句不同）`)
if (score < 40) console.log('⚠ 偏低：两档说的基本是同一件事，档位换了也看不出差别。')
else if (score < 65) console.log('· 中等：能看出区别，但核心要求有重叠。')
else console.log('✓ 够高：两档要求的东西基本不重合。')
rule()
