// AST 规则层：读规则文件，对解析器给出的语法树事实做判定，并生成拒绝文案。
//
// 分工是刻意的：PowerShell 侧只说"事实"（有哪些命令、哪些成员调用、哪些重定向），
// 策略全在这里。换策略不用碰解析器，规则文件是唯一的策略来源。
//
// 失败一律"响"：规则文件读坏时默认拒绝并说明原因，不学文本层那种静默失效
// （那条教训写在 AGENTS.md 里：watcher 吞掉编译错误，只留一份宿主日志，谁也看不见）。
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { MIN_COOLDOWN_SECONDS, matchCondition } from './deliberate.js'

let yamlModule = null

/** 找 yaml 模块：先按常规解析，再退回 profile 的 node_modules（本地 link: 包的标准做法）。 */
export async function loadYaml(explicitPath) {
  if (yamlModule !== null) return yamlModule
  const candidates = []
  if (explicitPath) candidates.push(explicitPath)
  candidates.push(null)
  const home = process.env.DSH_HOME
  if (home) candidates.push(path.join(home, 'profiles', 'web', 'node_modules', 'yaml', 'dist', 'index.js'))

  const tried = []
  for (const candidate of candidates) {
    try {
      const mod = candidate === null ? await import('yaml') : await import(pathToFileURL(candidate).href)
      yamlModule = mod.default ?? mod
      return yamlModule
    } catch (error) {
      tried.push(`${candidate ?? 'yaml'}（${error.code ?? error.message}）`)
    }
  }
  throw new Error(`找不到 yaml 模块，试过：${tried.join(' / ')}`)
}

export async function parseRulesFile(file, options = {}) {
  const YAML = await loadYaml(options.yamlPath)
  const text = readFileSync(file, 'utf8')
  let doc
  try {
    doc = YAML.parse(text)
  } catch (error) {
    throw new Error(`YAML 解析失败：${error.message}`)
  }
  return compileRules(doc, file)
}

export function compileRules(doc, source) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('规则文件的顶层必须是映射（version / deny / deliberate）')
  }
  return {
    source,
    deny: compileSection(doc.deny, 'deny', source, compileDeny),
    deliberate: compileSection(doc.deliberate, 'deliberate', source, compileDeliberate),
  }
}

