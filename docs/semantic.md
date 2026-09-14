# 语义文档：会话应急删帧（dsh-session-eject）

> 版本 v0.1（对应 `package.json` version **0.1.1**）· 2026-09-14 · 作者：爱丽丝 · 状态：**draft** · 开发方式：语义文档优先
> 能力名：会话应急删帧 · 插件名 `dsh-session-eject`（插件内 `name = 'agent-session-eject'`，`inject = ['tools']`）
> 主副本路径：`self-plugins/dsh-session-eject/docs/semantic.md`
> 实现落点：`self-plugins/dsh-session-eject/src/index.ts`、`src/core.ts`、`src/zstd.ts`（产物 `lib/index.js`、`lib/core.js`、`lib/zstd.js`）

## 1 · 定位与反定位

**定位**：把「最近 N 帧」从**会话事件流**（`session*.jsonl.zstd` 多帧容器）里**物理删除**，并对保留行做 seq 重编号（rebase），使删帧后文件仍满足平台的 `seq = 展开数组下标` 连续性契约；同时提供断档诊断与「只 rebase 不删帧」的修复入口。两个触发面：**工具面**（显式调用）与**自动面**（外部审核拒绝话术/审核类错误 → 自动删帧 + 正常退出触发守护重启）。

**反定位（本文不管什么）**：
- 不管**压缩**（`dsh-agent-compact` / `dsh-compact-provider`）——压缩做「总结 + 表层替换」，本插件按帧切掉日志尾部；不产 summary、不碰 surface 替换体。
- 不管**会话加载失败/物理损坏**（resume 校验失败、多帧格式修复属技能 `dsh-session-log-repair` 领域）——只处置自己造成的 seq 断档。
- **不是**审核规避策略：不判断内容是否敏感，只按 `triggerPhrases` / `policyKeywords` 命中后删帧。
- **不是**持久化层 owner：不接管平台 writer、不新增删事件 API，只在**文件层**重写（加载器容忍 torn tail，故物理重写安全）。

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 帧（frame） | = 一个 DSH step（一次完整思考 + 工具调用链），以 `step/start` 事件为起始边界 |
| chunk-rows 行 | `text-chunks` / `reasoning-chunks` / `tool-call-chunks` 三类存储行：一行携带多条子事件（`data.texts` 或 `data.args`），用 `seq0` 定位，展开后占多个 seq |
| 展开 seq | 把 chunk-rows 按子事件数展开后的序号（`totalExpandedEvents` 即展开后总数） |
| seq rebase | 重编号 `seq`、`seq0`、`surfaceOp.startSeq/endSeq`、`sourceEventSeqs[]`，使保留部分从 0 连续 |
| 多帧 zstd 容器 | 平台持久化格式：header 一帧 + 每批事件一帧；`scanFrames` 结构级扫帧、`decompressAll` 逐帧解压拼接 |
| torn tail | 未完成尾帧 / seq 不连续后的残余事件；加载器忽略之，故 rebase 是安全自保手段 |
| 派生投影缓存 | `<DSH_HOME>/storages/session_projcache.json`，按会话 + seq 版本键控，删帧后条目必须同步删除 |
| 自动面 | `llm/stream` 瀑布监听器：内容通道（拒绝话术）+ 错误通道（审核特征词）→ 自动删帧 → `process.exit(0)` |

## 3 · 概念模型

```
工具面: 爱丽丝/主人 ──session_eject_recent──► ejectRecent()    ｜ 诊断 detectSeqGaps()（只读）
                    └─session_eject_repair──► repairSeqGaps()（只 rebase）
        ▼ locateSessionFile(sessionsRoot) → parseLog → computeBoundary(stepStarts, N)
        ▼ 保留 firstExpandedSeq < boundarySeq 的行 → seqMap(旧→新) → rebaseRow → compressLog(header, body)
        ▼ 写 file+'.eject-tmp' → renameSync(file)（失败 → copyFileSync 降级）+ cleanProjectionCache(sessionId)
        ▼ needRestart: true ──► daemon_restart
自动面: llm/stream 瀑布（内容通道：命中 triggerPhrases 且 tailChars ≤ phraseTailCharsMax；错误通道：命中 policyKeywords）
        └─► doAutoEject() → marker 计数/限流 → ejectRecent() → setTimeout(exit(0), 1000) ──► watch/guardian 拉起 web
```

