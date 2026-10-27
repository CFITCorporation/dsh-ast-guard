# dsh-ast-guard（开源）

> 2026-10-27 建目录。**移植还没开始** —— 这里目前只是一个空容器（`git init` 已做）。

## 这是什么

一个 **Windows / PowerShell** 的命令守卫插件：把 pwsh 命令交给 **PowerShell 自带的语法树解析器**判定，
按**效应**而不是命令名触发；规则放在独立文件里（`<工作区>/.dsh/ast-rules.yaml`），代码不硬编码策略。

相对"纯文本匹配"的守卫，它多出来的能力是：**逐命令看参数**（`when: { flags, subcommands, argsExact, argsContain, all }`）、
**受保护路径**、**提及即停**、**工具参数规则**（`edit`/`write` 的目标路径）、以及**三思层**
（冷却窗口 + 一次性放行 + 进窗口前跑只读探针报"这条命令会丢什么"）。

## 现状（诚实版）

- 源码还在工作区里：`workspace\2026-09-22\ast-guard-plugin\dsh-ast-guard\` —— **尚未移植**；
- 移植前置：**先去硬编码**（见工作区 `2026-10-27\命令审查组件-开源素材清单.md` §4.8）；
- 测试隔离按 §4.9 三步：物理隔离（本仓库就在 workspace 之外）/ 每个用例 `mkdtemp` / runner 启动时若 cwd 落在 workspace 下就**拒跑**。

## 目录名说明

目录叫 `dsh-ast-guard开源` 是方便在本机一眼辨认；**包名与仓库名仍用 ASCII 的 `dsh-ast-guard`**
（npm 包名不支持中文，`.cmd` 脚本里出现非 ASCII 还会炸 —— 这个坑工作区里踩过）。

## 边界（会写进正式 README）

- 只接 `pwsh` / `powershell`；**bash 不在范围内**（规则层很简单，欢迎按目标 shell 自行移植）。
- 护的是"**忘了那一次**"，不防"故意绕"—— 对故意的靠回退点与审计，不靠墙。
- 看不见**字符串里**的东西（`Start-Process … -ArgumentList`、`[scriptblock]::Create("…")`、`cmd /c "…"`）。
