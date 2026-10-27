# dsh-ast-guard

> DSH（DeepSeek Harness）的**命令守卫插件**：在工具执行前，把 `pwsh` / `powershell` 命令交给
> **PowerShell 自带的语法树解析器**判定，按**效应**拦截（不是按命令名）；规则写在 YAML 里，
> 代码里不写死任何策略。

## 前置

- **已经装好 DSH** —— 这是 DSH 插件，不是独立程序；
- **Windows**（解析器用 `powershell.exe`，5.1 即可）；
- **Node ≥ 22.19**。

## 拿到它

还没发布到 npm，先 clone：

```powershell
git clone <本仓库地址>
cd <你 clone 下来的目录>
```

## 装进 DSH

```powershell
dsh plugin --profile web add <你 clone 下来的目录>
```

**然后重启 DSH**（插件与配置在启动时加载，**不热更新**）。

装好后插件会自己把配置挂上（包里有 `cordis.patch.yml`），规则用**包内**的 `rules/default.yaml` ——
**不需要你搬任何文件**。

<details>
<summary>没有 <code>dsh plugin add</code> 这个命令时，手动挂（两步）</summary>

1. 在 `$env:DSH_HOME\profiles\<你的 profile>\package.json` 的 `dependencies` 里加一行（`DSH_HOME` 是 DSH 的主目录，默认在 `~/.dsh`）：

   ```json
   "@cfitsec/dsh-ast-guard": "link:<你 clone 下来的绝对路径>"
   ```

2. 在同一个文件里，把它加进 `dsh.profile.bundles` 数组。

   然后**重启 DSH**。
</details>

## 验证它真的在拦

重启后，随便开一个 **pwsh** 会话，跑一条会被拦的命令：

```powershell
Set-Content -Path "$env:TEMP\ast-guard-探针.txt" -Value x
```

应该看到：

```
[ast-guard] 拒绝：content-write
…（dsh-ast-guard v0.1.0；规则来自 …\rules\default.yaml；…）
```

**看到了 ⇒ 装好了。** 没看到的话：

- 看 DSH 日志里有没有 `ast-guard:` 开头的行（插件加载失败会写在那里）；
- 确认**重启过**宿主；
- 在插件目录里跑一次 `npm install`（它只有一个依赖 `yaml`，装好再重启）。

## 它管什么

- **写文件内容**：`Set-Content` / `Add-Content` / `Clear-Content` / `Out-File` / `Tee-Object` / `Export-*`、
  `.NET` 的 `WriteAll*`、重定向 `>` `>>`（`$null` 豁免）、以及 `iex "Set-Content …"` 这种字符串里的写入；
- **删除 / 移动 / 改名**：受保护位置（`.git`、`node_modules`、`.ssh` …）、递归、通配、`-Force` 触发**三思**；
- **内联代码**：`node -e`、`python -c`、`powershell -Command`、`-EncodedCommand` …（逐命令看参数）；
- **凭据文件**：`edit` / `write` 的目标路径（`.npmrc` / `.credentials` / `id_rsa` …），**只看路径，不碰正文**；
- **注册表**增删改、**git 范围收缩**（`git checkout -- .` 这类）⇒ **三思**。

**三思**不是拒绝：插一道 10 秒冷却窗口，窗口内回答"是"和"否"都无效；冷却结束时先跑规则里声明的
**只读探针**，把"这条命令会丢什么"现算出来放进窗口，再用 `ast_confirm` 带编号回答。

## 改规则

默认规则是一套能直接用的（写内容族 + 条目操作族 + 内联 + 凭据 + 受保护目录 + 五组三思）。
想改成自己的：

1. 复制一份：`Copy-Item rules\default.yaml my-rules.yaml`，按需要改；
2. 在 profile 的插件配置里指过去（`$env:DSH_HOME\profiles\<profile>\cordis.patch.yml`）：

   ```yaml
   - id: ast-guard
     config:
       rulesFile: <绝对路径，或相对会话 cwd 的路径>
   ```

3. **重启**（配置不热更新；规则文件本身改了会热加载）。

完整规则词表：`commands` · `memberNames` · `redirects` ·
`when{ flags, wildcard, paths, subcommands, argsExact, argsContain, all }` ·
`tools` · `paths` · `mentions` · `evidence` · 三思的 `cooldownSeconds` / `when` / `evidence`。

## 判不了就拒（fail-closed）

规则文件读坏、解析器起不来 ⇒ **拒绝并说明怎么修**，不是静默放行。
理由很简单：一个"看起来在拦、其实没判"的守卫比没有守卫更危险 —— 它骗的是使用者。
（对应配置：`onRuleError: closed` / `failPolicy: closed`，都能改成 `open`，但要想清楚代价。）

## 边界（别误当成安全边界）

- 只接 `pwsh` / `powershell`；**bash 不在范围内** —— 规则层很简单，欢迎按目标 shell 自行移植。
- 护的是"**忘了那一次**"，不防"故意绕"：对故意的，靠回退点与审计，不靠墙。
- 看不见**字符串里**的东西（`Start-Process … -ArgumentList`、`[scriptblock]::Create("…")`、`cmd /c "…"`）。
- 覆盖面是**正面清单**，列不完；只读列举受保护目录**也会被拦**（"提及即停"的已知代价）。

## 跑自带的测试（可选）

> ✅ **测试随包发布**（在 `test/` 里，纯 dry-run：只解析、不执行、不联网、只写临时目录）。
> 所以从 npm 装好之后，也能直接拿它验证你改的规则。

在包目录里（`npm publish` 装的话是 `node_modules/@cfitsec/dsh-ast-guard`）：

```powershell
npm install                  # 只有一个依赖 yaml（以插件方式装好时通常已就位）
npm test                     # = smoke + hook 两套
node test/import-check.mjs   # 入口能否装载（不启动）
node test/smoke.mjs          # 30 条裁决用例：只解析、不执行；不联网、不写任何文件
node test/hook.mjs           # 12 条插件级用例：走真的 apply()（假 ctx）
```

## 改规则之前先读这一份

[`docs/维护规则.md`](docs/维护规则.md) —— 给**要动规则的人或智能体**：
维度速查、加规则的流程、我们踩过的坑（别名 / `args[0]` / YAML 单引号 / cmdlet 没有子命令）、
以及**永远不要做的三件事**（留反向后门、用内容白名单、静默放行）。

## 与生态里同类项目的关系

npm 上已经有两个相邻的项目。先认账，再说差异：

| 项目 | 它做什么 | 我们的差异 |
|---|---|---|
| `dsh-ast-guard` | tree-sitter 解析 bash + powershell CST；`allow/ask/block`；DNA 模式；沙箱升级联动 | 我们用 **PowerShell 自带解析器**（不引 WASM grammar、零原生依赖）；我们是 **三思冷却窗口**（不是弹窗四选）；我们有 **只读探针**把"这条命令会丢什么"现算出来；规则是朴素 YAML + 自有维度集 |
| `dsh-pwsh-guard` | 禁 shell 文本 I/O（`Select-String` / `Get-Content` / `node -e` …），指向 `read` / `grep` / `glob` | 目标不同：它管**读的方式**，我们管**写内容 / 删除 / 范围收缩**。**可以并存** |
