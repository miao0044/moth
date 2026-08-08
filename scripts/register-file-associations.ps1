<#
.SYNOPSIS
Registers Moth as a per-user handler for its supported file types.

.DESCRIPTION
Creates idempotent associations below HKCU only. The script never writes the
Explorer UserChoice key or attempts to manufacture its protected hash. Windows
therefore remains in control of the user's effective default application.

The legacy MDViewer.md ProgID is removed only after a complete UserChoice scan
confirms that no extension still relies on it. If it is still selected, choose
Moth in Windows Default Apps and run this script again.

.EXAMPLE
.\scripts\register-file-associations.ps1

.EXAMPLE
.\scripts\register-file-associations.ps1 -OpenDefaultAppsSettings

.EXAMPLE
.\scripts\register-file-associations.ps1 -ExecutablePath 'D:\Apps\Moth.exe'
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Position = 0)]
    [string]$ExecutablePath,

    [switch]$OpenDefaultAppsSettings
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $ExecutablePath = Join-Path $projectRoot 'release\win-unpacked\Moth.exe'
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Moth file associations can only be registered on Windows.'
}

$executableItem = Get-Item -LiteralPath $ExecutablePath -Force -ErrorAction Stop
if ($executableItem -isnot [System.IO.FileInfo]) {
    throw "ExecutablePath must identify a file: $ExecutablePath"
}

$resolvedExecutable = $executableItem.FullName
if ([System.IO.Path]::GetFileName($resolvedExecutable) -ine 'Moth.exe') {
    throw "ExecutablePath must point to Moth.exe: $resolvedExecutable"
}

if ($executableItem.Length -le 0) {
    throw "Moth.exe is empty and cannot be registered: $resolvedExecutable"
}

$executableStream = [System.IO.File]::OpenRead($resolvedExecutable)
$executableReader = [System.IO.BinaryReader]::new($executableStream)
try {
    if ($executableStream.Length -lt 64 -or $executableReader.ReadUInt16() -ne 0x5A4D) {
        throw "ExecutablePath is not a Windows PE executable: $resolvedExecutable"
    }

    $null = $executableStream.Seek(0x3C, [System.IO.SeekOrigin]::Begin)
    $peHeaderOffset = $executableReader.ReadInt32()
    if ($peHeaderOffset -lt 64 -or $peHeaderOffset -gt ($executableStream.Length - 4)) {
        throw "ExecutablePath has an invalid Windows PE header offset: $resolvedExecutable"
    }

    $null = $executableStream.Seek($peHeaderOffset, [System.IO.SeekOrigin]::Begin)
    if ($executableReader.ReadUInt32() -ne 0x00004550) {
        throw "ExecutablePath has an invalid Windows PE signature: $resolvedExecutable"
    }
}
finally {
    $executableReader.Dispose()
}

$versionInfo = $executableItem.VersionInfo
if ($versionInfo.ProductName -ine 'Moth' -or $versionInfo.FileDescription -ine 'Moth') {
    throw "ExecutablePath does not contain Moth product metadata: $resolvedExecutable"
}

if (-not (Get-PSDrive -Name HKCU -PSProvider Registry -ErrorAction SilentlyContinue)) {
    throw 'The HKCU registry drive is unavailable.'
}

function Ensure-RegistryKey {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        if ($PSCmdlet.ShouldProcess($Path, 'Create registry key')) {
            $null = New-Item -Path $Path -Force
        }
    }
}

function Set-RegistryDefaultValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Value
    )

    Ensure-RegistryKey -Path $Path
    if ($PSCmdlet.ShouldProcess($Path, "Set default value to '$Value'")) {
        Set-Item -LiteralPath $Path -Value $Value
    }
}

function Set-RegistryStringValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Value
    )

    Ensure-RegistryKey -Path $Path
    if ($PSCmdlet.ShouldProcess("$Path [$Name]", "Set string value to '$Value'")) {
        $null = New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType String -Force
    }
}

