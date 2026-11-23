#requires -Version 7.2
[CmdletBinding()]
param(
    [string]$Python,
    [string]$WorkerScript,
    [string[]]$WorkerArguments = @(),
    [string]$Queue,
    [ValidateRange(1, 1000000)][int]$PlannedPeakMiB,
    [ValidateRange(1, 144000)][int]$MaxGpuSeconds,
    [ValidateRange(1024, 1000000)][int]$HeadroomMiB = 4096,
    [ValidateRange(0, 16)][int]$GpuIndex = 0,
    [ValidateRange(2, 60)][int]$IdleSamples = 5,
    [ValidateRange(0, 172800)][int]$WaitSeconds = 0,
    [ValidateRange(0, 9007199254740991)][long]$DeadlineAtMs = 0,
    [string]$DispatchId,
    [int]$ProbeCompositorFallbackPid = -1,
    [ValidateRange(0.01, 1.0)][double]$ActivityThresholdPercent = 0.1,
    [ValidateRange(16, 524)][int]$ReleaseToleranceMiB = 192,
    [string]$HandoffFile,
    [switch]$Smoke,
    [switch]$Probe,
    [switch]$FunctionsOnly
)

$ErrorActionPreference = 'Stop'
$PSStyle.OutputRendering = 'PlainText'
$maxSampleAge = 5
$idleProbeRecoverySeconds = 20
$probeRestartIntervalSeconds = 5
$releaseVerificationSeconds = 20
$releaseBudgetSeconds = 31
$sessionCompositor = @{ checked = $false; pid = $null }

function Convert-GpuCounters($Samples) {
    $engines = @{}
    $memory = @{}
    $engineCount = 0
    $memoryCount = 0
    foreach ($sample in $Samples) {
        if ($sample.InstanceName -notmatch '^pid_(\d+)_luid_') { throw 'Unrecognized WDDM GPU counter instance.' }
        $ownerId = [int]$Matches[1]
        $value = [double]$sample.CookedValue
        # A new instance needs a second rate sample. Fail closed rather than assume idle.
        if ($sample.Status -notin (0, 1) -or -not [double]::IsFinite($value) -or $value -lt 0) {
            throw 'Invalid WDDM GPU counter value.'
        }
        if ($sample.Path -match '\\utilization percentage$') {
            $engineCount += 1
            $engines[$ownerId] = [Math]::Max([double]$engines[$ownerId], $value)
        } elseif ($sample.Path -match '\\dedicated usage$') {
            $memoryCount += 1
            $memory[$ownerId] = [double]$memory[$ownerId] + $value / 1MB
        } else {
            throw 'Unexpected WDDM GPU counter.'
        }
    }
    if ($engineCount -eq 0 -or $memoryCount -eq 0) { throw 'Missing WDDM engine or dedicated-memory counters.' }
    $rows = foreach ($ownerId in @($engines.Keys) + @($memory.Keys) | Sort-Object -Unique) {
        @{ pid = $ownerId; activity = [double]$engines[$ownerId]; dedicatedMiB = [double]$memory[$ownerId] }
    }
    return @($rows)
}

function Get-CompositorIds {
    $systemDwm = Join-Path ([Environment]::SystemDirectory) 'dwm.exe'
    $observerSession = (Get-Process -Id $PID).SessionId
    $candidates = @(Get-Process -Name 'dwm' -ErrorAction SilentlyContinue)
    $sameSession = @($candidates | Where-Object { $_.SessionId -gt 0 -and $_.SessionId -eq $observerSession })
    $firstPass = -not $sessionCompositor.checked
    $sessionCompositor.checked = $true
    if ($sessionCompositor.pid -and ($sameSession.Count -ne 1 -or $sameSession[0].Id -ne $sessionCompositor.pid)) {
        # A disappeared or ambiguous compositor invalidates the fallback for the entire run.
        $sessionCompositor.pid = $null
    }
    foreach ($process in $candidates) {
        if ($process.SessionId -le 0) { continue }
        $image = [CodexAgents.ProcessIdentity]::ImagePath($process.Id)
        if ($image -eq $systemDwm -or (-not $image -and
            [CodexAgents.ProcessIdentity]::HasWindowManagerIdentity($process.Id, $process.SessionId))) {
            $process.Id
        } elseif (-not $image -and $process.ProcessName -eq 'dwm' -and $sameSession.Count -eq 1 -and
            $sameSession[0].Id -eq $process.Id) {
            if ($firstPass) { $sessionCompositor.pid = $process.Id }
            if ($sessionCompositor.pid -eq $process.Id) { $process.Id }
        } elseif ($sessionCompositor.pid -eq $process.Id) {
            $sessionCompositor.pid = $null
        }
    }
}

