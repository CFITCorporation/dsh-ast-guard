// 三思层：在「有正当用途、但代价高」的动作前插一道冷却期。
//
// 语义（用户 2026-09-22 定，逐条照做）：
//   - 拦截时给出完整的语法树摘要
//   - 冷却期 x 秒（可配，**不低于 10**）：这段时间内**任何回答 —— 是或否 —— 都无效**
//   - 窗口内的回答会被拒，并告诉还剩几秒，同时提醒反复回看"这是不是我的本意"
//   - 只有 ≥ x 秒之后的回答才有效
//   - 确认是**一次性**的，绑定到那一条具体命令（规范化后的哈希），过期作废
//
// 时钟是注入的：测试可以把时间直接推快，不用真等 10 秒。
import { createHash, randomBytes } from 'node:crypto'

export const MIN_COOLDOWN_SECONDS = 10

/** 待确认项的编号：短、随机、每次拦截都换一个。 */
export function newPendingId() {
  return randomBytes(3).toString('hex')
}

export function canonicalCommand(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').trim()
}

export function commandHash(text) {
  return createHash('sha256').update(canonicalCommand(text), 'utf8').digest('hex').slice(0, 16)
}

// PowerShell 允许无歧义前缀（`-Rec` 就是 `-Recurse`），所以按"参数是规范标志的前缀"判，
// 与 PowerShell 自己的规则一致。歧义由规则作者承担：只列它真在意的标志。
export function flagMatches(arg, flag) {
  const bare = String(arg).toLowerCase().replace(/:.*$/, '')
  if (bare.length < 2 || !bare.startsWith('-')) return false
  // ⚠️ 裸 `--` 是"选项结束"标记，不是标志。不排掉它，`--` 会成为**所有** `--xxx` 的前缀
  // （`--hard` / `--force` / `--delete` 全中）—— 2026-10-10 实测：`git checkout -- <单个文件>`
  // 因此被误判成"范围收缩"，而对照组要求它必须放行。
  if (bare === '--') return false
  return flag.startsWith(bare)
}

/** 取值型全局选项：它们的**下一个参数是值**，不是位置参数。
 *  `git -C <仓库> checkout -- .` 的第一个位置参数是**仓库路径**，不是 `checkout` ——
 *  而带上 `-C` 正是 2026-10-10 那次事故的写法（`git -C $proj checkout -- .`），
 *  不跳过就整条规则失效。 */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

function firstPositional(args) {
  // ⚠️ 从 **1** 开始：daemon 给的形状是 `["git","reset","--hard"]` —— **args[0] 是命令名本身**。
  // 2026-10-10 实测踩到：不跳它会取到 `git` 而不是 `reset`，于是整个 `subcommands` 维度
  // 是哑的（10-03 加的注册表规则只靠 paths 那一半在工作，而当时没给语法树层写过用例）。
  // 规则里列的子命令都不会等于命令名，所以无条件跳第一个是安全的。
  for (let index = 1; index < args.length; index++) {
    const arg = String(args[index])
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) { index++; continue }
    if (arg.startsWith('-')) continue
    return arg
  }
  return undefined
}

/**
 * 一条 when 条件：**组内各维是 OR**（命中任一维，这条条件就算成立），返回命中的理由。
 * 这是"与"的零件 —— 2026-10-10 加。起因：`git checkout -b x`（建分支，无害）与
 * `git checkout -- .`（丢整棵树）**只差一个参数**，一组条件分不开，必须两组相与。
 */
export function matchCondition(condition, args) {
  const reasons = []
  const subcommands = Array.isArray(condition.subcommands) ? condition.subcommands : []
  const argsExact = Array.isArray(condition.argsExact) ? condition.argsExact : []
  const flags = Array.isArray(condition.flags) ? condition.flags : []
  const paths = Array.isArray(condition.paths) ? condition.paths : []
  const argsContain = Array.isArray(condition.argsContain) ? condition.argsContain : []

  // 子命令：第一个位置参数（跳过取值型全局选项，见上）。
  // `reg add`、`git checkout` 这类外部命令的参数形态解析器认不出来，位置参数就是它的子命令。
  // 取法是防御式的：规则对象可能是别处手写的（离线工具），缺某一维按空处理。
  if (subcommands.length > 0) {
    const first = firstPositional(args)
    if (first !== undefined && subcommands.includes(String(first).toLowerCase())) reasons.push(`子命令 ${String(first)}`)
  }

  for (const arg of args) {
    const text = String(arg)
    if (argsExact.length > 0 && argsExact.includes(text)) reasons.push(`参数 ${text}`)
    for (const flag of flags) if (flagMatches(text, flag)) reasons.push(`带标志 ${text}`)
    if (condition.wildcard === true && /[*?]/.test(text)) reasons.push(`通配 ${text}`)
    for (const needle of paths) if (text.includes(needle)) reasons.push(`落在受保护位置 ${text}`)
    for (const needle of argsContain) if (text.toLowerCase().includes(needle.toLowerCase())) reasons.push(`参数含 ${needle}`)
  }
  return reasons
}

/**
 * 按效应判：命中命令名之后，还要看参数里有没有真的踩到"贵"的那一面。
 * 规则没写 when 就是按命令名，一律三思。
 * when.all（2026-10-10 加）= **合取**：列表里每组条件都必须成立；没写 all 就是单组，行为同以前。
 */