/** enabled: false 的条目整条跳过 —— 与文本层 rules.yaml 的约定一致。 */
function compileSection(raw, field, source, compile) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${field} 必须是列表`)
  return raw
    .map((entry, index) => (entry !== null && typeof entry === 'object' && entry.enabled === false ? null : compile(entry, source, index)))
    .filter((entry) => entry !== null)
}

function compileDeny(entry, source, index) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`deny[${index}] 必须是映射`)
  }
  const id = String(entry.id ?? '').trim()
  if (id === '') throw new Error(`deny[${index}] 缺 id`)

  const asSet = (value, field) => {
    if (value === undefined) return new Set()
    if (!Array.isArray(value)) throw new Error(`deny[${id}].${field} 必须是列表`)
    return new Set(value.map((item) => String(item).toLowerCase()))
  }
  const commands = asSet(entry.commands, 'commands')
  const memberNames = asSet(entry.memberNames, 'memberNames')
  const memberTargetContains = entry.memberTargetContains === undefined
    ? []
    : (Array.isArray(entry.memberTargetContains) ? entry.memberTargetContains : [entry.memberTargetContains]).map(String)
  const redirects = entry.redirects === true

  // 逐命令参数条件（2026-10-21 加）：命令名命中之后，还要看**这条命令自己的参数**。
  // 起因：`node` 的内联规则在文本层只能按"整行参数池"判 ⇒ `adb … screencap -p` 的 `-p`、
  // `gradle -p` 的 `-p` 都会把同行的 `node 脚本` 一起拖下水（两条已知误报）。
  // 语法树层知道参数属于哪条命令 ⇒ 条件只对**同一个命令节点**求值，串场不可能发生。
  // 注：条件编译复用了三思层那套（flags / wildcard / paths / subcommands / argsExact / all），
  // 报错文案里会写成 `deliberate[...]`（同一个函数），规则作者按行号定位即可。
  let when = null
  if (entry.when !== undefined && entry.when !== null) {
    when = compileCondition(entry.when, id, 'when')
  }

  // 2026-10-27（独立化 P1）：吸收文本层那三类规则 ——
  //   ① tools：非 shell 工具（edit / write…）的目标路径，例：记忆文件逻辑只读；
  //   ② paths：与 commands 做 AND —— 受保护路径上的删除/改名；
  //   ③ mentions：提及即停（目录名约定 `切勿执行` / `DO-NOT-RUN`）。
  // needle 一律**大小写不敏感**（Windows 路径本来不分大小写），但保留原样存着，便于文案展示。
  const asList = (value, field) => {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error(`deny[${id}].${field} 必须是列表`)
    return value.map((item) => String(item)).filter((item) => item !== '')
  }
  const tools = asSet(entry.tools, 'tools')
  const paths = asList(entry.paths, 'paths')
  const mentions = asList(entry.mentions, 'mentions')
  if (tools.size > 0 && paths.length === 0 && mentions.length === 0) {
    throw new Error(`deny[${id}] 配了 tools 但既没有 paths 也没有 mentions —— 那样什么都匹配不到`)
  }

  if (commands.size === 0 && memberNames.size === 0 && !redirects && when === null
      && tools.size === 0 && paths.length === 0 && mentions.length === 0) {
    throw new Error(`deny[${id}] 什么都没配（commands / memberNames / redirects / when / tools / paths / mentions 至少要有一个）`)
  }
  return {
    id,
    why: String(entry.why ?? '').trim(),
    commands,
    memberNames,
    memberTargetContains,
    redirects,
    when,
    tools,
    paths,
    mentions,
  }
}

/**
 * 非 shell 工具的规则求值（2026-10-27 · 独立化 P1）。
 * 这一支**不经过解析器**：只看工具参数里的路径与字串。
 * ⚠️ 路径 needle 只比**路径型参数**（`file_path` / `path` / `dir` …）——
 *    连 `content` 一起比的话，写一份"提到 MEMORY.md"的备忘也会被拦下（那是真误伤）。
 */
const PATH_KEY = /^(file_path|path|notebook_path|directory|dir|target|dest|destination|output)$/i

export function evaluateToolParams(rules, tool, args) {
  const lowerTool = String(tool ?? '').toLowerCase()
  const pathValues = []
  const allStrings = []
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value !== 'string' || value === '') continue
    allStrings.push({ key, value })
    if (PATH_KEY.test(key)) pathValues.push(value)
  }

  for (const rule of rules.deny) {
    if (rule.tools.size === 0 || !rule.tools.has(lowerTool)) continue

    if (rule.paths.length > 0) {
      const hit = pathValues.find((value) => rule.paths.some((needle) => value.toLowerCase().includes(needle.toLowerCase())))
      if (hit !== undefined) return { rule, evidence: [{ kind: '目标路径', text: hit }] }
    }

    for (const needle of rule.mentions) {
      const hit = allStrings.find(({ value }) => value.toLowerCase().includes(needle.toLowerCase()))
      if (hit !== undefined) {
        return { rule, evidence: [{ kind: '提及', text: `含「${needle}」（参数 ${hit.key}）：${hit.value.slice(0, 160)}` }] }
      }
    }
  }
  return null
}

/** 工具参数规则的拒绝文案：短、可读、必须带"该怎么做"。 */
export function buildToolDenialMessage({ rules, hit }) {
  return [
    `[ast-guard] 拒绝：${hit.rule.id}`,
    '',
    '命中的参数（这一条按**工具参数**判，不经过 shell）：',
    ...hit.evidence.map((item) => `  - ${item.kind}：${item.text}`),
    '',
    hit.rule.why.trim(),
    '',
    `（规则来自 ${rules.source}）`,
  ].join('\n')
}

function compileDeliberate(entry, source, index) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`deliberate[${index}] 必须是映射`)
  }
  const id = String(entry.id ?? '').trim()
  if (id === '') throw new Error(`deliberate[${index}] 缺 id`)

  if (!Array.isArray(entry.commands) || entry.commands.length === 0) {
    throw new Error(`deliberate[${id}].commands 必须是非空列表`)
  }
  const commands = new Set(entry.commands.map((item) => String(item).toLowerCase()))

  const seconds = entry.cooldownSeconds === undefined ? MIN_COOLDOWN_SECONDS : Number(entry.cooldownSeconds)
  if (!Number.isFinite(seconds) || seconds < MIN_COOLDOWN_SECONDS) {
    throw new Error(`deliberate[${id}].cooldownSeconds 必须 ≥ ${MIN_COOLDOWN_SECONDS}（用户定的下限），收到 ${entry.cooldownSeconds}`)
  }

  let when = null
  if (entry.when !== undefined && entry.when !== null) {
    if (typeof entry.when !== 'object' || Array.isArray(entry.when)) {
      throw new Error(`deliberate[${id}].when 必须是映射`)
    }
    if (entry.when.all !== undefined && entry.when.all !== null) {
      // 合取（2026-10-10 加）：列表里每组条件都要成立，组内仍是 OR。
      // 起因：`git checkout -b x`（建分支，无害）与 `git checkout -- .`（丢整棵树）
      // 只差一个参数 —— 单组条件分不开，必须相与。
      if (!Array.isArray(entry.when.all) || entry.when.all.length === 0) {
        throw new Error(`deliberate[${id}].when.all 必须是非空列表`)
      }
      when = {
        all: entry.when.all.map((item, position) => compileCondition(item, id, `all[${position}]`)),
        flags: [], wildcard: false, paths: [], subcommands: [], argsExact: [],
      }
    } else {
      when = { ...compileCondition(entry.when, id, 'when'), all: null }
    }
  }

  // 三思窗口里的「要丢什么」：只读探针。命令文本**写死在规则里**，不是模型给的。
  // 编译期拦一道：探针里出现写动词就直接拒绝 —— 探针必须是只读的。
  const evidence = Array.isArray(entry.evidence) ? entry.evidence.map((item) => String(item)) : []
  for (const probe of evidence) {
    if (/(Remove-Item|Set-Content|Add-Content|Clear-Content|Out-File|Move-Item|Rename-Item|rmdir|del\s)/i.test(probe)) {
      throw new Error(`deliberate[${id}].evidence 里有写动词，探针必须只读：${probe}`)
    }
  }

  return { id, why: String(entry.why ?? '').trim(), commands, when, cooldownSeconds: seconds, evidence }
}

/** 一组 when 条件：组内各维 OR，至少要配一维。 */
function compileCondition(raw, id, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`deliberate[${id}].${where} 必须是映射`)
  }
  const condition = {
    flags: (raw.flags ?? []).map((flag) => String(flag).toLowerCase()),
    wildcard: raw.wildcard === true,
    paths: (raw.paths ?? []).map(String),
    // 子命令：`reg add` / `git checkout` 这类**外部命令**靠第一个位置参数分。
    // 外部命令的参数形态 PowerShell 解析器认不出来（`/v`、`/f` 都不是参数），
    // 所以"第一个位置参数"正好就是它的子命令。
    subcommands: (raw.subcommands ?? []).map((item) => String(item).toLowerCase()),
    // 精确参数（2026-10-10 加）：整个参数**等于**其中之一才算命中。
    // 用来表达"目标是整棵树"这种判据 —— `git checkout -- .` 里的那个 `.`。
    // 不能用 paths 代替：paths 是**包含**匹配，会把每个带点的参数都吃进来。
    argsExact: (raw.argsExact ?? []).map(String),
    // 子串匹配（2026-10-27 加，为吸收文本层的 `iex` 规则）：参数里**含**这串就算。
    // 文本层判的是"同一行里 iex 与 set-content 都出现"（前缀通配，只能覆盖几种顺序）；
    // 语法树层能精确到"**iex 自己的那个参数里**含写动词"——顺序、引号、换行都不影响。
    argsContain: (raw.argsContain ?? []).map(String),
  }
  const empty = condition.flags.length === 0 && !condition.wildcard && condition.paths.length === 0
    && condition.subcommands.length === 0 && condition.argsExact.length === 0
    && condition.argsContain.length === 0
  if (empty) {
    throw new Error(`deliberate[${id}].${where} 什么都没配（flags / wildcard / paths / subcommands / argsExact / argsContain 至少一个）`)
  }
  return condition
}

/** 判定。返回 null = 本层无意见，调用方应交给下游。 */
export function evaluate(rules, facts) {
  for (const rule of rules.deny) {
    const evidence = collectEvidence(rule, facts)
    if (evidence.length > 0) return { action: 'deny', rule, evidence }
  }
  return null
}

function collectEvidence(rule, facts) {
  const evidence = []

  for (const command of facts.commands ?? []) {
    const name = String(command.name ?? '')
    // 命令词可能是**全路径**（`& "E:\nodejs24\node.exe" -e`）—— 只比裸名会漏掉这条路，
    // 所以连 basename 一起比一次（`copy.exe` 与 `py.exe` 不会混，比文本层的 ends-with glob 更准）。
    const named = name.toLowerCase()
    const base = named.split(/[\\/]/).pop()
    if (!rule.commands.has(named) && !rule.commands.has(base)) continue
    const args = Array.isArray(command.args) ? command.args : []

    // 配了 paths ⇒ 与命令名做 AND：受保护路径的删除/改名（2026-10-27 从文本层吸收）。
    // 读和列举不受影响 —— 只有规则里点名的**动词**才会进到这里。
    let pathsHit = null
    if (rule.paths.length > 0) {
      pathsHit = args.find((arg) => rule.paths.some((needle) => String(arg).toLowerCase().includes(needle.toLowerCase())))
      if (pathsHit === undefined) continue
    }

    // 规则的 when（若配了）只对**这条命令自己的参数**求值 —— 这正是它比文本层准的地方：
    // 别的命令的 `-p` / `-c` 不会串进来（`adb … -p` 之于 `node 脚本`、`gradle -p` 同理）。
    if (rule.when !== null && rule.when !== undefined) {
      const matched = [...new Set(matchCondition(rule.when, args))]
      if (matched.length === 0) continue
      evidence.push({ kind: '命令', text: (args.length > 0 ? args.join(' ') : name) + `（${matched.join(' / ')}）` })
      continue
    }
    evidence.push({
      kind: '命令',
      text: (args.length > 0 ? args.join(' ') : name) + (pathsHit === null ? '' : '（含受保护路径）'),
    })
  }

  // 提及即停（2026-10-27 从文本层吸收）：任何命令名或参数里出现这串字，就算 ——
  // 判据**故意不含动词**：执行类动词的名单永远差一条，而"路径名"是唯一稳定的东西。
  for (const needle of rule.mentions) {
    for (const command of facts.commands ?? []) {
      const texts = [String(command.name ?? ''), ...(Array.isArray(command.args) ? command.args : []).map(String)]
      const found = texts.find((text) => text.toLowerCase().includes(needle.toLowerCase()))
      if (found === undefined) continue
      evidence.push({ kind: '提及', text: `含「${needle}」：${found}` })
      break
    }
  }

  for (const member of facts.members ?? []) {
    const name = String(member.name ?? '')
    if (!rule.memberNames.has(name.toLowerCase())) continue
    const target = String(member.target ?? '')
    if (rule.memberTargetContains.length > 0 && !rule.memberTargetContains.some((needle) => target.includes(needle))) continue
    evidence.push({ kind: '.NET 调用', text: `${target}::${name}` })
  }

  if (rule.redirects) {
    for (const redirect of facts.redirects ?? []) {
      const target = String(redirect.target ?? '')
      if (target === '$null') continue
      evidence.push({ kind: '重定向', text: `${redirect.append === true ? '>>' : '>'} ${target}` })
    }
  }

  return evidence
}

const MAX_EVIDENCE = 10

// 实测案例（视频观看任务）：一条 pwsh 里混着"列目录 + 抽 6 帧 + 拼预览 + 删临时帧"，
// 只有最后那句 `Remove-Item "$out\_p*.png"` 命中通配 —— 结果**整条都没跑**，前面几步全白干，
// 智能体得从头重做。它自己看出来了（"Also the whole command was blocked, so nothing ran"），
// 但不该指望每次都看得出来。这句话直接说给它听，同时教它怎么组织命令。
const WHOLE_CALL_BLOCKED = [
  '整条命令都不会执行 —— 包括里面那些本身无害的步骤（列目录、抽帧、构建……都算）。',
  '所以要重做时，把有风险的那一步单独发一次，别和别的步骤混在同一次调用里。',
].join('\n')

// 「不要绕道」这段话是必须写在文案里的。理由：名单永远列不全（动态调用、启动器参数、
// 换语言换 API 都够不着），能兜住"换个写法做同样的事"的只有这段文字 ——
// 而这正是工作区验证过唯一生效的通道：对已经在跑任务的智能体，生效的只有〔错误/拒绝〕和〔内容本身〕。
const NO_WORKAROUND_DENY = [
  '【不要绕道】被拦的意思是"这件事不该这么做"，不是"这条路走不通、换一条"。',
  '不要改用别的写法去达成同样的事 —— 换语言、换 API、换命令都算',
  '（比如 python 的 os.remove / open(..., "w")、cmd 的 del 与重定向、.NET 的文件方法）。',
  '同样的事、同样的危害，换个写法一样是危害；而且绕过去的那些写法本层多半看不见 —— 那正是要避免的。',
].join('\n')

// 三思不是拒绝 —— 等一会儿就允许执行。所以这里要挡的是另一件事：
// **嫌等冷却麻烦，于是改道去做同一件事**。那是三思最容易诱发的绕道。
const NO_WORKAROUND_DELIBERATE = [
  '【不要绕道】如果你只是嫌"要等冷却"麻烦，不要改用别的写法去达成同一件事 ——',
  '换语言、换 API、换命令都算。想执行，就按上面的流程确认；不想执行，就放弃它。',
].join('\n')

export function buildDenialMessage({ rules, hit, facts, command }) {
  const lines = []
  lines.push(`[ast-guard] 拒绝：${hit.rule.id}`)
  lines.push('')
  lines.push('语法树看到的（来自 PowerShell 自带解析器，不是文本匹配 —— 引号、换行、参数位置都不影响它）：')
  for (const item of hit.evidence.slice(0, MAX_EVIDENCE)) lines.push(`  - ${item.kind}：${item.text}`)
  if (hit.evidence.length > MAX_EVIDENCE) lines.push(`  - 另有 ${hit.evidence.length - MAX_EVIDENCE} 处同类命中`)
  lines.push('')
  lines.push(WHOLE_CALL_BLOCKED)

  const dynamic = Number(facts.dynamic ?? 0)
  if (dynamic > 0) {
    lines.push('')
    lines.push(`[注意] 这条命令里有 ${dynamic} 处动态调用（\`& $var\` 一类），语法树看不见它要跑什么：`)
    for (const text of (facts.dynamicTexts ?? []).slice(0, 3)) lines.push(`  - ${text}`)
    lines.push('  解析器也不确定的部分，按本意自己核对一遍。')
  }

  if (hit.rule.why !== '') {
    lines.push('')
    lines.push(hit.rule.why)
  }
  lines.push('')
  lines.push(NO_WORKAROUND_DENY)
  lines.push('')
  lines.push(`（规则来自 ${rules.source}；这条不是文本匹配的误报，是语法树里真的有这个节点。）`)
  return lines.join('\n')
}

