#!/usr/bin/env bash
# 重启 DSH 之后跑这个，一次把「待重启才生效」的改动全验一遍。
# 用法：bash verify.sh [端口]   不给端口就自动扫。
#
# 输出里带 ✓ / ✗ / ·(未重启所以还没有) 三种前缀，最后统计。
set -u

# 脚本里用的都是相对路径（lib/widget.js 等），
# 不先切到自己所在目录的话，在别处跑就会找不到文件。
cd "$(dirname "$0")" || exit 1

PORT="${1:-}"
if [ -z "$PORT" ]; then
  for p in $(netstat -ano 2>/dev/null | grep '127.0.0.1:' | grep LISTENING \
             | awk '{print $2}' | sed 's/.*://' | sort -n | uniq); do
    if curl -s --noproxy '*' --max-time 1 "http://127.0.0.1:$p/dsh-tone/state" 2>/dev/null | grep -q '"tone"'; then
      PORT="$p"; break
    fi
  done
fi

if [ -z "$PORT" ]; then
  echo "✗ 找不到插件端口（DSH 没起来，或者插件没加载）"; exit 1
fi
echo "→ 端口 $PORT"
B="http://127.0.0.1:$PORT"

PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then echo "✗ 找不到 python"; exit 1; fi

STATE_JSON=$(curl -s --noproxy '*' --max-time 5 "$B/dsh-tone/state")
INSP_JSON=$(curl -s --noproxy '*' --max-time 5 "$B/dsh-tone/inspect")

echo
echo "===== 0. 清单自检 ====="
if [ -f PENDING.md ]; then
  rows=$(grep -c '^| [0-9]' PENDING.md)
  stated=$(grep -o '累计 [0-9]* 项' PENDING.md | head -1 | grep -o '[0-9]*')
  if [ -n "$stated" ] && [ "$rows" = "$stated" ]; then
    echo "  ✓ PENDING.md 表格 $rows 行，标题写「累计 $stated 项」，一致"
  else
    echo "  ✗ PENDING.md 表格 $rows 行，标题写「累计 ${stated:-?} 项」，对不上"
    fail=$((fail+1))
  fi
else
  echo "  · 没有 PENDING.md，跳过"
fi

echo "===== 1. state 字段 ====="
echo "$STATE_JSON" | "$PY" -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception as e:
    print('✗ state 不是合法 JSON:', e); raise SystemExit
print('  tone         =', d.get('tone'))
print('  enabled      =', d.get('enabled'))
print('  channel      =', d.get('channel'))
print('  levelsCustom =', d.get('levelsCustom'))
print('  tempControl  =', d.get('tempControl'))
print('  levelsError  =', repr(d.get('levelsError')))
print('  stateError   =', repr(d.get('stateError')))
we = d.get('writeError')
if we is None:
    print('  writeError   = · 还没有（字段不存在 → index.js 是旧版）')
elif we == '':
    print('  writeError   = ✓ 空（上一次写盘成功）')
else:
    print('  writeError   = ✗ ' + str(we))
la = d.get('lastApplied')
if la is None:
    print('  lastApplied  = · 还没有（字段不存在 → index.js 是旧版，或本轮还没跑过）')
elif la.get('tone') is None:
    print('  lastApplied  = · 空（已停用，或者从没注入过）')
else:
    print('  lastApplied  = %s/10 %s · %s 字' % (la.get('tone'), la.get('name'), la.get('chars')))
ps = d.get('preStep')
if ps is None:
    print('  preStep      = · 还没有（字段不存在 → index.js 是旧版）')
elif ps.get('tone') is None:
    print('  preStep      = · 空（还没跑过一轮）')
else:
    print('  preStep      = %s/10 %s · %s 字' % (ps.get('tone'), ps.get('name'), ps.get('chars')))
    pv = ps.get('preview') or ''
    if pv:
        print('    预览　　     =', pv[:70].replace(chr(10), ' / '))
    t = ps.get('tone')
    if isinstance(t, int):
        has = '不使用表情' in pv
        want = t <= 6
        if want == has:
            print('    斗图开关   = ✓ %s（档位 %d）' % ('已禁止' if want else '已放开', t))
        else:
            print('    斗图开关   = ✗ 档位 %d 但提醒里%s“不使用表情”' % (t, '没有' if want else '却有'))
"

echo
echo "===== 2. inspect 三条通道 ====="
echo "$INSP_JSON" | "$PY" -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception as e:
    print('✗ inspect 不是合法 JSON:', e); raise SystemExit
if 'hasLevel' not in d:
    print('  · 服务端没有 hasLevel 字段 → index.js 还是旧版，重启后才会有')
    print('    （下面只是旧字段，别当成新结果看）')
