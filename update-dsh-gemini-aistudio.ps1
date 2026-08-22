#Requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

function Invoke-Git([string[]]$Arguments) {
  & git @Arguments
  if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) { throw '当前目录不是 Git 仓库' }

$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) { throw '工作区存在未提交修改，请先提交或保存后再更新' }

$upstream = (git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null).Trim()
if (-not $upstream) { throw '当前分支没有配置上游 Git 分支；先添加 GitHub remote 和 upstream' }

if ($CheckOnly) {
  $counts = (git rev-list --left-right --count 'HEAD...@{u}').Trim()
  Write-Host "仓库干净，上游状态：$counts"
  exit 0
}

Invoke-Git @('pull', '--ff-only')
Write-Host 'dsh-gemini-aistudio 更新完成，请重启 dsh。'
