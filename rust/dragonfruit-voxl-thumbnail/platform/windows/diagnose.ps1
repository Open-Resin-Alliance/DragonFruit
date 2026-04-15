# Diagnose Windows VOXL thumbnail handler registration.
#
# Usage:
#   .\diagnose.ps1 [-DllPath <path>] [-VoxlPath <path>]

param(
    [string]$DllPath,
    [string]$VoxlPath
)

$ErrorActionPreference = 'Continue'

$CLSID = '{8B4F2E3A-7C1D-4A5E-B9F0-6D2E8C3A1B5F}'
$ThumbnailHandlerCATID = '{E357FCCD-A995-4576-B01F-234630154E96}'

function Resolve-DllPath {
    param([string]$ScriptDir)

    $crateRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
    $candidates = @(
        (Join-Path $crateRoot 'windows-com\target\release\dragonfruit_voxl_thumbnail_com.dll'),
        (Join-Path $crateRoot ('windows-com\target\{0}\release\dragonfruit_voxl_thumbnail_com.dll' -f $env:TAURI_ENV_TARGET_TRIPLE)),
        (Join-Path $crateRoot 'target\release\dragonfruit_voxl_thumbnail_com.dll'),
        (Join-Path $crateRoot '..\..\src-tauri\windows-resources\dragonfruit_voxl_thumbnail_com.dll')
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    return $null
}

function Print-Check {
    param(
        [string]$Label,
        [bool]$Ok,
        [string]$Detail
    )

    $status = if ($Ok) { '[OK] ' } else { '[FAIL]' }
    Write-Host ("{0} {1}" -f $status, $Label)
    if ($Detail) {
        Write-Host ("       {0}" -f $Detail)
    }
}

function Coalesce {
    param(
        [object]$Value,
        [string]$Fallback
    )

    if ($null -eq $Value) {
        return $Fallback
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $Fallback
    }

    return $text
}

function Invoke-ShellThumbnailProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$Size = 256
    )

    $code = @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;

namespace VoxlShellProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx; public int cy; }

    [Flags]
    public enum SIIGBF : uint {
        BIGGERSIZEOK = 0x1,
        THUMBNAILONLY = 0x8
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
    public interface IShellItemImageFactory {
        [PreserveSig]
        int GetImage(SIZE size, SIIGBF flags, out IntPtr phbm);
    }

    public static class Native {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        public static extern int SHCreateItemFromParsingName(
            string pszPath,
            IntPtr pbc,
            ref Guid riid,
            out IntPtr ppv
        );

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr hObject);

        public static int Probe(string path, int size, string outputPng, out string detail) {
            detail = "";
            Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
            IntPtr ppv;
            int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out ppv);
            if (hr != 0 || ppv == IntPtr.Zero) {
                detail = string.Format("SHCreateItemFromParsingName failed: 0x{0:X8}", (uint)hr);
                return hr != 0 ? hr : unchecked((int)0x80004005);
            }

            IntPtr hbm = IntPtr.Zero;
            try {
                var factory = (IShellItemImageFactory)Marshal.GetObjectForIUnknown(ppv);
                var s = new SIZE { cx = size, cy = size };
                hr = factory.GetImage(s, SIIGBF.THUMBNAILONLY | SIIGBF.BIGGERSIZEOK, out hbm);
                if (hr != 0 || hbm == IntPtr.Zero) {
                    detail = string.Format("IShellItemImageFactory.GetImage failed: 0x{0:X8}", (uint)hr);
                    return hr != 0 ? hr : unchecked((int)0x80004005);
                }

                using (var bmp = Image.FromHbitmap(hbm)) {
                    bmp.Save(outputPng, ImageFormat.Png);
                }
                detail = outputPng;
                return 0;
            }
            catch (Exception ex) {
                detail = ex.GetType().Name + ": " + ex.Message;
                return unchecked((int)0x80004005);
            }
            finally {
                if (hbm != IntPtr.Zero) {
                    DeleteObject(hbm);
                }
                if (ppv != IntPtr.Zero) {
                    Marshal.Release(ppv);
                }
            }
        }
    }
}
'@

    try {
        Add-Type -TypeDefinition $code -ReferencedAssemblies @('System.Drawing') -ErrorAction Stop | Out-Null
    }
    catch {
        return @{ Ok = $false; Detail = ('Shell probe compilation failed: ' + $_.Exception.Message) }
    }

    $out = Join-Path $env:TEMP 'voxl_shell_probe.png'
    $detail = ''
    $hr = [VoxlShellProbe.Native]::Probe($Path, $Size, $out, [ref]$detail)
    if ($hr -eq 0) {
        return @{ Ok = $true; Detail = $detail }
    }

    return @{ Ok = $false; Detail = $detail }
}

