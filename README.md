# dsh-ast-guard

> 一个 **Windows / PowerShell** 的命令守卫插件（DSH 插件）：把 `pwsh` / `powershell` 命令交给
> **PowerShell 自带的语法树解析器**判定，按**效应**而不是命令名触发；
> 规则放在独立文件里（`<工作区>/.dsh/ast-rules.yaml`），**代码里不写死任何策略**。

## 现在能跑什么（已移植的部分）

```powershell
cd dsh-ast-guard开源
node test/smoke.mjs      # 冒烟测试：17 条，全程 dry-run，不联网、不需要 git、不碰任何工作区配置
```

- **规则词表**：`commands` · `memberNames` · `redirects` ·
  `when{ flags, wildcard, paths, subcommands, argsExact, argsContain, all }` ·
  `tools` · `paths` · `mentions` · `evidence`
- **三思层**：冷却窗口 + 一次性放行（绑命令哈希）+ 进窗口前跑**只读探针**报"这条命令会丢什么"
- **示例规则**：`rules/demo.yaml` —— 每个维度各演示一次，**不是**推荐配置

## 安装（还没发包，先本地挂）

1. 把本目录放到任意位置，用 `link:` 或 `dsh plugin add <本目录>` 挂进 profile；
2. 包自带 `cordis.patch.yml` ⇒ 装上会**自动注入配置**，不需要手改 profile；
3. 把 `rules/demo.yaml` 复制成 `<你的工作区>/.dsh/ast-rules.yaml`，再按自己的情况改。

`rulesFile` 默认按**会话 cwd** 解析（`<cwd>/.dsh/ast-rules.yaml`）；写绝对路径也行。

## 边界（别误当成安全边界）

- 只接 `pwsh` / `powershell`；**bash 不在范围内** —— 规则层很简单，欢迎按目标 shell 自行移植。
- 护的是"**忘了那一次**"，不防"故意绕"：对故意的，靠回退点与审计，不靠墙。
- 看不见**字符串里**的东西（`Start-Process … -ArgumentList`、`[scriptblock]::Create("…")`、`cmd /c "…"`）。
- 覆盖面是**正面清单**，列不完；只读列举受保护目录**也会被拦**（"提及即停"的已知代价）。

## 目录名说明

本机目录叫 `dsh-ast-guard开源` 只为一眼辨认；**包名与仓库名是 ASCII 的 `dsh-ast-guard`**
（npm 包名不支持中文，`.cmd` 里出现非 ASCII 还会炸 —— 踩过）。


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
