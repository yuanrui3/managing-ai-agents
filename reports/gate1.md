# Gate 1 pilot

On November 14, 2026, Gemini 3.1 Flash-Lite at minimal thinking produced all four artifacts on each of the three tryouts. The 12 live calls totaled **$0.009840** at standard paid list rates, with zero unresolved reservations. All three articles were within the 550–650 word range and agreed with their worked derivations and the primary references. All three diagrams rendered through the CPU geometry renderer. Picture checklist and clarity ratings are pending the blind panel.

| Pack | Words | Article and derivation | Simulation primary | Simulation withheld case | Automatic result | Cost |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Projectile range | 579 | 24.52 m | Instruction limit | Instruction limit | Fail | $0.00347750 |
| Series-parallel circuit | 553 | 112 Ω | 112 Ω | 178.125 Ω | Pass | $0.00321125 |
| Converging thin lens | 597 | 20 cm | 20 cm | 37.33333333333333 cm | Pass | $0.00315125 |

The projectile program used a numeric loop condition that stayed true when the projectile moved below ground level. The sandbox stopped it on both cases. This is a simulation failure on both inputs. The offline fixture separately checked that an implementation returning a hard-coded primary answer fails on the withheld input.

The following artifact links require the local run archive.

| Pack | Article | Derivation | Simulation | Illustration | Detailed checks |
| --- | --- | --- | --- | --- | --- |
| Projectile | [Article](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-01/article.md) | [Derivation](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-01/derivation.md) | [Program](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-01/simulation.json) | [Diagram](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-01/illustration.svg) | [Checks](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-01/checks.json) |
| Circuit | [Article](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-02/article.md) | [Derivation](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-02/derivation.md) | [Program](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-02/simulation.json) | [Diagram](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-02/illustration.svg) | [Checks](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-02/checks.json) |
| Thin lens | [Article](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-03/article.md) | [Derivation](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-03/derivation.md) | [Program](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-03/simulation.json) | [Diagram](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-03/illustration.svg) | [Checks](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/tryout-03/checks.json) |

Replay the checks and ledger totals on the recorded responses with `node scripts/replay-gate1.mjs gate1-2026-11-15T02-57-58-341Z-a62652ec`. Verify the reference calculations with `node scripts/verify-packs.mjs`. The recorded wall times are in the [run summary](../runs/gate1-2026-11-15T02-57-58-341Z-a62652ec/summary.json).
