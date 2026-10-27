# Persistent AST parser for the DSH ast-guard plugin.
#
# Protocol: one JSON request per stdin line, one JSON response per stdout line.
#   request : {"id":<int>,"command":"<text>"}
#   response: {"id":<int>,"commands":[{"name":..,"args":[..]}],
#              "members":[{"name":..,"target":..}],
#              "redirects":[{"target":..,"append":<bool>}],
#              "dynamic":<int>,"errors":[<message>]}
#
# THIS FILE MUST STAY PURE ASCII. Windows PowerShell 5.1 decodes a BOM-less .ps1 as
# GB2312, so one non-ASCII byte here turns into mojibake and the whole script fails
# to parse. Chinese in a denial message is written on the Node side instead.
#
# Explicit UTF-8 on both pipes, never [Console]::In / [Console]::Out: those use the
# console code page (936/GBK here) while Node speaks UTF-8, so a Chinese command gets
# decoded wrong and ConvertFrom-Json can fail outright -- which looked like a silent
# hang until it was traced to a single character.

$encoding = New-Object System.Text.UTF8Encoding $false
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $encoding)
$stdout.AutoFlush = $true
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $encoding)

# Readiness handshake: the client waits for this line before sending any request.
$stdout.WriteLine('{"ready":true}')
$stdout.Flush()

while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }

  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  if ($null -eq $req) { continue }

  # Alias reconciliation: ask PowerShell itself what a name is, and which aliases point at
  # a canonical command. Rule files must match this, not someone's memory.
  if ($null -ne $req.recon) {
    $nameInfo = @{}
    foreach ($name in @($req.recon.names)) {
      $key = [string]$name
      $cmd = Get-Command -Name $key -ErrorAction SilentlyContinue
      if ($null -eq $cmd) { $nameInfo[$key] = @{ kind = 'missing'; definition = '' }; continue }
      $kind = [string]$cmd.CommandType
      $definition = if ($kind -eq 'Alias') { [string]$cmd.Definition } else { [string]$cmd.Name }
      $nameInfo[$key] = @{ kind = $kind; definition = $definition }
    }
    $aliasInfo = @{}
    foreach ($canonical in @($req.recon.aliasesOf)) {
      $key = [string]$canonical
      $aliasInfo[$key] = @(Get-Alias -Definition $key -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Name })
    }
    $out = @{ id = $req.id; names = $nameInfo; aliasesOf = $aliasInfo } | ConvertTo-Json -Compress -Depth 6
    $stdout.WriteLine($out)
    $stdout.Flush()
    continue
  }

  $tokens = $null
  $errs = $null
  $text = [string]$req.command

  try {
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errs)
  } catch {
    $fail = @{ id = $req.id; fatal = [string]$_.Exception.Message } | ConvertTo-Json -Compress
    $stdout.WriteLine($fail)
    $stdout.Flush()
    continue
  }

  # Every occurrence is reported WITH its arguments: the effect-based tier needs them
  # (recursive / wildcard / -Force / which path), and two occurrences of the same name
  # can carry different arguments. Only EXACT duplicates collapse (same name, same args) --
  # that loses no information and keeps a 200-line script from returning 200 identical rows.
  $commands = New-Object System.Collections.ArrayList
  $commandSeen = @{}
  $nullChar = [string][char]0
  $dynamicCount = 0
  $dynamicSeen = @{}
  $dynamicTexts = New-Object System.Collections.ArrayList
  foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    $name = [string]$node.GetCommandName()
    if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('$') -or $name.StartsWith('(')) {
      $dynamicCount++
      $text = [string]$node.Extent.Text
      if (-not $dynamicSeen.ContainsKey($text)) { $dynamicSeen[$text] = $true; [void]$dynamicTexts.Add($text) }
      continue
    }
    $elements = New-Object System.Collections.ArrayList
    foreach ($element in $node.CommandElements) { [void]$elements.Add([string]$element.Extent.Text) }
    $key = $name + $nullChar + ($elements -join $nullChar)
    if ($commandSeen.ContainsKey($key)) { $commandSeen[$key].count = $commandSeen[$key].count + 1; continue }
    $entry = @{ name = $name; args = @($elements); count = 1 }
    $commandSeen[$key] = $entry
    [void]$commands.Add($entry)
  }

  $memberSeen = @{}
  $members = New-Object System.Collections.ArrayList
  foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) {
    $key = ([string]$node.Expression.Extent.Text) + '::' + ([string]$node.Member.Value)
    if ($memberSeen.ContainsKey($key)) { continue }
    $memberSeen[$key] = $true
    [void]$members.Add(@{
      name   = [string]$node.Member.Value
      target = [string]$node.Expression.Extent.Text
    })
  }

  $redirectSeen = @{}
  $redirects = New-Object System.Collections.ArrayList
  foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst] }, $true)) {
    $target = [string]$node.Location.Extent.Text
    $append = [bool]$node.Append
    $key = $target + '|' + $append
    if ($redirectSeen.ContainsKey($key)) { continue }
    $redirectSeen[$key] = $true
    [void]$redirects.Add(@{ target = $target; append = $append })
  }

  $messages = New-Object System.Collections.ArrayList
  foreach ($e in $errs) { [void]$messages.Add([string]$e.Message) }

  $response = @{
    id           = $req.id
    commands     = @($commands)
    members      = @($members)
    redirects    = @($redirects)
    dynamic      = $dynamicCount
    dynamicTexts = @($dynamicTexts)
    errors       = @($messages)
  }

  $stdout.WriteLine(($response | ConvertTo-Json -Compress -Depth 6))
  $stdout.Flush()
}