function Read-GpuTelemetry($Smi) {
    $adapter = @(& $Smi "--id=$GpuIndex" '--query-gpu=uuid,memory.total,memory.used,memory.free' '--format=csv,noheader,nounits')
    if ($LASTEXITCODE -ne 0 -or $adapter.Count -ne 1 -or
        $adapter[0] -notmatch '^(GPU-[A-Fa-f0-9-]+),\s*(\d+),\s*(\d+),\s*(\d+)\s*$') {
        throw 'NVIDIA adapter memory telemetry is unavailable.'
    }
    $uuid = $Matches[1]
    $totalMiB = [int]$Matches[2]
    $usedMiB = [int]$Matches[3]
    $freeMiB = [int]$Matches[4]
    if ($totalMiB -le 0 -or $usedMiB + $freeMiB -gt $totalMiB) { throw 'Invalid NVIDIA adapter memory telemetry.' }

    $compute = @(& $Smi "--id=$uuid" '--query-compute-apps=pid' '--format=csv,noheader,nounits')
    if ($LASTEXITCODE -ne 0) { throw 'NVIDIA compute context telemetry is unavailable.' }
    $computeIds = @(foreach ($line in $compute) {
        $line = $line.Trim()
        if ($line -eq '' -or $line -eq 'No running processes found') { continue }
        if ($line -notmatch '^\d+$') { throw 'Unrecognized NVIDIA compute context telemetry.' }
        [int]$line
    })

    $counters = Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage', '\GPU Process Memory(*)\Dedicated Usage' `
        -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop
    $processes = @(Convert-GpuCounters $counters.CounterSamples)
    $compositorIds = @(Get-CompositorIds)
    foreach ($engine in $processes) {
        if ($engine.activity -gt 0) {
            $engine.name = (Get-Process -Id $engine.pid -ErrorAction SilentlyContinue).ProcessName
        }
    }
    $computeRows = @(foreach ($ownerId in $computeIds) {
        $owner = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
        @{ pid = $ownerId; name = $owner.ProcessName }
    })
    return @{ ok = $true; observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); uuid = $uuid;
        totalMiB = $totalMiB; usedMiB = $usedMiB; freeMiB = $freeMiB; processes = $processes;
        compute = $computeRows; compositorIds = $compositorIds; compositorSessionFallbackPid = $sessionCompositor.pid }
}

function Get-GpuOccupancy($Sample, [int]$OwnId = -1) {
    $externalCompute = @($Sample.compute | Where-Object { $_.pid -ne $OwnId -and $_.pid -notin $Sample.compositorIds })
    $ownMemory = [double](($Sample.processes | Where-Object pid -EQ $OwnId | Measure-Object dedicatedMiB -Sum).Sum)
    $externalEngine = @($Sample.processes | Where-Object {
        # WDDM charges weight-transfer work to the kernel while our child acquires VRAM.
        $kernelHousekeeping = $_.pid -eq 4 -and $_.name -eq 'System' -and $_.dedicatedMiB -lt 16 -and
            ($_.activity -lt 2 -or ($OwnId -gt 0 -and $ownMemory -ge 128))
        $_.pid -ne $OwnId -and $_.pid -notin $Sample.compositorIds -and $_.activity -ge $ActivityThresholdPercent -and -not $kernelHousekeeping
    })
    $ownEngine = [double](($Sample.processes | Where-Object pid -EQ $OwnId | Measure-Object activity -Maximum).Maximum)
    return @{ compute = $externalCompute; engines = $externalEngine; ownMiB = $ownMemory; ownActivity = $ownEngine;
        ownCompute = $OwnId -in @($Sample.compute | ForEach-Object pid) }
}

function Write-WatchEvent([string]$Event, [hashtable]$Fields = @{}) {
    $entry = @{ event = $Event; timestamp = [DateTimeOffset]::UtcNow.ToString('o') } + $Fields
    [IO.File]::AppendAllText($logFile, ($entry | ConvertTo-Json -Depth 5 -Compress) + "`n")
    $message = if ($Fields.ContainsKey('reason')) { " ($($Fields.reason))" } else { '' }
    Write-Host "$($entry.timestamp) $Event$message"
}

function New-ChildStart([string]$Executable, [string[]]$Arguments) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new($Executable)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
    return $startInfo
}

function Start-Telemetry([int]$CompositorFallbackPid) {
    $pwsh = (Get-Process -Id $PID).Path
    $startInfo = New-ChildStart $pwsh @('-NoProfile', '-NonInteractive', '-File', $PSCommandPath, '-Probe', '-GpuIndex', "$GpuIndex",
        '-ProbeCompositorFallbackPid', "$CompositorFallbackPid")
    $startInfo.RedirectStandardOutput = $true
    $job = [CodexAgents.OwnedJob]::new()
    $process = $null
    $attached = $false
    try {
        $process = [Diagnostics.Process]::Start($startInfo)
        $job.Attach($process.Handle)
        $attached = $true
        return @{ process = $process; job = $job; pending = $process.StandardOutput.ReadLineAsync() }
    } catch {
        $job.Dispose()
        if ($process) {
            try {
                if (-not $attached -and -not $process.HasExited) { $process.Kill() }
            } finally { $process.Dispose() }
        }
        throw
    }
}

function Stop-Telemetry($Telemetry) {
    if ($Telemetry.job) { $Telemetry.job.Dispose() }
    if ($Telemetry.process) { $Telemetry.process.Dispose() }
    $Telemetry.job = $null
    $Telemetry.process = $null
    $Telemetry.pending = $null
}

function New-TelemetryState {
    return @{ process = $null; job = $null; pending = $null; latest = $null; notice = 0; gap = 0;
        lastValid = $watchClock.Elapsed.TotalSeconds; lastObservedAt = 0L; retryAt = 0.0;
        fallbackPid = -1; needsRestart = $true; fault = 'probe-start' }
}

