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

### Checking a simulation

For a direct calculation, the worker can return a formula such as `{"simulation":{"formula":"gain * x + bias"}}`. A bounded arithmetic parser converts the formula to the same sandbox program used for loops and conditionals. The scorer then runs that program with each set of numeric inputs.

New open-weight runs show the worker a complete example reply and run its submission in the CPU sandbox on the inputs stated in the question. A malformed reply, fixed-answer placeholder, sandbox error, or wrong number triggers one repair attempt during pack assembly, subject to the same call, time, and compute limits. Both the solo worker and the team get this opportunity. The repair receives the parser or sandbox error, or the number its own program returned. The controller keeps the first draft on a tie. After selecting a program, the scorer checks it on the original inputs and on the private changed inputs.

Run the worked example, failure cases, and end-to-end repair fixtures from the repository root with the following command.

```powershell
node --test test/simulation-format.test.mjs test/simulation-formula.test.mjs test/simulation-repair.test.mjs test/local-main.test.mjs
```

The fixtures use scripted worker replies and the real CPU sandbox. New price lists measure first attempts on both inputs. For a team repair, the manager can choose a worker. By default the controller switches workers when another setting has a higher two-case tryout pass rate. A solo repair stays with the solo model. The pinned roster records the simulation protocol so that resuming a historical study uses its original prompts and call schedule.

In a separate CPU-only check on the public circuit tryout, Qwen3-VL-4B-Instruct produced malformed JSON twice with the nested program format. With the formula option, its first reply computed 112 Ω on the stated inputs and 178.125 Ω on the withheld inputs. This check covered one simulation.

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
