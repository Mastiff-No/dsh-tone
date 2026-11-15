# dsh-tone

给 DeepSeek Harness 加一个**语气档位旋钮**。

侧边一个小竖条，点开是一个滑块：拖到 0，Agent 说话就只有结论和数据；拖到 10，它就活过来。档位每轮自动写进系统提示，改完下一句立刻生效，不用重启、不用改人设文件。

四档文案可以自己改，也能一键停用。

---

## 它解决什么

大部分人调 AI 语气的方式是改系统提示，改完要重启、要重开会话，而且只有"一刀切"的一种口味。

但实际用起来，语气是**变化的**：

- 查资料、对数据、排错误的时候，只想听结论
- 闲聊的时候，希望它有点人味
- 写东西卡住的时候，需要它活泼一点把思路撬开

同一个提示词满足不了这三种需求。dsh-tone 把这个选择权交给一个滑块。

---

## 安装

**从 npm 安装**（[dsh-tone](https://www.npmjs.com/package/dsh-tone)）：

```bash
dsh plugin --profile desktop add dsh-tone
```

需要 DSH 0.2.0 或更高版本。本地开发时可以直接挂目录：

```bash
dsh plugin --profile desktop add "link:C:\path\to\dsh-tone" --save-exact
```

装完重启一次 DSH。启动后，窗口右侧会出现一条竖着的「语气」小把手。

> 如果没出现，去插件管理里确认 `dsh-tone` 是启用状态（`cordis.patch.yml` 里 `disabled` 必须是 `false`）。

---

## 怎么用

### 拖滑块

点开把手，拖动 0–10 的滑块。**松手即保存，下一轮生效。**

```
0 ── 3    公事公办    只给结论、数据、步骤
4 ── 6    克制        内容优先，最多一句人味
7 ── 8    自然        日常口语，干活先给结论    ← 默认
9 ── 10   活泼        带情绪、带语气词，但不许省事实
```

> 界面会慢半拍：档位是你松手的瞬间写进文件的，而系统提示在**下一轮开头**才组装。所以拖完要再发一条消息，才会真正换口气。

### 停用

面板顶上的开关。关掉之后插件**完全不注入任何内容**（不是把档位调到 0，是真的什么都不发）。

### 改档位文案

点「编辑档位」展开，四档各有：

- **名字**（最多 24 字）—— 显示在面板上
- **正文**（最多 600 字）—— 直接注入给模型的内容

改完点「保存文案」。想撤回就点「恢复默认」。

**这一档是你自己的，随便写。** 比如「活泼」那一档可以写成「像一个话很多但靠谱的朋友」，也可以写成「用东北话回答」。

### 拖动位置

按住把手可以拖，松手会吸附到最近的左/右边缘，纵向位置也会记住。换个屏幕、改窗口大小都不会跑丢。

---

## 怎么确认它真的生效了

面板上的「看注入内容」按钮会去问宿主：**你现在组装出来的系统提示里，那一段到底是什么**。

看到开头写着「来自宿主实际组装的系统提示，187 字」，就说明注入是真的——不是插件自己拼出来给你看的。

也可以直接请求接口：

```bash
curl http://127.0.0.1:<端口>/dsh-tone/inspect
```

```json
{
  "channel": "section",
  "hasService": true,
  "hasMine": true,
  "sections": [{ "name": "dsh-tone:level", "order": 10210, "chars": 187 }],
  "text": "【语气档位 10/10·活泼】…"
}
```

`hasMine: false` 说明这段没进系统提示，此时 `channel` 会显示实际接上的通道（`context` 或 `none`）。

---

## 它怎么生效的

三条通道，任何一条退化都不会让插件崩掉：

### 1. 系统提示段落（主力）

```js
root.inject(['systemPrompt'], (ctx) => {
  ctx.systemPrompt.section({
    name: 'dsh-tone:level',
    order: getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 10,
    text: () => toneNote(readState()),   // 每次组装提示时求值
  })
})
```

`section()` 进的是 **system prompt 本体**，权重比 `<system-reminder>` 高。宿主没有 `section()` 时自动回落到 `context()`，效果弱一点但不会挂。

### 2. 采样温度（硬杠杆）

```js
root.on('agent/request', async (_payload, next) => {
  const config = await next()
  return { ...config, temperature: temperatureForTone(readState().tone) }
})
```

`LlmCallConfig extends LlmCallControls`，其中 `temperature` 可以自由替换——`provider` / `model` / `reasoningEffort` 被锁，改了就抛错。

这一层比提示词有效得多：低温时模型每步都挑"最可能的那个词"，而公文腔恰恰就是最可能的说法。

| 档位 | 温度 |
|---|---|
| 0–3 | 0.45 |
| 4–6 | 0.72 |
| 7–8 | 0.95 |
| 9–10 | 1.12 |

**默认不接管采样。** 面板上「采样温度」那行默认写着「未跟随」——插件不会去动你自己调好的 temperature。想让它跟着档位走，点那行一下，变成「跟随档位」；再点一下松开。

理由很简单：采样温度是你精心调出来的，插件不该一声不响替你改。只有你明确点了「跟随」，它才接管。

停用插件或关掉「跟随」，温度立刻恢复宿主原值。

### 3. 档位文案（热加载）

四档默认文案在 `lib/levels.default.json`，每一轮现读现用。改它**不需要重启 DSH**，下一轮就生效。

状态存在 `$DSH_HOME/dsh-tone.json`：

```json
{
  "enabled": true,
  "tone": 7,
  "pos": { "side": "right", "y": 0.5 },
  "levelsCustom": false,
  "tempControl": false,
  "updatedAt": "2026-11-14T15:16:08.404Z"
}
```

`levelsCustom: true` 表示你在面板里改过文案；`false` 表示用 `levels.default.json` 的默认值。

`tempControl: true` 才允许插件接管采样温度，默认 `false`。

---

## 兼容性

| 项 | 说明 |
|---|---|
| DSH Desktop | 已在 `0.2.0-rc.2` 上验证 |
| Node | `>= 22` |
| 用到的内部 API | `systemPrompt.section()` / `systemPrompt.context()`、`agent/request`、`webServer.register()`、`webServer.tapIndex()`、`webserver/index-inject` |

⚠️ 这些都是 DSH 的内部接口。大版本升级如果改了签名，插件会**静默失效**（不报错，但档位不再影响输出）。遇到这种情况请开 issue。

插件**从不**碰 `agent/pre-step` 那条 waterfall——它的 `decision.messages` 必须是完整的 Message 结构（`content` 是块数组、带 `source.kind`、带 `id`），形状不对会让整轮直接崩溃。

---

## 已知限制

- 档位是**全局**的，不区分会话。多窗口共用同一份状态。
- 面板界面目前是中文硬编码。
- 文案改动立即对所有会话生效，没有"只在当前会话用"的模式。

---

## License

MIT

---

## 开发

```bash
node test/smoke.mjs
```

65 条断言，覆盖：注入通道注册、三条路由的 HTTP 语义、状态文件读写、`levelsCustom` / `tempControl` 的边界、温度全档映射、`/inspect` 自检。

测试用假的 DSH host，会备份并恢复你的真实状态文件，跑完不影响正在用的配置。
