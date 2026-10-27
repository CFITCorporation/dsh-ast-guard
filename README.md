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
node test/smoke.mjs          # 30 条裁决用例：只解析、不执行；不联网、不需要 git、不写任何文件
node test/hook.mjs           # 12 条插件级用例：走真的 apply()（假 ctx），验注册/加载/文案/三思窗口
```

需要：Node ≥ 22.19；Windows 上的 `powershell.exe`（5.1 即可）。

## 安装

1. 把本目录放到任意位置，用 `link:` 或 `dsh plugin add <本目录>` 挂进 profile；
2. 包自带 `cordis.patch.yml` ⇒ 装上**自动注入配置**，不需要手改 profile；
3. **规则不用搬**：默认用包内 `rules/default.yaml`（规则跟插件走，装上就生效）。
   想用自己的规则 ⇒ 在插件配置里写 `rulesFile`（相对会话 cwd 的路径，或绝对路径）；
4. **改完配置要重启宿主**才生效（插件与配置在启动时加载，不热更新）。
   回滚：把 profile 里那条插件/配置去掉，再重启一次即可 —— 默认规则在包内，不往工作区留残留。

`rules/default.yaml` 是一套**能直接用**的默认规则：写内容族 + 条目操作族 + 内联代码 + 凭据文件 +
受保护目录 + 五组三思。按自己的情况复制一份再改。

## 判不了就拒（fail-closed）

规则文件读坏、解析器起不来 ⇒ **拒绝并说明怎么修**，不是静默放行。
理由很简单：一个"看起来在拦、其实没判"的守卫，比没有守卫更危险 —— 它骗的是使用者。
（对应配置：`onRuleError: closed` / `failPolicy: closed`，两者都可以改成 `open`，但要想清楚代价。）

## 边界（别误当成安全边界）

- 只接 `pwsh` / `powershell`；**bash 不在范围内** —— 规则层很简单，欢迎按目标 shell 自行移植。
- 护的是"**忘了那一次**"，不防"故意绕"：对故意的，靠回退点与审计，不靠墙。
- 看不见**字符串里**的东西（`Start-Process … -ArgumentList`、`[scriptblock]::Create("…")`、`cmd /c "…"`）。
- 覆盖面是**正面清单**，列不完；只读列举受保护目录**也会被拦**（"提及即停"的已知代价）。

## 与生态里同类项目的关系

npm 上已经有两个相邻的项目。先认账，再说差异：

| 项目 | 它做什么 | 我们的差异 |
|---|---|---|
| `dsh-ast-guard` | tree-sitter 解析 bash + powershell CST；`allow/ask/block`；DNA 模式；沙箱升级联动 | 我们用 **PowerShell 自带解析器**（不引 WASM grammar、零原生依赖）；我们是 **三思冷却窗口**（不是弹窗四选）；我们有 **只读探针**把"这条命令会丢什么"现算出来；规则是朴素 YAML + 自有维度集 |
| `dsh-pwsh-guard` | 禁 shell 文本 I/O（`Select-String` / `Get-Content` / `node -e` …），指向 `read` / `grep` / `glob` | 目标不同：它管**读的方式**，我们管**写内容 / 删除 / 范围收缩**。**可以并存** |

本项目的 npm 包名是 **`@cfitsec/dsh-ast-guard`** —— 裸名 `dsh-ast-guard` 已被占用。