不变量（invariants）：
1. **I1 帧边界对齐**：删帧只以 `step/start` 的展开 seq 为边界——被删区间必为完整整数个帧，帧内 chunk 存储行不可分割（整帧保留或整帧删除）。
2. **I2 rebase 后连续**：非 dryRun 的 `ejectRecent` / `repairSeqGaps` 落盘后，保留行展开 seq 必为 `0..lastKeptSeq` 连续，且返回 `needRestart: true`。
3. **I3 缓存同步**：每次实际落盘（且 `opts.projcache !== false`）都调用 `cleanProjectionCache(sessionId)`；返回 `true` 当且仅当该会话条目真的存在于 `data.tables.sessions` 中并被删。
4. **I4 重写不引入新内容**：保留行以原 JSON 对象序列化（只改 seq 系字段），header 行原样复用；`compressLog` 产出「header 帧 + body 帧」两帧布局。
5. **I5 生效需重启**：删帧/修复只作用于**磁盘文件**，对内存中的会话无影响——生效路径是重启 web（自动面则自行退出）。

## 4 · 契约

### 4.1 路径与落盘结构（逐字取自源码）

| 名称 | 位置 / 定义 | 说明 |
|------|------------|------|
| `dshHome()` | `process.env.DSH_HOME ?? join(homedir(), '.dsh')`（`src/core.ts`） | 与平台约定一致 |
| `sessionsRoot()` | `process.env.DSH_SESSIONS_ROOT ?? join(dshHome(), 'sessions')`（`src/core.ts`） | 可被配置覆盖（`root = () => config.sessionsRoot ?? sessionsRoot()`） |
| 会话文件 | `collectSessionFiles()` 只收 `entry.name === 'session.jsonl.zstd'`，递归深度 ≤ 4 | ⚠ 与线上实际文件名不一致，见 §8 / §10 U1 |
| 投影缓存 | `join(dshHome(), 'storages', 'session_projcache.json')`（`cleanProjectionCache`） | 删 `data.tables.sessions[sessionId]` 后 `tmp + renameSync` 写回 |
| 自动触发标记 | `join(dshHome(), 'session-eject-marker.json')`（`markerFile()`） | 形状 `{ count: number, lastAt: number }`；读失败回落 `{count:0,lastAt:0}`，写失败**不阻断主流程** |
| 重写临时文件 | `file + '.eject-tmp'`（删帧）/ `file + '.repair-tmp'`（修复） | rename 失败 → `copyFileSync(tmp, file)` + `rmSync(tmp)`（弱原子性） |

### 4.2 工具与配置契约

| 工具 | 必填 | 可选 | 主要返回字段 |
|------|------|------|-------------|
| `session_eject_recent` | `frames`(number) | `sessionId` `dryRun` `reason` | `ok` `sessionId` `file` `boundarySeq` `lastKeptSeq` `keptRows` `removedRows` `removedSteps` `totalSteps` `rebased` `dryRun` `needRestart` `note` |
| `session_eject_status` | — | `sessionId` | `ok` `sessionId` `file` `totalSteps` `eventRows` `totalEvents` `hasSeqGap` `gapBeforeSeq` `gapAfterSeq` `hasTurnEndPostGap` `autoTrigger` `autoFrames` `triggerPhrases` `phraseTailCharsMax` `markerCount` `note` |
| `session_eject_repair` | — | `sessionId` `dryRun` `reason` | `ok` `sessionId` `file` `gapFixed` `lastSeq` `totalRows` `dryRun` `needRestart` `note` |