function Clear-TelemetrySample($Telemetry, [string]$Reason, [bool]$NeedsRestart = $false) {
    $Telemetry.latest = $null
    $Telemetry.gap += 1
    $Telemetry.fault = $Reason
    $Telemetry.needsRestart = $Telemetry.needsRestart -or $NeedsRestart
}

function Restart-TelemetryIfNeeded($Telemetry, [string]$Phase, [double]$InvalidSeconds) {
    $now = $watchClock.Elapsed.TotalSeconds
    if ($now -lt $Telemetry.retryAt -or (-not $Telemetry.needsRestart -and $now - $Telemetry.lastValid -lt $InvalidSeconds)) { return }
    $reason = $Telemetry.fault
    Stop-Telemetry $Telemetry
    Clear-TelemetrySample $Telemetry $reason $true
    $Telemetry.lastValid = $now
    $Telemetry.lastObservedAt = 0L
    $Telemetry.retryAt = $now + $probeRestartIntervalSeconds
    try {
        $probe = Start-Telemetry $Telemetry.fallbackPid
        $Telemetry.process = $probe.process
        $Telemetry.job = $probe.job
        $Telemetry.pending = $probe.pending
        $Telemetry.needsRestart = $false
    } catch {
        $Telemetry.fault = $_.Exception.Message
    }
    Write-WatchEvent 'telemetry-restart' @{ reason = $reason; phase = $Phase; probePid = $Telemetry.process.Id;
        started = ($null -ne $Telemetry.process); telemetryError = $Telemetry.fault }
}

function Test-SampleShape($Sample) {
    if ($Sample -isnot [Collections.IDictionary] -or $Sample.ok -isnot [bool] -or -not $Sample.ok -or
        $Sample.observedAt -isnot [long] -or $Sample.uuid -cnotmatch '^GPU-[A-Fa-f0-9-]+$' -or
        $Sample.totalMiB -isnot [long] -or $Sample.usedMiB -isnot [long] -or $Sample.freeMiB -isnot [long] -or
        $Sample.totalMiB -le 0 -or $Sample.usedMiB -lt 0 -or $Sample.freeMiB -lt 0 -or
        $Sample.usedMiB + $Sample.freeMiB -gt $Sample.totalMiB -or
        $Sample.processes -isnot [array] -or $Sample.compute -isnot [array] -or $Sample.compositorIds -isnot [array]) { return $false }
    foreach ($row in $Sample.processes) {
        if ($row -isnot [Collections.IDictionary] -or $row.pid -isnot [long] -or $row.pid -le 0 -or
            $row.activity -isnot [ValueType] -or -not [double]::IsFinite($row.activity) -or $row.activity -lt 0 -or
            $row.dedicatedMiB -isnot [ValueType] -or -not [double]::IsFinite($row.dedicatedMiB) -or $row.dedicatedMiB -lt 0) { return $false }
    }
    foreach ($row in $Sample.compute) {
        if ($row -isnot [Collections.IDictionary] -or $row.pid -isnot [long] -or $row.pid -le 0) { return $false }
    }
    foreach ($ownerId in $Sample.compositorIds) {
        if ($ownerId -isnot [long] -or $ownerId -le 0) { return $false }
    }
    $fallback = $Sample.compositorSessionFallbackPid
    return ($null -eq $fallback -or ($fallback -is [long] -and $fallback -in $Sample.compositorIds -and $fallback -le [int]::MaxValue))
}

function Read-Latest($Telemetry) {
    if ($Telemetry.needsRestart) { return $null }
    $previousGap = $Telemetry.gap
    try {
        while ($Telemetry.pending -and $Telemetry.pending.IsCompleted) {
            $line = $Telemetry.pending.GetAwaiter().GetResult()
            if ($null -eq $line) {
                Clear-TelemetrySample $Telemetry 'probe-eof' $true
                $Telemetry.pending = $null
                return $null
            }
            $Telemetry.pending = $Telemetry.process.StandardOutput.ReadLineAsync()
            $Telemetry.notice += 1
            $sample = $line | ConvertFrom-Json -AsHashtable
            if (-not (Test-SampleShape $sample)) {
                $reason = if ($sample -is [Collections.IDictionary] -and $sample.error) { $sample.error } else { 'invalid-probe-sample' }
                Clear-TelemetrySample $Telemetry $reason
                continue
            }
            $ageMs = [Math]::Abs([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $sample.observedAt)
            if ($ageMs -gt $maxSampleAge * 1000 -or $sample.observedAt -le $Telemetry.lastObservedAt) {
                Clear-TelemetrySample $Telemetry 'stale-probe-sample'
                continue
            }
            $fallback = [int]$sample.compositorSessionFallbackPid
            if ($Telemetry.fallbackPid -ne -1 -and $fallback -ne 0 -and $fallback -ne $Telemetry.fallbackPid) {
                Clear-TelemetrySample $Telemetry 'unexpected-compositor-fallback' $true
                return $null
            }
            $Telemetry.fallbackPid = $fallback
            $Telemetry.lastObservedAt = $sample.observedAt
            $Telemetry.lastValid = $watchClock.Elapsed.TotalSeconds - $ageMs / 1000.0
            $Telemetry.latest = $sample
            $Telemetry.fault = $null
        }
    } catch {
        Clear-TelemetrySample $Telemetry $_.Exception.Message $true
        return $null
    }
    $sample = $Telemetry.latest
    if ($sample -and [Math]::Abs([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $sample.observedAt) -gt $maxSampleAge * 1000) {
        Clear-TelemetrySample $Telemetry 'stale-probe-sample'
    }
    if ($Telemetry.gap -eq $previousGap) { return $Telemetry.latest }
}

function Get-Handoff {
    try {
        $info = Get-Item -LiteralPath $HandoffFile -Force
        if ($info.PSIsContainer) { return @{ valid = $false; key = 'directory' } }
        if ($info.Length -gt 4096) { return @{ valid = $false; key = 'oversize' } }
        $stamp = $info.LastWriteTimeUtc.ToString('o')
        $hash = (Get-FileHash -LiteralPath $HandoffFile -Algorithm SHA256).Hash
        return @{ valid = $true; key = "$stamp/$hash"; modifiedUtc = $stamp; sha256 = $hash }
    } catch [System.Management.Automation.ItemNotFoundException] {
        return $null
    } catch {
        # An in-progress or unreadable marker still vetoes inference.
        return @{ valid = $false; key = 'unreadable' }
    }
}

function Write-AtomicJson([string]$Path, $Body) {
    $temp = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temp, ($Body | ConvertTo-Json -Compress -Depth 6) + "`n")
        [IO.File]::Move($temp, $Path, $true)
    } finally {
        [IO.File]::Delete($temp)
    }
}

