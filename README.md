<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 会话应急删帧：删除最近 N 帧（step 粒度）事件并从上下文剔除，支持审核错误自动触发
  inject: 'tools'
  tools: session_eject_*
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-session-eject — 会话应急删帧插件

> 2026-08-18 主人需求开发：模型走第三方服务有外部审核，会话上下文一旦混入敏感内容，整个会话将因审核无法使用。本插件把「近几帧」从会话事件流中物理删除，重启后模型上下文不再包含被删内容。

## 能力

| 工具 | 用途 |
|------|------|
| `session_eject_recent` | 删除会话最近 N 帧（DSH step 粒度），物理重写 `session.jsonl.zstd` + 清理派生缓存 |
| `session_eject_status` | 删前诊断：目标会话、step 帧总数、事件行规模、自动触发状态 |

自动面：监听 `llm/stream` 瀑布，捕获 provider 审核类错误（content policy / moderation / 敏感 等特征词）→ 自动删最近 `autoFrames` 帧 → 正常退出（watch 守护拉起，会话重载后上下文干净）。

## 工作原理（实测验证）

- 会话 = 事件溯源日志 `sessions/<workspace>--/<sessionId>/session.jsonl.zstd`（zstd 多帧容器：header 一帧 + 每批事件一帧）
- 平台持久层只提供 `append`（无删事件 API），但加载器只扫描完整 JSONL 记录并容忍 torn tail——**物理重写文件是平台可接受的修复方式**
- 删帧按 `step/start` 边界定位：删最近 N 帧 = 保留到「倒数第 N 个 step 起始 seq」之前的全部事件（含该 step 的 chunk / 工具调用链）
- 重写保持原始行（含 packChunks 存储行 `text-chunks` 等），布局不变字节兼容；header 帧原样保留
- 派生缓存 `storages/session_projcache.json` 按会话+seq 版本键控，删帧后同步删除该会话条目，否则增量投影不一致

## 使用

1. 诊断：爱丽丝调 `session_eject_status` 确认目标会话与帧数
2. 删除：`session_eject_recent { frames: 2, sessionId?: ..., dryRun?: true, reason: "..." }`
   - `dryRun: true` 先预览（不落盘）
   - 执行后需重启 web 生效：爱丽丝随后调 `daemon_restart`（自动面则自行正常退出由守护拉起）
3. 自动面：配置 `autoTrigger` 开启后无需人工干预；`maxAutoTriggers` 防误触发循环（超限暂停自动面 10 分钟）

## 配置

```yaml
- id: agent-session-eject
  name: dsh-session-eject
  config:
    enabled: true          # 总开关
    autoTrigger: true      # 自动触发（审核错误特征词命中）
    autoFrames: 2          # 自动触发删几帧
    policyKeywords: [...]  # 审核特征词列表（默认中英 20 词）
    sessionsRoot: ~        # 会话根目录（缺省 DSH_HOME/sessions）
    maxAutoTriggers: 3     # 连续自动触发上限
```

## 边界与注意

- 「一帧」= 一个 step（一次完整思考+工具调用链）；一帧内 chunk 存储行不可分割，整帧保留/删除
- 删除是物理删除，不留痕迹；不可恢复（如无备份请谨慎）
- 工具执行时若目标文件正被持久化 writer 写入，以最后读取的快照为准（毫秒级窗口，可接受）
- Windows 下 rename 失败时自动降级为复制覆盖（弱原子性）

## 生态

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）DSH 插件生态——21 个自研插件按生命/认知/感知/行动/通信/治理/呈现七层组织。

