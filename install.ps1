[CmdletBinding()]
param(
  [string]$Version = "",
  [long]$ReleaseId = 0,
  [string]$Repository = "contsulia-real/Junius",
  [string]$ApiBaseUrl = "https://api.github.com",
  [string]$CurrentVersion = "",
  [switch]$CheckOnly,
  [switch]$Json,
  [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "Junius installation currently supports Windows only."
}

$headers = @{
  "Accept" = "application/vnd.github+json"
  "User-Agent" = "Junius-Installer"
}

if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
  $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN"
}

function Invoke-JuniusGitHubJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri
  )

  $response = Invoke-RestMethod -Uri $Uri -Headers $headers -Method Get
  if ($response -is [System.Array]) {
    foreach ($item in $response) {
      Write-Output $item
    }
    return
  }

  Write-Output $response
}

function Get-JuniusRelease {
  if ($ReleaseId -gt 0) {
    return Invoke-JuniusGitHubJson -Uri (
      "$ApiBaseUrl/repos/$Repository/releases/$ReleaseId"
    )
  }

  if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $tag = $Version
    if (-not $tag.StartsWith("v", [System.StringComparison]::OrdinalIgnoreCase)) {
      $tag = "v" + $tag
    }

    $encodedTag = [Uri]::EscapeDataString($tag)
    return Invoke-JuniusGitHubJson -Uri (
      "$ApiBaseUrl/repos/$Repository/releases/tags/$encodedTag"
    )
  }

  $releases = @(
    Invoke-JuniusGitHubJson -Uri (
      "$ApiBaseUrl/repos/$Repository/releases?per_page=50"
    )
  )

  $published = @(
    $releases |
      Where-Object { -not $_.draft } |
      Sort-Object {
        [DateTimeOffset]$_.published_at
      } -Descending
  )

  if ($published.Count -eq 0) {
    throw "No published Junius GitHub Release is available."
  }

  return $published[0]
}

function Get-JuniusAsset {
  param(
    [Parameter(Mandatory = $true)]
    $Release,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $assets = @(
    $Release.assets |
      Where-Object { $_.name -eq $Name }
  )

  if ($assets.Count -ne 1) {
    throw "Release asset '$Name' was not found exactly once."
  }

  return $assets[0]
}

function Save-JuniusAsset {
  param(
    [Parameter(Mandatory = $true)]
    $Asset,
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  if (
    -not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN) -and
    -not [string]::IsNullOrWhiteSpace([string]$Asset.url)
  ) {
    $downloadHeaders = @{}
    foreach ($entry in $headers.GetEnumerator()) {
      $downloadHeaders[$entry.Key] = $entry.Value
    }
    $downloadHeaders["Accept"] = "application/octet-stream"

    Invoke-WebRequest -Uri $Asset.url -Headers $downloadHeaders -OutFile $Destination -UseBasicParsing
    return
  }

  Invoke-WebRequest -Uri $Asset.browser_download_url -Headers @{
    "User-Agent" = "Junius-Installer"
  } -OutFile $Destination -UseBasicParsing
}

function Get-JuniusSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha.ComputeHash($stream)
      return (
        [BitConverter]::ToString($bytes)
      ).Replace("-", "").ToLowerInvariant()
    }
    finally {
      $sha.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Get-JuniusNodePath {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    $node = Get-Command node -ErrorAction SilentlyContinue
  }

  if ($null -eq $node) {
    throw "Node.js 20 or newer is required. Install Node.js and rerun this command."
  }

  $nodePath = $node.Path
  $nodeVersion = (& $nodePath -p "process.versions.node").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to determine the installed Node.js version."
  }

  $majorText = $nodeVersion.Split(".")[0]
  $major = 0
  if (-not [int]::TryParse($majorText, [ref]$major) -or $major -lt 20) {
    throw "Node.js 20 or newer is required. Found Node.js $nodeVersion."
  }

  return $nodePath
}

$release = Get-JuniusRelease

if ($CheckOnly) {
  if ([string]::IsNullOrWhiteSpace($CurrentVersion)) {
    throw "-CurrentVersion is required with -CheckOnly."
  }

  $releaseTag = [string]$release.tag_name
  $latestVersion = $releaseTag
  if (
    $latestVersion.StartsWith(
      "v",
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    $latestVersion = $latestVersion.Substring(1)
  }

  $currentCore = (
    $CurrentVersion.Split("-")[0]
  )
  $latestCore = (
    $latestVersion.Split("-")[0]
  )

  try {
    $currentSemanticVersion = [Version]$currentCore
    $latestSemanticVersion = [Version]$latestCore
  }
  catch {
    throw (
      "Unable to compare Junius versions: current=" +
      $CurrentVersion +
      " latest=" +
      $latestVersion
    )
  }

  $updateAvailable = (
    $latestSemanticVersion -gt
    $currentSemanticVersion
  )
  $check = [pscustomobject]@{
    currentVersion = $CurrentVersion
    latestVersion = $latestVersion
    releaseTag = $releaseTag
    updateAvailable = $updateAvailable
  }

  if ($Json) {
    Write-Output (
      $check |
        ConvertTo-Json -Compress
    )
    return
  }

  Write-Host "Junius update check"
  Write-Host ("Current: " + $CurrentVersion)
  Write-Host ("Latest:  " + $latestVersion)
  if ($updateAvailable) {
    Write-Host "A Junius update is available."
  }
  else {
    Write-Host "Junius is up to date."
  }
  return
}

$packageAsset = Get-JuniusAsset -Release $release -Name "junius-windows.tgz"
$checksumAsset = Get-JuniusAsset -Release $release -Name "SHA256SUMS.txt"

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) (
  "JuniusInstall-" + [Guid]::NewGuid().ToString("N")
)
$packagePath = Join-Path $tempRoot "junius-windows.tgz"
$checksumPath = Join-Path $tempRoot "SHA256SUMS.txt"
$extractRoot = Join-Path $tempRoot "extract"

