# Managing AI agents

This project tests whether a manager-led team can produce better physics and mathematics explainers than one model working alone. The completed study used pinned open-weight models on a local GPU, with CPU checks for the calculations and diagrams. [Study design](PLAN.md) · [Related work](docs/related.md) · [Cluster workflow](cluster/README.md)

The Qwen study completed 81 of 84 planned runs within 40 GPU-hours, including the pilot. Every completed run failed simulation. The team scored higher on partial work in the matched comparison. [Results and saved-output audit](reports/main.md) · [Mathematical analysis](docs/mathematical-analysis.md)

## CPU checks

From the repository root, use Node.js 24 or later.

```powershell
node --test
node scripts/plan-gpu.mjs --design-only data/open-weight-grid.json
```

The tryout fixtures are in `data/tryout-packs.json`. The first release keeps the held-out questions and answer key, the reference calculation script, the local decision log, and the raw run archive out of Git.

## Pilot preparation with the local study files

The full runner needs the study's local `data/packs.json`. The local Gate 2 price list and calibration are in `runs/open-pilot/desktop-pilot-01/gate2.md`. The main run is in `runs/open-pilot/desktop-pilot-01/qwen-team-vs-solo-84/`. With those files present, `node scripts/run-local-main.mjs --plan` prints the held-out grid without launching inference.

```powershell
node scripts/open-pilot.mjs prepare-workers open-run-01
```

Preparing queues is local and free. The command pins the roster to the new run directory, makes one worker queue per checkpoint, and keeps the local manifest separate from each queue's model inputs. After retrieving every worker reply, use a desktop Python environment with Pillow. Set `PILOT_PYTHON` to the absolute executable path when `python` on `PATH` lacks Pillow.

```powershell
node scripts/open-pilot.mjs prepare-panel open-run-01
node scripts/open-pilot.mjs price-list open-run-01
node scripts/plan-gpu.mjs runs/open-pilot/open-run-01/gpu-telemetry.json
```

Collect the panel replies between the first and second commands. The planner's measured mode requires real unlimited assembly traces and allocation estimates. The design-only mode reports workload counts and break-even arithmetic.

## Historical API results

The [original Gate 1 report](reports/gate1.md) is archived evidence from the earlier vendor protocol. Replay its recorded checks locally with `node scripts/replay-gate1.mjs gate1-2026-11-15T02-57-58-341Z-a62652ec`. `scripts/gate1.mjs` is the historical paid-API entry point. The open-weight pilot uses `scripts/open-pilot.mjs`.

## Temporary Windows execution

`node scripts/run-local-pilot.mjs desktop-pilot-01 smoke` waits for the GPU to become available, runs one pinned Qwen request, and verifies CUDA allocation and release. `node scripts/run-local-pilot.mjs desktop-pilot-01 pilot` resumes the same run through the price list and local calibration. Use the workspace CUDA Python environment in `runs/local-runtime/venv`. Windows GPU counters must be readable by the launcher. The runner records Windows-specific times and never invokes a vendor API.

For explicit priority, another project can atomically place a small request file at `runs/local-runtime/gpu-handoff.request` and wait for `gpu-handoff.request.ack.json` with the matching request digest before launching its GPU work. Keep the request present while that work needs the GPU. The monitor also yields when counters show foreign GPU activity. The child exits to release memory; completed response files can be reused after a yield. The watcher logs why it paused and verifies release before starting the next batch.
