# Managing open-weight agents under scarcity

## Approved main study recorded 19 November 2026

The owner approved the 84-run fixed-Qwen proposal. Use the first 12 registered held-out packs, one repeat, and the Qwen top-tier manager with the pilot price list and disclosed remaining resources. Each pack receives all five manager conditions and solo-best controls under unlimited and compute-cap. The solo baseline uses the pilot's overall best setting. The paired completion differences and the management-by-compute interaction are the primary comparisons. The three other conditions support within-manager comparisons. The broader predictions below describe the original design.

Use matched four-cell blocks first and rotate their order across packs. Run the remaining manager-only conditions in a separate pass. Each review now asks for exact task keys and exact menu IDs as strings, with a concrete example and at most one revision per skill. The corrected prompt can generate extra calls. Charge pilot, continued generation, and the blind panel to the same 40 GPU-hour ledger. Set aside a pilot-based judging allowance for eligible cases during generation and stop if available allocation reaches the release reserve. Run the same offline, idle-only watchdog with priority for other projects. Use the frozen Gate 2 limits. On a quota refusal, log when another request is eligible. The runner scores the artifacts that the workflow obtained and preserves separate records for budget-truncated and unrun cells.

## Local execution amendment recorded 18 November 2026

The owner authorized the current pilot on the local Windows GPU, with priority for other projects. The local run uses the RTX A5000, desktop CPU orchestration, and the pinned open-weight roster. Its price list and calibration report Windows measurements. The watchdog waits for idle, yields to outside activity, reserves 4,096 MiB, and verifies VRAM release after every attempt.

The project budget is 40 allocated GPU-hours. Local accounting includes startup, loading, resident execution, interrupted attempts, and release verification. Admission waiting is logged separately. Runtime versions, CPU vision placement, memory adjustments, and native text-prefill chunking are recorded in replies and the decision log. Proposed main-study scope revisions remain subject to Gate 2 approval.

## Original cluster execution design

The authorized experiment uses open-weight checkpoints on Gilbreth. The original Gemini Gate 1 run remains a historical harness check. Include only Gilbreth measurements in the revised price list, calibration, and main analysis.

## Roster and effort

Use Qwen, Mistral, Granite, OLMo, and GLM as worker families with SmolVLM2 as the neutral vision judge. Pin every checkpoint revision in `data/open-weight-models.json`. The candidate roster pairs compact and larger checkpoints in four families. GLM has a single checkpoint. Confirm licences, access, installed software, and peak memory for every checkpoint before the full pilot. Use the same GPU type and inference runtime across compared cells. Record checkpoint, runtime versions, dtype, GPU type, and any required exceptions.

Use 0, 128, or 512 tokens of explicit private drafting before the final generation, with the same final answer ceiling at every setting. One admitted request includes both passes, and its usage includes both. Record actual draft tokens separately. Inference uses fixed seeds and deterministic decoding where supported. A setting's effective compute cost is measured active inference time, including prefill and both passes. Native model reasoning is recorded only when the runtime can identify it. Judges use zero drafting.

## Pilot and scarcity conditions

Run every checkpoint and draft level on all four skills across the five tryouts. The desktop creates every request. Gilbreth receives prompts and returns outputs through scratch file queues over SSH. Render illustrations and run model-written simulations on desktop CPU. For each setting and skill, report quality, active GPU-seconds, coverage and token use. The price list uses zero vendor API dollars. Batch one open-weight vision judge per family plus the neutral judge. Mask family labels, show the actual diagram, and score clarity and checklist items with and without the maker family's judge.

Collect five unlimited pack traces for each of the five styles on the same five tryouts. Rotate the five manager families over a fixed tryout order, each with the default pilot assignment policy and no resource disclosures. Use the same artifact checks, cache policy, model switching, request scheduling, and transport planned for the main experiment. Record active compute, wall time, every call's admission timestamp and worker family, active inference and model-switch costs, and Slurm submit/start/end times. Include judging and any model-load or idle overhead in the GPU budget. Score pilot traces separately from held-out main packs.

