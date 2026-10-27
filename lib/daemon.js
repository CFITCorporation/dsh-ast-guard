// 常驻 PowerShell 解析器的客户端：启动、握手、请求、超时、崩溃后重启。
//
// 为什么常驻：实测每命令起一个解释器要 1,130 ms，常驻后每命令 0.8 ms。
// 进程活着就用，死了就按需重启；重启失败达到上限就进入降温，避免刷屏式重启。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCRIPT = path.join(HERE, 'ast-daemon.ps1')

export class AstDaemon {
  constructor(options = {}) {
    this.script = options.script ?? DEFAULT_SCRIPT
    this.powershell = options.powershell ?? 'powershell.exe'
    this.timeoutMs = options.timeoutMs ?? 5000
    this.maxRestarts = options.maxRestarts ?? 3
    this.restartCooldownMs = options.restartCooldownMs ?? 30000
    this.logger = options.logger ?? null

    this.child = null
    this.readyPromise = null
    this.pending = new Map()
    this.buffer = ''
    this.seq = 0
    this.restarts = 0
    this.stopped = false
    this.lastFailure = null
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  start() {
    if (this.running) return this.readyPromise
    if (this.stopped) return Promise.reject(new Error('daemon 已关闭'))

    this.buffer = ''
    const child = spawn(this.powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') this.logger?.warn?.(`ast-guard: 解析器 stderr：${text.slice(0, 400)}`)
    })
    child.on('error', (error) => this.#onExit(child, error))
    child.on('exit', (code) => this.#onExit(child, new Error(`解析器进程退出（code ${code}）`)))

    // 三道保险，任何一条路径退出都不能把这孩子留成孤儿 ——
    // 它一旦继承着宿主的管道句柄活下来，调用方会一直等那个句柄关闭。
    if (this.exitHook === undefined) {
      this.exitHook = () => { try { this.child?.kill() } catch { /* 已经没了 */ } }
      process.once('exit', this.exitHook)
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      setTimeout(() => reject(new Error('解析器启动超时')), Math.max(this.timeoutMs, 10000)).unref?.()
    })
    return this.readyPromise
  }

  #onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue

      let message
      try { message = JSON.parse(line) } catch {
        // 解析不了的行 = 响应被换行截断了，或解析器吐了别的东西。丢掉会变成静默超时，所以必须喊。
        this.logger?.warn?.(`ast-guard: 解析器输出无法解析（前 200 字符）：${line.slice(0, 200)}`)
        continue
      }

      if (message.ready === true) {
        this.restarts = 0
        this.readyResolve?.()
        continue
      }
      const entry = this.pending.get(message.id)
      if (entry === undefined) continue
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.resolve(message)
    }
  }

  #onExit(child, error) {
    // 迟到的通知：老进程退出时新进程可能已经起来了。不认这一条，
    // 否则会把新进程的引用清成 null 并误拒它的就绪承诺（实测就栽在这）。
    if (child !== undefined && child !== this.child) return
    this.lastFailure = error
    this.logger?.warn?.(`ast-guard: ${error.message}`)
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    this.readyReject?.(error)
    this.readyResolve = undefined
    this.readyReject = undefined
    this.readyPromise = null
    this.child = null
  }

  async parse(command) {
    return this.#send({ command })
  }

  /**
   * 别名对账：问 PowerShell 自己"这名字是什么、别名指向谁"。
   * 规则文件里的别名表必须和这个结果一致 —— 2026-09-22 凭记忆写漏过 ri / rm，
   * 所以把它变成可以自动核对的东西，而不是靠谁记得。
   */
  async recon(names, aliasesOf = []) {
    return this.#send({ recon: { names, aliasesOf } })
  }

  async #send(payload) {
    if (this.stopped) throw new Error('daemon 已关闭')
    if (!this.running) {
      if (this.restarts >= this.maxRestarts) {
        throw new Error(`解析器重启次数超过上限（${this.maxRestarts}），暂停使用`)
      }
      this.restarts += 1
      await this.start()
    } else if (this.readyPromise !== null) {
      await this.readyPromise
    }

    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 一条请求卡住 = 后面全部排队，守卫会因此把所有 pwsh 都拒掉。
        // 所以直接把这个进程判死：exit 会拒掉其余在途请求，下次调用重新拉起。
        try { this.child?.kill() } catch { /* 已经没了 */ }
        reject(new Error(`解析请求超时（${this.timeoutMs} ms）；该进程已判死，下次调用会重启`))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
    })
  }

  stop() {
    this.stopped = true
    if (this.child !== null) {
      try { this.child.stdin.end() } catch { /* 进程可能已经没了 */ }
      try { this.child.kill() } catch { /* 同上 */ }
    }
    this.child = null
  }
}

// 进程级单例。解析器是**无状态**的（一问一答，按 id 配对），所以跨插件实例共享完全安全。
//
// 为什么必须共享（2026-09-23 实测）：宿主会**反复调用 apply()**，每次新建一个 AstDaemon
// —— 结果是同一个宿主底下挂着两个 powershell 进程（一个漏着不释放，另一个每次重建），
// 而且每次重建都要付一次约 700 ms 的进程启动。做成单例之后不管上层怎么反复 apply，
// 都是一个进程。
//
// ⚠️ 共享的东西**不能由某个实例的 dispose 关掉** —— 那会把别人的解析器一起弄没。
// 所以这里只在进程退出时收尾，不提供 stop()。
let shared = null

export function sharedDaemon(options = {}) {
  if (shared === null) {
    shared = new AstDaemon(options)
    process.once('exit', () => {
      try { shared?.stop() } catch { /* 可能已经在关了 */ }
    })
  }
  return shared
}