export function buildDeliberateMessage({ rules, rule, hits, facts, evidence, cooldownSeconds, pendingId }) {
  const lines = []
  lines.push(`[ast-guard] 三思：${rule.id}`)
  lines.push('')
  lines.push('语法树看到的（来自 PowerShell 自带解析器，不是文本匹配）：')
  for (const hit of hits.slice(0, 6)) {
    lines.push(`  - 命令：${hit.command}`)
    for (const reason of hit.reasons.slice(0, 3)) lines.push(`    触发原因：${reason}`)
  }
  if (hits.length > 6) lines.push(`  - 另有 ${hits.length - 6} 处同类命中`)

  // 「这条命令会丢什么」—— 守卫自己跑的只读探针现场产出（2026-10-10 加，起因见 evidence.js）。
  // 放在最前面：它是决定"要不要确认"的**唯一材料** —— 命令文本本身看不出这件事。
  if (Array.isArray(evidence) && evidence.length > 0) {
    lines.push('')
    lines.push('**这条命令会丢什么** —— 下面由只读探针**现跑**，数字来自命令本身，不是守卫估的：')
    lines.push(...evidence)
  }

  lines.push('')
  lines.push(WHOLE_CALL_BLOCKED)

  const dynamic = Number(facts.dynamic ?? 0)
  if (dynamic > 0) {
    lines.push('')
    lines.push(`[注意] 这条命令里有 ${dynamic} 处动态调用（\`& $var\` 一类），语法树看不见它要跑什么：`)
    for (const text of (facts.dynamicTexts ?? []).slice(0, 3)) lines.push(`  - ${text}`)
    lines.push('  解析器也不确定的部分，按本意自己核对一遍。')
  }

  lines.push('')
  lines.push('**这不是拒绝。** 拒绝的写法在拒绝模式里，那些会直接不让你执行；')
  lines.push('这一档的意思是：**这条命令有正当用途、但代价高，所以先停下来认真看一眼。**')
  lines.push('')
  lines.push('要判断的是两件事，缺一不可 —— 别只往一个方向想：')
  lines.push('  1. **必要性**：这件事非做不可吗？不做会怎样？是不是真有更便宜的做法（备份、挪走、换个工具）？')
  lines.push('  2. **安全性**：目标和范围对不对？会不会连累不该碰的东西？出错能不能回退？')
  lines.push('')
  lines.push('两种回答都是正常的，**别把"放弃"当默认答案**：')
  lines.push('  - 确认有必要、也确认安全 → 冷却结束后确认，然后执行它。**这是正常路径，不是闯关。**')
  lines.push('  - 发现没必要 / 不安全 / 有更便宜的做法 → 放弃，或者换个做法。那是真的换对了，不是被迫绕道。')
  lines.push('')
  lines.push('两条出口的代价都不高，**别单纯为了"省手续"去走第三条路**：')
  lines.push('  该做 → 走确认（代价就是等一次冷却 + 一句确认）；不该做 → 放弃。')
  lines.push('  真要换做法，先问自己一句：**新做法是真的更安全 / 更便宜，还是只是绕开了这一步？**')
  lines.push('')
  lines.push(`冷却期 ${cooldownSeconds} 秒：这段时间内你的任何回答都无效 —— 回答"是"也一样。`)
  lines.push('窗口内回答会被拒，并告诉你还剩几秒。')
  lines.push('这段时间就拿上面那两个问题过一遍，别急着答。')
  lines.push('')
  lines.push('冷却结束后用 ast_confirm 工具回答 —— **必须带上下面这个编号**：')
  lines.push(`  待确认编号：${pendingId}`)
  lines.push(`  ast_confirm({ id: "${pendingId}", decision: "yes" })  —— 确认「有必要且安全」，放行这一次（一次性，绑定到这条命令）`)
  lines.push(`  ast_confirm({ id: "${pendingId}", decision: "no" })   —— 放弃，不做它`)
  lines.push('不带编号的"是"一律无效。这条待确认项 2 分钟不处理会自动作废（防"忘了之后顺手确认"），')
  lines.push('届时把命令重发一次即可重新走冷却。')

  if (rule.why !== '') {
    lines.push('')
    lines.push(rule.why)
  }
  lines.push('')
  lines.push(NO_WORKAROUND_DELIBERATE)
  lines.push('')
  lines.push(`（规则来自 ${rules.source}；按效应触发，不是按命令名。）`)
  return lines.join('\n')
}
