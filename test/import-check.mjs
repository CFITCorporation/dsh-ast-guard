// 装载自检：只 import 插件的入口模块，**不启动**、不注册钩子。
// 目的：在动 profile 配置之前，先确认"这个包能不能被 require 进来"——
// 缺文件、写错路径、语法错误，都会在这一步炸，而不是等重启之后才发现守卫没装上。
//
// 用法：node test/import-check.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, '..', 'lib', 'index.js')

let mod
try {
  mod = await import(new URL(`file://${entry.replaceAll('\\', '/')}`))
} catch (error) {
  console.error('✗ 入口模块 import 失败：' + error.message)
  process.exit(1)
}

const problems = []
if (typeof mod.apply !== 'function') problems.push('没有导出 apply(ctx, config)')
if (typeof mod.name !== 'string' || mod.name === '') problems.push('没有导出 name')
if (!Array.isArray(mod.inject)) problems.push('没有导出 inject（数组）')

if (problems.length > 0) {
  console.error('✗ 入口导出不对：\n  - ' + problems.join('\n  - '))
  process.exit(1)
}

console.log(`✓ 入口可装载：name=${mod.name}  inject=[${mod.inject.join(', ')}]`)
process.exit(0)
