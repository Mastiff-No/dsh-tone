# 待重启才生效的改动

> 这个文件只记录「已经改完、但 DSH 还没重启、所以线上仍是旧行为」的东西。
> 重启后跑 `bash verify.sh` 一次全验，验完把「未生效」这一节清空。
>
> ⚠️ 「未生效」不等于「没测过」。这里说的只是**正在跑的那个 DSH 进程还加载着旧模块**，
> 不是代码没验证过 —— 每一项都有 `node test/smoke.mjs` 覆盖（假 host 跑真实代码）。

## 未生效

**当前为空。** 未生效累计 0 项。

0.3.1 已重启验证并发布到 npm：`lib/index.js`（启动时加载）和 `lib/widget.js`
（每请求现读）都已经是线上正在跑的版本，没有还在等重启的东西。

原来那张 13 项的表格全部已生效，表已删除。其中第 10–12 项讲的 `agent/pre-step`
通道不是「生效」，而是被**整条移除**：它往 `decision.messages` 里塞
`role:'system'` 的消息，DSH 的 Message 结构校验不过会直接崩。
详见 `lib/index.js` 顶部与注册段的注释。

## 已生效（无需操作，留作对照）

- `lib/index.js`（服务端，启动时加载）—— 三层注入已简化为两条通道：
  主通道 `systemPrompt.section`（`dsh-tone:level`，接在 `persona-suffix` 之后，
  接不上时回落 `systemPrompt.context`），外加 `system-prompt/assemble`
  收尾压一句 `dsh-tone:tail`，抢回「最后一句」的位置；`agent/pre-step` 绝不注册。
  另有 `lastApplied` 快照、`levelsError` / `stateError` / `writeError` 三个错误字段、
  `/inspect` 的分通道字段（`hasLevel` / `hasTail` / `tailIsLast`）、
  `getSectionOrder()` 返回 `undefined` 时回落 10200 + 10 的 NaN 防护。
- `lib/widget.js`（浏览器端，每请求现读、热加载）—— 健康状态行、`lastApplied` 行、
  键盘快捷键（`Ctrl/⌘+Shift+↑/↓/0`）、停用灰化、窄屏自适应、保存失败提示、
  编辑区自动撑高、复制 JSON、旧版服务端检测、拖完滑块立即刷新、5 秒轮询。
- `lib/levels.default.json` —— 四档硬指标 + 反例/正例 + 对比行 + 低档位防模仿 +
  通用示例（不含本项目黑话）。
- `README.md` / `PENDING.md` / `verify.sh` 本身。

## 重启后怎么验

```bash
cd C:/Users/kk/.dsh/plugins/dsh-tone
bash verify.sh
```

它会自己扫端口逐条打出来，带 ✓ / ✗ / ·（未重启）三种前缀。
