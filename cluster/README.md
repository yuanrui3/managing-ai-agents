# Gilbreth pilot workflow

## Preflight

Check `ssh -o BatchMode=yes gilbreth true`, then use RCAC's account and partition tools to identify permitted Slurm account, partition, QOS, GPU type and walltimes. Verify free scratch space and the Python, PyTorch, and CUDA stack. The roster targets Transformers 5.21.0. Check whether the Mistral processor needs `mistral-common`. Confirm model licences and memory with short test allocations. The model card size figures are feasibility estimates. [RCAC Slurm accounts and queues](https://docs.rcac.purdue.edu/userguides/gilbreth/run_jobs/queues/)

Use an experiment directory under `$RCAC_SCRATCH` for the launcher, worker, Python environment, checkpoint caches, and file queues. Use only public, pinned checkpoints. Stage weights in the Hugging Face cache layout `models--ORG--NAME/snapshots/REVISION` under scratch. Download public weights to scratch on the front end if compute nodes lack internet. No model computation belongs on the login node. [RCAC storage guide](https://docs.rcac.purdue.edu/userguides/gilbreth/storage/), [RCAC GPU jobs](https://docs.rcac.purdue.edu/userguides/gilbreth/run_jobs/gpu_jobs/)

## Staged file queues

For each prepared model directory, stage only its `inbox` files and `sealed.json` to a fresh remote scratch queue. Copy the seal after the requests. Keep manifests and reference answers on the desktop. Cluster outputs go to `outbox`. Sync `outbox`, `ready.json`, and `finished.json` back to the matching desktop model directory. Only the cluster worker code, reviewed model weights, and inference inputs need transfer. Run all simulation and illustration checks on the desktop.

On an authenticated session, launch the pinned checkpoint with the example below after substituting confirmed fields. Create `QUEUE` before submission. Use one warm checkpoint and Slurm job at a time. `ROLE` is `worker` or `judge`, and `LOADER` is `vision` or `causal` from the pinned roster.

```bash
sbatch --parsable --account="$ACCOUNT" --partition="$PARTITION" --qos="$QOS" --time="$WALLTIME" \
  "$EXPERIMENT/gilbreth_worker.sbatch" "$ROLE" "$LOADER" "$MODEL" "$REVISION" \
  "$EXPERIMENT" "$QUEUE" "$SNAPSHOT" "$PYTHON" "$EXPERIMENT/worker.py"
```

Before submission, reserve the requested walltime against the remaining 40 GPU-hours and check that the preceding job is terminal. Use a walltime of at most four hours. After the job, reconcile its elapsed GPU allocation and log the real queue wait from `Submit` to `Start`. For interrupted work retain completed replies and stage only missing requests in a fresh scratch queue. An unsealed interactive queue exits after ten idle minutes. The worker has no vendor credentials and runs in local-offline model mode.

```bash
sacct -X -j "$JOB_ID" --parsable2 \
  --format=JobID,State,Submit,Start,End,ElapsedRaw,AllocTRES
```

For the price list, run all prepared worker queues, collect the outputs, generate the blind panel inputs on desktop, then process the panel queues. Keep the neutral vision judge in one batched allocation for the pilot. Record all Slurm receipts, including test jobs and failed starts with elapsed allocations.

## Calibration input

`node scripts/plan-gpu.mjs <pilot.json>` expects the following measurements and registered grid.

- `unlimited` holds one record per calibration pack and style. Record `packId`, `style`, `activeSeconds`, `wallSeconds`, `calls` with `family`, `settingId`, and `startedMs`, and `managerFamily` for manager runs. Use the trace's observed start times from a common clock.
- `stageGpuSeconds` is elapsed allocated GPU time through the pilot. `fixedMainGpuSeconds` covers shared future costs such as judge runs, startup, and idle allowances. `perCellGpuSeconds` gives an allocation envelope per style. `conditionOverrides` can override any style envelope under a specific condition.
- `slotExtraDelayMs` is the rounded median pilot worker service time. Use `grid` with `packIds` in the registered retention order, `managerFamilies` in rotation priority, `managerPolicies`, `visibility`, and `repeats`.

Use style IDs `solo-best`, `specialists`, `manager-and-workers`, `tournament`, `cheap-first` and condition IDs `unlimited`, `compute-cap`, `deadline`, `call-quota`, `one-gpu-slot`. The last ID denotes the queue-contention condition. The pilot price-list queue collection and blind scoring are implemented. The later calibration needs actual, timed unlimited style traces from the desktop orchestrator.