| Condition | Intervention |
| --- | --- |
| Unlimited | Apply the project GPU cap and job safety limits. Omit the experimental pack limit. |
| Compute cap | Limit each pack's cumulative inference and drafting GPU-seconds. Reserve before dispatch and stop or truncate generation at the remaining compute allowance. |
| Deadline | Freeze the pack at a fixed elapsed wall-clock time after pack start. Score artifacts the desktop received by that time. |
| Call quota | Limit accepted requests per family in a sliding 60-second window. Return the next retry time when the quota is full. Count both draft and final generation as part of one request. |
| Queue contention | Apply the same compute cap and add a fixed wait ahead of each admitted request in a shared queue. Use the pilot median worker service time as the fixed wait, separate it from measured Slurm queue delay, and include any actual occupied GPU time in the project budget. |

Choose the compute, deadline, and call quota thresholds by the closest observed break share to 50% on the unlimited traces, using inclusive thresholds and reporting ties. For queue contention report the inherited cap break share and the separate imposed delay. Physical single-GPU execution applies throughout. The queue condition measures added waiting under that deployment. Slurm queue time runs from job submission to the start of its allocation and does not count toward allocated GPU-hours.

## Main comparison and budget

Pair all conditions and styles on the same main packs and repeat indices. Keep solo best, specialists by tryout, manager and workers, tournament, and cheap first. Solo and specialists choose from the pilot scores. Tournament runs each family's larger or only checkpoint on each part. Cheap first starts with the least GPU-intensive setting that can attempt the skill. Escalate after failed automatic checks, using the agreed review signal for illustration. Manager policies are always top, cheapest passing, manager choice with the price list, and start low with escalation. Cross them with resource visibility and manager family rotation. The registered grid is in `data/open-weight-grid.json`. It orders families and topics within difficulty using a fixed seed and SHA-256 of the seed and ID. Interleaving easy, medium, and hard preserves four of each at the 12-pack floor.

Charge actual Slurm elapsed allocation time for every job, including startup, task failures, model switches, judging, and idle shutdown. Reserve a proposed job's full walltime before submission and reconcile it with Slurm accounting after completion. Admit at most one one-GPU experiment job at once, with at most four hours per job and a ten-minute idle cutoff. Remaining hours are `40 − reconciled allocation hours − outstanding reservations`. For the projection, combine observed pilot spend, a measured allowance for shared overhead, and conservative per-style/per-condition allocation envelopes. Shrink in order from two repeats to one, then from 20 packs to no fewer than 12, then fewer manager rotations. Keep all five scarcity conditions. An infeasible minimum grid requires a revised design at Gate 2.

## Predictions and analysis

1. Tournament has the highest unlimited quality and the lowest completion under resource constraints.
2. Cheap first completes the most packs under the compute cap and the fewest under the deadline.
3. Disclosing remaining resources improves manager completion in constrained conditions.
4. Managers who choose settings use smaller tiers under the compute cap, fewer draft tokens under the deadline, and switch families more often after quota refusal.
5. Managers prefer their own family beyond its feasible opportunities and pilot skill scores.

Report completion, quality, compute, wall time, wasted compute on failed packs, simulation failures on withheld parameters, and human interventions. Completion requires four available artifacts and passing automatic checks. Writing quality is normalized clarity multiplied by the article checks. Derivation and simulation quality use their automatic checks. Illustration quality is the mean fraction of checklist items ticked. Give missing artifacts zero and report missing panel ratings and coverage. Recompute panel-derived scores after removing the maker family's judge. Average repeats within pack and bootstrap paired differences over packs with a fixed seed and 10,000 draws. Compare own-family hiring with the best passing settings feasible at the decision and split tied baseline weight evenly. Report the real Slurm queue-wait distribution with sample size and allocation types.
