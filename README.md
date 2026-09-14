<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 会话应急删帧——把「最近 N 帧」（DSH step 粒度）从会话事件流 session*.jsonl.zstd 中物理删除并对保留行做 seq rebase，使文件仍满足 seq=展开数组下标的连续性契约；两个触发面（工具面显式调用 / 自动面命中审核拒绝话术）
  inject: 'tools'
  tools: session_eject_recent,session_eject_status,session_eject_repair
  runtime: host-only（纯 Node 文件系统读写 + 监听 llm/stream 瀑布；无网络、无凭据）
  envDeps: 无（标准 Node；zstd 解码为自带实现）
  boundary: 不做内容判断、不是审核规避策略；不是持久化层 owner（不接管平台 writer）；只管自己造成的 seq 断档；**物理删除不可恢复**
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-session-eject

<p align="center">
  <a href="https://github.com/jonah791/dsh-session-eject"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-5%20passed-brightgreen" alt="tests">
</p>

**一句话**：把会话的「最近 N 帧」从事件溯源日志里**物理删除**（重写 `session*.jsonl.zstd` + 清理派生投影缓存），并对保留行做 seq 重编号，使删帧后的文件仍满足平台加载器的连续性契约。

**为什么值得用**：模型走第三方服务时，会话上下文一旦混入触发外部审核的内容，**整个会话可能因此不可用**。平台持久层只提供 `append`（没有删事件 API），但加载器只扫描完整 JSONL 记录且容忍 torn tail——所以「物理重写文件」是这个平台上**可接受的修复方式**，而删帧的难点不在删，在于删完还要让 `seq = 展开数组下标` 的契约继续成立（否则文件直接加载失败）。自动面还能在命中审核拒绝话术时自己删帧并正常退出，交守护拉起。

## 能力

| 工具 | 用途 |
|------|------|
| `session_eject_recent` | 删除会话最近 N 帧（DSH step 粒度，一帧 = 一次完整思考 + 工具调用链）并从上下文剔除。用于第三方服务审核场景：会话混入敏感内容后调用，物理删除事件（重写 `session.jsonl.zstd`）+ 清理派生缓存；执行后需重启 web 生效。缺省操作当前最新会话，可指定任意 `sessionId`。参数：`frames`(必填) / `sessionId` / `dryRun` / `reason` |
| `session_eject_status` | 会话删帧诊断：查看最新/指定会话的文件、step 帧总数、事件行规模、自动触发状态（含 `hasSeqGap` / `gapBeforeSeq` / `gapAfterSeq`）。删帧前调用以确认目标与帧数。参数：`sessionId` |
| `session_eject_repair` | 修复会话日志的 seq 断档（**不删帧，只 rebase**）。当 `session_eject_status` 报告 `hasSeqGap=true` 时调用：把所有行 seq 从 0 重编，使整个文件连续。修复后需重启 web 生效。参数：`sessionId` / `dryRun` / `reason` |

**自动面**：监听 `llm/stream` 瀑布（`autoTrigger` 开启才注册），滚动缓冲模型输出并在块结束时匹配审核特征（`triggerPhrases` 话术 / `policyKeywords` 特征词）→ 自动删最近 `autoFrames` 帧 → 记 marker → 1s 后 `process.exit(0)`，交 watch/guardian 拉起，会话重载后上下文干净。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-session-eject": "link:<工作区>/self-plugins/dsh-session-eject"
```

**2) 挂组合**（agent 预设行）：

```yaml
- insert:
    - id: agent-session-eject
      name: dsh-session-eject
      config:
        enabled: true
        autoTrigger: true
        autoFrames: 2
        maxAutoTriggers: 3
