// dsh-ast-guard —— 把 pwsh / powershell 命令交给真正的语法树判定。
//
// 这是一个**独立**的守卫层：不依赖任何其它规则层，规则全部在 rulesFile 指向的 YAML 里。
// 命令送进随宿主启动的常驻 PowerShell 解析器，按**节点**判定（不是文本匹配）。
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedDaemon } from './daemon.js'
import { DeliberateDesk } from './deliberate.js'
import { parseRulesFile, evaluate, buildDenialMessage, buildDeliberateMessage, evaluateToolParams, buildToolDenialMessage } from './rules.js'
import { collectEvidence, evidenceCwds } from './evidence.js'

export const name = 'dsh-ast-guard'
export const inject = ['tools']

const SHELL_TOOLS = new Set(['pwsh', 'powershell'])

const DEFAULTS = {
  // null = 用**包内自带**的 rules/default.yaml。
  // 2026-10-27 定的：规则文件的位置与**插件安装位置**保持一致 ——
  // 装上就有一套能跑的规则，不需要手动把文件搬到哪里去。
  // 想用自己的规则：在 config 里写路径（相对会话 cwd，或绝对路径）。
  rulesFile: null,
  enabled: true,
  failPolicy: 'closed',
  onRuleError: 'closed',
  timeoutMs: 5000,
  powershell: 'powershell.exe',
  yamlPath: null,
}

