<#
.SYNOPSIS
    Install the GNOSIA BepInEx plugin and register the gnosia MCP server.

.DESCRIPTION
    Does four things, in order:
      1. verify the game directory
      2. make sure BepInEx is present (unzip a bundle if one is given)
      3. copy GnosiaApi.dll into BepInEx\plugins
      4. add a "gnosia" entry to the MCP client's config (backed up first)

    Safe to re-run: existing files are overwritten, the MCP config keeps every
    other server it already has.

.PARAMETER GameDir
    GNOSIA install directory (the one containing Gnosia.exe).

.PARAMETER McpConfig
    MCP client config file. Default: %USERPROFILE%\.workbuddy\mcp.json

.PARAMETER BundleZip
    Optional zip that contains BepInEx (winhttp.dll, doorstop_config.ini,
    BepInEx\...). Extracted into GameDir when BepInEx is missing.

.PARAMETER SkipMcp
    Only do the game-side install, do not touch the MCP config.

.PARAMETER Force
    Continue even if a check fails (not recommended).

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -GameDir "D:\Games\GNOSIA" -BundleZip .\gnosia-mcp-bundle.zip
#>
[CmdletBinding()]
param(
    [string]$GameDir = 'C:\Program Files (x86)\Steam\steamapps\common\GNOSIA',
    [string]$McpConfig = (Join-Path $env:USERPROFILE '.workbuddy\mcp.json'),
    [string]$BundleZip,
    [switch]$SkipMcp,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
    Write-Host "ERROR  $text" -ForegroundColor Red
    if (-not $Force) { exit 1 }
    Write-Host "       (continuing because -Force was given)" -ForegroundColor Yellow
}

Say ''
Say '  gnosia-mcp installer' 'Cyan'
Say '  -------------------' 'DarkGray'
Say ''

# --- 1. game directory -------------------------------------------------------
$exe = Join-Path $GameDir 'Gnosia.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    Fail "Gnosia.exe not found in: $GameDir`n       Pass the right folder with -GameDir"
} else {
    Say "game      $GameDir" 'Green'
}

# --- 2. BepInEx --------------------------------------------------------------
$core = Join-Path $GameDir 'BepInEx\core\BepInEx.dll'
if (-not (Test-Path -LiteralPath $core)) {
    if ($BundleZip -and (Test-Path -LiteralPath $BundleZip)) {
        Say "bepinex   not installed, extracting $BundleZip" 'Yellow'
        Expand-Archive -LiteralPath $BundleZip -DestinationPath $GameDir -Force
    } elseif (Test-Path -LiteralPath (Join-Path $repo 'gnosia-mcp-bundle.zip')) {
        Say 'bepinex   not installed, extracting bundled zip' 'Yellow'
        Expand-Archive -LiteralPath (Join-Path $repo 'gnosia-mcp-bundle.zip') -DestinationPath $GameDir -Force
    } else {
        Fail @"
BepInEx is not installed in the game folder.
       Download BepInEx 5.4.x x64 (https://github.com/BepInEx/BepInEx/releases),
       or grab gnosia-mcp-bundle.zip from this project's Releases, then either
       extract it into "$GameDir" yourself or re-run with:
           .\install.ps1 -BundleZip .\gnosia-mcp-bundle.zip
"@
    }
}
if (Test-Path -LiteralPath $core) { Say 'bepinex   ok' 'Green' }

# --- 3. plugin dll -----------------------------------------------------------
$dll = $null
foreach ($candidate in @(
        (Join-Path $repo 'release\GnosiaApi.dll'),
        (Join-Path $repo 'plugin\build\GnosiaApi.dll'),
        (Join-Path $repo 'plugin\GnosiaApi.dll'))) {
    if (Test-Path -LiteralPath $candidate) { $dll = $candidate; break }
}
if (-not $dll) {
    Fail @"
GnosiaApi.dll not found.
       Build it first:  cd plugin; .\build-gnosia.ps1
       (or extract a Release bundle that ships the dll)
"@
} else {
    $target = Join-Path $GameDir 'BepInEx\plugins\GnosiaApi.dll'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $dll -Destination $target -Force
    Say "plugin    -> BepInEx\plugins\GnosiaApi.dll" 'Green'
}

# --- 4. MCP config -----------------------------------------------------------
if ($SkipMcp) {
    Say 'mcp       skipped (-SkipMcp)' 'Yellow'
} else {
    $entry = Join-Path $repo 'mcp\dist\index.js'
    if (-not (Test-Path -LiteralPath $entry)) {
        Fail @"
mcp\dist\index.js not found - the server has not been built.
       cd mcp; npm ci; npm run build
"@
    } else {
        $node = (Get-Command node -ErrorAction SilentlyContinue)
        if (-not $node) {
            Fail 'node.exe not found in PATH (Node.js 18+ is required).'
        } else {
            $configPath = $McpConfig
            $dir = Split-Path -Parent $configPath
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

            $config = @{ mcpServers = @{} }
            if (Test-Path -LiteralPath $configPath) {
                try {
                    $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
                    if ($raw.Trim()) {
                        $existing = $raw | ConvertFrom-Json
                        if ($existing.mcpServers) {
                            foreach ($prop in $existing.mcpServers.PSObject.Properties) {
                                $config.mcpServers[$prop.Name] = $prop.Value
                            }
                        }
                    }
                    $backup = "$configPath.bak"
                    Copy-Item -LiteralPath $configPath -Destination $backup -Force
                    Say "mcp       backup -> $backup" 'DarkGray'
                } catch {
                    Fail "existing MCP config is not valid JSON: $configPath"
                }
            }

            # the config is optional: config.ts already defaults every path to this repo
            $cfgPath = Join-Path $repo 'mcp\gnosia.config.json'
            if (-not (Test-Path -LiteralPath $cfgPath)) {
                '{ "processName": "Gnosia", "steamAppId": "1608290" }' |
                    Set-Content -LiteralPath $cfgPath -Encoding UTF8
                Say "mcp       wrote default gnosia.config.json" 'DarkGray'
            }

            $config.mcpServers['gnosia'] = [ordered]@{
                command = $node.Source
                args    = @($entry)
                env     = @{ GNOSIA_MCP_CONFIG = $cfgPath }
            }

            $config | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $configPath -Encoding UTF8
            Say "mcp       registered -> $configPath" 'Green'
        }
    }
}

Say ''
Say 'Done. Next:' 'Cyan'
Say '  1. restart your MCP client (or reload this session)'
Say '  2. launch GNOSIA'
Say '  3. the tool list should now contain gnosia_state, gnosia_advance, ...'
Say '  4. run gnosia_playbook once before playing'
Say ''
