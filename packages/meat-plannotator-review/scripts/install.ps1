$ErrorActionPreference = "Stop"

$PlannotatorRepository = if ($env:PLANNOTATOR_REPOSITORY) { $env:PLANNOTATOR_REPOSITORY } else { "https://github.com/dylanvanh/plannotator.git" }
$PlannotatorRef = if ($env:PLANNOTATOR_REF) { $env:PLANNOTATOR_REF } else { "bae103c7f5719c08a2261f0c5aadcdbae90a52cb" }
$SourceRepository = if ($env:SOURCE_REPOSITORY) { $env:SOURCE_REPOSITORY } else { "https://github.com/dylanvanh/opencode-as-openai-api.git" }
$SourceRef = if ($env:SOURCE_REF) { $env:SOURCE_REF } else { "main" }
$OpenCodeVersion = "1.18.15"
$MeatVersion = "v0.0.0-20260803201634-f39f41dfe7b5"
$MinimumNodeVersion = [version]"22.12.0"
$MinimumBunVersion = [version]"1.3.14"
$InstallPrefix = Join-Path $env:LOCALAPPDATA "Programs\meat-plannotator-review"
$WorkDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("meat-plannotator-review-" + [guid]::NewGuid())

function Refresh-Path {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$userPath;$machinePath"
}

function Install-WingetPackage([string]$CommandName, [string]$PackageIdentifier) {
    if (Get-Command $CommandName -ErrorAction SilentlyContinue) { return }
    winget install --id $PackageIdentifier --exact --accept-package-agreements --accept-source-agreements
    Refresh-Path
    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        throw "$CommandName was installed but is not available in PATH. Open a new terminal and run the installer again."
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

& gh auth status 2>$null
if ($LASTEXITCODE -ne 0) { throw "Run 'gh auth login' with access to dylanvanh/opencode-as-openai-api, then run this installer again." }
& gh repo view dylanvanh/opencode-as-openai-api 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { throw "Your GitHub account cannot access dylanvanh/opencode-as-openai-api." }
& gh auth setup-git
if ($LASTEXITCODE -ne 0) { throw "Git credential setup failed" }

$nodeVersion = [version]((& node --version).TrimStart("v"))
if ($nodeVersion -lt $MinimumNodeVersion) {
    & winget upgrade --id "OpenJS.NodeJS.LTS" --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Node.js upgrade failed" }
    Refresh-Path
    $nodeVersion = [version]((& node --version).TrimStart("v"))
    if ($nodeVersion -lt $MinimumNodeVersion) { throw "Node.js 22.12.0 or newer is required" }
}

$bunVersion = [version]((& bun --version).Trim())
if ($bunVersion -lt $MinimumBunVersion) {
    & winget upgrade --id "Oven-sh.Bun" --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Bun upgrade failed" }
    Refresh-Path
    $bunVersion = [version]((& bun --version).Trim())
    if ($bunVersion -lt $MinimumBunVersion) { throw "Bun 1.3.14 or newer is required" }
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

New-Item -ItemType Directory -Force -Path $WorkDirectory | Out-Null
try {
    Write-Host "Installing OpenCode and opencode-as-openai-api..."
    $sourceDirectory = Join-Path $WorkDirectory "source"
    & git clone --depth 1 --branch $SourceRef $SourceRepository $sourceDirectory
    if ($LASTEXITCODE -ne 0) { throw "Source clone failed" }
    & npm --prefix $sourceDirectory ci --ignore-scripts --include=dev
    if ($LASTEXITCODE -ne 0) { throw "Source dependency installation failed" }
    & npm --prefix $sourceDirectory run build --workspaces --if-present
    if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed" }
    $gatewaySourceDirectory = Join-Path $sourceDirectory "packages/opencode-as-openai-api"
    $gatewayTarballName = (& npm pack --ignore-scripts --silent --pack-destination $WorkDirectory $gatewaySourceDirectory | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Gateway package build failed" }
    $reviewSourceDirectory = Join-Path $sourceDirectory "packages/meat-plannotator-review"
    $reviewTarballName = (& npm pack --ignore-scripts --silent --pack-destination $WorkDirectory $reviewSourceDirectory | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Review package build failed" }
    & npm install --global --prefix $InstallPrefix `
        "opencode-ai@$OpenCodeVersion" `
        (Join-Path $WorkDirectory $gatewayTarballName) `
        (Join-Path $WorkDirectory $reviewTarballName)
    if ($LASTEXITCODE -ne 0) { throw "npm installation failed" }

    Write-Host "Installing Meat..."
    $env:GOBIN = $InstallPrefix
    & go install "meat.dev/cmd/meat@$MeatVersion"
    if ($LASTEXITCODE -ne 0) { throw "Meat installation failed" }

    Write-Host "Building the Plannotator fork..."
    $plannotatorDirectory = Join-Path $WorkDirectory "plannotator"
    & git clone --depth 1 $PlannotatorRepository $plannotatorDirectory
    if ($LASTEXITCODE -ne 0) { throw "Plannotator clone failed" }
    & git -C $plannotatorDirectory fetch --depth 1 origin $PlannotatorRef
    if ($LASTEXITCODE -ne 0) { throw "Plannotator ref fetch failed" }
    & git -C $plannotatorDirectory checkout --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw "Plannotator checkout failed" }
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
Write-Host "Installed: opencode, meat, plannotator, opencode-as-openai-api, and meat-plannotator-review"
Write-Host "Open a new terminal, configure an OpenCode provider, then run:"
Write-Host "  meat-plannotator-review --model provider/model"
Write-Host "  meat-plannotator-review https://github.com/owner/repo/pull/123 --model provider/model"