/** 包内默认规则：`<包>/rules/default.yaml` —— 与插件安装位置一致。 */
function defaultRulesFile() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rules', 'default.yaml')
}

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  if (options.enabled !== true) {
    ctx.logger?.info?.('ast-guard: enabled=false，本层不生效')
    return
  }

  // 进程级单例：宿主会反复 apply()，不共享的话每个实例都会拉一个常驻 powershell（实测漏了一个）。
  const daemon = sharedDaemon({
    powershell: options.powershell,
    timeoutMs: options.timeoutMs,
    logger: ctx.logger,
  })

  // 随宿主启动，但不阻塞启动流程：第一次真正要用时再等它就绪，那时通常早就好了。
  // 单例之后重复 apply 也不再重新拉起（start() 自己会判 running）。
  daemon.start().catch((error) => {
    ctx.logger?.warn?.(`ast-guard: 解析器启动失败，将在第一次用到时重试：${error.message}`)
  })

  // 三思台：冷却期状态、一次性放行都在这儿。按会话隔离 —— 同一会话同一时刻只留一条待确认。
  const desk = new DeliberateDesk()
  registerConfirmTool(ctx, desk)

  // 规则按【绝对路径 + mtime】缓存：改文件立即生效，没改就不重复解析。
  const cache = new Map()

  async function rulesFor(cwd) {
    const configured = options.rulesFile
    const isDefault = configured === null || configured === undefined || configured === ''
    const file = isDefault
      ? defaultRulesFile()
      : (path.isAbsolute(configured) ? configured : path.join(cwd, configured))

    let mtimeMs
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      // 两种"没有文件"，含义务不相同：
      //   · 配了路径但没有文件 ⇒ 这个工作区没配规则 ⇒ **无意见**（不是错误）
      //   · **包内默认**规则都没有 ⇒ 安装不完整 ⇒ 当**错误**（走 onRuleError=closed ⇒ 拒绝并说明）
      //     —— "失败一律响"是这套东西的底线，默认规则缺失绝不能静默放行。
      if (isDefault) return { file, rules: null, error: `包内默认规则不存在：${file}（安装不完整？）`, missing: false }
      return { file, rules: null, error: null, missing: true }
    }

    const cached = cache.get(file)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached

    try {
      const rules = await parseRulesFile(file, { yamlPath: options.yamlPath })
      const entry = { file, mtimeMs, rules, error: null, missing: false }
      cache.set(file, entry)
      return entry
    } catch (error) {
      // 坏的规则不顶掉上一份可用的，但必须报出来 ——
      // 文本层那条"规则写坏即静默失效"是这套系统里最贵的教训，不在这里重演。
      ctx.logger?.error?.(`ast-guard: 规则文件读不了（${file}）：${error.message}`)
      const entry = { file, mtimeMs, rules: cached?.rules ?? null, error: error.message, missing: false }
      cache.set(file, entry)
      return entry
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await check(exec)
    if (decision !== null) return decision
    return next()
  })

  async function check(exec) {
    const tool = String(exec?.name ?? '')
    const isShell = SHELL_TOOLS.has(tool)
    const command = exec?.arguments?.command
    if (isShell && (typeof command !== 'string' || command.trim() === '')) return null

    const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
    const entry = await rulesFor(cwd)
    if (entry.missing === true) return null

    // 非 shell 工具（edit / write…）：只查「工具参数规则」，不经过解析器（2026-10-27 · 独立化 P1）。
    // ⚠️ 这一支**规则文件坏了就放行**（fail open）：否则会连 edit 一起挡住，而"改规则文件"只能靠 edit
    //    —— 那是自锁。坏文件本身已经有 error 日志；shell 那一支仍然是 fail closed。
    if (!isShell) {
      if (entry.rules === null) return null
      const hit = evaluateToolParams(entry.rules, tool, exec?.arguments ?? {})
      if (hit === null) return null
      return { kind: 'deny', reason: buildToolDenialMessage({ rules: entry.rules, hit }) }
    }

    if (entry.error !== null && entry.rules === null) {
      if (options.onRuleError !== 'closed') return null
      return { kind: 'deny', reason: ruleErrorMessage(entry) }
    }
    if (entry.rules === null) return null

    let facts
    try {
      facts = await daemon.parse(command)
    } catch (error) {
      ctx.logger?.error?.(`ast-guard: 解析器不可用：${error.message}`)
      if (options.failPolicy !== 'closed') return null
      return { kind: 'deny', reason: unavailableMessage(error, entry.file) }
    }
    if (facts.fatal !== undefined) {
      ctx.logger?.error?.(`ast-guard: 解析失败：${facts.fatal}`)
      if (options.failPolicy !== 'closed') return null
      return { kind: 'deny', reason: unavailableMessage(new Error(facts.fatal), entry.file) }
    }

    // 顺序是刻意的：**彻底拒绝优先于三思**。
    // 一条命令里既有"没有正当用途的写法"又有"贵但正当的写法"时，直接拒 —— 三思是给后者的。
    const hit = evaluate(entry.rules, facts)
    if (hit !== null) {
      return { kind: 'deny', reason: buildDenialMessage({ rules: entry.rules, hit, facts, command }) }
    }

    const sessionId = String(exec?.agent?.session?.header?.id ?? cwd)
    const verdict = desk.check({ sessionId, command, facts, rules: entry.rules })
    if (verdict === null) return null
    if (verdict.action === 'allow-once') {
      ctx.logger?.info?.(`ast-guard: 三思一次性放行（${verdict.ruleId}）`)
      return null
    }
    // 2026-10-10：进冷却**之前**先跑规则里声明的只读探针。
    // 窗口里没有「要丢什么」的清单，加多少条规则都拦不住"回退范围扩张"那类事 ——
    // 因为决定要不要停的信息不在命令文本里（`git checkout -- .` 看起来完全无害），
    // 在**工作区状态**里（`?? src/lab/` = 644 行从未提交，reflog 救不回）。
    const evidence = await collectEvidence({
      probes: verdict.pending.rule.evidence,
      cwds: evidenceCwds(cwd, facts),
    })

    return {
      kind: 'deny',
      reason: buildDeliberateMessage({
        rules: entry.rules,
        rule: verdict.pending.rule,
        hits: verdict.pending.hits,
        facts,
        evidence,
        cooldownSeconds: verdict.pending.rule.cooldownSeconds,
        pendingId: verdict.pending.id,
      }),
    }
  }
}

