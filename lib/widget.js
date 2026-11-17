(function () {
  if (window.__DSH_TONE_WIDGET__) return;
  window.__DSH_TONE_WIDGET__ = true;

  var API_URL = '/dsh-tone/state';
  var SAVE_URL = '/dsh-tone/set';
  var INSPECT_URL = '/dsh-tone/inspect';

  var state = {
    enabled: true,
    tone: 7,
    bounds: [3, 6, 8, 10],
    sets: [],
    toneSet: 'default',
    pos: { side: 'right', y: 0.5 },
    levels: null, levelsError: '', stateError: '', writeError: '',
    tempControl: false,
    // 收藏位：5 个，空位是 null。每项 { tone, name, set, at }。
    // set 现在恒为 'default'，将来上三套互斥时这里记「哪一套」。
    snaps: [null, null, null, null, null]
  };
  var SNAP_SLOTS = 5;
  var saving = false;

  // 默认套的切段；真正用哪套由 /state 的 bounds 决定（三套互斥，段数不同）。
  // 这里只是"服务端还没回话"时的兜底。
  var BOUNDS = [3, 6, 8, 10];
  function boundsNow() {
    return (Array.isArray(state.bounds) && state.bounds.length) ? state.bounds : BOUNDS;
  }
  // 段位区间文字（0-3 / 4-6 …）不写死：段数随套变，写死就会错位。
  function bandsNow() {
    var b = boundsNow();
    var out = [];
    for (var i = 0; i < b.length; i += 1) {
      var lo = i === 0 ? 0 : b[i - 1] + 1;
      out.push(lo + '-' + b[i]);
    }
    return out;
  }
  // 十一档：和 lib/index.js 的 TEMPERATURE_BY_TONE 必须一字不差（有测试盯着）。
  var TEMPS = [0.45, 0.48, 0.51, 0.54, 0.65, 0.72, 0.79, 0.88, 0.97, 1.05, 1.12];
  // 这段必须和 lib/index.js 里的 NOTE_SUFFIX 一字不差。
  // 两边各写一份（浏览器里 import 不了后端模块），
  // 分叉了就会让“看实际生效内容”里的预览和真实注入对不上。
  var NOTE_SUFFIX = '（本条只描述对用户的说话方式，优先级高于其他人设、角色设定与风格指引；' +
    '这是本轮生效的硬要求，不是建议。事实、数字、结论、步骤仍然一个都不许省。）';
  var FALLBACK = [
    { name: '公事公办', text: '' },
    { name: '克制', text: '' },
    { name: '自然', text: '' },
    { name: '活泼', text: '' }
  ];

  function levelIndex(t) {
    var b = boundsNow();
    for (var i = 0; i < b.length; i += 1) {
      if (t <= b[i]) return i;
    }
    return b.length - 1;
  }

  // 档位名和描述永远按「当前选中的那套」取，不依赖 state.levels 有没有同步过来。
  // 之前是各函数自己读 state.levels，只要切套那一下没同步上，
  // 面板就会拿旧套的文案去配新套的分段——显示的和注入的不是一回事。
  function currentLevels() {
    var list = Array.isArray(state.sets) ? state.sets : [];
    var want = state.toneSet || 'default';
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === want
          && Array.isArray(list[i].levels) && list[i].levels.length) {
        return list[i].levels;
      }
    }
    return (state.levels && state.levels.length) ? state.levels : FALLBACK;
  }

  function levelName(t) {
    var list = currentLevels();
    // 段数正在切换的瞬间，索引可能越界；取最后一段总比空着强。
    var item = list[levelIndex(t)] || list[list.length - 1];
    return (item && item.name) || '';
  }

  // 一句话说明这一档是什么样 —— 光给个名字（"克制"）用户是不知道边界的
  // 刻度带上那四个名字跟着用户改的档位名走，不再写死「公事/克制/自然/活泼」。
  function renderBand() {
    var el = document.getElementById('dsh-tone-band');
    if (!el) return;
    var list = currentLevels();
    var spans = el.getElementsByTagName('span');
    for (var i = 0; i < spans.length && i < list.length; i += 1) {
      var name = (list[i] && list[i].name) ? String(list[i].name) : '';
      var range = bandsNow()[i] || '';
      spans[i].innerHTML = '<b>' + range + '</b> ' + escapeHtml(name);
    }
  }

  function levelDesc(t) {
    var list = currentLevels();
    var item = list[levelIndex(t)];
    if (!item || typeof item.text !== 'string') return '';
    var parts = item.text.split('。');
    // 第 0 句是标题（如「公事公办（0-3 档）」），取第一句有内容的正文
    for (var i = 1; i < parts.length; i += 1) {
      var s = parts[i].trim();
      if (s.length >= 4) return s;
    }
    // 用户自定义的文案可能没有合格的第二句（比如全是短句），
    // 不能让这行空着——回落到原文截断。
    var raw = String(item.text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    return raw.length > 40 ? raw.slice(0, 40) + '…' : raw;
  }

  var style = document.createElement('style');
  style.textContent = [
    '#dsh-tone-dock{position:fixed;right:0;top:50%;z-index:2147483000;touch-action:none;',
    'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;}',
    '#dsh-tone-dock.dragging{cursor:grabbing}',
    '#dsh-tone-dock.dragging #dsh-tone-tab{transition:none}',
    '#dsh-tone-dock.snapping{transition:top .18s,left .18s,right .18s}',
    '#dsh-tone-tab{width:30px;height:64px;border-radius:14px 0 0 14px;cursor:grab;',
    'background:linear-gradient(160deg,#2b6fd4,#1a3f7a);color:#eaf3ff;border:1px solid rgba(140,190,255,.55);',
    'border-right:none;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:2px;',
    'box-shadow:-4px 0 14px rgba(0,0,0,.35);user-select:none;transition:width .15s}',
    '#dsh-tone-dock.side-left #dsh-tone-tab{border-radius:0 14px 14px 0;border-right:1px solid rgba(140,190,255,.55);border-left:none;box-shadow:4px 0 14px rgba(0,0,0,.35)}',
    '#dsh-tone-tab:hover{width:36px}',
    '#dsh-tone-tab .v{font-size:13px;font-weight:700;line-height:1}',
    '#dsh-tone-tab .w{font-size:10px;opacity:.8;line-height:1}',
    '#dsh-tone-dock.muted #dsh-tone-tab{background:linear-gradient(160deg,#4a5568,#2d3748);border-color:rgba(160,180,200,.4)}',
    '#dsh-tone-dock.muted #dsh-tone-tab .v{opacity:.5}',

    '#dsh-tone-panel{position:absolute;right:34px;left:auto;top:50%;transform:translateY(-50%) scale(.96);',
    'transform-origin:right center;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s;',
    'width:300px;max-width:min(300px,calc(100vw - 80px));max-height:80vh;overflow-y:auto;padding:14px 16px;border-radius:14px;color:#e8f1ff;',
    'background:rgba(14,26,48,.97);border:1px solid rgba(120,175,255,.4);',
    'box-shadow:0 10px 34px rgba(0,0,0,.5);backdrop-filter:blur(8px)}',
    '#dsh-tone-panel.open{opacity:1;pointer-events:auto;transform:translateY(-50%) scale(1)}',
    '#dsh-tone-dock.side-left #dsh-tone-panel{left:34px;right:auto;transform-origin:left center}',
    '#dsh-tone-panel h4{margin:0 0 2px;font-size:13px;font-weight:600;letter-spacing:.5px}',
    '#dsh-tone-panel .hint{font-size:11px;opacity:.62;margin-bottom:10px}',

    '.dsh-tone-row{display:flex;align-items:center;justify-content:space-between;gap:8px;',
    'padding:7px 0;border-top:1px solid rgba(120,175,255,.14);font-size:12px}',
    '.dsh-tone-switch{position:relative;width:36px;height:20px;border-radius:10px;flex:none;cursor:pointer;',
    'background:rgba(120,140,170,.45);transition:background .16s}',
    '.dsh-tone-switch.on{background:#2b6fd4}',
    '.dsh-tone-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
    'background:#eaf3ff;transition:transform .16s}',
    '.dsh-tone-switch.on::after{transform:translateX(16px)}',

    '#dsh-tone-num{font-size:26px;font-weight:700;line-height:1;color:#8ec5ff;margin-top:4px}',
    '#dsh-tone-num small{font-size:12px;font-weight:400;opacity:.65;margin-left:6px}',
    '#dsh-tone-first{position:relative;font-size:11px;line-height:1.5;color:#cfe4ff;background:rgba(90,150,230,.16);border:1px solid rgba(120,180,255,.28);border-radius:8px;padding:7px 26px 7px 9px;margin:0 0 9px;}',
    '#dsh-tone-first .x{position:absolute;top:4px;right:7px;cursor:pointer;opacity:.65;font-size:11px;}',
    '#dsh-tone-first .x:hover{opacity:1;}',
    '#dsh-tone-desc{font-size:11px;line-height:1.5;color:rgba(200,220,245,.72);margin:2px 0 8px;min-height:1.5em}',
    '#dsh-tone-slider{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:3px;',
    'margin:12px 0 6px;outline:none;background:linear-gradient(90deg,#2b6fd4,#8ec5ff);cursor:pointer}',
    '#dsh-tone-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;',
    'background:#eaf3ff;border:2px solid #2b6fd4;cursor:grab;box-shadow:0 0 6px rgba(140,197,255,.8)}',
    '#dsh-tone-scale{display:flex;justify-content:space-between;font-size:10px;opacity:.45}',
    // 0-10 只有 4 个有效档（0-3 / 4-6 / 7-8 / 9-10），滑中间那几格不会有变化。
    // 标出分界，省得用户以为滑块坏了。
    '#dsh-tone-band{display:flex;font-size:9px;opacity:.38;margin-top:1px;letter-spacing:.2px}',
    '#dsh-tone-band span{text-align:center}',
    '#dsh-tone-band span b{font-weight:600;opacity:.85}',

    '.dsh-tone-editor{margin-top:10px;padding-top:8px;border-top:1px solid rgba(120,175,255,.14);display:none}',
    '.dsh-tone-editor.open{display:block}',
    '.dsh-tone-lv{margin-bottom:10px}',
    '.dsh-tone-lv .cap{display:flex;align-items:center;gap:6px;margin-bottom:4px}',
    '.dsh-tone-lv .cap span{font-size:11px;opacity:.55;flex:none}',
    '.dsh-tone-lv input{flex:1;min-width:0;background:rgba(255,255,255,.07);border:1px solid rgba(120,175,255,.25);',
    'color:#e8f1ff;border-radius:6px;padding:3px 6px;font-size:12px;outline:none;font-family:inherit}',
    '.dsh-tone-lv textarea{width:100%;box-sizing:border-box;background:rgba(255,255,255,.07);',
    'border:1px solid rgba(120,175,255,.25);color:#e8f1ff;border-radius:6px;padding:5px 6px;font-size:11px;',
    'line-height:1.45;resize:vertical;min-height:52px;outline:none;font-family:inherit}',
    '.dsh-tone-lv input:focus,.dsh-tone-lv textarea:focus{border-color:#5b9cf0}',

    '.dsh-tone-actions{display:flex;gap:8px;margin-top:4px}',
    '.dsh-tone-btn{flex:1;padding:6px 0;border-radius:7px;font-size:12px;cursor:pointer;text-align:center;',
    'background:rgba(43,111,212,.85);color:#eaf3ff;border:1px solid rgba(140,190,255,.4);font-family:inherit}',
    '.dsh-tone-btn:hover{background:rgba(64,136,236,.95)}',
    '.dsh-tone-btn.ghost{background:transparent;color:#9fb8d8}',
    '.dsh-tone-btn.ghost:hover{background:rgba(255,255,255,.06)}',
    '.dsh-tone-btn.ghost.danger{background:rgba(224,106,106,.16);color:#ff9b9b}',

    '#dsh-tone-editor .dsh-tone-cnt{font-size:10px;text-align:right;opacity:.45;margin:2px 2px 0}',
    '.dsh-tone-dirty{font-size:11px;line-height:1.4;color:#ffb86b;margin:6px 0 0;min-height:0}',
    '#dsh-tone-editor .dsh-tone-cnt.over{color:#ff8080;opacity:1;font-weight:600}',
    '#dsh-tone-temp{margin-top:2px;font-size:10px;text-align:center;opacity:.5;letter-spacing:.3px}',
    '#dsh-tone-temp b{font-weight:600;opacity:.9}',
    '#dsh-tone-preview{display:none;margin-top:8px;padding:8px;border-radius:8px;background:rgba(90,150,255,.10);border:1px solid rgba(120,180,255,.25);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:170px;overflow-y:auto;color:#a9c8ee}',
    '#dsh-tone-preview.on{display:block}',
    '#dsh-tone-msg{margin-top:8px;font-size:11px;min-height:14px;opacity:.7}',
    '.dsh-tone-sets{margin-top:9px}',
    '.dsh-tone-sets .cap{font-size:11px;opacity:.65;margin-bottom:5px}',
    '.dsh-tone-sets .cap small{opacity:.75;font-size:10px}',
    '#dsh-tone-sets{display:flex;gap:5px;flex-wrap:wrap}',
    '.dsh-tone-set{padding:4px 9px;border-radius:9px;font-size:11px;cursor:pointer;',
    '  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);opacity:.7;',
    '  user-select:none;white-space:nowrap}',
    '.dsh-tone-set:hover{opacity:1}',
    '.dsh-tone-set.active{opacity:1;border-color:var(--SmartThemeQuoteColor,#7aa2f7);',
    '  background:rgba(122,162,247,.16)}',
    '.dsh-tone-snaps{margin-top:10px}',
    '.dsh-tone-snaps .cap{font-size:11px;opacity:.65;margin-bottom:5px}',
    '.dsh-tone-snaps .cap small{opacity:.75;font-size:10px}',
    '#dsh-tone-snaps{display:flex;gap:4px}',
    '.dsh-tone-snap{flex:1;position:relative;min-height:28px;border-radius:6px;' +
      'border:1px solid rgba(255,255,255,.16);display:flex;align-items:center;' +
      'justify-content:center;font-size:12px;cursor:pointer;background:rgba(255,255,255,.04);' +
      'user-select:none}',
    '.dsh-tone-snap:hover{background:rgba(255,255,255,.11)}',
    '.dsh-tone-snap.empty{opacity:.45}',
    '.dsh-tone-snap.active{border-color:#9fc6ff;box-shadow:0 0 0 1px #9fc6ff inset;color:#cfe2ff}',
    '.dsh-tone-snap .sn-set{position:absolute;left:4px;bottom:1px;font-size:9px;line-height:1;opacity:.45}',
    '.dsh-tone-snap .x{position:absolute;top:-6px;right:-5px;width:15px;height:15px;' +
      'line-height:13px;text-align:center;border-radius:50%;background:#3a3a3a;' +
      'border:1px solid rgba(255,255,255,.25);font-size:11px;opacity:0;' +
      'transition:opacity .12s}',
    '.dsh-tone-snap:hover .x{opacity:1}',
    '#dsh-tone-health{font-size:11px;line-height:1.4;margin:6px 0 4px;padding:4px 7px;border-radius:7px;background:rgba(255,255,255,.055)}',
    '#dsh-tone-health.ok{color:#7ee2a8}',
    '#dsh-tone-health.warn{color:#ffb86b;background:rgba(255,184,107,.1)}',
    '#dsh-tone-pending{display:none;font-size:11px;line-height:1.5;margin:6px 0 4px;padding:6px 8px;border-radius:7px;background:rgba(255,214,102,.12);color:#ffd666;border:1px solid rgba(255,214,102,.28)}',
    '#dsh-tone-pending.on{display:block}',
    '#dsh-tone-pending b{color:#ffe08a}',
    '#dsh-tone-last{font-size:11px;line-height:1.4;color:rgba(255,255,255,.5);margin:0 0 6px}',
    '#dsh-tone-last b{color:#9fc6ff;font-weight:600}'
  ].join('');
  (document.head || document.documentElement).appendChild(style);

  var dock = document.createElement('div');
  dock.id = 'dsh-tone-dock';
  dock.innerHTML =
    '<div id="dsh-tone-tab" title="语气档位" tabindex="0" role="button" aria-label="语气档位" aria-expanded="false"><span class="v" id="dsh-tone-tabv">-</span><span class="w">语气</span></div>' +
    '<div id="dsh-tone-panel">' +
      '<div id="dsh-tone-first">第一次用？拖动滑块就行 —— 下一句开始，说法就变了。'
      + '<span class="x" id="dsh-tone-first-x">知道了</span></div>' +
      '<h4>语气档位</h4>' +
      '<div class="hint">拖动滑块，下一轮就换口气</div>' +
      '<div class="dsh-tone-row"><span id="dsh-tone-en-label">启用</span><div class="dsh-tone-switch" id="dsh-tone-en" tabindex="0" role="switch" aria-label="启用语气档位" aria-checked="true"></div></div>' +
      '<div id="dsh-tone-health"></div>' +
      '<div id="dsh-tone-pending"></div>' +
      '<div id="dsh-tone-last"></div>' +
      '<div id="dsh-tone-num">-<small id="dsh-tone-label"></small></div>' +
      '<div id="dsh-tone-desc"></div>' +
      '<input id="dsh-tone-slider" type="range" min="0" max="10" step="1" />' +
      '<div id="dsh-tone-scale"><span>0 正式</span><span>10 随性</span></div>' +
      '<div id="dsh-tone-band" title="滑块是连续的，但只有 4 个有效档；同一档内换数字不会有变化">' +

      '</div>' +
      '<div class="dsh-tone-sets" id="dsh-tone-sets-wrap"><div class="cap">语气套 <small>三选一，滑块只调选中的这套</small></div>' +
        '<div id="dsh-tone-sets"></div>' +
      '</div>' +
      '<div class="dsh-tone-snaps"><div class="cap">收藏位 <small>点空位存当前档，点已有跳过去</small></div>' +
        '<div id="dsh-tone-snaps"></div>' +
      '</div>' +
      '<div id="dsh-tone-temp"></div>' +
      '<div class="dsh-tone-editor" id="dsh-tone-editor"></div>' +
      '<div class="dsh-tone-actions">' +
        '<div class="dsh-tone-btn ghost" id="dsh-tone-edit">编辑档位</div>' +
        '<div class="dsh-tone-btn ghost" id="dsh-tone-peek" title="点一次会真的让它组装一遍，有很轻的开销">看实际生效内容 *</div>' +
      '</div>' +
      '<div id="dsh-tone-preview"></div>' +
      '<div id="dsh-tone-msg"></div>' +
    '</div>';

  function mount() {
    var host = document.body || document.documentElement;
    if (!host) return setTimeout(mount, 200);
    host.appendChild(dock);
    bind();
    applyPos();
    load();
  }

  var lastEditorSig = '';
  // 用户最近一次亲手动过界面（拖滑块、点套、点收藏位）的时间戳。
  // 轮询同步外部变更时要用它：正在拖的时候去「同步」等于跟用户抢滑块。
  var lastUserTouch = 0;
  // 服务端每次写盘都会更新 updatedAt。轮询拿回来的如果是旧快照
  //再去 applyState，就会把用户刚做的改动盖回去——面板「时神时鬼」就是这么来的。
  var lastStateAt = '';

  function buildEditor() {
    var box = document.getElementById('dsh-tone-editor');
    var list = (state.levels && state.levels.length === boundsNow().length) ? state.levels : FALLBACK;
    var html = '';
    var bnd = boundsNow();
    for (var i = 0; i < bnd.length; i += 1) {
      var lo = i === 0 ? 0 : bnd[i - 1] + 1;
      var hi = bnd[i];
      html +=
        '<div class="dsh-tone-lv">' +
          '<div class="cap"><span>' + lo + '-' + hi + '</span>' +
          '<input data-lv="' + i + '" value="' + escapeAttr(list[i] ? list[i].name : '') + '" maxlength="24" /></div>' +
          '<textarea data-lvt="' + i + '" placeholder="这一档该怎么说话">' +
            escapeHtml(list[i] ? list[i].text : '') +
          '</textarea>' +
          '<div class="dsh-tone-cnt" data-cnt="' + i + '">' +
            (list[i] ? list[i].text.length : 0) + '/600</div>' +
        '</div>';
    }
    html +=
      '<div class="dsh-tone-actions">' +
        '<div class="dsh-tone-btn" id="dsh-tone-save-lv">保存文案</div>' +
        '<div class="dsh-tone-btn ghost" id="dsh-tone-copy-lv">复制 JSON</div>' +
        '<div class="dsh-tone-btn ghost" id="dsh-tone-import">从剪贴板导入</div>' +
        '<div class="dsh-tone-btn ghost" id="dsh-tone-reset">恢复默认</div>' +
      '</div>' +
      // 改了没点保存就关面板，改动会丢；至少得让人看得出来。
      '<div class="dsh-tone-dirty" id="dsh-tone-dirty"></div>';
    box.innerHTML = html;
    // 记下这一次渲染用的 levels，applyState 据此判断要不要重建
    lastEditorSig = JSON.stringify(state.levels || []);
    // 文案动辄 300 字，固定高度的 textarea 只能看见三行，
    // 编辑时得一直滚，很容易改错位置。打开就撑到内容高度。
    autoGrowAll(box);
    if (!box.__cntBound) {
      box.__cntBound = true;
      box.addEventListener('input', function (e) {
        var ta = e.target;
        if (!ta || !ta.getAttribute) return;
        if (ta.tagName === 'TEXTAREA') grow(ta);
        var idx = ta.getAttribute('data-lvt');
        if (idx === null) return;
        var cnt = box.querySelector('[data-cnt="' + idx + '"]');
        if (!cnt) return;
        var dirty = document.getElementById('dsh-tone-dirty');
        if (dirty) dirty.textContent = '有未保存的改动（点「保存文案」才会生效）';
        var n = ta.value.length;
        if (n > 600) {
          cnt.textContent = n + '/600（超出上限，保存时只保留前 600 字）';
          cnt.classList.add('over');
        } else {
          cnt.textContent = n + '/600';
          cnt.classList.remove('over');
        }
      });
      // 面板宽度会随窗口变，换行行数跟着变，得重新量一次。
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('resize', function () {
          if (box.innerHTML) autoGrowAll(box);
        });
      }
    }
  }

  function grow(ta) {
    try {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px';
    } catch (e) { /* 元素已拆掉，忽略 */ }
  }

  function autoGrowAll(box) {
    var list = box.querySelectorAll('textarea[data-lvt]');
    for (var i = 0; i < list.length; i += 1) grow(list[i]);
  }

  // 本地拼一份「按当前档位应该注入什么」，只用于服务端自检不可用时兜底显示。
  // 复制出去的 JSON 得能导回来，否则「备份」只是一句空话。
  // 浏览器不给读剪贴板时（非安全上下文）退回提示，不静默失败。
  function importLevels() {
    var setMsg = function (t) {
      var m = document.getElementById('dsh-tone-msg');
      if (m) m.textContent = t;
    };
    var done = function (txt) {
      var arr = null;
      try { arr = JSON.parse(txt); } catch (e) { setMsg('导入失败：不是合法 JSON'); return; }
      if (!Array.isArray(arr) || arr.length !== 4 ||
          !arr.every(function (x) { return x && typeof x.name === 'string' && typeof x.text === 'string'; })) {
        setMsg('导入失败：需要 4 个 {name, text} 的对象');
        return;
      }
      state.levels = arr;
      buildEditor();
      state.levelsCustom = true;
      save({ levels: arr });
      setMsg('已导入 4 档文案');
    };
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(done).catch(function () {
        setMsg('读不到剪贴板 —— 请手动粘贴到下方编辑区');
      });
    } else {
      setMsg('这个环境不支持读剪贴板 —— 请手动粘贴到下方编辑区');
    }
  }

  function buildLocalPreview() {
    var list = (state.levels && state.levels.length === boundsNow().length) ? state.levels : FALLBACK;
    var i = levelIndex(tone);
    var lv = list[i] || FALLBACK[i];
    if (!lv) return '';
    return '【语气档位 ' + tone + '/10·' + lv.name + '】' + lv.text + NOTE_SUFFIX;
  }

  // 复制到剪贴板。navigator.clipboard 只在安全上下文（https / localhost）可用，
  // DSH 是 file:// 或者局域网地址时不可用，所以留一条 textarea + execCommand 的退路。
  function copyLevels(text) {
    function done(ok) {
      var el = document.getElementById('dsh-tone-msg');
      if (el) el.textContent = ok ? '已复制四档 JSON 到剪贴板' : '复制失败：请手动选中文本复制';
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); },
          function () { done(false); });
        return;
      }
    } catch (e) { /* 落到下面的退路 */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(!!ok);
    } catch (e) {
      done(false);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  var FIRST_KEY = 'dsh-tone.first-seen'
  function firstSeen() {
    try { return window.localStorage.getItem(FIRST_KEY) === '1' } catch (e) { return false }
  }
  function dismissFirstTip() {
    var el = document.getElementById('dsh-tone-first')
    if (el && el.parentNode) el.parentNode.removeChild(el)
    try { window.localStorage.setItem(FIRST_KEY, '1') } catch (e) {}
  }

  function bind() {
    var tab = document.getElementById('dsh-tone-tab');
    var panel = document.getElementById('dsh-tone-panel');
    var slider = document.getElementById('dsh-tone-slider');
    var enabledEl = document.getElementById('dsh-tone-en');
    var editor = document.getElementById('dsh-tone-editor');
    var snapsBox = document.getElementById('dsh-tone-snaps');

    // 收藏位的点击：整个容器一个委托，因为 renderSnaps() 会重建 innerHTML，
    // 给每个小格子单独 addEventListener 的话，每次重画都得重新绑一遍。
    if (snapsBox) {
      snapsBox.addEventListener('click', function (e) {
        var el = e.target;
        // 先看是不是点了右上角那个 ×
        var clearIdx = el && el.getAttribute ? el.getAttribute('data-clear') : null;
        if (clearIdx !== null && clearIdx !== undefined && clearIdx !== '') {
          snapClear(Number(clearIdx));
          return;
        }
        // 否则往上找最近的一个 slot
        var node = el;
        var slot = null;
        while (node && node !== snapsBox) {
          if (node.getAttribute) {
            var v = node.getAttribute('data-slot');
            if (v !== null && v !== undefined && v !== '') { slot = Number(v); break; }
          }
          node = node.parentNode;
        }
        if (slot === null || !isFinite(slot)) return;
        snapJump(slot);
      });
    }

    // 套选择：同样是整块一个委托，renderSets() 会重建 innerHTML。
    var setsBox = document.getElementById('dsh-tone-sets');
    if (setsBox) {
      setsBox.addEventListener('click', function (e) {
        var node = e.target;
        while (node && node !== setsBox) {
          if (node.getAttribute) {
            var v = node.getAttribute('data-set');
            if (v) { switchSet(v); return; }
          }
          node = node.parentNode;
        }
      });
    }

    var suppressClick = false;
    var drag = null;

    tab.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, moved: false, rect: dock.getBoundingClientRect() };
      try { tab.setPointerCapture(e.pointerId); } catch (err) { }
      dock.classList.add('dragging');
      dock.classList.remove('snapping');
    });

    tab.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      var w = dock.offsetWidth || 30;
      var h = dock.offsetHeight || 64;
      var nx = Math.max(0, Math.min(window.innerWidth - w, drag.rect.left + dx));
      var ny = Math.max(0, Math.min(window.innerHeight - h, drag.rect.top + dy));
      dock.style.left = nx + 'px';
      dock.style.right = 'auto';
      dock.style.top = ny + 'px';
    });

    function endDrag(e) {
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      dock.classList.remove('dragging');
      if (!moved) return;
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      snapTo(dock.getBoundingClientRect());
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
    }
    tab.addEventListener('pointerup', endDrag);
    tab.addEventListener('pointercancel', endDrag);

    tab.addEventListener('click', function (e) {
      if (suppressClick) { e.stopPropagation(); e.preventDefault(); return; }
      panel.classList.toggle('open');
      tab.setAttribute('aria-expanded', panel.classList.contains('open') ? 'true' : 'false');
    });

    // 键盘可达：Tab 聚焦把手后按 Enter / 空格也能开面板
    tab.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();
      tab.click();
    });

    slider.addEventListener('input', function () {
      lastUserTouch = Date.now();
      renderTone(Number(slider.value), false);
    });
    slider.addEventListener('change', function () {
      lastUserTouch = Date.now();
      save({ tone: Number(slider.value) });
    });

    enabledEl.addEventListener('click', function () {
      save({ enabled: !state.enabled });
    });
    enabledEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();
      save({ enabled: !state.enabled });
    });

    document.getElementById('dsh-tone-peek').addEventListener('click', function () {
      var pre = document.getElementById('dsh-tone-preview');
      if (!pre) return;
      var peekBtn = document.getElementById('dsh-tone-peek');
      var peekLabel = function (opened) {
        if (peekBtn) peekBtn.textContent = opened ? '收起内容 ·' : '看实际生效内容 *';
      };
      if (pre.classList.contains('on')) { pre.classList.remove('on'); peekLabel(false); return; }

      // 优先向宿主要「真正在系统提示里的那段文字」，
      // 拿不到才回落到本地拼一份（并注明是估算）。
      var fallback = function () {
        var body = buildLocalPreview();
        if (!body) return;
        pre.textContent = '（宿主自检不可用，下面是按当前档位拼出来的估算）\n\n' + body;
        pre.classList.add('on'); peekLabel(true);
      };

      pre.textContent = '读取中…';
      pre.classList.add('on'); peekLabel(true);
      fetch(INSPECT_URL, { method: 'GET' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          // hasLevel 是新版服务端才有的字段；老版本只给 hasMine。
          // 两者都没有，说明服务端代码还是旧的（改了 index.js 但没重启）。
          var has = d && (typeof d.hasLevel === 'boolean' ? d.hasLevel : d.hasMine);
          if (d && has && typeof d.text === 'string' && d.text) {
            // 三种状态分开写：“不在”和“在但不在最后”是两回事，
            // 不能都变成一句“未生效”。
            var tailNote = ''
            if (d.tailStatus === 'ok') tailNote = '· 末尾压句已生效'
            else if (d.tailStatus === 'not-last') tailNote = '· 末尾压句在，但被别的内容插到了后面'
            else if (d.tailStatus === 'missing') tailNote = '· 末尾压句没了（可能被另一个插件整段替换掉了）'
            else if (d.hasTail === false) tailNote = '· 末尾压句未生效。服务端是旧版，重启后才能看到具体原因'
            // pre-step 那条通道已经拆掉（它往 messages 里塞 role:"system" 会把 DSH 弄崩），
            // 所以这里不再有「生成前提醒」可显示。
            var preNote = '';
            if (d.tail && d.tail.preview) {
      preNote += '\n\n末尾压句（' + d.tail.chars + ' 字）：「' + d.tail.preview +
        (d.tail.chars > d.tail.preview.length ? '…' : '') + '」';
    }
    pre.textContent = '（来自宿主实际组装的系统提示 —— 每点一次都会真的组装一遍，' + d.text.length + ' 字' + tailNote + '）\n\n' + d.text + preNote;
          } else if (d && typeof d.hasLevel === 'undefined') {
            // 服务端不认 hasLevel：插件代码是旧版，重启 DSH 才会换成新的。
            pre.textContent = '服务端还是旧版插件（没有 hasLevel 字段）。\n' +
              '重启 DSH 后这里才会显示实际生效的内容。\n\n' + buildLocalPreview();
          } else {
            fallback();
          }
        })
        .catch(fallback);
    });

    document.getElementById('dsh-tone-edit').addEventListener('click', function () {
      var opening = !editor.classList.contains('open');
      // 先展开再建：展开前它是 display:none，
      // 那会儿量 scrollHeight 永远是 0，自动撑高全作废。
      editor.classList.toggle('open');
      // 按钮文案跟着变，否则点完还写着「编辑档位」，
      // 下一次点又把它收起来了，看不出是个开关。
      var editBtn = document.getElementById('dsh-tone-edit');
      if (editBtn) editBtn.textContent = opening ? '收起编辑区' : '编辑档位';
      if (opening) {
        if (!editor.innerHTML) buildEditor();
        autoGrowAll(editor);
      }
    });

    editor.addEventListener('click', function (e) {
      var target = e.target;
      if (target && target.id === 'dsh-tone-save-lv') {
        var next = [];
        for (var i = 0; i < 4; i += 1) {
          var nameEl = editor.querySelector('[data-lv="' + i + '"]');
          var textEl = editor.querySelector('[data-lvt="' + i + '"]');
          next.push({
            name: nameEl ? nameEl.value : '',
            text: textEl ? textEl.value : ''
          });
        }
        var dirty2 = document.getElementById('dsh-tone-dirty');
        if (dirty2) dirty2.textContent = '';
        save({ levels: next });
      } else if (target && target.id === 'dsh-tone-reset') {
        // 两段式：误点一次不会立刻把用户自己改的文案冲掉
        if (!target.__armed) {
          target.__armed = true;
          target.textContent = '再点一次确认恢复';
          target.classList.add('danger');
          target.__timer = window.setTimeout(function () {
            target.__armed = false;
            target.textContent = '恢复默认';
            target.classList.remove('danger');
          }, 4000);
          return;
        }
        if (target.__timer) window.clearTimeout(target.__timer);
        target.__armed = false;
        target.textContent = '恢复默认';
        target.classList.remove('danger');
        save({ levels: null });
      } else if (target && target.id === 'dsh-tone-copy-lv') {
        // 导出：把编辑区当前内容（不是已保存的）序列化成 JSON，
        // 方便贴给别人、或者存进自己的仓库里当备份。
        var dump = [];
        for (var j = 0; j < 4; j += 1) {
          var nEl = editor.querySelector('[data-lv="' + j + '"]');
          var tEl = editor.querySelector('[data-lvt="' + j + '"]');
          dump.push({ name: nEl ? nEl.value : '', text: tEl ? tEl.value : '' });
        }
        copyLevels(JSON.stringify(dump, null, 2));
      } else if (target && target.id === 'dsh-tone-import') {
        importLevels();
      }
    });

    document.addEventListener('click', function (e) {
      if (!dock.contains(e.target)) panel.classList.remove('open');
    }, true);

    window.addEventListener('resize', function () { applyPos(); });

    // 引导条：点「知道了」记进 localStorage；看过的直接不显示。
    // 用 removeChild 而不是 display:none —— 少一个节点就少一次布局。
    var firstX = document.getElementById('dsh-tone-first-x');
    if (firstX) { firstX.addEventListener('click', dismissFirstTip); }
    if (firstSeen()) { dismissFirstTip(); }

    // 「上一轮 · 12 秒前」里的时间会一直停在加载那一刻，得让它自己往前走。
    // 面板关着的时候不用重画——那一行根本看不见。
    setInterval(function () {
      var panel = document.getElementById('dsh-tone-panel');
      if (!panel || !panel.classList.contains('open')) return;
      // 光重画时间不够：「上一轮记录」本身也会变（你聊一句就会变）。
      // 只 renderLast(lastLa) 的话，拿永远是页面加载那一刻的值。
      // 每 5 秒重新拉一次，只更新那一行，动不到别的。
      // 原来写的是 30 秒 —— 聊完一句回来一看，那一行还是「刚刚」之前的样子，
      // 用户会当成数据没更新。5 秒够快了，本地请求也不花钱。
      fetch(API_URL, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (typeof d.lastApplied !== 'undefined') renderLast(d.lastApplied);
          // 外部也可能改档位：命令行、另一个窗口、插件自己跑测试。
          // 只更新「上一轮」那一行的话，面板会停在旧状态，
          // 用户看到的是「我没动它，它自己变了」。
          // 但用户正在拖的时候别抢——2.5 秒内碰过就这一轮跳过。
          var busy = Date.now() - lastUserTouch < 2500;
          // 服务器给的 writeError / 错误提示照旧显示，但状态别用旧快照盖。
          // 本地还没拿到过带文案的套数据时，不看 updatedAt 也要更新：
          // 这多半是「页面比后端旧」——刷新之前 sets 里没有 levels，
          // 而 updatedAt 又不会因为页面老旧而变化，不强制更新就永远补不上。
          var setsOk = Array.isArray(state.sets) && state.sets.length > 0
            && state.sets.every(function (x) {
              return x && Array.isArray(x.levels) && x.levels.length > 0;
            });
          if (!busy && setsOk && typeof d.updatedAt === 'string'
              && lastStateAt && d.updatedAt <= lastStateAt) {
            return;
          }
          if (!busy) {
            var t = Number(d.tone);
            var s2 = typeof d.toneSet === 'string' ? d.toneSet : '';
            if ((isFinite(t) && t !== state.tone) || (s2 && s2 !== state.toneSet)) {
              applyState(d, false);
            }
          }
        })
        .catch(function () { /* 拉不到就保留上一次的，5 秒后再试 */ });
    }, 5000);

    // 键盘快捷键：不打开面板也能调档位
    // Ctrl/⌘ + Shift + ↑ / ↓ 各走一档；+ Shift + 0 直接归零（"闭嘴模式"）
    function inEditable(el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    }

    document.addEventListener('keydown', function (ev) {
      if (!(ev.ctrlKey || ev.metaKey) || !ev.shiftKey) return;
      // 别抢输入框里的按键：Ctrl+Shift+↑/↓ 在聊天框里是「选中到开头/结尾」，
      // 抢走会让人以为输入法坏了。只在非编辑区才当快捷键用。
      if (inEditable(ev.target)) return;
      // 注意：Shift+0 在多数键盘上产出的是 ')'，不是 '0'，
      // 所以这里必须看 ev.code（物理键位）才认得出 "Shift+0"。
      var k = ev.key;
      var isZero = ev.code === 'Digit0' || ev.code === 'Numpad0';
      if (k !== 'ArrowUp' && k !== 'ArrowDown' && !isZero) return;
      ev.preventDefault();
      var next = state.tone;
      if (k === 'ArrowUp') next = Math.min(10, state.tone + 1);
      else if (k === 'ArrowDown') next = Math.max(0, state.tone - 1);
      else if (isZero) next = 0;
      else return;
      if (next === state.tone) return;
      state.tone = next;
      renderTone(next, false);
      save(next);
      panel.classList.add('open');
      var t = document.getElementById('dsh-tone-msg');
      if (t) {
        t.textContent = '快捷键 → ' + next + '/10';
        // 和「已保存」那句一个道理：不能永远挂着。
        // 只清自己那句，别把后来的错误提示也抹掉。
        setTimeout(function () {
          if (t.textContent.indexOf('快捷键 →') === 0) t.textContent = '';
        }, 4000);
      }
    }, true);
  }

  function applyPos() {
    var h = dock.offsetHeight || 64;
    var span = Math.max(1, window.innerHeight - h);
    var left = state.pos.side === 'left';
    dock.classList.toggle('side-left', left);
    dock.classList.toggle('side-right', !left);
    dock.style.top = Math.round(state.pos.y * span) + 'px';
    if (left) { dock.style.left = '0px'; dock.style.right = 'auto'; }
    else { dock.style.right = '0px'; dock.style.left = 'auto'; }
  }

  function snapTo(rect) {
    var w = dock.offsetWidth || 30;
    var h = dock.offsetHeight || 64;
    var span = Math.max(1, window.innerHeight - h);
    var cx = rect.left + w / 2;
    state.pos = {
      side: cx < window.innerWidth / 2 ? 'left' : 'right',
      y: Math.max(0, Math.min(1, rect.top / span))
    };
    dock.classList.add('snapping');
    applyPos();
    setTimeout(function () { dock.classList.remove('snapping'); }, 220);
    save({ pos: state.pos, quiet: true });
  }

  function setMsg(text) {
    var msg = document.getElementById('dsh-tone-msg');
    if (msg) msg.textContent = text;
  }

  function renderTone(t, dirty) {
    // 万一拿到的不是数（服务端老版本/字段缺失），
    // 不能把 NaN 直接灌进滑块和标签里。
    var n0 = Number(t);
    if (!isFinite(n0)) n0 = 7;
    t = Math.min(10, Math.max(0, Math.round(n0)));
    state.tone = t;
    var num = document.getElementById('dsh-tone-num');
    if (num && num.firstChild) num.firstChild.textContent = String(t);
    var lab = document.getElementById('dsh-tone-label');
    if (lab) lab.textContent = ' ' + levelName(t);
    var desc = document.getElementById('dsh-tone-desc');
    if (desc) desc.textContent = levelDesc(t);
    renderBand();
    var tabv = document.getElementById('dsh-tone-tabv');
    if (tabv) tabv.textContent = String(t);
    var slider = document.getElementById('dsh-tone-slider');
    if (slider) slider.value = String(t);
    var temp = document.getElementById('dsh-tone-temp');
    if (temp) {
      // 温度是十一档、和段位无关，直接按档位取。
      var v = TEMPS[t] === undefined ? TEMPS[7] : TEMPS[t];
      var label = state.tempControl ? '（跟随档位 · 点此关闭）' : '（未跟随 · 点此启用）';
      if (!state.enabled) label = '（已停用）';
      temp.innerHTML = '采样温度（越高越放得开）<b>' + v.toFixed(2) + '</b>' + label;
      temp.style.cursor = 'pointer';
      temp.title = '默认不接管采样；点一下让温度跟着档位走';
      if (!temp.__tcBound) {
        temp.__tcBound = true;
        temp.addEventListener('click', function () {
          save({ tempControl: !state.tempControl });
        });
      }
    }
    if (dirty) setMsg('未保存…');
  }

  function renderHealth(ch) {
    var el = document.getElementById('dsh-tone-health');
    if (!el) return;
    var text, cls;
    if (ch === 'section') {
      text = '✓ 已写入系统提示（每轮生效）';
      cls = 'ok';
    } else if (ch === 'context') {
      text = '✓ 已接入（兼容模式，效果可能弱一些）';
      cls = 'ok';
    } else {
      text = '⚠ 尚未接入 · 重启 DSH 后生效';
      cls = 'warn';
    }
    if (!state.enabled) { text += ' · 当前已停用'; cls = ''; }
    if (state.levelsError) {
      // 四档文案文件读坏了：静默回落兜底会让人以为"我改的怎么没生效"
      text += ' · 文案文件有误，正用内置兜底（' + state.levelsError + '）';
      cls = 'warn';
    }
    if (state.stateError) {
      // 状态文件坏了更要命：改了档位却记不住，看起来像插件失灵。
      // 光说「坏了」没用，得告诉人怎么恢复：把文件删掉就会重建默认。
      text += ' · 设置记不住（' + state.stateError + '）；删掉 '
        + '~/.dsh/dsh-tone.json 会重建默认值';
      cls = 'warn';
    }
    if (state.writeError) {
      // 写盘失败：盘满 / 没权限 / 路径不对。把原因直接摆出来。
      text += ' · 上一次保存写不进去：' + state.writeError;
      cls = 'warn';
    }
    el.textContent = text;
    el.className = cls;
  }

  function ago(ts) {
    if (!ts) return '';
    var sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) return '刚刚';
    if (sec < 60) return sec + ' 秒前';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
    return Math.floor(sec / 3600) + ' 小时前';
  }

  // 上一轮真正注入的是什么 —— 拧完滑块最想知道的就是这句
  var lastLa = undefined;

  function renderLast(la) {
    lastLa = la;
    var el = document.getElementById('dsh-tone-last');
    if (!el) return;
    // 老版本 index.js 不返回 lastApplied —— 整行藏掉，别让用户看到误导文案
    if (la === undefined) { el.style.display = 'none'; return; }
    el.style.display = '';
    if (!la || typeof la !== 'object' || typeof la.tone !== 'number') {
      el.innerHTML = '上一轮：<b>还没用过</b>（发一条消息后这里会有记录）';
      return;
    }
    var cur = state.tone;
    var hint = la.tone === cur
      ? ''
      : ' <span style="color:#ffb86b">← 你已改成 ' + cur + '，下一轮生效</span>';
    el.innerHTML = '上一轮实际用的档位 <b>' + la.tone + '/10 ' + escapeHtml(la.name || '') + '</b>' +
      ' · ' + la.chars + ' 字 · ' + ago(la.at) + hint;
  }

  // -------------------------------------------------------------------
  // 收藏位：把「某个档位」存成一格，之后一键跳回。
  // 它不存配置、不写文案、不碰注入通道——只是「跳到某个已存在的状态」，
  // 所以是纯前端 + 一个本地数字，恢复现场的成本几乎为零。
  // -------------------------------------------------------------------
  function snapList() {
    var list = (state.snaps || []).slice(0, SNAP_SLOTS);
    while (list.length < SNAP_SLOTS) list.push(null);
    return list;
  }

  // 三套互斥：点哪个就切到哪套，滑块只调当前这套。
  // 切套/跳收藏位时要当场换掉档位名和描述：拿 /state 给的 sets[] 里那套。
  // 不这么做的话，切完那一刻 state.levels 还是旧套的，
  // 界面就会「档位名和描述缺失」——等下一轮轮询才好。
  function applySetLocal(id) {
    var list = Array.isArray(state.sets) ? state.sets : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) {
        var item = list[i];
        // 手里没有这套的文案就别动：只换 bounds 不换 levels，
        // 档位名会拿旧套的文案去配新套的分段，出来的是个既不属于新旧任何一套的名字。
        // 这种时候宁可什么都不改，等下一轮 /state 把整套数据带回来。
        if (!Array.isArray(item.levels) || item.levels.length !== item.bounds.length) return false;
        state.bounds = item.bounds;
        state.levels = item.levels;
        state.toneSet = id;
        renderTone(state.tone, false);
        renderSets();
        return true;
      }
    }
    return false;
  }

  function renderSets() {
    var box = document.getElementById('dsh-tone-sets');
    if (!box) return;
    var list = Array.isArray(state.sets) ? state.sets : [];
    // 服务端还没新版（或者热加载了前端、后端还没重启）时不显示这一排：
    // 摆两个点了没反应的按钮，比不显示更糟。
    var wrap = document.getElementById('dsh-tone-sets-wrap');
    if (wrap) wrap.style.display = list.length ? '' : 'none';
    if (!list.length) { box.innerHTML = ''; return; }
    var html = '';
    for (var i = 0; i < list.length; i += 1) {
      var it = list[i];
      var on = (it.id === state.toneSet) ? ' active' : '';
      html += '<div class="dsh-tone-set' + on + '" data-set="' + escapeAttr(String(it.id)) + '"'
        + ' title="' + escapeAttr(String(it.count || it.bounds && it.bounds.length || '') + ' 段') + '">'
        + escapeHtml(String(it.name || it.id)) + '</div>';
    }
    box.innerHTML = html;
  }

  function setDisplayName(id) {
    var list = Array.isArray(state.sets) ? state.sets : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) return String(list[i].name || id);
    }
    return String(id || '');
  }

  function switchSet(id) {
    if (!id || id === state.toneSet) return;
    // 切套是用户操作，跟拖滑块一样要挡住轮询回盖。
    lastUserTouch = Date.now();
    // 直接把这套的段位名和文案换上：/state 的 sets[] 里带着 levels。
    // 换不上（老后端没给 levels）才退回只改标记，等轮询补。
    if (!applySetLocal(id)) {
      state.toneSet = id;
      renderSets();
    }
    setMsg('正在切到「' + setDisplayName(id) + '」…');
    save({ toneSet: id, quiet: true });
    // 这句不能永远挂着：切套就是一次本地写盘，几百毫秒的事。
    // 一直写「正在切到」等于骗人——用户在等一个早就不存在的过程。
    setTimeout(function () {
      var el = document.getElementById('dsh-tone-msg');
      if (!el || el.textContent.indexOf('正在切到') !== 0) return;
      el.textContent = '已切到「' + setDisplayName(id) + '」· ' + levelName(state.tone) + ' 档';
    }, 1200);
  }

  function renderSnaps() {
    var box = document.getElementById('dsh-tone-snaps');
    if (!box) return;
    var list = snapList();
    var html = '';
    for (var i = 0; i < SNAP_SLOTS; i += 1) {
      var sn = list[i];
      if (!sn) {
        html += '<div class="dsh-tone-snap empty" data-slot="' + i + '" title="点一下把当前 ' +
          state.tone + ' 档存到这里">+</div>';
      } else {
        var snSet = sn.set || 'default';
        // 高亮要连套一起看：同一个数字在不同套里是不同段位，只比数字会误伤。
        var act = (sn.tone === state.tone && snSet === state.toneSet) ? ' active' : '';
        html += '<div class="dsh-tone-snap' + act + '" data-slot="' + i + '" title="' +
          escapeAttr(setDisplayName(snSet) + ' · ' + (sn.name ? sn.name + ' · ' : '') +
            sn.tone + ' 档，点一下跳过去') + '">' +
          sn.tone +
          '<span class="sn-set">' + escapeHtml(String(snSet === 'default' ? '默' : snSet.slice(0, 2))) + '</span>' +
          '<span class="x" data-clear="' + i + '" title="清空这个位">&times;</span>' +
        '</div>';
      }
    }
    box.innerHTML = html;
  }

  function snapStore(i) {
    var list = snapList();
    // 记住「哪套 + 几档」：同一个数字在不同套里是不同段位，
    // 只存数字的话，跳过去会按错的分段算出一个错的段位名。
    list[i] = {
      tone: state.tone,
      name: levelName(state.tone),
      set: state.toneSet || 'default',
      at: Date.now(),
    };
    state.snaps = list;
    renderSets();
    renderSnaps();
    save({ snaps: list });
    setMsg('已存到收藏位 ' + (i + 1) + ' · ' + state.tone + ' 档');
  }

  function snapClear(i) {
    var list = snapList();
    list[i] = null;
    state.snaps = list;
    renderSnaps();
    save({ snaps: list });
    setMsg('收藏位 ' + (i + 1) + ' 已清空');
  }

  function snapJump(i) {
    var list = snapList();
    var sn = list[i];
    if (!sn) return snapStore(i);
    var wantSet = sn.set || 'default';
    if (wantSet !== state.toneSet) {
      // 先切套再跳档：分段边界和段位名都是跟着套走的。
      // 只改 toneSet 不换 levels 的话，跳过去就成了「档位名和描述缺失」——
      // 这正是用户报的那个现象。
      if (!applySetLocal(wantSet)) {
        state.toneSet = wantSet;
        renderSets();
      }
    }
    renderTone(sn.tone, true);
    save({ tone: sn.tone, toneSet: wantSet });
    setMsg('跳到收藏位 ' + (i + 1) + ' · ' + setDisplayName(wantSet) + ' ' + sn.tone + ' 档');
  }

  function renderEnabled() {
    var sw = document.getElementById('dsh-tone-en');
    if (sw) {
      sw.classList.toggle('on', !!state.enabled);
      sw.setAttribute('aria-checked', state.enabled ? 'true' : 'false');
    }
    dock.classList.toggle('muted', !state.enabled);
    var lab = document.getElementById('dsh-tone-en-label');
    if (lab) lab.textContent = state.enabled ? '启用中' : '已停用';
  }

  // 面板打开时就知道「代码更新了但没重启」—— 否则用户会以为功能坏了
  function renderPending(isStale) {
    var el = document.getElementById('dsh-tone-pending');
    if (!el) return;
    if (!isStale) { el.classList.remove('on'); el.textContent = ''; return; }
    el.classList.add('on');
    el.innerHTML = '<b>插件代码比运行时新</b><br>' +
      '这个页面加载的是旧版后端，一批改进还没生效（不算坏）。<br>' +
      '重启 DSH 后：温度跟随、上一轮记录、自检明细、末尾追加那句 都会上线。';
  }

  // isLoad=true 只在首次 GET 时传：POST 的返回体不带 lastApplied，
  // 若照样判断会被误认成「服务端是旧版」，一拖滑块就冒黄条。
  function applyState(d, isLoad) {
    if (!d || typeof d !== 'object') return;
    if (d.pos && typeof d.pos === 'object') {
      var py = Number(d.pos.y);
      state.pos = {
        side: d.pos.side === 'left' ? 'left' : 'right',
        y: isFinite(py) ? Math.min(1, Math.max(0, py)) : 0.5
      };
    }
    // 档位数不是固定 4 了：三套里有两套是 5 段。
    // 这里必须按「当前这套的分段数」校验，还写死 4 的话，
    // 切到五段的套之后 state.levels 永远是默认套那 4 段，
    // 面板上就会显示「活泼」而不是「雌小鬼」。
    // bounds 必须先赋值——下面那句要用它。
    if (Array.isArray(d.bounds) && d.bounds.length) state.bounds = d.bounds;
    if (Array.isArray(d.levels) && d.levels.length === state.bounds.length) {
      state.levels = d.levels;
    } else if (Array.isArray(d.levels) && d.levels.length) {
      // 对不上就别硬塞：拿旧名字配新边界，界面会显示成
      // 既不是新套也不是旧套的东西。清空比串台好。
      state.levels = [];
    }
    if (typeof d.levelsError === 'string') state.levelsError = d.levelsError;
    if (typeof d.stateError === 'string') state.stateError = d.stateError;
    if (typeof d.writeError === 'string') state.writeError = d.writeError;
    state.enabled = d.enabled !== false;
    state.tempControl = d.tempControl === true;
    if (typeof d.channel === 'string') renderHealth(d.channel);
    if (typeof d.updatedAt === 'string') lastStateAt = d.updatedAt;
    // 顺序要紧：renderLast 拿 state.tone 和 lastApplied.tone 比，
    // 比的是「你当前设的档位」和「上一轮真正用的档位」。
    // 必须先 renderTone 把 state.tone 定下来，否则第一次加载时
    // state.tone 还是初始值 7，而 lastApplied 是 10，
    // 就会在滑块明明停在 10 的时候写一句「你已改成 7，下一轮生效」。
    if (Array.isArray(d.sets)) state.sets = d.sets;
    if (typeof d.toneSet === 'string') state.toneSet = d.toneSet;
    renderTone(Number(d.tone), false);
    if (isLoad) renderPending(typeof d.lastApplied === 'undefined');
    // POST 不带这个字段，就不动「上一轮」那行，别把已有信息抹掉
    if (typeof d.lastApplied !== 'undefined') renderLast(d.lastApplied);
    renderEnabled();
    if (Array.isArray(d.snaps)) state.snaps = d.snaps;
    renderSnaps();
    // 套选择器也得在每次拿到状态后重画一遍——只在初始化时画一次的话，
    // 后端的 sets 永远进不了界面（上一版就是这么漏的：赋值写了，没画）。
    renderSets();
    applyPos();
    // 不能无条件重建：用户可能正在编辑框里改文案，
    // 这时拖一下滑块就会触发 save -> applyState，
    // 重建把输入的内容全冲掉。只有 levels 真的变了才重建。
    var editor = document.getElementById('dsh-tone-editor');
    var sig = JSON.stringify(state.levels || []);
    if (editor && editor.innerHTML && sig !== lastEditorSig) buildEditor();
  }

  function load() {
    fetch(API_URL, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { applyState(d, true); })
      .catch(function () {
        state.pos = { side: 'right', y: 0.5 };
        state.enabled = true;
        renderTone(7, false);
        renderEnabled();
        applyPos();
        // 读不到就不能装作读到了：滑块上是 7，
        // 但那不是你设的。不说的话用户会把它当成自己的设置。
        var msg = document.getElementById('dsh-tone-msg');
        if (msg) msg.textContent = '读不到设置（服务端没响应），上面显示的是默认值 7';
      });
  }

  var pendingSave = null;

  function save(patch) {
    var quiet = !!(patch && patch.quiet);
    pendingSave = pendingSave || {};
    if (quiet) pendingSave.quiet = true;
    for (var k in patch) {
      if (k !== 'quiet') pendingSave[k] = patch[k];
    }
    // 保存进行中不再直接丢弃：已经并进 pendingSave，等这次回来接着发。
    // 连续拖动滑块时，最终写入的一定是最后一次的值。
    if (saving) return;
    flushSave();
  }

  // 把 HTTP 状态码翻成人能看懂的话。很多人看到「413」只会点重试，
  // 而真正该做的是把内容截短。
  function describeErr(status, body) {
    var code = body && body.error ? String(body.error) : '';
    var reason = body && body.reason ? String(body.reason) : '';
    if (status === 413 || code === 'payload-too-large') return '内容太大了（超过 128 KB），没保存';
    // bad-tone 也是 400，但它不是「JSON 不合法」——先认它，
    // 否则用户会去查自己的 JSON 格式，而真正的错是档位不对。
    if (code === 'bad-tone') return reason || '档位必须是 0 到 10 的数字，没保存';
    if (status === 400 || code === 'bad-json') return '发过去的内容不是合法 JSON，没保存';
    if (code === 'write-failed') return '写文件失败' + (reason ? '：' + reason : '') + '，没保存';
    if (code === 'method-not-allowed') return '请求方式不对（这是程序问题）';
    // 服务端抛异常时回的。不认就只剩「HTTP 500」，用户不知道是插件自己抛的。
    if (code === 'internal') return '插件内部出错' + (reason ? '：' + reason : '') + '，没保存';
    return 'HTTP ' + status + (reason ? '：' + reason : '');
  }

  function flushSave() {
    if (!pendingSave) return;
    var body = pendingSave;
    pendingSave = null;
    var quiet = body.quiet === true;
    delete body.quiet;
    saving = true;
    if (!quiet) setMsg('保存中…');
    fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        if (r.ok) return r.json();
        // 服务端会带 error / reason 字段，翻成人话比「HTTP 413」有用得多。
        return r.json().catch(function () { return {}; }).then(function (b) {
          throw new Error(describeErr(r.status, b));
        });
      })
      .then(function (d) {
        applyState(d);
        // 拖完滑块要立刻重画「上一轮」那行：state.tone 刚变，
        // 但 POST 返回体不带 lastApplied，renderLast 根本不会被调用，
        // 那行还挂着改之前的判断（或者干脆没有「你已改成 X」）。
        if (lastLa !== undefined) renderLast(lastLa);
        // 「已保存」三个字对新用户没有意义 —— 他关心的是「什么时候能看到变化」。
        // 明确写出「下一句生效」，省得他拖完盯着这一句等变化。
        if (!quiet) {
          setMsg('已保存 · ' + (state.enabled ? levelName(state.tone) + ' · 下一句生效' : '已停用'));
          // 这条提示不能永远挂着：下次打开面板看到「已保存」，
          // 会以为刚刚存过。只清自己那句，别把后来的错误提示也抹掉。
          var el = document.getElementById('dsh-tone-msg');
          setTimeout(function () {
            if (el && el.textContent.indexOf('已保存') === 0) el.textContent = '';
          }, 4000);
        }
      })
      .catch(function (err) {
        setMsg('保存失败：' + (err && err.message ? err.message : '网络错误'));
      })
      // ⚠️ 必须用 finally：如果上面的 r.json() 抛了，链会跳到 catch，
      //    而 "saving = false" 如果只写在末尾的 then 里就会永远不执行,
      //    之后所有保存都被 "if (saving) return" 挡掉 —— 界面看起来彻底卡死。
      .finally(function () { saving = false; flushSave(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
