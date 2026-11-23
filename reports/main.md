# Qwen team and solo study

The desktop study completed 81 of 84 planned runs on 12 held-out physics and mathematics assignments. One run was interrupted by the project budget and two were unrun. The pilot and main study used 39.994 of 40 GPU-hours and zero paid API calls. The blind panel returned 361 of 366 planned replies.

The team scored 12.1 points higher than solo on the 100-point partial-quality scale without an execution cap and 17.2 points higher with the cap. Each comparison paired the same 12 assignments. All 48 paired runs failed at least one automatic check. The quality differences measure progress on individual artifacts. Full-pack completion was zero in both arms.

## Which checks failed

The CPU audit replayed all 81 completed runs through the original evaluator and reproduced every saved check. Multiple checks could fail in the same run.

| Automatic check | Passed | Failed |
| --- | ---: | ---: |
| Simulation matches the expected answer on the original inputs | 0 | 81 |
| Simulation matches the expected answer when the inputs change | 0 | 81 |
| Article, derivation, and simulation agree on the main answer | 0 | 81 |
| Article is 550 to 650 words | 7 | 74 |
| Article gives the correct marked answer | 17 | 64 |
| Illustration renders successfully | 25 | 56 |
| Derivation gives the correct marked answer | 29 | 52 |

Only three articles passed both their length and answer checks. Of the 45 articles that parsed, 18 were too short and 20 too long. Escaping raw line breaks in 17 replies made them readable but produced zero additional article passes. Replies cut off mid-string at the token limit need a shorter generation or a complete replacement.

## Why simulation blocked every run

- **34** runs supplied no accepted program. Twenty-two replies contained invalid JSON, 11 requests hit the execution cap, and one hit the call quota.
- **21** runs supplied a program that failed to run. Frequent causes included unknown names, incorrect statement formats, and unsupported operations.
- **26** programs ran on both inputs and returned wrong answers. **25** returned zero on both inputs. In **22** of those cases, the same Qwen worker submitted an empty program with a constant zero result. A spring simulation also returned zero because its loop tested the wrong direction and never started. The sole nonzero program used drag proportional to speed squared for a task that specified drag proportional to speed.

All 24 unlimited runs also failed simulation. Checking all 50 parseable saved simulation replies, including superseded attempts, found zero correct answers on either input set. For three team runs on the same sampling assignment, the article, derivation, and illustration already passed their checks. Substituting a hand-written program in a separate CPU diagnostic made all three packs pass. The original scores remain zero.

## What to fix first

1. **Qualify the simulation worker and its interface before another full study.** Start with a small, working program example in the prompt. Reject blank programs and unsupported operations locally. Execute each candidate on a simple known case and on changed inputs. Feed the exact validation error back for a bounded retry. Select worker settings by their rate of correct solutions on both inputs. Keep the alternate cases and answers outside the prompt.
2. **Keep formatting from throwing away usable artifacts.** Separate article text from structured answer metadata and validate the length and answer before assembly. Check diagrams against the drawing format before judging. Preserve the numerical and agreement checks throughout.

The audit used saved outputs and bounded CPU execution. Raw responses, full held-out pack specifications, model caches, and machine logs are local. The first solo run's elapsed time includes a multi-day pause. A temporary Windows file lock also delayed a resumed deadline run. These elapsed times mix workload and infrastructure delays.
