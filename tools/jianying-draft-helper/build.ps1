$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'src/main.cpp'
$outputDirectory = Join-Path $PSScriptRoot 'bin'
$output = Join-Path $outputDirectory 'jianying-draft-helper.exe'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$gxx = Get-Command g++ -ErrorAction SilentlyContinue
if ($gxx) {
  & $gxx.Source -std=c++17 -O2 -municode -Wall -Wextra -static -static-libgcc -static-libstdc++ $source -o $output
  if ($LASTEXITCODE -ne 0) { throw "MinGW build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $output"
  exit 0
}

$cl = Get-Command cl -ErrorAction SilentlyContinue
if ($cl) {
  Push-Location $outputDirectory
  try {
    & $cl.Source /nologo /std:c++17 /O2 /EHsc /DUNICODE /D_UNICODE $source /Fe:$output
    if ($LASTEXITCODE -ne 0) { throw "MSVC build failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
  Write-Host "Built $output"
  exit 0
}

throw 'No supported Windows C++ compiler found. Install MinGW-w64 g++ or use a Developer PowerShell with cl.exe.'
