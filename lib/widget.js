(function () {
  if (window.__DSH_TONE_WIDGET__) return;
  window.__DSH_TONE_WIDGET__ = true;

  var API_URL = '/dsh-tone/state';
  var SAVE_URL = '/dsh-tone/set';
  var INSPECT_URL = '/dsh-tone/inspect';

  var state = {
    enabled: true,
    tone: 7,
    pos: { side: 'right', y: 0.5 },
    levels: null,
    tempControl: false
  };
  var saving = false;

  var BOUNDS = [3, 6, 8, 10];
  var TEMPS = [0.45, 0.72, 0.95, 1.12];
  var NOTE_SUFFIX = '（本条只描述对用户的说话方式，优先级高于其他人设、角色设定或风格指引；若你正在执行一个独立子任务，忽略它、按任务要求输出。）';
  var FALLBACK = [
    { name: '公事公办', text: '' },
    { name: '克制', text: '' },
    { name: '自然', text: '' },
    { name: '活泼', text: '' }
  ];

  function levelIndex(t) {
    for (var i = 0; i < BOUNDS.length; i += 1) {
      if (t <= BOUNDS[i]) return i;
    }
    return BOUNDS.length - 1;
  }

  function levelName(t) {
    var list = state.levels && state.levels.length === 4 ? state.levels : FALLBACK;
    var item = list[levelIndex(t)];
    return (item && item.name) || '';
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
    'width:300px;max-height:80vh;overflow-y:auto;padding:14px 16px;border-radius:14px;color:#e8f1ff;',
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
    '#dsh-tone-slider{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:3px;',
    'margin:12px 0 6px;outline:none;background:linear-gradient(90deg,#2b6fd4,#8ec5ff);cursor:pointer}',
    '#dsh-tone-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;',
    'background:#eaf3ff;border:2px solid #2b6fd4;cursor:grab;box-shadow:0 0 6px rgba(140,197,255,.8)}',
    '#dsh-tone-scale{display:flex;justify-content:space-between;font-size:10px;opacity:.45}',

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

    '#dsh-tone-editor .dsh-tone-cnt{font-size:10px;text-align:right;opacity:.45;margin:2px 2px 0}',
    '#dsh-tone-editor .dsh-tone-cnt.over{color:#ff8080;opacity:1;font-weight:600}',
    '#dsh-tone-temp{margin-top:2px;font-size:10px;text-align:center;opacity:.5;letter-spacing:.3px}',
    '#dsh-tone-temp b{font-weight:600;opacity:.9}',
    '#dsh-tone-preview{display:none;margin-top:8px;padding:8px;border-radius:8px;background:rgba(90,150,255,.10);border:1px solid rgba(120,180,255,.25);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:170px;overflow-y:auto;color:#a9c8ee}',
    '#dsh-tone-preview.on{display:block}',
    '#dsh-tone-msg{margin-top:8px;font-size:11px;min-height:14px;opacity:.7}',
    '#dsh-tone-health{font-size:11px;line-height:1.4;margin:6px 0 4px;padding:4px 7px;border-radius:7px;background:rgba(255,255,255,.055)}',
    '#dsh-tone-health.ok{color:#7ee2a8}',
    '#dsh-tone-health.warn{color:#ffb86b;background:rgba(255,184,107,.1)}'
  ].join('');
  (document.head || document.documentElement).appendChild(style);

  var dock = document.createElement('div');
  dock.id = 'dsh-tone-dock';
  dock.innerHTML =
    '<div id="dsh-tone-tab" title="语气档位" tabindex="0" role="button" aria-label="语气档位" aria-expanded="false"><span class="v" id="dsh-tone-tabv">-</span><span class="w">语气</span></div>' +
    '<div id="dsh-tone-panel">' +
      '<h4>语气档位</h4>' +
      '<div class="hint">拖动滑块，下一轮就换口气</div>' +
      '<div class="dsh-tone-row"><span id="dsh-tone-en-label">启用</span><div class="dsh-tone-switch" id="dsh-tone-en" tabindex="0" role="switch" aria-label="启用语气档位" aria-checked="true"></div></div>' +
      '<div id="dsh-tone-health"></div>' +
      '<div id="dsh-tone-num">-<small id="dsh-tone-label"></small></div>' +
      '<input id="dsh-tone-slider" type="range" min="0" max="10" step="1" />' +
      '<div id="dsh-tone-scale"><span>0 硬</span><span>10 软</span></div>' +
      '<div id="dsh-tone-temp"></div>' +
      '<div class="dsh-tone-editor" id="dsh-tone-editor"></div>' +
      '<div class="dsh-tone-actions">' +
        '<div class="dsh-tone-btn ghost" id="dsh-tone-edit">编辑档位</div>' +
        '<div class="dsh-tone-btn ghost" id="dsh-tone-peek">看注入内容</div>' +
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

  function buildEditor() {
    var box = document.getElementById('dsh-tone-editor');
    var list = state.levels || FALLBACK;
    var html = '';
    for (var i = 0; i < 4; i += 1) {
      var lo = i === 0 ? 0 : BOUNDS[i - 1] + 1;
      var hi = BOUNDS[i];
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
        '<div class="dsh-tone-btn ghost" id="dsh-tone-reset">恢复默认</div>' +
      '</div>';
    box.innerHTML = html;
    if (!box.__cntBound) {
      box.__cntBound = true;
      box.addEventListener('input', function (e) {
        var ta = e.target;
        if (!ta || !ta.getAttribute) return;
        var idx = ta.getAttribute('data-lvt');
        if (idx === null) return;
        var cnt = box.querySelector('[data-cnt="' + idx + '"]');
        if (!cnt) return;
        var n = ta.value.length;
        if (n > 600) {
          cnt.textContent = n + '/600（超出，保存时会截断）';
          cnt.classList.add('over');
        } else {
          cnt.textContent = n + '/600';
          cnt.classList.remove('over');
        }
      });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  function bind() {
    var tab = document.getElementById('dsh-tone-tab');
    var panel = document.getElementById('dsh-tone-panel');
    var slider = document.getElementById('dsh-tone-slider');
    var enabledEl = document.getElementById('dsh-tone-en');
    var editor = document.getElementById('dsh-tone-editor');

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
      renderTone(Number(slider.value), false);
    });
    slider.addEventListener('change', function () {
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
      if (pre.classList.contains('on')) { pre.classList.remove('on'); return; }

      // 优先向宿主要「真正在系统提示里的那段文字」，
      // 拿不到才回落到本地拼一份（并注明是估算）。
      var fallback = function () {
        var list = state.levels || FALLBACK;
        var i = levelIndex(tone);
        var lv = list[i] || FALLBACK[i];
        if (!lv) return;
        pre.textContent = '（宿主自检不可用，下面是按当前档位拼出来的估算）\n\n' +
          '【语气档位 ' + tone + '/10·' + lv.name + '】' + lv.text + NOTE_SUFFIX;
        pre.classList.add('on');
      };

      pre.textContent = '读取中…';
      pre.classList.add('on');
      fetch(INSPECT_URL, { method: 'GET' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.hasMine && typeof d.text === 'string' && d.text) {
            pre.textContent = '（来自宿主实际组装的系统提示，' + d.text.length + ' 字）\n\n' + d.text;
          } else {
            fallback();
          }
        })
        .catch(fallback);
    });

    document.getElementById('dsh-tone-edit').addEventListener('click', function () {
      if (!editor.innerHTML) buildEditor();
      editor.classList.toggle('open');
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
        save({ levels: next });
      } else if (target && target.id === 'dsh-tone-reset') {
        save({ levels: null });
      }
    });

    document.addEventListener('click', function (e) {
      if (!dock.contains(e.target)) panel.classList.remove('open');
    }, true);

    window.addEventListener('resize', function () { applyPos(); });
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
    state.tone = t;
    var num = document.getElementById('dsh-tone-num');
    if (num && num.firstChild) num.firstChild.textContent = String(t);
    var lab = document.getElementById('dsh-tone-label');
    if (lab) lab.textContent = ' ' + levelName(t);
    var tabv = document.getElementById('dsh-tone-tabv');
    if (tabv) tabv.textContent = String(t);
    var slider = document.getElementById('dsh-tone-slider');
    if (slider) slider.value = String(t);
    var temp = document.getElementById('dsh-tone-temp');
    if (temp) {
      var i = levelIndex(t);
      var v = TEMPS[i] === undefined ? TEMPS[2] : TEMPS[i];
      var label = state.tempControl ? '（跟随档位 · 点此关闭）' : '（未跟随 · 点此启用）';
      if (!state.enabled) label = '（已停用）';
      temp.innerHTML = '采样温度 <b>' + v.toFixed(2) + '</b>' + label;
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
      text = '✓ 已接入（兼容模式，权重较低）';
      cls = 'ok';
    } else {
      text = '⚠ 尚未接入 · 重启 DSH 后生效';
      cls = 'warn';
    }
    if (!state.enabled) { text += ' · 当前已停用'; cls = ''; }
    el.textContent = text;
    el.className = cls;
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

  function applyState(d) {
    if (!d || typeof d !== 'object') return;
    if (d.pos && typeof d.pos === 'object') {
      var py = Number(d.pos.y);
      state.pos = {
        side: d.pos.side === 'left' ? 'left' : 'right',
        y: isFinite(py) ? Math.min(1, Math.max(0, py)) : 0.5
      };
    }
    if (d.levels && d.levels.length === 4) state.levels = d.levels;
    state.enabled = d.enabled !== false;
    state.tempControl = d.tempControl === true;
    if (typeof d.channel === 'string') renderHealth(d.channel);
    renderTone(Number(d.tone), false);
    renderEnabled();
    applyPos();
    var editor = document.getElementById('dsh-tone-editor');
    if (editor && editor.innerHTML) buildEditor();
  }

  function load() {
    fetch(API_URL, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function () {
        state.pos = { side: 'right', y: 0.5 };
        state.enabled = true;
        renderTone(7, false);
        renderEnabled();
        applyPos();
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
      .then(function (r) { return r.json(); })
      .then(function (d) {
        applyState(d);
        if (!quiet) setMsg('已保存 · ' + (state.enabled ? levelName(state.tone) : '已停用'));
      })
      .catch(function () { setMsg('保存失败'); })
      .then(function () { saving = false; flushSave(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
