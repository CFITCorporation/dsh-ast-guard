// 插件级集成测试：走**真的 apply()**（假 ctx），而不是直接调 evaluate()。
//
// 为什么需要它：smoke.mjs 只验"裁决引擎"—— 它直接调 evaluate()，绕过了插件的真正入口：
//   apply() → ctx.on('tools/pre-execute') → check(exec)
// 那一层会漏掉的东西：规则文件的加载与 mtime 缓存、非 shell 分支、规则读坏时的 fail-closed、
// 拒绝文案的组装、三思窗口的生成、钩子与工具的注册。
//
// 仍然**不启动宿主、不注册真实钩子**（假 ctx 只把注册记下来），也**不执行任何被测命令**。
//
// 用法：node test/hook.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RULES = path.join(here, '..', 'rules', 'default.yaml')
const entry = new URL(`file://${path.join(here, '..', 'lib', 'index.js').replaceAll('\\', '/')}`)
const mod = await import(entry)

let bad = 0
function check(label, want, got) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`${ok ? '  ✅' : '  ❌'} 期望=${JSON.stringify(want).padEnd(18)} 实际=${JSON.stringify(got).padEnd(18)} ${label}`)
}

// ── 假 ctx：只记录注册，不接事件总线 ─────────────────────────────────────
function makeCtx() {
  const captured = { hooks: new Map(), tools: [] }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on(event, handler) { captured.hooks.set(event, handler) },
    tools: { register(tool) { captured.tools.push(tool) } },
  }
  return { ctx, captured }
}

const { ctx, captured } = makeCtx()
mod.apply(ctx, { rulesFile: RULES, timeoutMs: 15000 })

const hook = captured.hooks.get('tools/pre-execute')
check('注册了 tools/pre-execute', 'function', typeof hook)
check('注册了 ast_confirm', true, captured.tools.some((tool) => tool.name === 'ast_confirm'))

// 假 exec：形状照宿主给的那份（name / arguments / agent.session.header.cwd）
const exec = (name, args) => ({
  name,
  arguments: args,
  agent: { session: { header: { cwd: here, id: 'hook-test' } } },
})
const next = async () => ({ kind: 'allow' })
const decide = async (name, args) => hook(exec(name, args), next)

// ① shell + 写内容 ⇒ 拒，且文案里带规则 id（证明走到 buildDenialMessage）
const d1 = await decide('pwsh', { command: 'Set-Content -Path x.txt -Value y' })
check('Set-Content ⇒ kind', 'deny', d1 && d1.kind)
check('Set-Content ⇒ 文案带 id', true, String(d1 && d1.reason).includes('content-write'))

// ② shell + 只读 ⇒ 交给下游（本层返回 next() 的结果）
const d2 = await decide('pwsh', { command: 'Get-Content x.txt -TotalCount 3' })
check('只读 ⇒ 下游', 'allow', d2 && d2.kind)

// ③ 非 shell 分支：写凭据文件 ⇒ 拒（这一支不经过解析器）
const d3 = await decide('write', { file_path: '.npmrc', content: 'x' })
check('write .npmrc ⇒ kind', 'deny', d3 && d3.kind)
check('write .npmrc ⇒ 文案带 id', true, String(d3 && d3.reason).includes('credentials-readonly'))

// ④ 非 shell + 正文提到凭据文件名 ⇒ 放行（只比路径参数）
const d4 = await decide('write', { file_path: 'notes.md', content: '改 .npmrc 之前先备份' })
check('正文提到 ⇒ 下游', 'allow', d4 && d4.kind)

// ⑤ 三思：递归删除 ⇒ 拒，且文案是"冷却窗口"那一套（不是直接拒绝）
const d5 = await decide('pwsh', { command: 'Remove-Item .\\src\\a -Recurse' })
check('递归删除 ⇒ kind', 'deny', d5 && d5.kind)
check('递归删除 ⇒ 冷却窗口文案', true, String(d5 && d5.reason).includes('冷却'))

// ⑥ 规则文件读坏 ⇒ fail-closed（拒绝并说明怎么修），不是静默放行
const brokenDir = mkdtempSync(path.join(tmpdir(), 'ast-guard-broken-'))
const broken = path.join(brokenDir, 'rules.yaml')
writeFileSync(broken, 'deny:\n  - id: [这不是合法的规则结构\n', 'utf8')
const second = makeCtx()
mod.apply(second.ctx, { rulesFile: broken, timeoutMs: 15000 })
const hook2 = second.captured.hooks.get('tools/pre-execute')
const d6 = await hook2(exec('pwsh', { command: 'Get-ChildItem .' }), next)
check('规则读坏 ⇒ kind', 'deny', d6 && d6.kind)
check('规则读坏 ⇒ 说明怎么修', true, String(d6 && d6.reason).includes('规则'))

console.log('')
const total = 12
if (bad === 0) {
  console.log(`插件级集成测试全部通过（${total} 条；走真的 apply()，假 ctx，不执行任何命令）`)
  process.exit(0)
}
console.log(`${bad} 条不符`)
process.exit(1)