function Find-UserChoiceReferences {
    param([Parameter(Mandatory)][string]$ProgId)

    $fileExtsRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts'
    $references = @()

    if (-not (Test-Path -LiteralPath $fileExtsRoot)) {
        return [pscustomobject]@{
            Succeeded  = $true
            Extensions = @()
        }
    }

    try {
        foreach ($extensionKey in Get-ChildItem -LiteralPath $fileExtsRoot -ErrorAction Stop) {
            $userChoicePath = Join-Path $extensionKey.PSPath 'UserChoice'
            if (-not (Test-Path -LiteralPath $userChoicePath)) {
                continue
            }

            $userChoice = Get-ItemProperty -LiteralPath $userChoicePath -ErrorAction Stop
            $progIdProperty = $userChoice.PSObject.Properties['ProgId']
            if ($null -ne $progIdProperty -and [string]$progIdProperty.Value -ieq $ProgId) {
                $references += $extensionKey.PSChildName
            }
        }

        return [pscustomobject]@{
            Succeeded  = $true
            Extensions = @($references)
        }
    }
    catch {
        Write-Warning "Could not complete the UserChoice scan. The legacy ProgID will be retained. $($_.Exception.Message)"
        return [pscustomobject]@{
            Succeeded  = $false
            Extensions = @()
        }
    }
}

$classesRoot = 'HKCU:\Software\Classes'
$progIdSpecs = @(
    [pscustomobject]@{ ProgId = 'Moth.md';    Description = 'Moth Markdown Document' },
    [pscustomobject]@{ ProgId = 'Moth.txt';   Description = 'Moth Text Document' },
    [pscustomobject]@{ ProgId = 'Moth.json';  Description = 'Moth JSON Document' },
    [pscustomobject]@{ ProgId = 'Moth.jsonl'; Description = 'Moth JSON Lines Document' },
    [pscustomobject]@{ ProgId = 'Moth.epub';  Description = 'Moth EPUB Book' }
)

$associationSpecs = @(
    [pscustomobject]@{ Extension = '.md';       ProgId = 'Moth.md';    ContentType = 'text/markdown' },
    [pscustomobject]@{ Extension = '.markdown'; ProgId = 'Moth.md';    ContentType = 'text/markdown' },
    [pscustomobject]@{ Extension = '.txt';      ProgId = 'Moth.txt';   ContentType = 'text/plain' },
    [pscustomobject]@{ Extension = '.json';     ProgId = 'Moth.json';  ContentType = 'application/json' },
    [pscustomobject]@{ Extension = '.jsonl';    ProgId = 'Moth.jsonl'; ContentType = 'application/x-ndjson' },
    [pscustomobject]@{ Extension = '.epub';     ProgId = 'Moth.epub';  ContentType = 'application/epub+zip' }
)

$quotedExecutable = '"{0}"' -f $resolvedExecutable
$openCommand = '{0} "%1"' -f $quotedExecutable
$defaultIcon = '{0},0' -f $quotedExecutable

foreach ($progIdSpec in $progIdSpecs) {
    $progIdPath = Join-Path $classesRoot $progIdSpec.ProgId
    Set-RegistryDefaultValue -Path $progIdPath -Value $progIdSpec.Description
    Set-RegistryDefaultValue -Path (Join-Path $progIdPath 'DefaultIcon') -Value $defaultIcon
    Set-RegistryDefaultValue -Path (Join-Path $progIdPath 'shell\open\command') -Value $openCommand
    Set-RegistryStringValue -Path (Join-Path $progIdPath 'Application') -Name 'ApplicationName' -Value 'Moth'
    Set-RegistryStringValue -Path (Join-Path $progIdPath 'Application') -Name 'ApplicationDescription' -Value 'A focused text editor and EPUB reader.'
}

