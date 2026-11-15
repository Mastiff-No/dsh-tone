# 待重启才生效的改动

> 这个文件只记录「已经改完、但 DSH 还没重启、所以线上仍是旧行为」的东西。
> 重启后跑 `bash verify.sh` 一次全验，验完把「未生效」这一节删掉。
>
> ⚠️ 「未生效」不等于「没测过」。这 13 项全都有测试覆盖（`node test/smoke.mjs` 用假 host
> 跑真实代码），也都能用 `node test/demo.mjs` 看到实际注入内容。这里说的只是
> **正在跑的那个 DSH 进程还加载着旧模块** —— 代码是对的，进程是旧的。

## 未生效（全在 `lib/index.js` 里，累计 13 项）

| # | 改动 | 怎么验证 |
|---|---|---|
| 1 | `lastApplied` 快照（上一轮实际注入了哪个档位、多少字） | `state.lastApplied.tone` 不是 `None` |
| 2 | `NOTE_SUFFIX` 去掉了「独立子任务可以忽略」这个逃避口子，改成「本轮生效的硬要求」 | `inspect.text` 末尾那句话 |
| 3 | 停用时清空 `LAST_APPLIED`（否则界面一直挂着上一轮的数字） | 停用后查 `state.lastApplied.tone` 应为 `null` |
| 4 | `system-prompt/assemble` 收尾压一句 `dsh-tone:tail` | `inspect.sections` 最后一项 `name` 是 `dsh-tone:tail`（不是 `dsh-expression:companion`） |
| 5 | `levelsError` 字段：文案文件写坏时能看出原因，而不是静默回落 | 故意改坏 `lib/levels.default.json`，查 `state.levelsError` |
| 6 | `stateError` 字段：状态文件读不出来时能看出原因 | 故意写坏 `dsh-tone.json`，查 `state.stateError`；`ENOENT` 不算错 |
| 7 | `widgetHandler` 读盘失败时返回 500 + 原因（原来静默挂起，浏览器干等到超时） | 临时改名 `lib/widget.js`，`GET /dsh-tone/widget.js` 应 500 并带原因 |
| 8 | `inspect` 拆成 `hasLevel` / `hasTail` / `tailIsLast`（原来只有一个 `hasMine`，分不清是哪条通道） | `inspect.hasLevel`、`inspect.hasTail`、`inspect.tailIsLast` 三个字段都在 |
| 9 | `getSectionOrder()` 返回 `undefined` 时的 NaN 防护（回落 10200 并打 warn） | 正常情况看不出来；日志里不该出现 `NaN` 或 `order` 乱序 |
| 10 | **`agent/pre-step` 在 `messages` 末尾补一条 system 消息**（第三层注入，离生成点最近）；**档位换过时点破「上一轮还是 X，这轮换成 Y」**（用独立的 `PREV_STEP_TONE`，不跟 section 抢 `LAST_APPLIED`） | 重启后先把档位拖到 10 聊一句、再拖到 2 聊一句，第 2 句的 `inspect.preStep.preview` 里应出现「这一轮换成了 2」；另查 `inspect.preStep.chars > 0` |
| 11 | `LAST_PRE_STEP` 快照（记录那条短版提醒的档位与字数，因为 `inspect` 只读 sections，看不到 messages 里那条） | `state.preStep.chars > 0`、`state.preStep.tone` 是 0–10 |
| 12 | 低档位（≤6）的短版提醒里正面否掉「斗图」：`dsh-meme` 注册的 `dsh-expression:companion` 排在我们后面教主动发图，不靠用户改文案压它 | 档位 3 时问一句，回复里不该出现 `[表情: …]`；`inspect.preStep` 可见 |
| 13 | 写盘失败时留下原因：`WRITE_ERROR`，500 响应带 `reason`、`/state` 带 `writeError`（原来只报 `write-failed`，不说是盘满还是没权限） | `state.writeError` 是空串即正常；异常时它会带上 `EACCES` / `ENOSPC` 之类的原文 |

## 已生效（热加载，刷新页面即可）

- `lib/widget.js`：健康状态行、`lastApplied` 行、键盘快捷键（`Ctrl/⌘+Shift+↑/↓/0`）、停用灰化、窄屏自适应、保存失败提示、编辑区自动撑高、复制 JSON、旧版服务端检测
- `lib/levels.default.json`：四档硬指标 + 反例/正例 + 对比行 + 低档位防模仿 + 通用示例（无本项目黑话）
- `README.md` / `PENDING.md` / `verify.sh` 本身

## 重启后怎么验

```bash
cd C:/Users/kk/.dsh/plugins/dsh-tone
bash verify.sh
```

它会自己扫端口，把上面 1–4 和 8 逐条打出来，带 ✓ / ✗ / ·（未重启）三种前缀。
第 5、6、7 项需要故意弄坏文件才能验，日常不用跑。
第 9、10 项看日志和实际语气。第 11–13 项看 `state.preStep`、`state.writeError`。
