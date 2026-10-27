# dsh-ast-guard

> 一个 **Windows / PowerShell** 的命令守卫插件（DSH 插件）：把 `pwsh` / `powershell` 命令交给
> **PowerShell 自带的语法树解析器**判定，按**效应**而不是命令名触发。
> 规则写在 YAML 里，**代码里不写死任何策略**；默认带上包内的一份 `rules/default.yaml`。

## 它比"文本匹配"多什么

- **逐命令看参数**：`when: { flags, wildcard, paths, subcommands, argsExact, argsContain, all }`
  —— `adb … -p` 里的 `-p` 不会被当成 `node -p`（这是文本匹配做不到的）；
- **受保护路径**（命令名 AND 路径）；**提及即停**（名字出现就停，不列动词）；
- **工具参数规则**：`edit` / `write` 的目标路径 —— 不经过 shell，只看路径型参数，**不碰正文**；
- **三思层**：正当但代价高的动作插一道冷却窗口 + 一次性放行（绑命令哈希）；
  进窗口**之前**跑规则里声明的**只读探针**，把"这条命令会丢什么"现算出来放进窗口。

## 跑起来（dry-run，不执行任何命令）

```powershell
node test/import-check.mjs   # 入口能否装载（不启动）
node test/smoke.mjs          # 28 条裁决用例：只解析、不执行；不联网、不需要 git、不写任何文件
```

需要：Node ≥ 22.19；Windows 上的 `powershell.exe`（5.1 即可）。

## 安装

1. 把本目录放到任意位置，用 `link:` 或 `dsh plugin add <本目录>` 挂进 profile；
2. 包自带 `cordis.patch.yml` ⇒ 装上**自动注入配置**，不需要手改 profile；
3. **规则不用搬**：默认用包内 `rules/default.yaml`（规则跟插件走，装上就生效）。
   想用自己的规则 ⇒ 在插件配置里写 `rulesFile`（相对会话 cwd 的路径，或绝对路径）。

`rules/default.yaml` 把每个维度都演示了一遍，**不是**推荐配置 —— 复制成自己的再改。

## 边界（别误当成安全边界）

- 只接 `pwsh` / `powershell`；**bash 不在范围内** —— 规则层很简单，欢迎按目标 shell 自行移植。
- 护的是"**忘了那一次**"，不防"故意绕"：对故意的，靠回退点与审计，不靠墙。
- 看不见**字符串里**的东西（`Start-Process … -ArgumentList`、`[scriptblock]::Create("…")`、`cmd /c "…"`）。
- 覆盖面是**正面清单**，列不完；只读列举受保护目录**也会被拦**（"提及即停"的已知代价）。

## 目录名

本机目录叫 `dsh-ast-guard开源` 只为一眼辨认；**包名与仓库名是 ASCII 的 `dsh-ast-guard`**
（npm 包名不支持中文，`.cmd` 里出现非 ASCII 还会炸 —— 踩过）。