function Publish-HandoffAck($Marker) {
    if (-not $Marker.valid -or $handoffState.acknowledged -eq $Marker.key) { return }
    Write-AtomicJson "$HandoffFile.ack.json" @{ requestModifiedUtc = $Marker.modifiedUtc; requestSha256 = $Marker.sha256;
        status = 'released'; acknowledgedAt = [DateTimeOffset]::UtcNow.ToString('o') }
    $handoffState.acknowledged = $Marker.key
    Write-WatchEvent 'handoff-acknowledged'
}

function Test-WallDeadline {
    return (($DeadlineAtMs -gt 0 -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $DeadlineAtMs) -or
        ($WaitSeconds -gt 0 -and $watchClock.Elapsed.TotalSeconds -ge $WaitSeconds))
}

function Wait-IdleGpu($Telemetry) {
    $idleCount = 0
    $lastNotice = -1
    $lastReason = $null
    $lastLog = -30.0
    while (-not (Test-WallDeadline)) {
        $sample = Read-Latest $Telemetry
        $marker = Get-Handoff
        $state = @{}
        if ($marker) {
            Publish-HandoffAck $marker
            $reason = 'handoff-requested'
        } elseif (-not $sample) {
            $reason = 'telemetry-unavailable'
        } else {
            $state = Get-GpuOccupancy $sample
            if ($sample.totalMiB -lt $PlannedPeakMiB + $HeadroomMiB) { throw 'Model allocation plus headroom exceeds adapter capacity.' }
            if ($state.compute.Count -gt 0) { $reason = 'external-compute-context' }
            elseif ($state.engines.Count -gt 0) { $reason = 'external-engine-activity' }
            elseif ($sample.freeMiB -lt $PlannedPeakMiB + $HeadroomMiB) { $reason = 'insufficient-free-vram' }
            else { $reason = 'confirming-idle' }
        }
        if ($reason -ne 'confirming-idle') { $idleCount = 0 }
        elseif ($Telemetry.notice -ne $lastNotice) { $idleCount += 1 }
        $lastNotice = $Telemetry.notice
        if ($idleCount -ge $IdleSamples -and -not (Test-WallDeadline)) { return $sample }
        if ($reason -ne $lastReason -or $watchClock.Elapsed.TotalSeconds - $lastLog -ge 30) {
            Write-WatchEvent 'waiting' @{ reason = $reason; freeMiB = $sample.freeMiB; externalCompute = $state.compute;
                externalEngines = $state.engines; compositorIds = $sample.compositorIds;
                compositorSessionFallbackPid = $sample.compositorSessionFallbackPid; telemetryError = $Telemetry.fault }
            $lastLog = $watchClock.Elapsed.TotalSeconds
            $lastReason = $reason
        }
        if (-not $sample -and -not (Test-WallDeadline)) {
            Restart-TelemetryIfNeeded $Telemetry 'idle' $idleProbeRecoverySeconds
        }
        Start-Sleep -Milliseconds 100
    }
    return $null
}