配置：`enabled`(true) / `autoTrigger`(true) / `autoFrames`(2, 1–50) / `triggerPhrases`(默认 `['你好，我无法给到相关内容。','我无法给到相关内容']`) / `phraseTailCharsMax`(200, 0–10000) / `policyKeywords`(20 条中英特征词) / `sessionsRoot?` / `maxAutoTriggers`(3, 1–20)。`enabled=false` 时两个写工具返回 `{ ok: false, note: '插件已禁用' }`；无 `step/start` 时抛错（不静默）；自动面限流 = `marker.count >= maxAutoTriggers && Date.now() - marker.lastAt < 10 * 60 * 1000` → 抑制并 `logger.warn`（不删帧、不退出）。

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 宿主组合（web profile） | `.dsh/profiles/web/cordis.patch.yml` → `insert: { id: agent-session-eject, name: dsh-session-eject }` | web 启动装载（无 config，全默认值） |
| 爱丽丝（模型） | `session_eject_recent` → `src/index.ts:defineTool.execute` → `doEject()` → `core.ts:ejectRecent()` | 会话混入敏感内容需物理删帧时；调用后应接着 `daemon_restart` |
| 爱丽丝（模型） | `session_eject_status` → `src/index.ts:defineTool.execute` → `core.ts:detectSeqGaps()`（只读） | 删帧前定目标/帧数；删帧后确认 `hasSeqGap` |
| 爱丽丝（模型） | `session_eject_repair` → `src/index.ts:defineTool.execute` → `core.ts:repairSeqGaps()` | `status` 报 `hasSeqGap=true` 时（不删帧，只 rebase） |
| 宿主 LLM 流 | `src/index.ts:ctx.on('llm/stream', (_options, next) => …)`（瀑布；`config.autoTrigger` 开启才注册） | 每轮模型流：`text-delta` 滚动缓冲 / `block-end` 块文本；`catch` 内 `matchesPolicy` |
| 宿主 LLM 流（命中后） | `src/index.ts:doAutoEject()` → `core.ts:ejectRecent()` → `saveMarker()` → `setTimeout(() => process.exit(0), 1000)` | 命中审核拒绝：删帧 + 记 marker + 1s 后退出，交 watch/guardian 拉起 |
| 插件自身 | `src/index.ts:ctx.effect(...)` 仅打 `logger.info('ready auto=… frames=… keywords=…')` | 装载完成自报（**注**：`ctx.logger` 不落盘，非持久轨迹） |
| 构建/加载 | `src/index.ts` → `import … from './core.ts'`；`core.ts` → `import { scanFrames, decompressAll, compressLog } from './zstd.ts'` | 模块加载期（`npm run build` = `tsc -p tsconfig.json --noCheck`） |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：本插件直接读写 `DSH_HOME` 下会话文件与投影缓存，且删除**不可逆**；不校验调用者、不做内容判定、无回收站/备份。
- 不越界清单：不改平台 writer；不新增会话 API；不删整个会话目录（只重写单个 `session*` 文件）；不清理 `tables.sessions[sessionId]` 之外的 projcache 内容；不动 `AGENTS.md`/记忆库。
- 失败面（一律显式）：找不到文件 / 无法解析 / 无 `step/start` → `throw`，工具返回 `{ ok: false, note: <err> }`（文案逐字，如 `'会话文件不存在: '`、`'会话中没有 step/start 事件，无法界定帧边界: '`）；单行 JSON 解析失败 → `parseRow` 返回 `null` 并**跳过该行**（不删可疑行）；`cleanProjectionCache` / marker 读写失败 → `catch` 返回 `false` / 保持零值，**不抛错**（宁可缓存多留一条，不让删帧主流程失败）；目标文件被 writer 共享打开 → rename 失败降级复制覆盖。
- 读失败：dryRun 只计算不落盘（不写 tmp、不动 projcache；render 前缀「【预览】」）。

## 6 · 与既有机制的关系

