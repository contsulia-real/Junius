$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct JuniusIoCounters {
    public UInt64 ReadOperationCount;
    public UInt64 WriteOperationCount;
    public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount;
    public UInt64 WriteTransferCount;
    public UInt64 OtherTransferCount;
}

[StructLayout(LayoutKind.Sequential)]
public struct JuniusBasicLimitInformation {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
}

[StructLayout(LayoutKind.Sequential)]
public struct JuniusExtendedLimitInformation {
    public JuniusBasicLimitInformation BasicLimitInformation;
    public JuniusIoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
}

public static class JuniusJobNative {
    public const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    public const Int32 JobObjectExtendedLimitInformation = 9;
    public const UInt32 SYNCHRONIZE = 0x00100000;
    public const UInt32 PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    public const UInt32 WAIT_OBJECT_0 = 0x00000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(
        IntPtr lpJobAttributes,
        string lpName
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(
        IntPtr hJob,
        Int32 JobObjectInfoClass,
        ref JuniusExtendedLimitInformation lpJobObjectInfo,
        UInt32 cbJobObjectInfoLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(
        IntPtr hJob,
        IntPtr hProcess
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(
        IntPtr ProcessHandle,
        IntPtr JobHandle,
        out bool Result
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(
        IntPtr hJob,
        Int32 JobObjectInfoClass,
        ref JuniusExtendedLimitInformation lpJobObjectInfo,
        UInt32 cbJobObjectInfoLength,
        out UInt32 lpReturnLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(
        UInt32 dwDesiredAccess,
        bool bInheritHandle,
        UInt32 dwProcessId
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern UInt32 WaitForSingleObject(
        IntPtr hHandle,
        UInt32 dwMilliseconds
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
}
"@

function Add-Backslashes {
    param(
        [System.Text.StringBuilder]$Builder,
        [int]$Count
    )

    for ($index = 0; $index -lt $Count; $index += 1) {
        [void]$Builder.Append('\')
    }
}

function ConvertTo-WindowsArgument {
    param([string]$Value)

    if (
        $Value.Length -gt 0 -and
        $Value -notmatch '[\s"]'
    ) {
        return $Value
    }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0

    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes += 1
            continue
        }

        if ($character -eq '"') {
            Add-Backslashes $builder ($backslashes * 2 + 1)
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }

        Add-Backslashes $builder $backslashes
        $backslashes = 0
        [void]$builder.Append($character)
    }

    Add-Backslashes $builder ($backslashes * 2)
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Process-Ended {
    param([IntPtr]$Handle)

    return (
        $Handle -ne [IntPtr]::Zero -and
        [JuniusJobNative]::WaitForSingleObject(
            $Handle,
            0
        ) -eq [JuniusJobNative]::WAIT_OBJECT_0
    )
}

$encodedPayload = [Console]::In.ReadLine()
if ([string]::IsNullOrWhiteSpace($encodedPayload)) {
    throw "job_guardian_payload_missing"
}

$payloadJson = [System.Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($encodedPayload)
)
$payload = $payloadJson | ConvertFrom-Json

$job = [IntPtr]::Zero
$owner = [IntPtr]::Zero
$hostHandle = [IntPtr]::Zero
$bootstrap = $null
$nonce = [Guid]::NewGuid().ToString("N")
$readyFile = Join-Path (
    [IO.Path]::GetTempPath()
) (
    "junius-job-ready-" +
    $nonce +
    ".txt"
)
$payloadFile = Join-Path (
    [IO.Path]::GetTempPath()
) (
    "junius-job-payload-" +
    $nonce +
    ".json"
)
$payloadStagingFile = Join-Path (
    [IO.Path]::GetTempPath()
) (
    "junius-job-payload-" +
    $nonce +
    ".tmp"
)
$exitCode = 1

try {
    $owner = [JuniusJobNative]::OpenProcess(
        [JuniusJobNative]::SYNCHRONIZE,
        $false,
        [uint32]$payload.ownerPid
    )
    if ($owner -eq [IntPtr]::Zero) {
        throw "job_guardian_owner_open_failed"
    }

    if (
        $payload.hostPid -ne $null -and
        [int]$payload.hostPid -gt 0
    ) {
        $hostHandle = [JuniusJobNative]::OpenProcess(
            [JuniusJobNative]::SYNCHRONIZE,
            $false,
            [uint32]$payload.hostPid
        )
        if ($hostHandle -eq [IntPtr]::Zero) {
            throw "job_guardian_host_open_failed"
        }
    }

    $job = [JuniusJobNative]::CreateJobObject(
        [IntPtr]::Zero,
        $null
    )
    if ($job -eq [IntPtr]::Zero) {
        throw "job_guardian_create_job_failed"
    }

    $basicLimits =
        New-Object JuniusBasicLimitInformation
    $basicLimits.LimitFlags =
        [JuniusJobNative]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

    $limits =
        New-Object JuniusExtendedLimitInformation
    $limits.BasicLimitInformation =
        $basicLimits

    $limitSize = [Runtime.InteropServices.Marshal]::SizeOf(
        [type][JuniusExtendedLimitInformation]
    )

    if (
        -not [JuniusJobNative]::SetInformationJobObject(
            $job,
            [JuniusJobNative]::JobObjectExtendedLimitInformation,
            [ref]$limits,
            [uint32]$limitSize
        )
    ) {
        throw "job_guardian_set_limit_failed"
    }

    $queriedLimits =
        New-Object JuniusExtendedLimitInformation
    $returnedLength = 0
    if (
        -not [JuniusJobNative]::QueryInformationJobObject(
            $job,
            [JuniusJobNative]::JobObjectExtendedLimitInformation,
            [ref]$queriedLimits,
            [uint32]$limitSize,
            [ref]$returnedLength
        )
    ) {
        throw "job_guardian_query_limit_failed"
    }

    if (
        (
            $queriedLimits.BasicLimitInformation.LimitFlags -band
            [JuniusJobNative]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ) -eq 0
    ) {
        throw "job_guardian_kill_on_close_not_set"
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName =
        [string]$payload.bootstrapExecutable
    $startInfo.Arguments =
        ConvertTo-WindowsArgument (
            [string]$payload.bootstrapPath
        )
    $startInfo.WorkingDirectory =
        [string]$payload.cwd
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $startInfo.EnvironmentVariables[
        "JUNIUS_JOB_READY_FILE"
    ] = $readyFile
    $startInfo.EnvironmentVariables[
        "JUNIUS_JOB_PAYLOAD_FILE"
    ] = $payloadFile

    [IO.File]::WriteAllText(
        $payloadStagingFile,
        $payloadJson,
        (New-Object Text.UTF8Encoding($false))
    )

    $bootstrap = New-Object System.Diagnostics.Process
    $bootstrap.StartInfo = $startInfo

    if (-not $bootstrap.Start()) {
        throw "job_guardian_bootstrap_start_failed"
    }

    if (
        -not [JuniusJobNative]::AssignProcessToJobObject(
            $job,
            $bootstrap.Handle
        )
    ) {
        throw "job_guardian_assign_failed"
    }

    $bootstrapInJob = $false
    if (
        -not [JuniusJobNative]::IsProcessInJob(
            $bootstrap.Handle,
            $job,
            [ref]$bootstrapInJob
        ) -or
        -not $bootstrapInJob
    ) {
        throw "job_guardian_bootstrap_not_in_job"
    }

    $stdout = [Console]::OpenStandardOutput()
    $stderr = [Console]::OpenStandardError()
    $stdoutCopy =
        $bootstrap.StandardOutput.BaseStream.CopyToAsync(
            $stdout
        )

    [IO.File]::Move(
        $payloadStagingFile,
        $payloadFile
    )

    $payloadPid = $null
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(10)

    while ($payloadPid -eq $null) {
        if (Process-Ended $owner) {
            $exitCode = 251
            break
        }
        if (Process-Ended $hostHandle) {
            $exitCode = 252
            break
        }

        if (Test-Path -LiteralPath $readyFile) {
            $readyText = (
                Get-Content -LiteralPath $readyFile -Raw
            ).Trim()
            $parsedPid = 0
            if (
                [int]::TryParse(
                    $readyText,
                    [ref]$parsedPid
                ) -and
                $parsedPid -gt 0
            ) {
                $payloadPid = $parsedPid
                break
            }
        }

        if ($bootstrap.HasExited) {
            $bootstrapError = (
                $bootstrap.StandardError.ReadToEnd()
            ) -replace "[\r\n]+", " | "
            throw (
                "job_guardian_bootstrap_exited_before_ready:" +
                $bootstrap.ExitCode +
                ":" +
                $bootstrapError
            )
        }

        if ([DateTime]::UtcNow -ge $readyDeadline) {
            throw "job_guardian_bootstrap_ready_timeout"
        }

        Start-Sleep -Milliseconds 20
    }

    if ($payloadPid -ne $null) {
        $payloadHandle = [JuniusJobNative]::OpenProcess(
            (
                [JuniusJobNative]::SYNCHRONIZE -bor
                [JuniusJobNative]::PROCESS_QUERY_LIMITED_INFORMATION
            ),
            $false,
            [uint32]$payloadPid
        )
        if ($payloadHandle -eq [IntPtr]::Zero) {
            [void]$bootstrap.WaitForExit(100)
            if (
                -not $bootstrap.HasExited -or
                $bootstrap.ExitCode -ne 0
            ) {
                throw "job_guardian_payload_open_failed"
            }
        }
        else {
            try {
                $payloadInJob = $false
                if (
                    -not [JuniusJobNative]::IsProcessInJob(
                        $payloadHandle,
                        $job,
                        [ref]$payloadInJob
                    ) -or
                    -not $payloadInJob
                ) {
                    throw "job_guardian_payload_not_in_job"
                }
            }
            finally {
                [void][JuniusJobNative]::CloseHandle(
                    $payloadHandle
                )
            }
        }

        $ready = [System.Text.Encoding]::ASCII.GetBytes(
            "@@JUNIUS_JOB_READY@@:" +
            $payloadPid +
            "`n"
        )
        $stderr.Write($ready, 0, $ready.Length)
        $stderr.Flush()

        $stderrCopy =
            $bootstrap.StandardError.BaseStream.CopyToAsync(
                $stderr
            )

        while (-not $bootstrap.HasExited) {
            if (Process-Ended $owner) {
                $exitCode = 251
                break
            }
            if (Process-Ended $hostHandle) {
                $exitCode = 252
                break
            }

            Start-Sleep -Milliseconds 50
        }

        if ($bootstrap.HasExited) {
            $bootstrap.WaitForExit()
            $stdoutCopy.Wait()
            $stderrCopy.Wait()
            $exitCode = $bootstrap.ExitCode
        }
    }
}
finally {
    if ($job -ne [IntPtr]::Zero) {
        [void][JuniusJobNative]::CloseHandle($job)
    }
    if ($owner -ne [IntPtr]::Zero) {
        [void][JuniusJobNative]::CloseHandle($owner)
    }
    if ($hostHandle -ne [IntPtr]::Zero) {
        [void][JuniusJobNative]::CloseHandle($hostHandle)
    }

    if ($bootstrap -ne $null) {
        $bootstrap.Dispose()
    }

    Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $payloadFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $payloadStagingFile -Force -ErrorAction SilentlyContinue
}

exit $exitCode