export function evaluateDeliberate(rule, facts) {
  const hits = []
  for (const command of facts.commands ?? []) {
    const name = String(command.name ?? '')
    // 同 rules.js：命令词可能是**全路径**，裸名匹配会漏 ⇒ 连 basename 一起比。
    const named = name.toLowerCase()
    const base = named.split(/[\\/]/).pop()
    if (!rule.commands.has(named) && !rule.commands.has(base)) continue
    const args = Array.isArray(command.args) ? command.args : []
    const shown = args.join(' ') || name

    if (rule.when === null) {
      hits.push({ command: shown, reasons: ['规则没有限定效应条件，按命令名触发'] })
      continue
    }

    const conditions = Array.isArray(rule.when.all) ? rule.when.all : [rule.when]
    const reasons = []
    let allMatched = true
    for (const condition of conditions) {
      const part = matchCondition(condition, args)
      if (part.length === 0) { allMatched = false; break }
      reasons.push(...part)
    }
    if (allMatched && reasons.length > 0) hits.push({ command: shown, reasons })
  }
  return hits
}

export class DeliberateDesk {
  /**
   * pendingTtlMs 是刻意的短：忘了的待确认项必须自己烂掉。
   * 否则"很久之后顺手 confirm 一下"就会批准一条早就忘了的危险命令。
   */
  constructor({ now = () => Date.now(), confirmWindowMs = 60000, pendingTtlMs = 120000 } = {}) {
    this.now = now
    this.confirmWindowMs = confirmWindowMs
    this.pendingTtlMs = pendingTtlMs
    this.pendings = new Map()
    this.grants = new Map()
  }

  static key(sessionId, hash) {
    return `${sessionId}\u0000${hash}`
  }

  /**
   * 三态：allow-once（有效的一次性放行被消费）/ deliberate（拦截，进冷却）/ null（本层无意见）
   */
  check({ sessionId, command, facts, rules }) {
    const hash = commandHash(command)
    const grantKey = DeliberateDesk.key(sessionId, hash)
    const grant = this.grants.get(grantKey)
    const now = this.now()

    if (grant !== undefined) {
      if (grant.used || grant.expiresAt <= now) this.grants.delete(grantKey)
      else {
        grant.used = true
        this.grants.delete(grantKey)
        return { action: 'allow-once', ruleId: grant.ruleId }
      }
    }

    for (const rule of rules.deliberate) {
      const hits = evaluateDeliberate(rule, facts)
      if (hits.length === 0) continue
      const pending = {
        id: newPendingId(),
        sessionId,
        hash,
        rule,
        hits,
        command: canonicalCommand(command),
        requestedAt: now,
        readyAt: now + rule.cooldownSeconds * 1000,
      }
      this.pendings.set(sessionId, pending)
      return { action: 'deliberate', pending }
    }
    return null
  }

  /** none / live / expired —— 区分开才能给出"该重发命令了"这种有用的拒绝理由。 */
  stateFor(sessionId) {
    const pending = this.pendings.get(sessionId)
    if (pending === undefined) return { status: 'none' }
    const ageMs = this.now() - pending.requestedAt
    if (ageMs > this.pendingTtlMs) {
      this.pendings.delete(sessionId)
      return { status: 'expired', ageMs, command: pending.command }
    }
    return { status: 'live', pending }
  }

  /**
   * 智能体来回答。三道门，缺一不可：
   *   ① 待确认项还活着（过期即作废，防"忘了之后顺手确认"）
   *   ② 编号对得上（**不接受不带编号的"是"** —— 那是意外确认的唯一入口）
   *   ③ 冷却期已满（窗口内是或否都无效）
   */
  confirm({ sessionId, id, decision, command }) {
    const state = this.stateFor(sessionId)

    if (state.status === 'none') {
      return { ok: false, reason: 'no-pending', message: '这个会话当前没有等待确认的三思命令。' }
    }

    if (state.status === 'expired') {
      return {
        ok: false,
        reason: 'expired',
        message: [
          `这次确认被拒：那条命令是 ${Math.round(state.ageMs / 1000)} 秒前拦下的，`,
          `已经超过等待上限（${Math.round(this.pendingTtlMs / 1000)} 秒），自动作废了。`,
          '作废是故意的 —— 免得你在很久之后顺手确认一条自己已经忘了的危险命令。',
          '',
          '真要执行它，把那条命令重新发一次：会重新拦截、重新走一遍冷却期。',
        ].join('\n'),
      }
    }

    const pending = state.pending
    if (typeof id !== 'string' || id !== pending.id) {
      return {
        ok: false,
        reason: 'wrong-id',
        message: [
          '这次确认被拒：编号对不上。',
          `当前待确认的编号是 ${pending.id}；你给的是 ${id === undefined ? '（没给）' : JSON.stringify(id)}。`,
          '不带编号的"是"一律无效 —— 这是为了挡住"顺手确认一条自己已经忘了的命令"。',
          '',
          '待确认的命令：',
          ...pending.command.split('\n').map((line) => `  ${line}`),
        ].join('\n'),
      }
    }

    if (command !== undefined && commandHash(command) !== pending.hash) {
      return {
        ok: false,
        reason: 'mismatch',
        message: '你附带的命令原文和待确认的那条对不上。待确认的是：\n  ' + pending.command,
      }
    }

    const now = this.now()
    const remainingMs = pending.readyAt - now
    if (remainingMs > 0) {
      return {
        ok: false,
        reason: 'too-early',
        remainingSeconds: Math.ceil(remainingMs / 1000),
        pending,
      }
    }

    this.pendings.delete(sessionId)
    if (decision !== 'yes') {
      return { ok: true, decision: 'no', message: '已放弃，这条命令不会被放行。' }
    }

    const expiresAt = now + this.confirmWindowMs
    this.grants.set(DeliberateDesk.key(sessionId, pending.hash), {
      ruleId: pending.rule.id,
      approvedAt: now,
      expiresAt,
      used: false,
    })
    return {
      ok: true,
      decision: 'yes',
      expiresAt,
      ruleId: pending.rule.id,
      id: pending.id,
      command: pending.command,
    }
  }
}