- **§5.21 压缩纪律**：真原文只存在于 append-only 会话事件流——本插件的物理重写会**改变那份真相**，故属「应急」动作。
- **§5.15 会话事件契约**：`surfaceOp.replace` 的 V3 键名是 `startSeq`/`endSeq`（旧 v2 为 `start`/`end`）；`rebaseRow` **两者都重编**（2026-09-10 修复），字段迁移只需改这一处。
- **重启链**：`needRestart: true` 的处置是 `daemon_restart`（重启前按 §5.11 调 `preflight_check`）；自动面走 `process.exit(0)`，由 watch/guardian 保活拉起（§5.19：拉起者只有守护，本插件不自行 spawn）。
- **组合变更**：`inject = ['tools']` 是唯一硬依赖；改代码后按 §5.11「重建 ≠ 生效」验证（见 §8 生效判据）。
- **并行实例（§5.14）**：删帧是共享写入面操作——同一会话被两实例同写会互相覆盖，动手前先看 `.dsh/plugin-boot.jsonl` 与 `git status`。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行） | 状态 |
|---|-----------|--------------------------|------|
| A1 | 删 N 帧后保留行展开 seq 连续为 `0..lastKeptSeq` | `session_eject_recent {frames:2, dryRun:true}` → `rebased:true` 且 `lastKeptSeq` = 保留展开数 − 1 | **待验收** |
| A2 | 帧数不足按实际帧数删除且不抛错；落盘为 tmp+rename | `src/core.ts:computeBoundary` 返回 `min(frames, stepStarts.length)`；`ejectRecent` 中 `file+'.eject-tmp'` → `renameSync` → `catch { copyFileSync }` | 已实测（源码判据） |
| A3 | 删帧后 projcache 中该会话条目消失 | 前后对比 `<DSH_HOME>/storages/session_projcache.json` 的 `tables.sessions[sessionId]` | **待验收** |
| A4 | 自动面命中后 marker 递增 + 进程退出 + 守护拉起 | `<DSH_HOME>/session-eject-marker.json` 的 `count` +1、`lastAt` 为当刻；日志行 `[content-phrase] 自动删帧 …` | **待验收** |
| A5 | 超 `maxAutoTriggers` 且 10 分钟内 → 抑制 | 日志 `auto-trigger suppressed（连续触发已达上限 N 次）` | **待验收** |
| A6 | 能定位到线上会话文件 | `Get-ChildItem -Recurse -Force -File -Filter *jsonl.zstd E:\alice\.dsh\sessions \| Group-Object Name` → **`session.v3.jsonl.zstd`=34 / `session.v2.jsonl.zstd`=1 / `session.jsonl.zstd`=0**；代码字面量见 `lib/core.js:116` | **已实测：判为不匹配（当前构建定位不到任何线上会话文件）** |
| A7 | dryRun 不落盘 | dryRun 后文件 mtime 不变、`session_projcache.json` 不变 | **待验收** |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（工具注册 + 自动面 + config）、`src/core.ts`（定位/解析/边界/rebase/重写/缓存清理/断档诊断）、`src/zstd.ts`（多帧容器 scan/decompress/compress）。
- 构建产物：`lib/index.js`、`lib/core.js`、`lib/zstd.js`（`main: lib/index.js`）；`npm run build` = `tsc -p tsconfig.json --noCheck`（**带 `--noCheck`：类型错误不会挡住构建**）。
- **未实现/未验证部分显式标注**：① **文件名不匹配（A6）**——`collectSessionFiles` 只认 `session.jsonl.zstd`，线上是 `session.v3.jsonl.zstd`（34 个）/`session.v2.jsonl.zstd`（1 个），故三个工具当前会在 `locateSessionFile` 处返回「找不到会话文件」；本文只记事实，修复不在本次任务范围。② `eventRows/totalEvents` 依赖 `parseLog` 的读取快照（writer 正在写入时为毫秒级窗口，README 已声明可接受）。③ 自动面**无持久轨迹**：`ctx.logger` 不落盘、marker 只记 `count/lastAt`——「触发过几次、哪一轮」事后不可完整重建（§5.22 第 2 条不满足）。
- **生效判据**（改了代码后怎么证明真的生效）：① 比对 `lib/*.js` mtime 与 **web 进程启动时间**（`.dsh/plugin-boot.jsonl` 最后一行 `processStartMs`）——产物 mtime 必须**早于**进程启动才算被当前进程加载（§5.11「重建 ≠ 生效」）；本次核对：`lib/index.js` mtime `2026-09-11 12:55:16` 早于当前进程 `2026-09-14 10:05:47`，且该账本 `live[]` 含 `dsh-session-eject`，且 `src/core.ts`(`08:27:09`) 早于 `lib/core.js` → 跑的就是这份产物。② 行为判据：`session_eject_status` 应能答出 `sessionId/file/totalSteps`——**返回「找不到会话文件」即 A6 缺陷在场**；再 `session_eject_recent {frames:1, dryRun:true}` 看 `rebased` 与 `removedSteps`。
- **回退**（出问题怎么办）：① 代码/语义问题 → `git -C E:/alice/self-plugins/dsh-session-eject revert`（或 `checkout <上个提交>`）+ `npm run build`，按「生效判据」重验；② 整体下线 → `plugin_unmount dsh-session-eject`（写 patch + 重启）或临时 `plugin_stop`；③ 误删帧无备份、**不可逆**——删帧前建议先 `Copy-Item` 该 `session*.jsonl.zstd`；④ 回退后仍异常 → 用 §5.20 的 `semantic_check` 复核本文与实现是否再度漂移。