```

**3) 30 秒验证**：

```
session_eject_status
session_eject_recent frames=1 dryRun=true reason="接线验证"
```

期望：`status` 返回 `{ok:true, sessionId, file, totalSteps, eventRows, hasSeqGap, …}`；`dryRun` 返回 `rebased`/`removedSteps`/`removedRows` 且**文件 mtime 不变**。

> ⚠ **先读这条再验收**：当前构建的 `collectSessionFiles()` **只匹配文件名 `session.jsonl.zstd`**，而线上实际文件名是 `session.v3.jsonl.zstd` / `session.v2.jsonl.zstd`——因此 **`status` 会返回「找不到会话文件」，三个工具都定位不到任何线上会话**（`docs/semantic.md` §7 A6 已实测判定为**不匹配**，§10 U1 记录修复方向）。这是**已知缺陷**，不是你的接线问题；修复需改源码（只认后缀 `.jsonl.zstd` 并保留旧名兼容），不在文档任务范围内。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 总开关；`false` 时两个写工具返回 `{ok:false, note:'插件已禁用'}` |
| `autoTrigger` | `true` | 自动面开关（`false` 时不注册 `llm/stream` 监听） |
| `autoFrames` | `2`（1–50） | 自动触发删几帧 |
| `triggerPhrases` | `['你好，我无法给到相关内容。', '我无法给到相关内容']` | 审核拒绝话术（尾部匹配，配合 `phraseTailCharsMax`） |
| `phraseTailCharsMax` | `200`（0–10000） | 话术匹配的尾部扫描窗口字符数 |
| `policyKeywords` | 20 条中英特征词（`content policy` / `moderation` / `refusal` / 审核 / 违规 / 敏感内容 …） | 审核类特征词 |
| `sessionsRoot` | 未设 → `<DSH_HOME>/sessions`（或 `DSH_SESSIONS_ROOT`） | 会话根目录 |
| `maxAutoTriggers` | `3`（1–20） | 连续自动触发上限：`marker.count ≥ maxAutoTriggers` 且距上次 < 10 分钟 → **抑制**（不删帧、不退出，仅 `logger.warn`） |

## 落盘与自证（出问题时先看这里）

**本插件无侧车轨迹**（`<DSH_HOME>/session-eject-trace.jsonl` 尚不存在——「自动面触发过几次、哪一轮」事后**不可完整重建**，见 `docs/semantic.md` §10 U2）。它的持久产物就是它改动的那几个文件：

| 落点 | 写者 | 说明 |
|------|------|------|
| `<sessionsRoot>/<…>/session*.jsonl.zstd` | `session_eject_recent` / `session_eject_repair` | **物理重写**：tmp（`.eject-tmp` / `.repair-tmp`）→ `renameSync`；rename 失败降级为 `copyFileSync` + 删 tmp（弱原子性）。保留行含 `text-chunks` 等存储行，header 帧原样保留，布局字节兼容 |
| `<DSH_HOME>/storages/session_projcache.json` | 删帧时 | 删掉该 `sessionId` 的投影条目（tmp + rename 写回）——否则增量投影不一致 |
| `<DSH_HOME>/session-eject-marker.json` | 自动面 | 形状 `{count, lastAt}`：连续触发计数与时刻；读失败回落 `{count:0,lastAt:0}`，**写失败不阻断主流程** |

无阶段枚举（没有 trace 行）；**行为级阶段**由工具返回值给出：`locateSessionFile`（找不到文件即在此断）→ `parseLog`（读取快照）→ `computeBoundary`（`min(frames, stepStarts.length)`）→ 重写 + 清缓存 → 返回 `rebased/removedRows/lastKeptSeq/needRestart`。

**一条命令答五问**（无 trace 时的行为级等价物）：

```bash
cat "$DSH_HOME/session-eject-marker.json"; ls -l "$DSH_HOME/sessions"/*/session*.jsonl.zstd | tail -3
# ① 线上跑的是哪个构建 → marker 无 build 字段：改为比 lib/index.js mtime 与 web 进程启动时间（见「生效判据」）
# ② 谁发起 / 目标是谁   → marker 只记 count/lastAt（时点），不记 sessionId/帧数 ⇒ 这是当前证据层缺口（§10 U2）
# ③ 断在哪一段         → 无阶段枚举；返回值 note 区分：找不到会话文件（定位失败）/ 无 step/start（抛错，不静默）/ rebased:false
# ④ 结果质量           → 返回值 keptRows / removedRows / removedSteps / totalSteps / lastKeptSeq（dryRun 时同字段但不落盘）
# ⑤ 耗时与预算         → 无耗时字段；自动面退出延迟固定 1000ms；自动面限流窗口 10 分钟
```

> **建议先看 `session_eject_status` 的返回**：它一次性给出 `totalSteps` / `eventRows` / `hasSeqGap` / `gapBeforeSeq` / `gapAfterSeq` / `markerCount`——这是本插件目前信息量最大的一处外部可见面（前提是它定位得到文件，见「快速开始」的缺陷警告）。

## 生效判据与回退

**生效判据**（三选一）：
1. 行为级：`session_eject_status` 能被调用并返回结构化字段（**注意**：返回「找不到会话文件」是 A6 缺陷在场，不是「没生效」——二者要分开判）；
2. 产物级：`lib/index.js` 的 mtime **早于** web 进程启动时间（`<DSH_HOME>/plugin-boot.jsonl` 末行 `processStartMs`）⇒ 当前进程加载的是这份产物；
3. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）的 `live` 含 `dsh-session-eject`、`stale` 为空 ⇒ 判据 2 的机器化版本。

> 注意：**重新构建 ≠ 生效**——`tsc` 只是写了一个新产物，**进程启动时间必须晚于产物 mtime** 才算「在跑它」。缺这一条时不得宣称「已生效」。
> 另注意：本仓库构建是 `tsc -p tsconfig.json --noCheck`（**带 `--noCheck`，类型错误不会挡住构建**）——产物可能是类型不干净的代码，改源码后请另外单跑 `npm run typecheck`。

**回退**：
- 源码级：`git -C self-plugins/dsh-session-eject revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `agent-session-eject` 行加 `disabled: true`（或移除该行）→ 哨兵重启（`config.enabled=false` 也能让**写工具**拒绝执行，但工具仍在工具面）；
- 运行期：**删帧是物理删除、不可恢复**——回退前请确认有备份或 git/文件快照；`session_eject_repair` 只做 seq 重编，不恢复被删内容。marker 文件可随时删除（自动面限流计数归零）。

## 测试

```bash
node --test "tests/*.test.mjs"      # 本仓库无 npm test 脚本；直接对 lib/ 产物跑
```

**5 例离线测试**（5/5 通过），`tests/session-file.test.mjs`——会话文件层：多帧 zstd 容器的 scan / decompress / compress 往返、帧边界（`step/start`）定位与 `computeBoundary` 的 `min(frames, stepStarts.length)` 语义、以及**深度上限**（超过 4 层的会话不再扫描，防深层遍历爆栈）。

**离线单测不需要网络、不需要挂载插件、不需要真实会话目录、不需要 WSL**——用例在临时目录构造多帧容器后直跑 `lib/` 产物。**注意覆盖面的边界（诚实披露）**：本仓库测试**不覆盖**「真实线上会话文件定位」这条路径——`docs/semantic.md` §7 A6 的实测判据（枚举线上文件名的分布）显示当前构建定位失败，该缺陷**没有任何单测守卫**（因为它考的是文件名匹配约定，而非纯逻辑）。三条工具的接线（`apply` 注册、自动面命中、marker 递增）同样**无自动化回归**。

## 设计要点

- **删帧 = 重写文件，不是删事件**：平台持久层只有 `append`，但加载器只扫描完整 JSONL 记录且容忍 torn tail——故物理重写是**被平台接受的修复方式**。改这条链路时不要试图寻找「删事件 API」，它不存在。
- **seq rebase 是删帧的必然后果**：删掉中间的事件会让 `seq = 展开数组下标` 的契约断裂，故每次删帧都要从头重编 seq（返回值 `rebased`）；`session_eject_repair` 是「只 rebase 不删帧」的独立入口，用于消化历史断档。
- **帧不可分割**：一帧 = 一个 `step`（一次完整思考 + 工具调用链）；帧内的 chunk 存储行（`text-chunks`）必须整帧保留或整帧删除，切开会让投影层拿不到完整块。
- **派生缓存必须同步删**：`session_projcache.json` 按「会话 + seq 版本」键控；删帧后不同步删除该会话条目，增量投影会与新文件不一致（表现为上下文里仍出现被删内容）。
- **自动面用退出换重载**：删帧后进程内上下文仍是旧的，故自动面删完就 `process.exit(0)`（1s 后），依赖 watch/guardian 拉起——**这依赖守护在线**（`docs/semantic.md` §10 U3）；工具面则由使用者显式接 `daemon_restart`。
- **限流是防循环的必要件**：命中话术 → 删帧 → 重启 → 若话术仍在缓冲里就会再触发。故 marker 记 `count/lastAt`，超限 10 分钟窗口内抑制（**抑制不等于修复**：抑制期间问题仍在，只是不再自动处置）。
- **无 step/start 时抛错不静默**：找不到帧边界说明文件形态超出预期，静默返回成功会造成「以为删了其实没删」。
- **不是审核规避策略**：本插件不判断内容是否敏感，只做模式命中后的机械处置；边界与合规责任在使用者。

### 与相邻机制的边界

| 相近机制 | 分工 |
|---------|------|
| 压缩（`dsh-agent-compact` / `dsh-compact-provider`） | 压缩做「总结 + 表层替换」，产 summary、改表层；本插件**按帧物理切掉日志尾部**，不产 summary、不碰替换体 |
| 会话日志修复（技能 `dsh-session-log-repair`） | 那里管 resume 校验失败/多帧格式损坏；本插件只管**自己造成的 seq 断档** |
| 平台持久层 | 本插件**不是** owner：不接管 writer、不新增删事件 API，只在文件层重写 |

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、契约（路径与落盘结构 + 工具返回字段 + 调用点清单）、可证伪验收清单（A1–A7，含 A6 的**证伪**判定）、未决问题（U1–U4） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `dsh-session-log-repair` / `dsh-session-debugging` / `plugin-maintainability` | 会话日志物理格式与损坏修复、事件流重放与计量投影、可维护性工程（五问判据） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