New-Item -ItemType Directory -Path $tempRoot | Out-Null
New-Item -ItemType Directory -Path $extractRoot | Out-Null

try {
  Write-Host "Junius GitHub Release installer"
  Write-Host ("Release: " + $release.tag_name)

  Save-JuniusAsset -Asset $packageAsset -Destination $packagePath
  Save-JuniusAsset -Asset $checksumAsset -Destination $checksumPath

  $checksumPattern = "^([A-Fa-f0-9]{64})\s+\*?junius-windows\.tgz$"
  $checksumLine = Get-Content $checksumPath |
    Where-Object { $_ -match $checksumPattern } |
    Select-Object -First 1

  if ($null -eq $checksumLine) {
    throw "SHA256SUMS.txt does not contain junius-windows.tgz."
  }

  $null = $checksumLine -match $checksumPattern
  $expectedHash = $Matches[1].ToLowerInvariant()
  $actualHash = Get-JuniusSha256 -Path $packagePath

  if ($expectedHash -ne $actualHash) {
    throw "Junius release checksum verification failed."
  }

  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($null -eq $tar) {
    $tar = Get-Command tar -ErrorAction SilentlyContinue
  }
  if ($null -eq $tar) {
    throw "Windows tar is required to unpack the Junius release."
  }

  & $tar.Path -xzf $packagePath -C $extractRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to unpack the Junius release."
  }

  $packageRoot = Join-Path $extractRoot "package"
  $packageJsonPath = Join-Path $packageRoot "package.json"
  if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
    throw "The Junius release package is missing package.json."
  }

  $packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
  $expectedTag = "v" + [string]$packageJson.version
  if ([string]$release.tag_name -cne $expectedTag) {
    throw (
      "Release tag/package version mismatch: release=" +
      [string]$release.tag_name +
      " package=" +
      [string]$packageJson.version
    )
  }

  $nodePath = Get-JuniusNodePath
  Write-Host ("Verified SHA-256: " + $actualHash)
  Write-Host ("Using Node: " + $nodePath)

  if ($VerifyOnly) {
    Write-Host "Junius release verification completed without installation."
    return
  }

  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue

  $cliPath = Join-Path $packageRoot "bin\junius.mjs"
  & $nodePath $cliPath install
  if ($LASTEXITCODE -ne 0) {
    throw "Junius installation failed."
  }

  $juniusRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Junius"
  $juniusBin = Join-Path $juniusRoot "bin"
  $installedCli = Join-Path $juniusRoot "app\bin\junius.mjs"
  $juniusShim = Join-Path $juniusBin "junius.cmd"

  New-Item -ItemType Directory -Path $juniusBin -Force | Out-Null
  $shim = "@echo off`r`n`"$nodePath`" `"$installedCli`" %*`r`n"
  [IO.File]::WriteAllText(
    $juniusShim,
    $shim,
    [Text.UTF8Encoding]::new($false)
  )

  $normalizedJuniusBin = $juniusBin.TrimEnd([char]92)
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $userEntries = if ([string]::IsNullOrWhiteSpace($userPath)) {
    @()
  }
  else {
    @(
      $userPath.Split(";") |
        Where-Object {
          -not [string]::IsNullOrWhiteSpace($_)
        }
    )
  }
  $userHasJuniusBin = @(
    $userEntries |
      Where-Object {
        $_.Trim().TrimEnd([char]92) -ieq $normalizedJuniusBin
      }
  ).Count -gt 0

  if (-not $userHasJuniusBin) {
    $userPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
      $juniusBin
    }
    else {
      $userPath.TrimEnd(";") + ";" + $juniusBin
    }
    [Environment]::SetEnvironmentVariable("Path", $userPath, "User")
  }

  $sessionHasJuniusBin = @(
    $env:Path.Split(";") |
      Where-Object {
        $_.Trim().TrimEnd([char]92) -ieq $normalizedJuniusBin
      }
  ).Count -gt 0

  if (-not $sessionHasJuniusBin) {
    $env:Path = $juniusBin + ";" + $env:Path
  }
}
finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