function Initialize-OwnedJobType {
    if ('CodexAgents.OwnedJob' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CodexAgents {
    public static class ProcessIdentity {
        private const uint QueryLimitedInformation = 0x1000;
        private const uint TokenQuery = 0x0008;

        [StructLayout(LayoutKind.Sequential)]
        private struct WtsProcess {
            public int Session, Pid;
            public IntPtr Name, Sid;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeFileHandle OpenProcess(uint access, bool inherit, int processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryFullProcessImageName(SafeFileHandle process, uint flags, StringBuilder value, ref int size);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(SafeFileHandle process, uint access, out SafeFileHandle token);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(SafeFileHandle token, int infoClass, IntPtr data, int size, out int required);
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WTSEnumerateProcesses(IntPtr server, int reserved, int version, out IntPtr rows, out int count);
        [DllImport("wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr memory);

        public static string ImagePath(int pid) {
            using (var process = OpenProcess(QueryLimitedInformation, false, pid)) {
                if (process.IsInvalid) return null;
                var path = new StringBuilder(32768);
                int size = path.Capacity;
                return QueryFullProcessImageName(process, 0, path, ref size) ? path.ToString() : null;
            }
        }

        private static bool IsWindowManagerSid(IntPtr value) {
            if (value == IntPtr.Zero) return false;
            string sid = new SecurityIdentifier(value).Value;
            // DWM's per-session virtual user is under the Windows Window Manager SID authority.
            return sid.StartsWith("S-1-5-90-0-", StringComparison.Ordinal);
        }

        public static bool HasWindowManagerIdentity(int pid, int session) {
            if (session <= 0) return false;
            using (var process = OpenProcess(QueryLimitedInformation, false, pid)) {
                if (!process.IsInvalid && OpenProcessToken(process, TokenQuery, out var token)) {
                    using (token) {
                        GetTokenInformation(token, 1, IntPtr.Zero, 0, out int size);
                        if (size > 0 && size <= 4096) {
                            IntPtr buffer = Marshal.AllocHGlobal(size);
                            try {
                                if (GetTokenInformation(token, 1, buffer, size, out _))
                                    return IsWindowManagerSid(Marshal.ReadIntPtr(buffer));
                            } finally { Marshal.FreeHGlobal(buffer); }
                        }
                    }
                }
            }
            if (!WTSEnumerateProcesses(IntPtr.Zero, 0, 1, out IntPtr rows, out int count)) return false;
            try {
                int size = Marshal.SizeOf<WtsProcess>();
                for (int index = 0; index < count; index++) {
                    var row = Marshal.PtrToStructure<WtsProcess>(IntPtr.Add(rows, index * size));
                    if (row.Pid == pid && row.Session == session &&
                        string.Equals(Marshal.PtrToStringUni(row.Name), "dwm.exe", StringComparison.OrdinalIgnoreCase))
                        return IsWindowManagerSid(row.Sid);
                }
                return false;
            } finally { WTSFreeMemory(rows); }
        }
    }

    public sealed class OwnedJob : IDisposable {
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimit {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinWorkingSet, MaxWorkingSet;
            public uint ActiveProcesses;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimit {
            public BasicLimit Basic;
            public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(SafeFileHandle job, int type, ref ExtendedLimit limits, uint bytes);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

        private readonly SafeFileHandle job;

        public OwnedJob() {
            const uint killOnClose = 0x2000;
            const int extendedLimitInformation = 9;
            job = CreateJobObject(IntPtr.Zero, null);
            if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new ExtendedLimit { Basic = new BasicLimit { Flags = killOnClose } };
            if (!SetInformationJobObject(job, extendedLimitInformation, ref limits, (uint)Marshal.SizeOf<ExtendedLimit>())) {
                int error = Marshal.GetLastWin32Error();
                job.Dispose();
                throw new Win32Exception(error);
            }
        }

        public void Attach(IntPtr process) {
            if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        public void Stop() {
            if (!TerminateJobObject(job, 70)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        public void Dispose() { job.Dispose(); }
    }
}
'@
}

function New-WorkerStart($Sample, [string]$Gate) {
    # Wait in stdlib Python until the watchdog has attached this exact process handle to its Job Object.
    $shim = @'
import pathlib, runpy, sys, time, traceback

gate, out, err, script, *args = sys.argv[1:]
marker = pathlib.Path(gate)
deadline = time.monotonic() + 30
while not marker.exists():
    if time.monotonic() >= deadline:
        raise SystemExit(69)
    time.sleep(0.05)
marker.unlink(missing_ok=True)
with open(out, 'a', encoding='utf-8', buffering=1) as stdout, open(err, 'a', encoding='utf-8', buffering=1) as stderr:
    sys.stdout, sys.stderr = stdout, stderr
    sys.argv = [script, *args]
    sys.path.insert(0, str(pathlib.Path(script).parent))
    try:
        runpy.run_path(script, run_name='__main__')
    except Exception:
        traceback.print_exc(file=stderr)
        raise SystemExit(1)
'@
    $args = @('-B', '-u', '-c', $shim, $Gate, (Join-Path $Queue 'gpu-worker.stdout.log'),
        (Join-Path $Queue 'gpu-worker.stderr.log'), $WorkerScript) + $WorkerArguments
    $startInfo = New-ChildStart $Python $args
    $startInfo.WorkingDirectory = $Queue
    $startInfo.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $startInfo.Environment[$name] = $value }
    }
    $startInfo.Environment['CUDA_VISIBLE_DEVICES'] = $Sample.uuid
    $startInfo.Environment['HF_HUB_OFFLINE'] = '1'
    $startInfo.Environment['TRANSFORMERS_OFFLINE'] = '1'
    $startInfo.Environment['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
    $startInfo.Environment['HF_HUB_DISABLE_TELEMETRY'] = '1'
    $startInfo.Environment['PYTHONNOUSERSITE'] = '1'
    return $startInfo
}

function Get-YieldReason($Sample, $Occupancy, $Baseline) {
    if (Get-Handoff) { return 'handoff-requested' }
    if (-not $Sample) { return 'telemetry-unavailable' }
    if ($Sample.uuid -ne $Baseline.uuid) { return 'adapter-changed' }
    if ($Occupancy.compute.Count -gt 0) { return 'external-compute-context' }
    if ($Occupancy.engines.Count -gt 0) { return 'external-engine-activity' }
    if ($Sample.freeMiB -lt $HeadroomMiB) { return 'headroom-depleted' }
    return $null
}

function Invoke-WorkerAttempt($Telemetry, $Baseline, [double]$RemainingGpuSeconds) {
    $gate = Join-Path $Queue ('.gpu-start-' + [Guid]::NewGuid().ToString('N'))
    $job = [CodexAgents.OwnedJob]::new()
    $child = $null
    $attached = $false
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $attempt = @{ reason = $null; ownPeakMiB = 0.0; ownActivity = 0.0; maxUsedMiB = $Baseline.usedMiB; sawOwnCompute = $false;
        startedWork = $false }
    try {
        $child = [Diagnostics.Process]::Start((New-WorkerStart $Baseline $gate))
        $job.Attach($child.Handle)
        $attached = $true
        $attempt.pid = $child.Id
        $sample = Read-Latest $Telemetry
        $occupancy = if ($sample) { Get-GpuOccupancy $sample $child.Id } else { $null }
        $attempt.reason = Get-YieldReason $sample $occupancy $Baseline
        if (Test-WallDeadline) { $attempt.reason = 'wait-deadline' }
        if (-not $attempt.reason) {
            Write-WatchEvent 'worker-start' @{ pid = $child.Id; uuid = $Baseline.uuid; baselineUsedMiB = $Baseline.usedMiB;
                baselineFreeMiB = $Baseline.freeMiB; plannedPeakMiB = $PlannedPeakMiB; headroomMiB = $HeadroomMiB;
                remainingGpuSeconds = $RemainingGpuSeconds }
            [IO.File]::WriteAllText($gate, "start`n")
            $attempt.startedWork = $true
        }
        while (-not $child.HasExited -and -not $attempt.reason) {
            $sample = Read-Latest $Telemetry
            $occupancy = if ($sample) { Get-GpuOccupancy $sample $child.Id } else { $null }
            if ($sample) {
                $attempt.maxUsedMiB = [Math]::Max($attempt.maxUsedMiB, $sample.usedMiB)
                $attempt.ownPeakMiB = [Math]::Max($attempt.ownPeakMiB, $occupancy.ownMiB)
                $attempt.ownActivity = [Math]::Max($attempt.ownActivity, $occupancy.ownActivity)
                $attempt.sawOwnCompute = $attempt.sawOwnCompute -or $occupancy.ownCompute
            }
            $attempt.reason = Get-YieldReason $sample $occupancy $Baseline
            if ($timer.Elapsed.TotalSeconds -ge $RemainingGpuSeconds) { $attempt.reason = 'gpu-budget' }
            if (Test-WallDeadline) { $attempt.reason = 'wait-deadline' }
            if ($attempt.reason) {
                Write-WatchEvent 'worker-yield' @{ reason = $attempt.reason; pid = $child.Id;
                    externalCompute = $occupancy.compute; externalEngines = $occupancy.engines }
                break
            }
            Start-Sleep -Milliseconds 80
        }
        if (-not $child.HasExited) { $job.Stop() }
        if (-not $child.WaitForExit(10000)) { throw 'Own inference process did not exit after termination.' }
        $attempt.exitCode = $child.ExitCode
        $attempt.seconds = $timer.Elapsed.TotalSeconds
        return $attempt
    } finally {
        $job.Dispose()
        if ($child) {
            if (-not $attached -and -not $child.HasExited) { $child.Kill() }
            if (-not $child.HasExited) { [void]$child.WaitForExit(10000) }
            $child.Dispose()
        }
        [IO.File]::Delete($gate)
    }
}

function Confirm-VramReleased($Telemetry, $Baseline, $Attempt) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $observations = 0
    $lastNotice = $Telemetry.notice
    $observedGpuUse = $Attempt.ownPeakMiB -gt 0 -and ($Attempt.sawOwnCompute -or $Attempt.ownActivity -gt 0)
    $measuredCudaBytes = 0
    $readyPath = Join-Path $Queue 'ready.json'
    if ([IO.File]::Exists($readyPath)) {
        $ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json -AsHashtable
        if ($ready.worker_pid -eq $Attempt.pid -and $ready.model_cuda_allocated_bytes -gt 0) {
            $measuredCudaBytes = $ready.model_cuda_allocated_bytes
        }
    }
    $state = @{ pid = $Attempt.pid; observedGpuUse = ($observedGpuUse -or $measuredCudaBytes -gt 0);
        sawWddmAllocation = $observedGpuUse; reportedCudaAllocatedBytes = $measuredCudaBytes; ownPeakMiB = $Attempt.ownPeakMiB;
        peakAdapterUsedMiB = $Attempt.maxUsedMiB; baselineUsedMiB = $Baseline.usedMiB; verified = $false;
        baselineRestored = $false; exitCode = $Attempt.exitCode; gpuAttemptSeconds = $Attempt.seconds }
    while ($timer.Elapsed.TotalSeconds -lt $releaseVerificationSeconds) {
        $sample = Read-Latest $Telemetry
        if ($sample -and $sample.uuid -eq $Baseline.uuid -and $Telemetry.notice -ne $lastNotice -and
            $timer.Elapsed.TotalSeconds -lt $releaseVerificationSeconds) {
            $occupancy = Get-GpuOccupancy $sample $Attempt.pid
            $clear = $occupancy.ownMiB -eq 0 -and -not $occupancy.ownCompute -and $occupancy.ownActivity -eq 0
            $state.releasedUsedMiB = $sample.usedMiB
            $state.releasedFreeMiB = $sample.freeMiB
            $state.baselineRestored = $sample.usedMiB -le $Baseline.usedMiB + $ReleaseToleranceMiB
            if ($clear) { $observations += 1 } else { $observations = 0 }
            # During a handoff, an external project may consume VRAM as ours is reclaimed.
            $externalPresent = $occupancy.compute.Count -gt 0 -or $occupancy.engines.Count -gt 0
            if ($observations -ge 2 -and ($state.baselineRestored -or ($Attempt.reason -and $externalPresent))) {
                $state.verified = $true
                break
            }
        } elseif (-not $sample -or $sample.uuid -ne $Baseline.uuid) {
            $observations = 0
            if (-not $sample -and $timer.Elapsed.TotalSeconds -lt $releaseVerificationSeconds) {
                Restart-TelemetryIfNeeded $Telemetry 'release' $maxSampleAge
            }
        }
        $lastNotice = $Telemetry.notice
        Start-Sleep -Milliseconds 100
    }
    $state.releaseWaitSeconds = $timer.Elapsed.TotalSeconds
    Write-WatchEvent 'worker-release' $state
    return $state
}

function Confirm-SmokeResults([int]$WorkerId) {
    $results = @(Get-ChildItem -LiteralPath (Join-Path $Queue 'outbox') -File -Filter '*.json')
    if ($results.Count -eq 0) { throw 'Smoke worker produced no response files.' }
    $matchingReply = $false
    foreach ($result in $results) {
        $reply = Get-Content -LiteralPath $result.FullName -Raw | ConvertFrom-Json -AsHashtable
        if ($reply.status -ne 'ok' -or $reply.output_tokens -le 0) { throw 'A smoke request did not produce model output.' }
        if ($reply.worker_pid -eq $WorkerId) { $matchingReply = $true }
    }
    if (-not $matchingReply) { throw 'No completed smoke reply matches the worker whose GPU release was verified.' }
}

function Test-SealedQueueComplete {
    $sealPath = Join-Path $Queue 'sealed.json'
    if (-not [IO.File]::Exists($sealPath)) { return $false }
    try {
        $seal = Get-Content -LiteralPath $sealPath -Raw | ConvertFrom-Json -AsHashtable
        if ($seal.requests -isnot [long] -and $seal.requests -isnot [int]) { return $false }
        if ($seal.requests -lt 1) { return $false }
        $replies = @(Get-ChildItem -LiteralPath (Join-Path $Queue 'outbox') -File -Filter '*.json')
        if ($replies.Count -ne $seal.requests) { return $false }
        $completedIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($file in $replies) {
            $reply = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -AsHashtable
            if ($reply.id -cne $file.BaseName -or $reply.status -notin @('ok', 'error') -or
                $reply.error_type -eq 'OutOfMemoryError') { return $false }
            [void]$completedIds.Add($reply.id)
        }
        foreach ($folder in @('inbox', 'inflight')) {
            foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $Queue $folder) -File -Filter '*.json')) {
                $request = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -AsHashtable
                if ($request.id -cne $file.BaseName -or -not $completedIds.Contains($request.id)) { return $false }
            }
        }
        return $true
    } catch {
        return $false
    }
}

if ($FunctionsOnly) { return }

if ($Probe) {
    if ($ProbeCompositorFallbackPid -ge 0) {
        $sessionCompositor.checked = $true
        $sessionCompositor.pid = if ($ProbeCompositorFallbackPid -gt 0) { $ProbeCompositorFallbackPid } else { $null }
    }
    Initialize-OwnedJobType
    $smi = (Get-Command nvidia-smi.exe -CommandType Application).Source
    while ($true) {
        try { $sample = Read-GpuTelemetry $smi }
        catch { $sample = @{ ok = $false; error = $_.Exception.Message; observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } }
        [Console]::WriteLine(($sample | ConvertTo-Json -Depth 5 -Compress))
        Start-Sleep -Milliseconds 100
    }
}

if (-not $IsWindows -or -not $Python -or -not $WorkerScript -or -not $Queue -or $PlannedPeakMiB -le 0 -or $MaxGpuSeconds -le 0) {
    throw 'Windows watchdog requires -Python, -WorkerScript, -Queue, -PlannedPeakMiB and -MaxGpuSeconds.'
}
$Python = (Resolve-Path -LiteralPath $Python).ProviderPath
$WorkerScript = (Resolve-Path -LiteralPath $WorkerScript).ProviderPath
$Queue = (Resolve-Path -LiteralPath $Queue).ProviderPath
if (-not [IO.File]::Exists($Python) -or -not [IO.File]::Exists($WorkerScript) -or -not [IO.Directory]::Exists($Queue)) {
    throw 'Python, worker script, or queue is missing.'
}
if (-not $HandoffFile) { $HandoffFile = Join-Path $Queue 'gpu-handoff.request' }
$HandoffFile = [IO.Path]::GetFullPath($HandoffFile)
$logFile = Join-Path $Queue 'gpu-watch.jsonl'
$mutex = [Threading.Mutex]::new($false, 'Global\Codex.ManagingAIAgents.GpuWatch')
$ownsMutex = $false
$telemetry = $null
$watchClock = [Diagnostics.Stopwatch]::StartNew()
$usedGpuSeconds = 0.0
$handoffState = @{ acknowledged = $null }
$attemptClock = $null
$receipts = [Collections.Generic.List[object]]::new()
$receipt = @{ released = $true; allocatedSeconds = 0.0; waitMs = $null; status = 'stopped';
    smoke = $Smoke.IsPresent; attempts = $receipts }
if ($DispatchId) { $receipt.dispatchId = $DispatchId }
try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another experiment GPU watchdog is already active.' }
    Initialize-OwnedJobType
    $telemetry = New-TelemetryState
    Write-WatchEvent 'watch-start' @{ gpuIndex = $GpuIndex; maxGpuSeconds = $MaxGpuSeconds; smoke = $Smoke.IsPresent;
        idleSamples = $IdleSamples; sampleMaxAgeSeconds = $maxSampleAge; activityThresholdPercent = $ActivityThresholdPercent;
        dispatchId = $DispatchId; deadlineAtMs = $DeadlineAtMs }
    while ($usedGpuSeconds -lt $MaxGpuSeconds) {
        $workSeconds = $MaxGpuSeconds - $usedGpuSeconds - $releaseBudgetSeconds
        if ($workSeconds -le 0) {
            $receipt.status = 'budget'
            $receipt.stopReason = 'gpu-budget'
            break
        }
        $baseline = Wait-IdleGpu $telemetry
        if (-not $baseline) {
            $receipt.status = 'deadline'
            $receipt.stopReason = 'wait-deadline'
            break
        }
        if ($null -eq $receipt.waitMs) { $receipt.waitMs = $watchClock.ElapsedMilliseconds }
        $receipt.released = $false
        $attemptClock = [Diagnostics.Stopwatch]::StartNew()
        $attempt = Invoke-WorkerAttempt $telemetry $baseline $workSeconds
        $release = Confirm-VramReleased $telemetry $baseline $attempt
        $usedGpuSeconds += $attemptClock.Elapsed.TotalSeconds
        $attemptClock = $null
        $release.yieldReason = $attempt.reason
        $release.startedWork = $attempt.startedWork
        $receipts.Add($release)
        $receipt.released = $release.verified
        if (-not $release.verified) { throw 'The worker exited, but VRAM release could not be verified. Further inference stopped.' }
        $marker = Get-Handoff
        if ($marker) { Publish-HandoffAck $marker }
        if ($attempt.reason -eq 'gpu-budget' -or $usedGpuSeconds -ge $MaxGpuSeconds) {
            $receipt.status = 'budget'
            $receipt.stopReason = 'gpu-budget'
            break
        }
        if ($attempt.reason -eq 'wait-deadline') {
            $receipt.status = 'deadline'
            $receipt.stopReason = 'wait-deadline'
            break
        }
        $finishedBeforeYield = $attempt.reason -and (Test-SealedQueueComplete)
        if ($attempt.reason -and -not $finishedBeforeYield) { continue }
        if ($attempt.exitCode -ne 0 -and -not $finishedBeforeYield) {
            throw "Worker exited with code $($attempt.exitCode). See the worker logs."
        }
        if ($Smoke) {
            if (-not $release.observedGpuUse -or -not $release.baselineRestored) {
                throw 'The smoke worker exited, but its GPU usage and return to the memory baseline were not both observed.'
            }
            Confirm-SmokeResults $attempt.pid
        }
        Write-WatchEvent 'watch-complete' @{ consumedGpuSeconds = $usedGpuSeconds; smoke = $Smoke.IsPresent;
            completedBeforeYield = [bool]$finishedBeforeYield }
        $receipt.status = 'complete'
        break
    }
    if ($receipt.stopReason) {
        Write-WatchEvent 'watch-stopped' @{ reason = $receipt.stopReason; consumedGpuSeconds = $usedGpuSeconds }
    }
} catch {
    if ($attemptClock) { $usedGpuSeconds += $attemptClock.Elapsed.TotalSeconds }
    $receipt.error = $_.Exception.Message
    if ($ownsMutex) { Write-WatchEvent 'watch-stopped' @{ reason = $_.Exception.Message; consumedGpuSeconds = $usedGpuSeconds } }
    throw
} finally {
    try {
        if ($telemetry) { Stop-Telemetry $telemetry }
    }
    finally {
        if ($ownsMutex) {
            try {
                $receipt.allocatedSeconds = $usedGpuSeconds
                Write-AtomicJson (Join-Path $Queue 'gpu-usage.json') $receipt
            } finally { $mutex.ReleaseMutex() }
        }
        $mutex.Dispose()
    }
}