foreach ($associationSpec in $associationSpecs) {
    $extensionPath = Join-Path $classesRoot $associationSpec.Extension
    Set-RegistryDefaultValue -Path $extensionPath -Value $associationSpec.ProgId
    Set-RegistryStringValue -Path $extensionPath -Name 'Content Type' -Value $associationSpec.ContentType
    Set-RegistryStringValue -Path (Join-Path $extensionPath 'OpenWithProgids') -Name $associationSpec.ProgId -Value ''
}

$capabilitiesPath = 'HKCU:\Software\Moth\Capabilities'
Set-RegistryStringValue -Path $capabilitiesPath -Name 'ApplicationName' -Value 'Moth'
Set-RegistryStringValue -Path $capabilitiesPath -Name 'ApplicationDescription' -Value 'A focused text editor and EPUB reader.'
Set-RegistryStringValue -Path $capabilitiesPath -Name 'ApplicationIcon' -Value $defaultIcon

$fileAssociationsPath = Join-Path $capabilitiesPath 'FileAssociations'
foreach ($associationSpec in $associationSpecs) {
    Set-RegistryStringValue -Path $fileAssociationsPath -Name $associationSpec.Extension -Value $associationSpec.ProgId
}

Set-RegistryStringValue -Path 'HKCU:\Software\RegisteredApplications' -Name 'Moth' -Value 'Software\Moth\Capabilities'

$legacyProgId = 'MDViewer.md'
$legacyReferences = Find-UserChoiceReferences -ProgId $legacyProgId
if ($legacyReferences.Succeeded -and $legacyReferences.Extensions.Count -eq 0) {
    $legacyProgIdPath = Join-Path $classesRoot $legacyProgId
    if (Test-Path -LiteralPath $legacyProgIdPath) {
        if ($PSCmdlet.ShouldProcess($legacyProgIdPath, 'Remove unused legacy ProgID')) {
            Remove-Item -LiteralPath $legacyProgIdPath -Recurse -Force
        }
    }

    foreach ($associationSpec in $associationSpecs) {
        $openWithPath = Join-Path (Join-Path $classesRoot $associationSpec.Extension) 'OpenWithProgids'
        if (-not (Test-Path -LiteralPath $openWithPath)) {
            continue
        }

        $openWithValues = Get-ItemProperty -LiteralPath $openWithPath
        if ($null -ne $openWithValues.PSObject.Properties[$legacyProgId]) {
            if ($PSCmdlet.ShouldProcess("$openWithPath [$legacyProgId]", 'Remove unused legacy OpenWith entry')) {
                Remove-ItemProperty -LiteralPath $openWithPath -Name $legacyProgId -Force
            }
        }
    }
}
elseif ($legacyReferences.Succeeded) {
    $extensions = $legacyReferences.Extensions -join ', '
    Write-Warning "Retained $legacyProgId because it is still the UserChoice for: $extensions. Select Moth in Windows Default Apps, then run this script again to clean it safely."
}

if ($PSCmdlet.ShouldProcess('Windows Shell', 'Refresh file associations and icons')) {
    $shellRefreshType = ([System.Management.Automation.PSTypeName]'MothShellRefresh').Type
    if (-not $shellRefreshType) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MothShellRefresh
{
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
        $shellRefreshType = ([System.Management.Automation.PSTypeName]'MothShellRefresh').Type
    }
    # SHCNE_ASSOCCHANGED tells Explorer to invalidate association and icon data.
    $shellRefreshType.GetMethod('SHChangeNotify').Invoke(
        $null,
        [object[]]@([uint32]0x08000000, [uint32]0, [IntPtr]::Zero, [IntPtr]::Zero)
    ) | Out-Null
}

Write-Output "Registered Moth file handlers for the current user using: $resolvedExecutable"

if ($OpenDefaultAppsSettings) {
    $settingsUri = 'ms-settings:defaultapps?registeredAppUser=Moth'
    if ($PSCmdlet.ShouldProcess($settingsUri, 'Open Windows Default Apps settings')) {
        Start-Process $settingsUri
    }
}
