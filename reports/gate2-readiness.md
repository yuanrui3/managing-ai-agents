# Gate 2 preparation for the open-weight pilot

**19 November 2026 update.** The owner-authorized local GPU pilot reached Gate 2 with all 25 calibration traces and 22.6544 GPU-hours charged. Measurements and proposed cuts are in the local archive at `runs/open-pilot/desktop-pilot-01/gate2.md`. The November 14 preparation record follows.

**Status on November 14, 2026.** Gilbreth rejected the configured non-interactive SSH login. The authenticated Slurm account, available GPU types, and checkpoint fit are pending. The revised pilot has used **0 GPU-hours** and made **0 paid API calls**. No Gilbreth inference, judging, or calibration observations are available yet.

## Revised design and pilot package

The pinned candidate roster comprises Qwen, Mistral, Granite, OLMo, and GLM, with one vision judge from each lineage and SmolVLM2 as the neutral vision judge. There are nine worker checkpoints, with one tier for GLM and two for each other family. The desktop staged 540 worker requests across the five tryout packs, four skills, and three draft budgets. The project uses one GPU on Gilbreth. The desktop remains CPU-only for the simulation sandbox, diagram rendering, and analysis. [Roster](../data/open-weight-models.json), [protocol](../PLAN.md), [pilot workflow](../cluster/README.md)

The five conditions are unlimited, active GPU-second cap, wall-clock deadline, per-family call quota in a rolling minute, and queue contention. Queue contention applies the same compute cap plus a fixed per-request delay calibrated from pilot service times. Real scheduler wait is recorded separately. Pilot traces will determine the thresholds and the fraction of unlimited runs each threshold would have broken.

The seven desktop tests and five Python queue tests passed. A separate fixture exercised all 540 staged worker slots, image rasterization, blind panel responses, and own-family exclusion in the price list. The fixture outputs are excluded from the Gilbreth run directory and carry no pilot measurements.

## The 40 GPU-hour envelope

Charge Slurm allocation occupancy rather than the worker's active inference time. Include pilot jobs, failed starts, model loads, judging, idle time, and the queue treatment's occupied time. Reserve the full walltime for each job before submission and reconcile from `sacct` afterward. Limit each job to one GPU and at most four hours, and submit jobs serially.

| Main grid | Pack runs | Maximum average allocated seconds per run before pilot and shared overhead |
| --- | ---: | ---: |
| Two repeats, 20 packs, five manager rotations | 8,800 | 16.36 |
| One repeat, 20 packs, five rotations | 4,400 | 32.73 |
| One repeat, 12 packs, five rotations | 2,640 | 54.55 |
| One repeat, 12 packs, one rotation | 720 | 200.00 |

These ceilings are break-even arithmetic. Each one decreases after subtracting actual pilot allocations and the shared main-stage allowance. All cuts retain the five conditions and the same selected packs across the compared styles. At the 12-pack floor the preregistered order retains four easy, four medium, and four hard packs. If the observed projection still exceeds 40 hours at the floor, Gate 2 will need a revised main design.

Reproduce the counts and ceilings with `node scripts/plan-gpu.mjs --design-only data/open-weight-grid.json`. The measured price list, calibrated limits, projection, and selected cuts require the Gilbreth pilot and unlimited calibration traces.