function registerConfirmTool(ctx, desk) {
  ctx.tools.register({
    name: 'ast_confirm',
    description: [
      'Answer the ast-guard deliberation prompt for a command that was held for a cooling-off period.',
      'You MUST pass the id shown in that prompt: a bare "yes" is rejected, so that a confirmation can',
      'never land on a command you have forgotten about. During the window EVERY answer is rejected —',
      'yes and no alike — and the call comes back with the seconds still left, so you can keep re-reading',
      'the syntax tree. Only an answer given after the window is accepted.',
      'A "yes" is one-shot, bound to that exact command, and expires if unused.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: {
          type: 'string',
          description: 'The pending id shown in the deliberation prompt. Required — a confirmation without it is rejected.',
        },
        decision: {
          type: 'string',
          enum: ['yes', 'no'],
          description: 'yes = allow this one execution; no = give it up.',
        },
        command: {
          type: 'string',
          description: 'Optional. The exact command you are confirming; when given it must match the held command.',
        },
      },
      required: ['id', 'decision'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean' },
          reason: { type: 'string' },
          remainingSeconds: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['accepted', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args = {}, exec) {
      const sessionId = String(exec?.agent?.session?.header?.id ?? '')
      const result = desk.confirm({
        sessionId,
        id: args.id,
        decision: args.decision,
        command: typeof args.command === 'string' ? args.command : undefined,
      })

      if (result.ok) {
        if (result.decision === 'no') return { accepted: true, reason: 'no', message: result.message }
        return {
          accepted: true,
          reason: 'yes',
          message: [
            `确认已接受（编号 ${result.id}）。这条命令的一次性放行已生效。`,
            `用掉或过期即作废，不会留到下一次。`,
            '',
            '你批准的是下面这一条 —— 再读一遍，确认它确实是你想的那个：',
            ...result.command.split('\n').map((line) => `  ${line}`),
            '',
            '现在可以重新执行它了。',
            '（放行只针对这一条命令本身 —— 不要把它当成"类似的事也可以做"。）',
          ].join('\n'),
        }
      }

      if (result.reason === 'too-early') {
        const lines = [
          `回答无效：冷却期还没结束，还剩 ${result.remainingSeconds} 秒。`,
          '这段时间里回答"是"和回答"否"一样都无效 —— 这是故意的。',
          `（这一条的编号是 ${result.pending.id}。）`,
          '',
          '待确认的命令：',
          ...result.pending.command.split('\n').map((line) => `  ${line}`),
          '',
          '语法树看到的：',
          ...result.pending.hits.slice(0, 4).flatMap((hit) => [
            `  - 命令：${hit.command}`,
            ...hit.reasons.slice(0, 2).map((reason) => `    触发原因：${reason}`),
          ]),
          '',
          '再拿那两个问题过一遍，别只往"别做"一个方向想：',
          '  ① 必要性 —— 这件事非做不可吗？不做会怎样？有没有更便宜的做法？',
          '  ② 安全性 —— 目标和范围对不对？会不会连累不该碰的东西？出错能不能回退？',
          '（确认有必要且安全，就在到点后确认执行 —— 那是正常路径。）',
          '（别为了绕开这段等待去换个写法做同一件事 —— 那同样是绕道。）',
          '（到时间后再调用一次 ast_confirm。）',
        ]
        return {
          accepted: false,
          reason: 'too-early',
          remainingSeconds: result.remainingSeconds,
          message: lines.join('\n'),
        }
      }

      return { accepted: false, reason: result.reason, message: result.message }
    },
  })
}

function ruleErrorMessage(entry) {
  return [
    '[ast-guard] 拒绝：AST 规则文件读不了',
    '',
    `文件：${entry.file}`,
    `错误：${entry.error}`,
    '',
    '为什么读不了就拒绝，而不是放行：规则写坏时静默放行是这套系统里最危险的失效模式 ——',
    '文本层就栽在这上面（watcher 吞掉编译错误，只留一份宿主日志，谁也看不见）。',
    '',
    '修法：用 edit 工具改这个文件。edit / write 不受本层影响，不会被一起挡住。',
    '改好之后下一条命令就会用上新规则（按 mtime 热生效，不用重启）。',
  ].join('\n')
}

function unavailableMessage(error, file) {
  return [
    '[ast-guard] 拒绝：语法树解析器不可用',
    '',
    `原因：${error.message}`,
    `规则文件：${file}`,
    `当前 failPolicy = closed（解析器不可用时拒绝）`,
    '',
    '为什么不可用也拒绝：文本层有已知盲区（引号里以 \\ 结尾会让分词器错位、多行命令的 glob 不跨行、',
    '写动词当参数交给启动器时看不见）。这一层挡不住的东西，那些盲区也挡不住 —— 放行等于没装。',
    '',
    '解析器是随宿主启动的常驻 PowerShell 进程；它连续重启失败会进入降温，不再反复拉起。',
    '要临时放行：把插件配置里的 failPolicy 改成 open（改完需重启宿主）；',
    '或者改用 edit / write / Copy-Item 完成任务 —— 它们不经过本层。',
  ].join('\n')
}
