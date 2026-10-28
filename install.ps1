# Backburner installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/MeagerPotato/backburner/main/install.ps1 | iex
#
# Installs the `backburner` command with npm, then runs `backburner setup`, which finds
# the AI tools on this computer (Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor,
# Windsurf) and asks which ones to connect.
#
# $env:BACKBURNER_SOURCE      install from another tarball or folder instead of GitHub main
# $env:BACKBURNER_NO_SETUP=1  install only; run `backburner setup` yourself later

function Install-Backburner {
  $ErrorActionPreference = 'Stop'
  $source = if ($env:BACKBURNER_SOURCE) { $env:BACKBURNER_SOURCE } else { 'https://github.com/MeagerPotato/backburner/archive/refs/heads/main.tar.gz' }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Backburner needs Node.js 20 or newer.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      $answer = Read-Host 'Install Node.js LTS now with winget? (y/n)'
      if ($answer -match '^y') {
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
      }
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      Write-Host 'Install Node.js from https://nodejs.org, open a new PowerShell window, and run this again.'
      return
    }
  }
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -lt 20) {
    Write-Host "Backburner needs Node.js 20 or newer; you have $(node -v). Update it from https://nodejs.org and run this again."
    return
  }

  Write-Host 'Installing Backburner...'
  npm install -g $source
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'npm could not install Backburner. Scroll up for its error.'
    return
  }

  # The new command may not be on PATH in this window yet.
  $prefix = (npm prefix -g).Trim()
  if (-not (Get-Command backburner -ErrorAction SilentlyContinue)) { $env:Path = "$prefix;$env:Path" }

  if ($env:BACKBURNER_NO_SETUP -eq '1') {
    Write-Host 'Installed. Run `backburner setup` to connect your AI tools.'
    return
  }
  Write-Host ''
  backburner setup
}

Install-Backburner
