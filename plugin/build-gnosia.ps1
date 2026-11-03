# Build the GNOSIA BepInEx plugin with Unity's bundled Mono compiler.
#
#   powershell -ExecutionPolicy Bypass -File .\build-gnosia.ps1
#   powershell -ExecutionPolicy Bypass -File .\build-gnosia.ps1 -Install
#
# Same shape as cs_gameapi/build.ps1: no .NET SDK needed, the compiler comes from
# the Unity editor install, references come from the game's own Managed folder.

[CmdletBinding()]
param(
    [string]$Source,
    [string]$Name = 'GnosiaApi',
    [string]$OutputDir,
    [string]$GameDir = 'C:\Program Files (x86)\Steam\steamapps\common\GNOSIA',
    [string[]]$ExtraRefs = @(),
    [switch]$Install
)

$ErrorActionPreference = 'Stop'

$GameRoot    = $GameDir
$GameManaged = Join-Path $GameRoot 'Gnosia_Data\Managed'
$BepInExCore = Join-Path $GameRoot 'BepInEx\core'
$PluginDir   = Join-Path $GameRoot 'BepInEx\plugins'

if (-not $Source)    { $Source = Join-Path $PSScriptRoot 'src' }
if (-not $OutputDir) { $OutputDir = Join-Path $PSScriptRoot 'build' }

# Locate any installed Unity editor's MonoBleedingEdge (version-agnostic).
$monoRoot = $null
foreach ($candidate in (Get-ChildItem 'C:\Program Files\UnityEditor' -Directory -ErrorAction SilentlyContinue)) {
    $probe = Join-Path $candidate.FullName 'Editor\Data\MonoBleedingEdge'
    if (Test-Path (Join-Path $probe 'bin\mono.exe')) { $monoRoot = $probe; break }
}
if (-not $monoRoot) { throw 'MonoBleedingEdge not found under C:\Program Files\UnityEditor\*' }

$Mono = Join-Path $monoRoot 'bin\mono.exe'
$Csc  = Join-Path $monoRoot 'lib\mono\4.5\csc.exe'
foreach ($p in @($Mono, $Csc, $GameManaged)) {
    if (-not (Test-Path $p)) { throw "not found: $p" }
}
if (-not (Test-Path (Join-Path $BepInExCore 'BepInEx.dll'))) {
    throw "BepInEx is not installed yet: $BepInExCore\BepInEx.dll missing. Extract the BepInEx pack (winhttp.dll + BepInEx\ + doorstop_config.ini) into $GameRoot first."
}

# Expand sources: file or directory, recursive .cs
$sources = @()
if (Test-Path $Source) {
    $item = Get-Item $Source
    if ($item.PSIsContainer) {
        $sources += Get-ChildItem -Path $item.FullName -Filter '*.cs' -Recurse | ForEach-Object { $_.FullName }
    } else {
        $sources += $item.FullName
    }
}
if ($sources.Count -eq 0) { throw "no .cs sources found in: $Source" }

# References: BCL + Unity modules + BepInEx. Assembly-CSharp is intentionally NOT
# referenced - the plugin reads game objects through reflection, so it keeps
# working when the game updates its internals.
#
# mscorlib / System / System.Core are deliberately NOT pinned to the game folder:
# the compiler's own default response file already references them, and GNOSIA
# ships its own copies under Managed\, which makes csc import the same identity
# twice (CS1703). Only the assemblies that are genuinely unique to the game are
# added explicitly.
$refNames = @(
    'netstandard.dll',
    'UnityEngine.dll',
    'UnityEngine.CoreModule.dll',
    'UnityEngine.IMGUIModule.dll'
)
$refs = @()
foreach ($n in $refNames) { $refs += Join-Path $GameManaged $n }
$refs += (Join-Path $BepInExCore 'BepInEx.dll')
if (Test-Path (Join-Path $BepInExCore '0Harmony.dll')) { $refs += (Join-Path $BepInExCore '0Harmony.dll') }
foreach ($r in $ExtraRefs) { $refs += $r }

$missing = $refs | Where-Object { -not (Test-Path $_) }
if ($missing) { throw "missing reference assemblies:`n  $($missing -join "`n  ")" }

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$outFile = Join-Path $OutputDir "$Name.dll"

$cscArgs = @('/nologo', '/target:library', "/out:$outFile", '/optimize+', '/langversion:7.3')
foreach ($r in $refs) { $cscArgs += "/r:$r" }
$cscArgs += $sources

Write-Host "compiling $Name ($($sources.Count) file(s)) -> $outFile" -ForegroundColor Cyan
$output = & $Mono $Csc @cscArgs 2>&1
$code = $LASTEXITCODE
$output | Where-Object { "$_".Trim() } | ForEach-Object { Write-Host $_ }
if ($code -ne 0) { throw "compile failed with exit code $code" }

$dll = Get-Item $outFile
Write-Host ("OK  {0}  ({1:N0} bytes)" -f $dll.Name, $dll.Length) -ForegroundColor Green

if ($Install) {
    New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
    Copy-Item $outFile (Join-Path $PluginDir $dll.Name) -Force
    Write-Host "installed -> $(Join-Path $PluginDir $dll.Name)" -ForegroundColor Green
}

return $outFile