print('  hasService =', d.get('hasService'))
print('  hasLevel   =', d.get('hasLevel'))
print('  hasTail    =', d.get('hasTail'))
print('  tailIsLast =', d.get('tailIsLast'))
secs = d.get('sections') or []
print('  sections   =', len(secs), '个')
for s in secs[-3:]:
    print('     ...', s.get('name'), s.get('chars'), '字')
"

echo
echo "===== 3. HTTP 方法限定 ====="
fail=0
check_code() {
  local want="$1"; local got="$2"; local label="$3"
  if [ "$got" = "$want" ]; then echo "  ✓ $label -> $got"
  else echo "  ✗ $label -> $got（期望 $want）"; fail=$((fail+1)); fi
}
check_code 200 "$(curl -s --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' "$B/dsh-tone/state")" "GET  /state"
check_code 405 "$(curl -s --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' -X POST "$B/dsh-tone/state")" "POST /state"
check_code 405 "$(curl -s --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' "$B/dsh-tone/set")" "GET  /set"
# 带一个合法 body：空 body 在新版里会返 400（不是合法 JSON），
# 拿它当"写入能不能成功"的探针会一直红。
# 但探针必须用**当前档位**，不能写死 7：
# verify.sh 是"检查"，不该顺手把用户的档位改掉。
# 以前这里写死 {"tone":7}，跑一次就把人从 10 档拽回 7 档，还没人发现。
CUR_TONE=$(printf '%s' "$STATE_JSON" | "$PY" -c "import sys,json;print(json.load(sys.stdin).get('tone'))" 2>/dev/null)
case "$CUR_TONE" in ''|None|*[!0-9]*) CUR_TONE=7 ;; esac
check_code 200 "$(curl -s --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data "{\"tone\":$CUR_TONE}" "$B/dsh-tone/set")" "POST /set 合法 body（当前 $CUR_TONE 档，不改它）"
BADJSON=$(curl -s --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' -X POST --data 'not-json' "$B/dsh-tone/set")
if [ "$BADJSON" = "400" ]; then echo "  ✓ POST /set 坏 body -> 400"
elif [ "$BADJSON" = "200" ]; then echo "  · POST /set 坏 body -> 200（旧版还没有 400，重启后变红）"
else echo "  ✗ POST /set 坏 body -> $BADJSON（期望 400）"; fail=$((fail+1)); fi

echo
echo "===== 4. 坏文件容错（自动，秒级，有 trap 兜底）====="
SETS="lib/sets.default.json"
if [ -f "$SETS" ]; then
  cp "$SETS" "$SETS.verifybak"
  trap 'mv -f "$SETS.verifybak" "$SETS" 2>/dev/null' EXIT INT TERM
  printf '{ 这不是合法 JSON' > "$SETS"
  BAD=$(curl -s --noproxy '*' --max-time 5 "$B/dsh-tone/state")
  LE=$(echo "$BAD" | "$PY" -c "import sys,json;print(json.load(sys.stdin).get('levelsError') or '')" 2>/dev/null)
  N=$(echo "$BAD" | "$PY" -c "import sys,json;print(len(json.load(sys.stdin).get('levels') or []))" 2>/dev/null)
  HASKEY=$(echo "$BAD" | "$PY" -c "import sys,json;print('yes' if 'levelsError' in json.load(sys.stdin) else 'no')" 2>/dev/null)
  if [ "$HASKEY" = "no" ]; then
    echo "  · 服务端没有 levelsError 字段 → index.js 是旧版，这一项要重启后才验得了"
    echo "    （如果你正跑旧版，接口在坏文件下仍回落 $N 档、没崩，这本身是对的）"
  elif [ -n "$LE" ] && [ "$N" -gt 0 ] 2>/dev/null; then
    echo "  ✓ 文案文件写坏后：接口没崩、levelsError 有值、仍回落 $N 档"
    echo "    （档数跟着当前那套走，不写死——三套的段数不一样）"
  else
    echo "  ✗ 文案写坏后表现异常 levelsError='$LE' levels=$N"; fail=$((fail+1))
  fi
  mv -f "$SETS.verifybak" "$SETS"; trap - EXIT INT TERM
else
  echo "  · 找不到 $SETS，跳过"
fi

echo
echo "===== 4b. 状态文件写坏后的容错（自动，会还原）====="
SF="$HOME/.dsh/dsh-tone.json"
if [ -f "$SF" ]; then
  cp "$SF" "$SF.verifybak"
  trap 'mv -f "$SF.verifybak" "$SF" 2>/dev/null' EXIT INT TERM
  # 新版读到坏文件会把它另存成 .broken-<时间戳>。
  # 这里先记下已有的，跑完只删这次新产生的，
  # 否则每跑一次 verify.sh 就往家目录里丢一个垃圾文件。
  BROKEN_BEFORE=$(ls "$SF".broken-* 2>/dev/null | sort)
  printf '{ 坏掉的 json' > "$SF"
  BAD2=$(curl -s --noproxy '*' --max-time 5 "$B/dsh-tone/state")
  SE=$(echo "$BAD2" | "$PY" -c "import sys,json;print(json.load(sys.stdin).get('stateError') or '')" 2>/dev/null)
  KEY2=$(echo "$BAD2" | "$PY" -c "import sys,json;print('yes' if 'stateError' in json.load(sys.stdin) else 'no')" 2>/dev/null)
  TONE2=$(echo "$BAD2" | "$PY" -c "import sys,json;print(json.load(sys.stdin).get('tone'))" 2>/dev/null)
  if [ "$KEY2" = "no" ]; then
    echo "  · 服务端没有 stateError 字段 → index.js 是旧版，这一项要重启后才验得了"
    echo "    （旧版在坏文件下仍返回合法 state：tone=$TONE2）"
  elif [ -n "$SE" ] && [ -n "$TONE2" ] && [ "$TONE2" != "None" ]; then
    echo "  ✓ 状态文件写坏后：接口没崩、stateError 有值、仍返回合法 state（tone=$TONE2）"
  else
    echo "  ✗ 状态写坏后表现异常 stateError='$SE' tone=$TONE2"; fail=$((fail+1))
  fi
  mv -f "$SF.verifybak" "$SF"; trap - EXIT INT TERM
  for f in "$SF".broken-*; do
    [ -e "$f" ] || continue
    if ! printf '%s\n' "$BROKEN_BEFORE" | grep -qxF "$f"; then rm -f "$f"; fi
  done
else
  echo "  · 状态文件不存在，跳过"
fi

echo
echo "===== 4c. widget.js 读不到时的响应（自动，会还原）====="
WF="lib/widget.js"
if [ -f "$WF" ]; then
  mv "$WF" "$WF.verifybak"
  trap 'mv -f "$WF.verifybak" "$WF" 2>/dev/null' EXIT INT TERM
  # 注意 --max-time 3：旧版在出错时是静默挂起，等到超时才看得出问题
  CODE=$(curl -s --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' "$B/dsh-tone/widget.js" 2>/dev/null)
  if [ "$CODE" = "500" ]; then
    echo "  ✓ widget.js 缺失时立刻回 500（不是挂起等超时）"
  elif [ "$CODE" = "000" ]; then
    echo "  · 旧版：请求挂住直到超时（新版会回 500）"
  elif [ "$CODE" = "200" ]; then
    echo "  · 旧版：回 200 + 空脚本（面板会静默消失，新版会回 500）"
  else
    echo "  ✗ widget.js 缺失时返回 $CODE，预期 500"; fail=$((fail+1))
  fi
  mv -f "$WF.verifybak" "$WF"; trap - EXIT INT TERM
else
  echo "  · 找不到 $WF，跳过"
fi


# 放在 4c 之后是故意的：4c 已经把 widget.js 移走又还回来了，
# 这一步验的是“还回来了没有”，不是“一开始能不能读”。
echo "===== 4d. widget 已恢复可读 ====="
check_code 200 "$(curl -s --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' "$B/dsh-tone/widget.js")" "GET  /widget.js"
# 只看 200 不够：一个空脚本也是 200。
WIDGET_BYTES=$(curl -s --noproxy '*' --max-time 3 "$B/dsh-tone/widget.js" | wc -c | tr -d ' \n')
if [ "${WIDGET_BYTES:-0}" -gt 5000 ]; then
  echo "  ✓ 内容 $WIDGET_BYTES 字节"
else
  echo "  ✗ 内容只有 $WIDGET_BYTES 字节（不像完整的 widget）"
  fail=$((fail + 1))
fi

echo
# 这里不 exit：搅到最后才退，
# 否则有失败时用户看不到“5. 只剩一项需要人工听”和重启后的对照清单。
echo
echo "===== 5. 只剩一项需要人工听 ====="
cat <<'NOTE'
  · 10 pre-step 实际效果 —— 上面 2.2 已经把 prompt 预览打出来了，
                         但「这句话真的动了语气吗」只能聊一句才知道。
                         把档位拖到 2 问一句，再拖到 10 问一句——对比两次回答的开头。
NOTE
echo "重启后要看的重点："
echo "  1. state.lastApplied 有值       → 快照通了"
echo "  2. inspect.hasLevel = True      → 正文进了系统提示"
echo "  3. inspect.hasTail  = True      → 收尾压句进了"
echo "  4. inspect.tailIsLast = True    → 压句抢到了最后一句"
echo "  5. sections 最后一项是 dsh-tone:tail（不是 dsh-expression:companion）"
echo
if [ "$fail" -gt 0 ]; then
  echo "✗ $fail 项不对（具体看上面带 ✗ 的行）"
  exit 1
fi
echo "✓ 全部自动检查通过（只剩上面那一项要人工听）"