if (-not $DllPath) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $DllPath = Resolve-DllPath -ScriptDir $ScriptDir
}

Write-Host "=== VOXL Thumbnail Handler Diagnostics ==="

$hasDll = $DllPath -and (Test-Path $DllPath)
Print-Check -Label 'COM DLL exists' -Ok $hasDll -Detail (Coalesce -Value $DllPath -Fallback '<not found>')

$inprocKey = "HKCU:\Software\Classes\CLSID\$CLSID\InProcServer32"
$shellExDotKey = "HKCU:\Software\Classes\.voxl\ShellEx\$ThumbnailHandlerCATID"
$shellExSystemKey = "HKCU:\Software\Classes\SystemFileAssociations\.voxl\ShellEx\$ThumbnailHandlerCATID"
$shellExLegacyKey = "HKCU:\Software\Classes\VoxlFile\shellex\$ThumbnailHandlerCATID"
$approvedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved'

$inprocExists = Test-Path $inprocKey
Print-Check -Label 'CLSID InProcServer32 key exists (HKCU)' -Ok $inprocExists -Detail $inprocKey

$shellExDotExists = Test-Path $shellExDotKey
Print-Check -Label '.voxl ShellEx key exists (HKCU)' -Ok $shellExDotExists -Detail $shellExDotKey

$shellExSystemExists = Test-Path $shellExSystemKey
Print-Check -Label 'SystemFileAssociations .voxl ShellEx key exists (HKCU)' -Ok $shellExSystemExists -Detail $shellExSystemKey

$shellExLegacyExists = Test-Path $shellExLegacyKey
Print-Check -Label ('Legacy VoxlFile ShellEx key (optional): ' + ($(if ($shellExLegacyExists) { 'present' } else { 'missing' }))) -Ok $true -Detail $shellExLegacyKey

$approvedValue = Get-ItemProperty -Path $approvedKey -Name $CLSID -ErrorAction SilentlyContinue
Print-Check -Label 'Shell Extensions Approved contains CLSID' -Ok ([bool]$approvedValue) -Detail $approvedKey

if ($inprocExists) {
    $defaultProp = (Get-ItemProperty -Path $inprocKey -ErrorAction SilentlyContinue).'(default)'
    if (-not $defaultProp) {
        $defaultProp = (Get-ItemProperty -Path $inprocKey -ErrorAction SilentlyContinue).'(Default)'
    }
    if (-not $defaultProp) {
        $defaultProp = (Get-Item -Path $inprocKey -ErrorAction SilentlyContinue).GetValue('')
    }

    $threadingModel = (Get-ItemProperty -Path $inprocKey -Name 'ThreadingModel' -ErrorAction SilentlyContinue).ThreadingModel
    Print-Check -Label 'InProc default path points to existing DLL' -Ok ([bool]$defaultProp -and (Test-Path $defaultProp)) -Detail (Coalesce -Value $defaultProp -Fallback '<missing default value>')
    Print-Check -Label 'ThreadingModel is Apartment' -Ok ($threadingModel -eq 'Apartment') -Detail (Coalesce -Value $threadingModel -Fallback '<missing>')
}

if ($VoxlPath) {
    $exists = Test-Path $VoxlPath
    Print-Check -Label 'Sample VOXL path exists' -Ok $exists -Detail $VoxlPath

    if ($exists) {
        $probe = Invoke-ShellThumbnailProbe -Path $VoxlPath -Size 256
        Print-Check -Label 'Shell thumbnail probe via IShellItemImageFactory' -Ok ([bool]$probe.Ok) -Detail $probe.Detail
    }
}

Write-Host ""
Write-Host "If all checks are OK but Explorer still shows icons:"
Write-Host "  1) ie4uinit.exe -show"
Write-Host "  2) Remove-Item \"$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db\" -Force -ErrorAction SilentlyContinue"
Write-Host "  3) Restart Explorer (or sign out/in)"
