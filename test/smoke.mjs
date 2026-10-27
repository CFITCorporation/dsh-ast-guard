// 冒烟测试 —— **全程 dry-run**：只判"裁决"，不执行任何被测命令。
//
// 它做的事只有两件：
//   ① 编译 rules/demo.yaml（走真的编译链，配置写错立刻炸）
//   ② 把一批命令文本喂给常驻解析器（**只解析，不执行**），断言裁决结果
//
// 依赖：本机有 `powershell.exe`（Windows）。不需要联网、不需要 git、不碰工作区的任何配置。
// 用法：node test/smoke.mjs      （或 npm test）
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RULES = path.join(here, '..', 'rules', 'demo.yaml')

const { AstDaemon } = await import('../lib/daemon.js')
const { parseRulesFile, evaluate, evaluateToolParams } = await import('../lib/rules.js')
const { DeliberateDesk } = await import('../lib/deliberate.js')

let bad = 0
function check(label, want, got) {
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? '  ✅' : '  ❌'} 期望=${String(want ?? 'pass').padEnd(24)} 实际=${String(got ?? 'pass').padEnd(24)} ${label}`)
}

// ── ① 编译 ────────────────────────────────────────────────────────────
const rules = await parseRulesFile(RULES)
console.log(`规则已编译：deny ${rules.deny.length} 条 · deliberate ${rules.deliberate.length} 条`)

// ── ② 语法树层（deny）───────────────────────────────────────────────
const daemon = new AstDaemon({
  timeoutMs: 15000,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
})
await daemon.start()

const denyCases = [
  ['写内容命令词', 'Set-Content -Path x.txt -Value y', 'example-write-verbs'],
  ['写内容拦截不误伤读', 'Get-Content x.txt -TotalCount 3', null],

  ['解释器 + -e', 'node -e "console.log(1)"', 'example-inline-code-node'],
  ['解释器 + -Command', 'powershell -NoProfile -Command "Get-Date"', 'example-inline-code-interp'],
  ['解释器 + -c（python）', 'python -c "print(1)"', 'example-inline-code-interp'],
  ['解释器跑脚本（放行）', 'node tool.mjs', null],
  ['node -c 语法检查（放行 —— 与 python -c 含义不同）', 'node -c tool.mjs', null],

  ['受保护路径 + 删除动词', 'Remove-Item .\\node_modules\\x -Force', 'example-protected-path'],
  ['受保护路径 + 只读（放行）', 'Get-ChildItem .\\node_modules', null],

  ['提及即停', 'Get-ChildItem .\\DO-NOT-RUN', 'example-naming-convention'],
  ['提及即停的反向用例', 'Get-ChildItem .\\normal', null],
]

for (const [label, command, want] of denyCases) {
  const facts = await daemon.parse(command)
  const hit = evaluate(rules, facts)
  check(label, want, hit === null ? null : hit.rule.id)
}

// ── ③ 工具参数层（不需要解析器）──────────────────────────────────────
const toolCases = [
  ['工具参数：路径命中', 'write', { file_path: 'CHANGELOG.md', content: 'x' }, 'example-protected-files'],
  ['工具参数：正文提到不算写', 'write', { file_path: 'notes.md', content: '改 CHANGELOG.md 之前先看它' }, null],
  ['工具参数：别的工具不动', 'read', { file_path: 'CHANGELOG.md' }, null],
]
for (const [label, tool, args, want] of toolCases) {
  const hit = evaluateToolParams(rules, tool, args)
  check(label, want, hit === null ? null : hit.rule.id)
}

// ── ④ 三思层（只断言"停在哪个规则上"，不确认、不等冷却）─────────────
const desk = new DeliberateDesk()
const deliberateCases = [
  ['三思：递归删除', 'Remove-Item .\\src\\a -Recurse', 'example-deliberate-delete'],
  ['三思：合取条件（when.all）', 'git checkout -- .', 'example-deliberate-scope'],
  ['三思：不该停的形状', 'git checkout -b feature-x', null],
]
for (const [label, command, want] of deliberateCases) {
  const facts = await daemon.parse(command)
  const verdict = desk.check({ sessionId: 'smoke', command, facts, rules })
  check(label, want, verdict === null ? null : verdict.pending.rule.id)
}

daemon.stop()

console.log('')
if (bad === 0) {
  console.log(`冒烟测试全部通过（${denyCases.length + toolCases.length + deliberateCases.length} 条，全程 dry-run）`)
  process.exit(0)
}
console.log(`${bad} 条不符`)
process.exit(1)
