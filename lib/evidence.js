// 三思窗口的「要丢什么」—— 规则里声明的只读探针，由守卫自己跑，结果打进窗口。
//
// 为什么必须有这一层（2026-10-10 事故征候「回退范围扩张」）：
//   `git checkout -- .` 这行字**看起来完全无害**，它甚至不含路径。
//   决定"要不要停"的信息不在命令里，在**工作区状态**里 ——
//   那次是 `?? src/lab/`：两个文件、644 行、**从未提交**，而 reflog 只记 HEAD 移动过的东西，
//   对"从未提交的文件"没有任何记录，丢了就没有第二处。
//   报告 §5.3/§6.2 的结论：**加多少条规则都拦不住那次，除非窗口里带上这个清单。**
//
// 三条硬约束：
//   ① **只跑规则文件里写死的命令**，不是模型给的 —— 探针的命令文本不经过任何外部输入；
//   ② 只读、带超时、失败就如实说（不许让探针把守卫拖死，也不许假装拿到数据）；
//   ③ 数字**由命令算出来**，守卫自己不估（报告原话："不许守卫自己估"）。
import { spawn } from 'node:child_process'

const MAX_LINES_PER_PROBE = 14
const DEFAULT_TIMEOUT_MS = 2500

function runOnce(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true })
    } catch (error) {
      resolve({ ok: false, text: `没能启动：${error.message}` })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经结束了 */ }
      finish({ ok: false, text: `超过 ${timeoutMs} ms 没返回，已终止` })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => finish({ ok: false, text: `没能启动：${error.message}` }))
    child.on('close', (code) => {
      const text = (out.trim() !== '' ? out : err).trim()
      finish({ ok: code === 0, text: text === '' ? '（无输出）' : text })
    })
  })
}

/** 把探针输出算成一句账 —— 数字全部来自命令本身，守卫不加不减。 */
function accountFor(byProbe) {
  // ⚠️ 只有**真跑成功**的输出才算数：报错文本和"（无输出）"这种占位符不许混进账里 ——
  // 否则它们会被当成文件名数进去（2026-10-10 实测：账上写着"1 个未跟踪文件：（无输出）"）。
  const raw = (probe) => {
    const result = byProbe[probe]
    return result !== undefined && result.ok === true ? result.text : ''
  }
  const porcelain = raw('git status --porcelain')
  const others = raw('git ls-files --others --exclude-standard')
  const shortstat = raw('git diff --shortstat HEAD').trim()
  if (porcelain === '' && others === '' && shortstat === '') return []

  const untracked = others.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const tracked = porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('??'))
  const account = []
  if (tracked.length > 0) {
    account.push(`将丢弃 ${tracked.length} 个已跟踪文件的改动（${shortstat === '' ? '行数见上' : shortstat}）—— **可从 HEAD 恢复**`)
  }
  if (untracked.length > 0) {
    const head = untracked.slice(0, 6).join(' / ')
    account.push(`${untracked.length} 个未跟踪文件 —— **从未提交，reflog 救不回**：${head}${untracked.length > 6 ? ` …共 ${untracked.length} 个` : ''}`)
  }
  if (account.length === 0) account.push('工作区看起来是干净的：没有未提交内容会因这一下丢掉')
  return ['', '▶ 按上面探针算出来的账：', ...account.map((line) => `   ${line}`)]
}

/**
 * 跑规则里声明的探针，返回可直接塞进窗口的文本行。
 * probes：规则里的 `evidence:` 列表；cwds：会话 cwd + 命令里 `-C <路径>` 指向的仓库。
 */
export async function collectEvidence({ probes, cwds, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const lines = []
  const list = Array.isArray(probes) ? probes.filter((item) => typeof item === 'string' && item.trim() !== '') : []
  const dirs = [...new Set((cwds ?? []).filter((dir) => typeof dir === 'string' && dir.trim() !== ''))]
  if (list.length === 0 || dirs.length === 0) return lines

  for (const cwd of dirs) {
    lines.push(`── 只读探针（守卫自己跑的，工作目录 ${cwd}）`)
    const byProbe = {}
    for (const probe of list) {
      const result = await runOnce(probe, cwd, timeoutMs)
      byProbe[probe] = result
      const all = result.text.split('\n')
      for (const line of all.slice(0, MAX_LINES_PER_PROBE)) lines.push(`   ${line}`)
      // 硬截断：`git diff` 在非仓库目录里会打**整篇 usage**（几百行），不截会把窗口灌满。
      if (all.length > MAX_LINES_PER_PROBE) lines.push(`   …（这条输出还有 ${all.length - MAX_LINES_PER_PROBE} 行，为免灌满窗口已省略）`)
      if (result.ok !== true) lines.push('   （这条没跑成，下面只按拿到的算）')
    }
    lines.push(...accountFor(byProbe))
  }
  return lines
}

/**
 * 探针在哪儿跑：命令里 `-C <路径>` 指向的仓库；没有才用会话 cwd。
 * ⚠️ 有 `-C` 时**只跑那个仓库** —— 会话 cwd 多半不是 git 仓库，在那儿跑探针只会拿到
 * git 的 usage 长文（2026-10-10 实测：那一坨把窗口灌满，而真正有用的三行在另一个目录里）。
 */
export function evidenceCwds(cwd, facts) {
  const fromDashC = []
  for (const command of facts?.commands ?? []) {
    const args = Array.isArray(command.args) ? command.args.map((item) => String(item)) : []
    const at = args.indexOf('-C')
    if (at >= 0 && args[at + 1] !== undefined) fromDashC.push(args[at + 1].replace(/^["']|["']$/g, ''))
  }
  return fromDashC.length > 0 ? [...new Set(fromDashC)] : [cwd]
}
