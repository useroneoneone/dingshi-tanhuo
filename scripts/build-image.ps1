[CmdletBinding()]
param(
    [string]$Version = '1.0.0',
    [ValidateSet('linux/amd64', 'linux/arm64')]
    [string]$Platform = 'linux/amd64',
    [string]$Image = '',
    [string]$BaseImage = '',
    [string]$OutputDir = 'artifacts',
    [switch]$Push,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Help) {
    Write-Output @'
Build a Linux image locally and export a compressed, checksum-protected archive.

Usage:
  .\scripts\build-image.ps1 -Version 1.0.0
  .\scripts\build-image.ps1 -Version 1.0.0 -Platform linux/arm64
  .\scripts\build-image.ps1 -Version 1.0.0 -BaseImage public.ecr.aws/docker/library/node:24-bookworm-slim
  .\scripts\build-image.ps1 -Version 1.0.0 -Image ghcr.io/OWNER/dingshi-tanhuo:1.0.0 -Push

Options:
  -Version     Archive version and default image tag. Default: 1.0.0.
  -Platform    linux/amd64 or linux/arm64. Match the cloud server architecture.
  -Image       Image reference. Default: dingshi-tanhuo:<Version>.
  -BaseImage   Optional Dockerfile NODE_IMAGE override.
  -OutputDir   Archive directory, relative to this project or absolute.
  -Push        Explicitly push the image after export. Requires registry login.
  -Help        Show this help without building.

No registry publication occurs without -Push. Existing archives are not replaced.
Archives contain the image only, never the application's runtime data volume.
'@
    exit 0
}

if ($Version -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$') {
    throw 'Version must be a valid Docker tag, without spaces or path separators.'
}
if (-not $Image) { $Image = "dingshi-tanhuo:$Version" }
if ($Image -notmatch '^[a-z0-9][A-Za-z0-9._:/-]*$') {
    throw 'Image must be a Docker image reference without whitespace or shell characters.'
}
if ($BaseImage -and $BaseImage -notmatch '^[a-z0-9][A-Za-z0-9._:/-]*$') {
    throw 'BaseImage must be a Docker image reference without whitespace or shell characters.'
}
if ($Push -and -not $Image.Contains('/')) {
    throw 'Use -Image with a registry/owner repository when requesting -Push.'
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) { throw 'OutputDir must not be empty.' }

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputPath = if ([IO.Path]::IsPathRooted($OutputDir)) {
    [IO.Path]::GetFullPath($OutputDir)
} else {
    [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDir))
}
$archiveName = "dingshi-tanhuo-$Version-$($Platform.Replace('/', '-')).tar.gz"
$archivePath = Join-Path $outputPath $archiveName
$checksumPath = "$archivePath.sha256"
if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $checksumPath)) {
    throw "Output already exists: $archivePath. Choose another version or OutputDir."
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is required.' }
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

function Invoke-Docker([string[]]$DockerArguments) {
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker failed with exit code $LASTEXITCODE." }
}

$buildArguments = @(
    'buildx', 'build', '--platform', $Platform, '--load', '--provenance=false',
    '--tag', $Image
)
if ($BaseImage) { $buildArguments += @('--build-arg', "NODE_IMAGE=$BaseImage") }
$buildArguments += $projectRoot
Write-Host "Building $Image for $Platform locally..."
Invoke-Docker $buildArguments

$temporaryTar = Join-Path $outputPath ('.tanhuo-' + [Guid]::NewGuid().ToString('N') + '.tar')
$createdArchive = $false
$createdChecksum = $false
$complete = $false
try {
    Invoke-Docker @('image', 'save', '--output', $temporaryTar, $Image)
    $inputStream = [IO.File]::OpenRead($temporaryTar)
    try {
        $outputStream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $createdArchive = $true
        try {
            $gzip = New-Object IO.Compression.GZipStream($outputStream, [IO.Compression.CompressionLevel]::Optimal, $true)
            try { $inputStream.CopyTo($gzip) } finally { $gzip.Dispose() }
        } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksumStream = [IO.File]::Open($checksumPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $createdChecksum = $true
    try {
        $checksumBytes = [Text.Encoding]::ASCII.GetBytes("$hash  $archiveName`n")
        $checksumStream.Write($checksumBytes, 0, $checksumBytes.Length)
    } finally { $checksumStream.Dispose() }
    $complete = $true
} finally {
    if (Test-Path -LiteralPath $temporaryTar) { Remove-Item -LiteralPath $temporaryTar -Force }
    if ($createdArchive -and -not $complete) { Remove-Item -LiteralPath $archivePath -Force }
    if ($createdChecksum -and -not $complete) { Remove-Item -LiteralPath $checksumPath -Force }
}

Write-Host "Image:    $Image"
Write-Host "Archive:  $archivePath"
Write-Host "Checksum: $checksumPath"
Write-Host "SHA256:   $hash"
if ($Push) {
    Write-Host "Pushing $Image..."
    Invoke-Docker @('image', 'push', $Image)
}
