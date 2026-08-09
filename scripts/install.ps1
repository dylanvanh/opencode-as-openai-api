$ErrorActionPreference = "Stop"

$PlannotatorRepository = if ($env:PLANNOTATOR_REPOSITORY) { $env:PLANNOTATOR_REPOSITORY } else { "https://github.com/dylanvanh/plannotator.git" }
$PlannotatorRef = if ($env:PLANNOTATOR_REF) { $env:PLANNOTATOR_REF } else { "feat/raw-patch-review" }
$GatewayPackage = if ($env:GATEWAY_PACKAGE) { $env:GATEWAY_PACKAGE } else { "git+https://github.com/dylanvanh/opencode-as-openai-api.git" }
$OpenCodeVersion = "1.18.15"
$MeatVersion = "v0.0.0-20260803201634-f39f41dfe7b5"
$InstallPrefix = Join-Path $env:LOCALAPPDATA "Programs\opencode-meat-review"
$WorkDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("opencode-meat-review-" + [guid]::NewGuid())

function Refresh-Path {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$userPath;$machinePath"
}

function Install-WingetPackage([string]$Command, [string]$Package) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
    winget install --id $Package --exact --accept-package-agreements --accept-source-agreements
    Refresh-Path
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Command was installed but is not available in PATH. Open a new terminal and run the installer again."
    }
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget is required. Install App Installer from Microsoft Store, then run this installer again."
}

Install-WingetPackage "git" "Git.Git"
Install-WingetPackage "gh" "GitHub.cli"
Install-WingetPackage "node" "OpenJS.NodeJS.LTS"
Install-WingetPackage "go" "GoLang.Go"
Install-WingetPackage "bun" "Oven-sh.Bun"

$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) {
    & winget upgrade --id "OpenJS.NodeJS.LTS" --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Node.js upgrade failed" }
    Refresh-Path
    $nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
    if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required" }
}

$goVersionMatch = [regex]::Match((& go version), 'go(\d+\.\d+\.\d+)')
if (-not $goVersionMatch.Success) { throw "Could not read the Go version" }
if ([version]$goVersionMatch.Groups[1].Value -lt [version]"1.24.13") {
    & winget upgrade --id "GoLang.Go" --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Go upgrade failed" }
    Refresh-Path
    $goVersionMatch = [regex]::Match((& go version), 'go(\d+\.\d+\.\d+)')
    if (-not $goVersionMatch.Success) { throw "Could not read the upgraded Go version" }
    $upgradedGoVersion = [version]$goVersionMatch.Groups[1].Value
    if ($upgradedGoVersion -lt [version]"1.24.13") { throw "Go 1.24.13 or newer is required" }
}

New-Item -ItemType Directory -Force -Path $InstallPrefix | Out-Null
$env:Path = "$InstallPrefix;$env:Path"

Write-Host "Installing OpenCode and opencode-as-openai-api..."
& npm install --global --prefix $InstallPrefix "opencode-ai@$OpenCodeVersion" $GatewayPackage
if ($LASTEXITCODE -ne 0) { throw "npm installation failed" }

Write-Host "Installing Meat..."
$env:GOBIN = $InstallPrefix
& go install "meat.dev/cmd/meat@$MeatVersion"
if ($LASTEXITCODE -ne 0) { throw "Meat installation failed" }

Write-Host "Building the Plannotator fork..."
New-Item -ItemType Directory -Force -Path $WorkDirectory | Out-Null
try {
    $plannotatorDirectory = Join-Path $WorkDirectory "plannotator"
    & git clone --depth 1 --branch $PlannotatorRef $PlannotatorRepository $plannotatorDirectory
    if ($LASTEXITCODE -ne 0) { throw "Plannotator clone failed" }
    Push-Location $plannotatorDirectory
    try {
        & bun install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "Plannotator dependency installation failed" }
        & bun run --cwd apps/review build
        if ($LASTEXITCODE -ne 0) { throw "Plannotator review build failed" }
        & bun run build:hook
        if ($LASTEXITCODE -ne 0) { throw "Plannotator hook build failed" }
        & bun build apps/hook/server/index.ts --compile --outfile (Join-Path $InstallPrefix "plannotator.exe")
        if ($LASTEXITCODE -ne 0) { throw "Plannotator binary build failed" }
    } finally {
        Pop-Location
    }
} finally {
    Remove-Item -Recurse -Force $WorkDirectory -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathEntries = @($userPath -split ";" | Where-Object { $_ })
if ($pathEntries -notcontains $InstallPrefix) {
    [Environment]::SetEnvironmentVariable("Path", (($pathEntries + $InstallPrefix) -join ";"), "User")
}

Write-Host ""
Write-Host "Installed: opencode, meat, plannotator, and opencode-as-openai-api"
Write-Host "Open a new terminal, configure an OpenCode provider, then run:"
Write-Host "  opencode-as-openai-api review --model provider/model"
Write-Host "  opencode-as-openai-api review https://github.com/owner/repo/pull/123 --model provider/model"