## 9 · 实践修订记录

（I3：每次事故/实践暴露的语义缺口当场回写。没有也要保留本节——D6 检查它存在）

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
  - 语义**被确认**：双触发面、seq rebase 的四个重编字段（`seq` / `seq0` / `surfaceOp.startSeq|endSeq`（兼容旧 `start|end`）/ `sourceEventSeqs[]`）、`needRestart: true` 的重启语义、两类落盘路径（`storages/session_projcache.json`、`session-eject-marker.json`）。
  - 语义**被补充**：`computeBoundary` 的「帧数不足按实际帧数全删尾部」；自动面限流是**时间窗**（`maxAutoTriggers` 且 10 分钟内）而非「累计上限即永久停用」；`--noCheck` 构建不挡类型错误。
  - 语义**被修正**：源码注释/工具描述里的 `session.jsonl.zstd` 与线上实际文件名 `session.v3.jsonl.zstd` 不一致——按**双向取证**（源码字面量 + 落盘清点）记录，不沿用注释口径。
  - 教训（同时回写技能 `semantic-doc-first`）：**路径类契约必须与落盘实测对照**，只读注释会写出「文档对、现实错」的语义。

## 10 · 未决问题

- **U1 文件名不匹配（A6）**：`collectSessionFiles` 应匹配 `session.v3.jsonl.zstd`/`session.v2.jsonl.zstd`（或「前缀 `session` + 后缀 `.jsonl.zstd`」）。倾向：后缀匹配并保留旧名兼容；**本任务不改源码**，交主人/爱丽丝定修复批次。
- **U2 自动面可维护性（§5.22）**：自动触发应落侧车轨迹（`<DSH_HOME>/session-eject-trace.jsonl`：`atMs/phase/channel/markerCount/removedSteps`），否则事后不可查。
- **U3 退出 vs 显式重启**：自动面 `setTimeout(() => process.exit(0), 1000)` 依赖 watch/guardian 拉起（§5.19 单点所有权成立与否取决于守护在线）。倾向保持现状（退出更轻），但要确认守护一定在。
- **U4 注册表登记**：`docs/semantics/registry.json` 尚无本条目（本任务禁改注册表）——由主 agent 用 `semantic_register` 登记（`status: draft`、`doc: self-plugins/dsh-session-eject/docs/semantic.md`、`impl` 取 §8 三源文件）。
