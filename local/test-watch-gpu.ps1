#requires -Version 7.2
param([string]$Python)

$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $PSScriptRoot ('.gpu-watch-test-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
try {
    . (Join-Path $PSScriptRoot 'watch-gpu.ps1') -FunctionsOnly -Python $Python -Queue $testRoot -PlannedPeakMiB 3000 `
        -MaxGpuSeconds 60 -IdleSamples 2 -ActivityThresholdPercent 1
    $Queue = $testRoot
    $HandoffFile = Join-Path $Queue 'handoff.request'
    $logFile = Join-Path $Queue 'fixture.jsonl'
    $handoffState = @{ acknowledged = $null }
    $watchClock = [Diagnostics.Stopwatch]::StartNew()

    function New-CounterFixture($OwnerId, $Value, $Counter, $Status = 0) {
        [pscustomobject]@{ InstanceName = "pid_${OwnerId}_luid_0x00000000_0x00123456_phys_0_eng_0";
            CookedValue = $Value; Status = $Status; Path = "\\desktop\gpu(sample)\$Counter" }
    }

    $records = @(Convert-GpuCounters @(
        (New-CounterFixture 10 18 'utilization percentage'), (New-CounterFixture 10 60MB 'dedicated usage'),
        (New-CounterFixture 40 5.0 'utilization percentage'), (New-CounterFixture 40 3.0 'utilization percentage'),
        (New-CounterFixture 40 1200MB 'dedicated usage'), (New-CounterFixture 60 2.2 'utilization percentage'),
        (New-CounterFixture 61 0.25 'utilization percentage')
    ))
    $baseline = @{ uuid = 'GPU-deadbeef'; totalMiB = 24564; freeMiB = 23718; usedMiB = 533;
        processes = @($records | Where-Object pid -EQ 10); compute = @(@{pid = 10; name = 'dwm'}); compositorIds = @(10) }
    $busy = $baseline.Clone()
    $busy.processes = $records
    $busy.compute += @(@{pid = 40; name = 'fixture-child'}, @{pid = 77; name = 'compute-owner'})
    $state = Get-GpuOccupancy $busy 40
    if ($state.compute.Count -ne 1 -or $state.compute[0].pid -ne 77 -or $state.engines.Count -ne 1 -or $state.engines[0].pid -ne 60 -or
        $state.ownMiB -ne 1200 -or $state.ownActivity -ne 5 -or -not $state.ownCompute) {
        throw 'GPU occupancy did not distinguish external graphics, external compute, DWM, and the worker.'
    }
    if ((Get-YieldReason $busy $state $baseline) -ne 'external-compute-context') { throw 'External context failed to veto.' }
    $state.compute = @()
    if ((Get-YieldReason $busy $state $baseline) -ne 'external-engine-activity') { throw 'External graphics failed to veto.' }
    if ((Get-YieldReason $null $null $baseline) -ne 'telemetry-unavailable') { throw 'Missing telemetry failed to veto.' }

    $transfer = $baseline.Clone()
    $transfer.processes += @(@{pid = 4; name = 'System'; activity = 15; dedicatedMiB = 4},
        @{pid = 40; activity = 3; dedicatedMiB = 4000}, @{pid = 60; activity = 7; dedicatedMiB = 0})
    $ownedTransfer = Get-GpuOccupancy $transfer 40
    if ($ownedTransfer.engines.Count -ne 1 -or $ownedTransfer.engines[0].pid -ne 60) {
        throw 'The worker weight-transfer rule hid another application or vetoed its own driver work.'
    }
    if (4 -notin @((Get-GpuOccupancy $transfer).engines | ForEach-Object pid)) {
        throw 'Pre-launch idle checks ignored active Windows kernel work.'
    }

    $caught = $false
    try { Convert-GpuCounters @((New-CounterFixture 40 0 'utilization percentage' 2)) | Out-Null }
    catch { $caught = $_.Exception.Message -match 'Invalid WDDM' }
    if (-not $caught) { throw 'Invalid WDDM data was treated as idle.' }

    [IO.File]::WriteAllText($HandoffFile, 'request A')
    if ((Get-YieldReason $baseline (Get-GpuOccupancy $baseline) $baseline) -ne 'handoff-requested') { throw 'Handoff failed to veto.' }
    Publish-HandoffAck (Get-Handoff)
    $ack = Get-Content -Raw -LiteralPath "$HandoffFile.ack.json" | ConvertFrom-Json -AsHashtable
    if ($ack.status -ne 'released' -or $ack.requestSha256 -ne (Get-FileHash -LiteralPath $HandoffFile).Hash) {
        throw 'Handoff acknowledgment failed to identify its request.'
    }
    [IO.File]::Delete($HandoffFile)

    function New-ProbeLineFixture([AllowNull()][object]$Line) {
        $telemetry = New-TelemetryState
        $stream = [pscustomobject]@{ Pending = [Threading.Tasks.TaskCompletionSource[string]]::new().Task }
        $stream | Add-Member -MemberType ScriptMethod -Name ReadLineAsync -Value { $this.Pending }
        $telemetry.process = [pscustomobject]@{ StandardOutput = $stream }
        $telemetry.process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
        $telemetry.pending = if ($null -eq $Line) { [Threading.Tasks.Task]::FromResult[string]([NullString]::Value) }
            else { [Threading.Tasks.Task]::FromResult[string]($Line) }
        $telemetry.needsRestart = $false
        return $telemetry
    }

    $wire = $baseline.Clone()
    $wire.ok = $true
    $wire.observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $wire.compositorSessionFallbackPid = 10
    $fresh = New-ProbeLineFixture (ConvertTo-Json -InputObject $wire -Depth 5 -Compress)
    if ((Read-Latest $fresh).uuid -ne $baseline.uuid -or $fresh.fallbackPid -ne 10 -or $fresh.notice -ne 1) {
        throw 'A fresh telemetry line did not establish the initial compositor state.'
    }
    $fresh.latest.observedAt -= 6000
    if ((Read-Latest $fresh) -or $fresh.latest -or $fresh.fault -ne 'stale-probe-sample' -or $fresh.gap -ne 1) {
        throw 'A stale cached reading survived telemetry validation.'
    }
    $invalid = New-ProbeLineFixture '{"ok":true,"observedAt":1}'
    if ((Read-Latest $invalid) -or $invalid.fault -ne 'invalid-probe-sample') { throw 'A malformed sample was accepted.' }
    $malformed = New-ProbeLineFixture '{not json'
    if ((Read-Latest $malformed) -or -not $malformed.needsRestart) { throw 'Malformed JSON did not close telemetry.' }
    $eof = New-ProbeLineFixture $null
    if ((Read-Latest $eof) -or -not $eof.needsRestart -or $eof.fault -ne 'probe-eof') { throw 'EOF did not close telemetry.' }
    $script:probeFixture = @{ starts = 0; pin = $null }
    function Start-Telemetry([int]$CompositorFallbackPid) {
        $script:probeFixture.starts += 1
        $script:probeFixture.pin = $CompositorFallbackPid
        return @{ process = $null; job = $null; pending = $null }
    }
    $eof.fallbackPid = 10
    Restart-TelemetryIfNeeded $eof 'idle' $idleProbeRecoverySeconds
    if ($script:probeFixture.starts -ne 1 -or $script:probeFixture.pin -ne 10 -or $eof.needsRestart) {
        throw 'The EOF restart changed the compositor exemption or did not reinitialize the probe.'
    }
    $eof.fallbackPid = 0
    $eof.retryAt = 0
    $eof.lastValid = $watchClock.Elapsed.TotalSeconds - 30
    $eof.fault = 'stale-probe-sample'
    Restart-TelemetryIfNeeded $eof 'idle' $idleProbeRecoverySeconds
    if ($script:probeFixture.starts -ne 2 -or $script:probeFixture.pin -ne 0) {
        throw 'A stale probe did not restart or renewed an invalidated compositor exemption.'
    }

    function Read-Latest($Telemetry) {
        $Telemetry.notice += 1
        if ($Telemetry.notice -eq 1) { return $busy }
        return $baseline
    }
    $testTelemetry = @{notice = 0; latest = $null}
    if ((Wait-IdleGpu $testTelemetry).freeMiB -ne 23718 -or $testTelemetry.notice -ne 3) {
        throw 'Idle gate did not wait for two distinct clear samples.'
    }
    $DeadlineAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 1
    if ((Wait-IdleGpu $testTelemetry) -or $testTelemetry.notice -ne 3) {
        throw 'The idle gate sampled or admitted after the absolute deadline.'
    }
    $DeadlineAtMs = 0

    Write-AtomicJson (Join-Path $Queue 'ready.json') @{ worker_pid = 40; model_cuda_allocated_bytes = 1200MB }
    $unobserved = @{ pid = 40; ownPeakMiB = 0; sawOwnCompute = $false; ownActivity = 0;
        maxUsedMiB = 1833; exitCode = 0; seconds = 2; reason = $null }
    $release = Confirm-VramReleased $testTelemetry $baseline $unobserved
    if (-not $release.verified -or -not $release.observedGpuUse -or -not $release.baselineRestored -or $testTelemetry.notice -ne 5) {
        throw 'Release verification lost allocation provenance or accepted an incomplete release.'
    }

    function Read-Latest($Telemetry) {
        $Telemetry.notice += 1
        if ($Telemetry.notice -eq 3) {
            Clear-TelemetrySample $Telemetry 'probe-eof' $true
            return $null
        }
        return $baseline
    }
    $IdleSamples = 5
    $recoveredIdle = New-TelemetryState
    $recoveredIdle.needsRestart = $false
    if ((Wait-IdleGpu $recoveredIdle).uuid -ne $baseline.uuid -or $recoveredIdle.notice -ne 8 -or $script:probeFixture.starts -ne 3) {
        throw 'Admission did not require five new idle samples after lost telemetry.'
    }
    $IdleSamples = 2

    function Read-Latest($Telemetry) {
        $Telemetry.notice += 1
        if ($Telemetry.notice -eq 2) {
            Clear-TelemetrySample $Telemetry 'probe-eof' $true
            return $null
        }
        return $baseline
    }
    $recoveredRelease = New-TelemetryState
    $recoveredRelease.needsRestart = $false
    if (-not (Confirm-VramReleased $recoveredRelease $baseline $unobserved).verified -or $recoveredRelease.notice -ne 4 -or
        $script:probeFixture.starts -ne 4) { throw 'Release verification did not require two new samples after probe replacement.' }

    function Read-Latest($Telemetry) { return $null }
    $releaseVerificationSeconds = 0.3
    $missingRelease = Confirm-VramReleased (New-TelemetryState) $baseline $unobserved
    $releaseVerificationSeconds = 20
    if ($missingRelease.verified -or $missingRelease.releaseWaitSeconds -gt 2) {
        throw 'Recovery without fresh samples falsely verified release or exceeded its bounded wait.'
    }

    function Read-Latest($Telemetry) {
        $Telemetry.notice += 1
        return $baseline
    }

    foreach ($folder in @('inbox', 'inflight', 'outbox')) {
        [void][IO.Directory]::CreateDirectory((Join-Path $Queue $folder))
    }
    Write-AtomicJson (Join-Path $Queue 'sealed.json') @{ requests = 1 }
    Write-AtomicJson (Join-Path $Queue 'inflight/fixture-request.json') @{ id = 'fixture-request' }
    if (Test-SealedQueueComplete) { throw 'A pending sealed request was treated as complete.' }
    Write-AtomicJson (Join-Path $Queue 'outbox/fixture-request.json') @{ id = 'fixture-request'; status = 'ok' }
    if (-not (Test-SealedQueueComplete)) { throw 'A published reply with a leftover claim was not recognized.' }
    Write-AtomicJson (Join-Path $Queue 'outbox/fixture-request.json') @{
        id = 'fixture-request'; status = 'error'; error_type = 'OutOfMemoryError'
    }
    if (Test-SealedQueueComplete) { throw 'An allocation failure bypassed the required recovery.' }
    Write-AtomicJson (Join-Path $Queue 'outbox/fixture-request.json') @{ id = 'wrong-request'; status = 'ok' }
    if (Test-SealedQueueComplete) { throw 'A mismatched reply was treated as complete.' }

    Initialize-OwnedJobType
    if ([CodexAgents.ProcessIdentity]::HasWindowManagerIdentity($PID, (Get-Process -Id $PID).SessionId)) {
        throw 'A non-DWM process was recognized as a compositor.'
    }
    if ($Python) {
        $WorkerScript = Join-Path $Queue 'fixture.py'
        [IO.File]::WriteAllText($WorkerScript, @'
import os
import pathlib
import sys
import time
assert os.environ.get('GPU_WATCH_TEST_SECRET') is None
assert os.environ.get('CUDA_VISIBLE_DEVICES') == 'GPU-deadbeef'
if len(sys.argv) > 1:
    pathlib.Path('fixture-parked').write_text('waiting')
    time.sleep(15)
pathlib.Path('fixture-done').write_text('ok')
'@)
        $env:GPU_WATCH_TEST_SECRET = 'fixture-only'
        try { $attempt = Invoke-WorkerAttempt $testTelemetry $baseline 6 }
        finally { Remove-Item Env:GPU_WATCH_TEST_SECRET -ErrorAction SilentlyContinue }
        if ($attempt.exitCode -ne 0 -or -not [IO.File]::Exists((Join-Path $Queue 'fixture-done'))) {
            throw 'Trusted CPU-only job shim failed.'
        }
        [IO.File]::Delete((Join-Path $Queue 'fixture-done'))
        $WorkerArguments = @('hold')
        function Read-Latest($Telemetry) {
            $Telemetry.notice += 1
            if ([IO.File]::Exists((Join-Path $Queue 'fixture-parked'))) { return $busy }
            return $baseline
        }
        $attempt = Invoke-WorkerAttempt $testTelemetry $baseline 6
        if ($attempt.reason -ne 'external-compute-context' -or $attempt.exitCode -ne 70 -or
            [IO.File]::Exists((Join-Path $Queue 'fixture-done'))) {
            throw 'External activity did not terminate the authorized fixture child.'
        }
        [IO.File]::Delete((Join-Path $Queue 'fixture-parked'))
        function Read-Latest($Telemetry) {
            $Telemetry.notice += 1
            if ([IO.File]::Exists((Join-Path $Queue 'fixture-parked'))) { return $null }
            return $baseline
        }
        $startsBeforeLoss = $script:probeFixture.starts
        $attempt = Invoke-WorkerAttempt $testTelemetry $baseline 6
        if ($attempt.reason -ne 'telemetry-unavailable' -or $attempt.exitCode -ne 70 -or
            $script:probeFixture.starts -ne $startsBeforeLoss -or [IO.File]::Exists((Join-Path $Queue 'fixture-done'))) {
            throw 'Telemetry loss did not terminate the owned worker before probe recovery.'
        }
        [IO.File]::Delete((Join-Path $Queue 'fixture-parked'))
        function Read-Latest($Telemetry) {
            $Telemetry.notice += 1
            return $baseline
        }
        $DeadlineAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 3000
        $attempt = Invoke-WorkerAttempt $testTelemetry $baseline 10
        if (-not $attempt.startedWork -or $attempt.reason -ne 'wait-deadline' -or $attempt.exitCode -ne 70 -or
            [IO.File]::Exists((Join-Path $Queue 'fixture-done'))) {
            throw 'The absolute deadline did not terminate the authorized fixture child.'
        }
        $DeadlineAtMs = 0
    }

    $dwmFixtures = @([pscustomobject]@{ Id = 16000000; SessionId = 99; ProcessName = 'dwm' })
    $sessionCompositor = @{ checked = $false; pid = $null }
    function Get-Process {
        [CmdletBinding()]
        param([string]$Name, [int]$Id)
        if ($Name -eq 'dwm') { return $dwmFixtures }
        if ($Id -eq $PID) { return [pscustomobject]@{ SessionId = 99 } }
    }
    if ((Get-CompositorIds) -ne 16000000) { throw 'Unique startup compositor failed to pin.' }
    $dwmFixtures += [pscustomobject]@{ Id = 16000001; SessionId = 99; ProcessName = 'dwm' }
    if (@(Get-CompositorIds).Count -ne 0) { throw 'Multiple unknown compositors were exempted.' }
    $dwmFixtures = @($dwmFixtures[0])
    if (@(Get-CompositorIds).Count -ne 0) { throw 'An invalidated compositor exemption was renewed.' }
    'GPU watchdog fixture checks passed.'
} finally {
    $resolved = (Resolve-Path -LiteralPath $testRoot).ProviderPath
    if ([IO.Path]::GetDirectoryName($resolved) -ne $PSScriptRoot -or (Split-Path -Leaf $resolved) -notlike '.gpu-watch-test-*') {
        throw 'Test cleanup path escaped its workspace.'
    }
    [IO.Directory]::Delete($resolved, $true)
}
