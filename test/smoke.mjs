// 冒烟测试 —— **全程 dry-run**：只判"裁决"，不执行任何被测命令。
//
// 三件事：① 编译 rules/default.yaml（走真的编译链）② 喂命令文本给常驻解析器（只解析，不执行）
// ③ 断言裁决结果。不联网、不需要 git、不写任何文件。
//
// 用法：node test/smoke.mjs      （或 npm test）
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RULES = path.join(here, '..', 'rules', 'default.yaml')

const { AstDaemon } = await import('../lib/daemon.js')
const { parseRulesFile, evaluate, evaluateToolParams } = await import('../lib/rules.js')
const { DeliberateDesk } = await import('../lib/deliberate.js')

let bad = 0
function check(label, want, got) {
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? '  ✅' : '  ❌'} 期望=${String(want ?? 'pass').padEnd(22)} 实际=${String(got ?? 'pass').padEnd(22)} ${label}`)
}

const rules = await parseRulesFile(RULES)
console.log(`规则已编译：deny ${rules.deny.length} 条 · deliberate ${rules.deliberate.length} 条`)

const daemon = new AstDaemon({
  timeoutMs: 15000,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
})
await daemon.start()

// ── ① 写文件内容（这套东西的重点交付物）────────────────────────────────────
const writeCases = [
  ['命令词 Set-Content', 'Set-Content -Path x.txt -Value y', 'content-write'],
  ['别名 sc', 'sc -Path x.txt -Value y', 'content-write'],
  ['别名 tee', 'Get-Date | tee x.txt', 'content-write'],
  ['重定向 >', 'Get-ChildItem . > out.txt', 'content-write'],
  ['.NET 直写', '[IO.File]::WriteAllText("x.txt","y")', 'content-write'],
  ['读文件（放行）', 'Get-Content x.txt -TotalCount 3', null],
  ['流合并 2>&1（放行）', 'node x.mjs 2>&1', null],
]

// ── ② 内联代码 ────────────────────────────────────────────────────────────
const inlineCases = [
  ['node -e', 'node -e "console.log(1)"', 'inline-code-node'],
  ['node -p', 'node -p "process.version"', 'inline-code-node'],
  ['node 跑脚本（放行）', 'node tool.mjs', null],
  ['node -c 语法检查（放行 —— 与 python -c 含义不同）', 'node -c tool.mjs', null],
  ['python -c', 'python -c "print(1)"', 'inline-code-interp'],
  ['powershell -Command', 'powershell -NoProfile -Command "Get-Date"', 'inline-code-interp'],
  // 字符串里的写命令（语法树看不见内层代码，只按参数子串兜一层）
  ['iex 里藏写命令', 'iex "Set-Content -Path x.txt -Value y"', 'encoded-write'],
  ['iex 只读（放行）', 'iex "Get-Date"', null],
  ['python -m（放行）', 'python -m http.server 8000', null],
]

// ── ③ 受保护目录 ──────────────────────────────────────────────────────────
const pathCases = [
  ['删 node_modules', 'Remove-Item .\\node_modules\\x -Force', 'protected-path'],
  ['删 .git 下的东西', 'Remove-Item .\\\.git\\hooks\\x', 'protected-path'],
  ['读 node_modules（放行）', 'Get-ChildItem .\\node_modules', null],
]

// ── ④ 三思层（只断言"停在哪条规则上"，不确认、不等冷却）──────────────────
const desk = new DeliberateDesk()
const deliberateCases = [
  ['递归删除', 'Remove-Item .\\src\\a -Recurse', 'destructive-delete'],
  ['删受保护目录', 'Remove-Item .\\node_modules -Force', 'destructive-delete'],
  ['移动覆盖', 'Move-Item .\\a.txt .\\src\\a.txt -Force', 'destructive-move'],
  ['注册表改键（cmdlet 那条）', "New-ItemProperty -Path 'HKCU:\\Software\\X' -Name a -Value b", 'registry-write-cmdlet'],
  ['注册表改键（reg 那条）', 'reg add HKCU\\Software\\X /v a /d b /f', 'registry-write'],
  ['读注册表（放行）', "reg query HKCU\\Software\\X", null],
  ['git 范围收缩', 'git checkout -- .', 'destructive-git'],
  ['git 建分支（放行）', 'git checkout -b feature-x', null],
]

// ── ⑤ 工具参数（不经过 shell）─────────────────────────────────────────────
const toolCases = [
  ['写凭据文件', 'write', { file_path: '.npmrc', content: 'x' }, 'credentials-readonly'],
  ['写别的文件、正文提到凭据文件名（放行）', 'write', { file_path: 'notes.md', content: '改 .npmrc 之前先备份' }, null],
  ['读凭据文件（放行）', 'read', { file_path: '.npmrc' }, null],
]

for (const [label, command, want] of [...writeCases, ...inlineCases, ...pathCases]) {
  const facts = await daemon.parse(command)
  const hit = evaluate(rules, facts)
  check(label, want, hit === null ? null : hit.rule.id)
}
for (const [label, tool, args, want] of toolCases) {
  const hit = evaluateToolParams(rules, tool, args)
  check(label, want, hit === null ? null : hit.rule.id)
}
for (const [label, command, want] of deliberateCases) {
  const facts = await daemon.parse(command)
  const verdict = desk.check({ sessionId: 'smoke', command, facts, rules })
  check(label, want, verdict === null ? null : verdict.pending.rule.id)
}

daemon.stop()

const total = writeCases.length + inlineCases.length + pathCases.length + toolCases.length + deliberateCases.length
console.log('')
if (bad === 0) {
  console.log(`冒烟测试全部通过（${total} 条，全程 dry-run）`)
  process.exit(0)
}
console.log(`${bad} 条不符`)
process.exit(1)
