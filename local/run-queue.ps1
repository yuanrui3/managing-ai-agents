param(
    [Parameter(Mandatory)][string]$Python,
    [Parameter(Mandatory)][string]$Queue,
    [Parameter(Mandatory)][string]$Snapshot,
    [Parameter(Mandatory)][string]$Checkpoint,
    [Parameter(Mandatory)][string]$Revision,
    [Parameter(Mandatory)][ValidateSet('worker','judge')][string]$Role,
    [Parameter(Mandatory)][ValidateSet('causal','vision')][string]$Loader,
    [Parameter(Mandatory)][int]$PlannedPeakMiB,
    [Parameter(Mandatory)][int]$MaxGpuSeconds,
    [Parameter(Mandatory)][string]$HandoffFile,
    [long]$DeadlineAtMs = 0,
    [string]$DispatchId,
    [switch]$Smoke
)

$ErrorActionPreference = 'Stop'
# Native BF16 tensor sizes and bounded decoding caches need model-specific limits.
# Resolve them here on every allocation so a resumed launcher uses the same policy.
$memoryLimits = @{
    '89644892e4d85e24eaac8bacfd4f463576704203' = 5565   # Qwen3-VL 2B
    'ebb281ec70b05090aa6165b016eac8ec08e71b17' = 16000  # Qwen3-VL 4B main review prefill
    'b6d637bef2393152b3da2b2fde72eecdee30557e' = 9500   # Ministral 3B
    'f6fae9795746f63c9be8344932f01275f3c63734' = 19200  # Ministral 8B
    '6a7381ba1f54d684ff508d991aeb7dc580157103' = 5000   # Granite 1B
    '56111ae135df9c53a78c99028e7bc24035a9e979' = 12000  # Granite Micro long review prefill
    '48d788eca847d4d7548f375ad03d3c9312f6139e' = 5000   # OLMo 1B
    '6e5971d9eba42665f5bd5a0fcf047f299ce1dccc' = 19400  # OLMo 7B
    '411bb4d77144a3f03accbf4b780f5acb8b7cde4e' = 19200 # GLM with CPU vision
    'bf66a8244401a8e26d2ff429aa82df8550a289e5' = 12000  # Granite Vision image prefill
    '784410650d12be9bc086118fdefa32d2c3bced86' = 19400  # Molmo2-O
    'be92141c8d0ceb98596a923c308ac2bbb4a7c466' = 6500   # SmolVLM2
}
if ($memoryLimits.ContainsKey($Revision)) { $PlannedPeakMiB = $memoryLimits[$Revision] }
$workerArgs = @('--role', $Role, '--loader', $Loader, '--checkpoint', $Checkpoint, '--revision', $Revision,
    '--snapshot', $Snapshot, '--queue', $Queue, '--memory-mib', "$PlannedPeakMiB")
& (Join-Path $PSScriptRoot 'watch-gpu.ps1') -Python $Python -WorkerScript (Join-Path $PSScriptRoot 'worker.py') `
    -WorkerArguments $workerArgs -Queue $Queue -PlannedPeakMiB $PlannedPeakMiB -MaxGpuSeconds $MaxGpuSeconds `
    -HandoffFile $HandoffFile -ActivityThresholdPercent 1 -DeadlineAtMs $DeadlineAtMs -DispatchId $DispatchId -Smoke:$Smoke
