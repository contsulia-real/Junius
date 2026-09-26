$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class JuniusSandboxApiProbeNative
{
    public const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadLibraryExW(
        string lpFileName,
        IntPtr hFile,
        uint dwFlags
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr GetProcAddress(
        IntPtr hModule,
        string lpProcName
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FreeLibrary(IntPtr hModule);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RTL_OSVERSIONINFOEXW
    {
        public uint dwOSVersionInfoSize;
        public uint dwMajorVersion;
        public uint dwMinorVersion;
        public uint dwBuildNumber;
        public uint dwPlatformId;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szCSDVersion;

        public ushort wServicePackMajor;
        public ushort wServicePackMinor;
        public ushort wSuiteMask;
        public byte wProductType;
        public byte wReserved;
    }

    [DllImport("ntdll.dll", CharSet = CharSet.Unicode)]
    public static extern int RtlGetVersion(
        ref RTL_OSVERSIONINFOEXW versionInfo
    );
}
"@

$version = New-Object JuniusSandboxApiProbeNative+RTL_OSVERSIONINFOEXW
$version.dwOSVersionInfoSize = [Runtime.InteropServices.Marshal]::SizeOf($version)
$rtlStatus = [JuniusSandboxApiProbeNative]::RtlGetVersion([ref]$version)

$module = [JuniusSandboxApiProbeNative]::LoadLibraryExW(
    "processmodel.dll",
    [IntPtr]::Zero,
    [JuniusSandboxApiProbeNative]::LOAD_LIBRARY_SEARCH_SYSTEM32
)

$dllAvailable = $module -ne [IntPtr]::Zero
$loadError = if ($dllAvailable) {
    $null
} else {
    [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}

$createProcessExport = $false
$createProcessAsUserExport = $false

if ($dllAvailable) {
    try {
        $createProcessExport =
            [JuniusSandboxApiProbeNative]::GetProcAddress(
                $module,
                "Experimental_CreateProcessInSandbox"
            ) -ne [IntPtr]::Zero

        $createProcessAsUserExport =
            [JuniusSandboxApiProbeNative]::GetProcAddress(
                $module,
                "Experimental_CreateProcessAsUserInSandbox"
            ) -ne [IntPtr]::Zero
    }
    finally {
        [void][JuniusSandboxApiProbeNative]::FreeLibrary($module)
    }
}

$result = [ordered]@{
    platform = "win32"
    windowsVersion = if ($rtlStatus -eq 0) {
        "$($version.dwMajorVersion).$($version.dwMinorVersion).$($version.dwBuildNumber)"
    } else {
        $null
    }
    rtlGetVersionStatus = $rtlStatus
    processModelDllAvailable = $dllAvailable
    processModelDllLoadError = $loadError
    experimentalCreateProcessInSandbox = $createProcessExport
    experimentalCreateProcessAsUserInSandbox = $createProcessAsUserExport
    candidateUsable =
        $dllAvailable -and
        $createProcessExport
}

$result | ConvertTo-Json -Depth 4
