# Mathematical analysis of managing AI agents under a shared GPU budget

Research checked through 19 November 2026, including preprints submitted on 18 November. The local pilot reached Gate 2 with 540 worker replies, 228 blind-panel replies, 108 price-list rows, and all 25 workflow calibration traces. Three workflow traces passed every automatic check, all on the circuit tryout. The pilot used zero paid API calls.

The successful specialist example illustrates complementary skills. Both passing worker articles came from Qwen settings, while both passing worker simulations came from Mistral settings. A specialist team combined suitable settings and passed a complete circuit pack. Its 148.55 seconds of recorded backend execution wall time required 354.85 seconds of charged allocation. Both the conjunction of skill checks and the cost of loading and interruption belong in the mathematical model.

Execution wall time uses a monotonic timer around backend processing, including drafting, input preparation, CPU vision work where configured, synchronized generation, and decoding. Error replies include elapsed processing before failure. Service wall time uses request timestamps and includes request parsing. Charged allocation also includes loading, resident overhead, interrupted attempts, and release verification. Calendar time includes admission waits, waiting for other projects, and desktop checks.

## Recent research with direct implications

### Preserving work during interruption

Shi et al.'s *Making Preemption Productive in Long-Output LLM Serving*, submitted 15 November 2026 and under review, preserves KV snapshots in host memory and combines age-based readmission with protected decoding turns. In three matched Qwen3-32B H200 replay runs, it reports 50.7% lower p99 time per output token and 12.0% higher throughput than its recomputation baseline. The tradeoffs include host memory, more frequent pauses, and worse first-token tails. Our other projects have immediate priority, so protected GPU residency would conflict with the current yielding rule. Saving resumable state in CPU memory is a future implementation candidate that needs its own correctness and cost validation. [Stint preprint](https://arxiv.org/html/2611.20106v1)

Ao et al.'s *Optimizing LLM Inference*, revised 13 June 2026, develops a fluid queueing model with endogenous KV-cache growth. WAIT and Nested WAIT approach the fluid benchmark under linear multi-stage timing, asymptotic scaling, atomic feasibility, and specified memory buffers. These assumptions describe shared serving capacity more closely than our intermittent desktop access. The transferable principle is to account for future memory growth when admitting work. It motivates measuring peak memory across context lengths. Our current checkpoint caps provide empirical guards under the measured contexts. [WAIT and Nested WAIT paper](https://arxiv.org/html/2504.11320v4)

Yildiz et al., 19 May 2026, separately measure model reload and KV migration costs across several models and two workstation GPUs. Reload dominates their measured preemption overhead. Their preserved-state unload/reload experiments differ from our whole-request restarts, which discard unfinished decoding. The distinction explains why their modest end-to-end preemption penalty cannot be substituted for our ledger measurements. [Multi-model scheduling study](https://arxiv.org/html/2605.19593v1)

Novotny et al.'s *Cap-and-Track*, submitted 18 November 2026, combines durable priority queues, bounded engine admission, and dispatch rates updated from capacity refusals. Its same-traffic production A/B reports 43% fewer H100s for a classifier, with longer waits for lower-priority work at backfill peaks. That empirical fleet result motivates retaining pending work outside GPU execution and classifying capacity signals separately from errors. Our single-GPU watcher already waits without model residency and yields to other projects. The study supplies no restart-cost guarantee for this desktop. Its adaptive fleet controller would require a separate implementation and validation. [Cap-and-Track preprint](https://arxiv.org/html/2611.24891v1)

### Auditing adaptation to the remaining budget

Liu et al.'s *Choosing What to Observe*, submitted 18 November 2026, holds public evidence fixed while changing remaining observation budgets. Controlled finite-state tasks permit exact continuation values and the accounting identity

\[
V_B(H_0)-J_{\mu,\nu}
=\mathbb E\!\left[\sum_{t=0}^{B-1}
\delta_{B-t}(H_t,A_t)+\eta(H_B,\hat Y)\right].
\]

Here $\delta_b=V_b-Q_b$ measures acquisition loss against optimal continuation, while $\eta$ measures terminal-answer loss given the acquired evidence. The identity follows by telescoping conditional expectations. It requires legal actions, a correct prior and observation kernel, positive-probability scored histories, and policies restricted to their stated information. Exact enumeration relies on small controlled scenes. For this project, a future paired audit could hold artifacts and the price list fixed while varying the disclosed remaining allocation. That would test whether managers adapt their choices. Our continuation probabilities are unknown, so the present traces cannot supply numerical oracle regret from this result. The assignment-validity and fallback audit already identifies a separate source of pipeline behavior. [Budget-paired counterfactual audits](https://arxiv.org/html/2611.24867v1)

### Choosing candidates and spending verification effort

Dughmi et al.'s *Adaptive Generate-Rank-Verify*, revised 7 November 2026 for NeurIPS 2026, formalizes first-positive search with cheap proxy scores and costly verification. ADAP satisfies $\mathbb E[J_{\mathrm{ADAP}}]\le154J^\star$ under its sampling model, positive success probability, fixed scalar costs, and a monotone relation between proxy score and verification success. Our automatic checks are relatively cheap, our GPU costs depend on loading and interruption, and zero full-pack worker successes provide weak evidence about the success function. The paper supports selective generation and verification as a research direction. Applying its guarantee would require a validated model of those quantities. [Adaptive Generate-Rank-Verify](https://arxiv.org/html/2605.17609v3)

Sun et al.'s *What Effort Level Should I Choose?*, 25 October 2026, evaluates low-effort attempts followed by high-effort retries after external failure feedback. Its oracle selects the cheapest successful recorded effort after seeing outcomes. Our practical cheap-first policy must pay for failed attempts, checking, model switches, and retries. Native reasoning effort in that study also differs from this pilot's explicit drafting-token limits. The cost inequality below incorporates the additional switching cost. [Reasoning effort study](https://arxiv.org/html/2610.34491v1)

Feng, Ma, and Zhu's *Satisficing Regret Minimization in Bandits with Knapsacks*, submitted 29 October 2026, targets policies whose mean reward exceeds an acceptance threshold under finite resources. SELECTwK obtains horizon-independent expected satisficing regret when a sufficiently feasible policy exists under bounded i.i.d. rewards and consumptions, a null action, and the stated learning-oracle conditions. The constants depend on the gap above the threshold. This makes feasibility an explicit prerequisite. A single successful specialist pack establishes an observed success, while the policy's population mean remains uncertain. [Satisficing bandits with knapsacks](https://arxiv.org/abs/2610.39321)

Simchi-Levi, Xu, and Zhao's limited-switch bandits-with-knapsacks research appeared in *Operations Research* in 2025, following a 2019 preprint. It shows how restricting action switches changes attainable regret under stationary resource models. In our runner, cold loads can occur even between requests to the same model, and outside interruptions cause additional restarts. Counting family switches alone would omit substantial overhead. [Primary manuscript, September 2025 revision](https://arxiv.org/pdf/1911.01067v5)

### Efficient evaluation with biased and incomplete judges

Ao et al.'s *Designing Service Systems from Textual Evidence*, revised 5 November 2026, combines potentially biased LLM proxies with selective verified audits. One shared case reference can evaluate several configurations. Its asymptotically optimal identification result assumes a specified finite model family containing the true law and separating different best configurations. Its prediction-powered confidence sequences use known positive audit probabilities and also handle delayed feedback. This suggests sharing trusted pack references and pairing configurations. Existing deterministic judge failures supply no randomized audit probabilities, so the current ratings do not inherit that guarantee. [Selective auditing paper](https://arxiv.org/pdf/2601.21471v2)

Lee et al.'s *Instance-Optimal Estimation with Multiple LLM Judges on a Budget*, revised 6 November 2026, derives cost-aware allocations under independent, unbiased, stationary repeated scores with known judge costs. For query $k$, its oracle prefers the judge minimizing $c_j\sigma_{kj}^2$. Its appendix explicitly identifies nearly identical temperature-zero repeats as a problem for variance estimation. Our greedy judges have schema-dependent missing ratings and unmeasured residual bias. A deterministic judge can have low variance and substantial error. The current study should retain coverage and sensitivity analyses alongside available-rating means. [Budgeted multi-judge estimation](https://arxiv.org/html/2605.23362v2)

Lyu et al.'s ICML 2026 SySRs algorithm evaluates surviving models on the same prompts. Its best-model identification guarantee benefits from small variance of paired score differences. For two scores, that variance is $\sigma_i^2+\sigma_j^2-2\operatorname{Cov}(Y_i,Y_j)$. Shared difficulty can therefore improve comparison precision. When every full-pack reward is zero, this endpoint supplies no observed ranking gap. Component checks retain information about where the models differ. [SySRs proceedings paper](https://proceedings.mlr.press/v306/lyu26h.html)

### Structured output and correlated errors

Le's IJCNLP-AACL November 2026 paper studies schema keys as an instruction channel under constrained decoding. For a bounded task score and suitable support and stopping assumptions, its projection analysis bounds expected-score change by $\sqrt{D_{\mathrm{KL}}(Q\Vert P)/2}$. A key-wording advantage survives if it exceeds the sum of the two projection bounds. Experiments show model-dependent improvements and regressions. Grammar constraints can change semantic behavior while enforcing structure. A future paired format intervention should measure parsing, executable validity, numerical correctness, and full completion separately. The distributional result supplies no per-run guarantee for greedy decoding. [Schema-key wording paper](https://aclanthology.org/2026.aacl-long.116/)

Morante and Romero García-Rubio, published 4 November 2026, analyze exchangeable binary votes with common accuracy $p$ and pairwise correlation $\rho$. Their variance-based effective size is

\[
N_{\mathrm{eff}}=\frac{N}{1+(N-1)\rho}.
\]

At positive fixed correlation it approaches $1/\rho$. This concerns repeated candidates or judges voting on the same target. Our four skills require a conjunction model. Their measured correlations on MMLU also require fresh validation before use with this roster. The relevant design implication is to measure error overlap alongside the number of candidates. [Correlated ensemble reliability](https://link.springer.com/article/10.1007/s44564-026-00040-z)

### Interpreting the coordination literature

The latest verified *Towards a Science of Scaling Agent Systems*, revised 8 April 2026, evaluates 260 configurations on six benchmarks. Its cross-validated regression $R^2$ is .373, rising to .413 with task-grounded capability. Capability saturation is more robust than several tool-count and interaction coefficients under benchmark clustering. The numerical fit is an empirical relationship with substantial unexplained variation. Local GPU serialization and smaller checkpoints further limit transfer. [Agent scaling study](https://arxiv.org/html/2512.08296v3)

The 28 May 2026 revision of *Multi-Agent Teams Hold Experts Back* reports its 6.3–41.1% ML synergy gaps against a per-problem At Least One Correct oracle. Revealed-expert teams exceed the best fixed individual on four of five ML benchmarks in the reported table. Its ranking experiments demonstrate expertise dilution under asymmetric information. Our comparisons should therefore distinguish fixed solo selection, feasible tryout-based skill routing, and hindsight oracle headroom. [Expertise dilution study](https://arxiv.org/html/2602.01011v4)

*DecisionBench*, 18 May 2026, measures routing fidelity separately from final task quality and uses a same-family baseline determined by its eligible peer pool. Its chance formula excludes the orchestrator itself. Our manager can hire its own worker setting, so its denominator and feasible candidates differ. A hiring baseline should condition on the actual skill rankings, settings, available resources, and eligibility at each decision. [DecisionBench](https://arxiv.org/html/2605.19099v1)

These sources overlap selection, delegation, verification, and constrained resource allocation. None of the verified sources duplicates the entire crossed explainer-pack design. The brief's *My Budget Is Yours* conference citation remains unresolved after rechecking, which limits a complete novelty assessment. The intended contribution is to measure how management policy, component reliability, and resource constraints interact on these packs and checkpoints.

## A mathematical model of the task

The following derivations are our analysis of this experiment. They are proposals for interpretation and future design.

Let a pack have component artifacts $z_A,z_D,z_S,z_I$, representing article, derivation, simulation, and illustration. Let $G_A,G_D,G_S,G_I$ denote their necessary skill gates, and $K$ denote cross-part numerical consistency. The terminal success reward is

\[
R=\mathbf 1\{G_A\cap G_D\cap G_S\cap G_I\cap K\}.
\]

A management action selects a model setting, a skill, a drafting limit, or a revision. Its state includes remaining project allocation, per-pack limits, rolling family call counts, current artifacts, resident checkpoint, and available information about model performance. Loading and interruption make action durations variable. A semi-Markov decision model captures this through a value function

\[
V(s)=\max\left\{
\mathbb E[R\mid s],\quad
\max_{a\in\mathcal A(s)}\mathbb E\left[V(S')-\eta C(a,s)-\xi T(a,s)\mid s,a\right]
\right\}.
\]

The first term stops and scores the existing artifacts. $\mathcal A(s)$ contains only actions that obey hard resource and yielding rules. $C$ is charged GPU allocation, $T$ is elapsed time, and the nonnegative multipliers express the value of scarce allocation and time. Estimating this model accurately would require more data than five tryouts. It clarifies which quantities a useful manager must compare.

For producing successful packs, a sensible local decision statistic is the expected increase in full-pack success divided by incremental allocated cost. For learning management effects, an experiment needs precision on specified contrasts. Both objectives deserve explicit treatment in the Gate 2 scope decision.

A stationary resource-allocation relaxation chooses expected action counts \(x_a\) by maximizing \(\sum_a\mu_a x_a\), subject to \(\sum_a c_{aj}x_a\le B_j\) for each resource \(j\). Its dual assigns each resource a shadow price \(\lambda_j\). An action's net value becomes \(\mu_a-\sum_j\lambda_jc_{aj}\). Thus a slow free model can still be expensive when GPU occupancy or deadline slack has a high shadow price. State-dependent loading and interruption require costs conditional on the resident model and observed workload. The relaxation supplies a planning approximation, and the hard gateway caps enforce realized consumption.

## Why complementary specialists can succeed

The chain rule gives the exact identity

\[
P(R=1)=P(G_A)P(G_D\mid G_A)P(G_S\mid G_A,G_D)
P(G_I\mid G_A,G_D,G_S)P(K\mid G_A,G_D,G_S,G_I).
\]

If a conditioning prefix has probability zero, joint success is zero and the remaining conditional factors may be assigned arbitrary values. Every factor on a positive-probability path matters, including formatting and execution. The saved 135 worker groups contain the following necessary-gate successes.

| Necessary gate | Passing groups | Share |
| --- | ---: | ---: |
| Article length and reference | 2 | 1.48% |
| Derivation reference | 38 | 28.15% |
| Simulation on both parameter sets | 2 | 1.48% |
| Rendered illustration | 14 | 10.37% |
| All automatic checks | 0 | 0% |

For the uniform distribution over these observed rows, the Fréchet upper bound on the intersection is $2/135$. The article–simulation intersection is empty. Multiplying the four pooled marginal shares would give $6.41\times10^{-6}$ under independence. That illustrative assumption conflicts with the observed empty article–simulation intersection. Shared packs and model settings also limit an independent-trial interpretation across rows.

Formatting exposes an earlier bottleneck. Of 135 article attempts, 35 parsed and two passed both article checks. Of 135 simulations, 55 parsed, five executed, and two passed both parameter sets. Increasing parse success could expose more semantically correct outputs, while the later gates would still determine final success. Existing outputs retain their registered scoring.

The successful circuit specialist run used Qwen-top-d128 for writing, Qwen-top-d0 for derivation, Mistral-top-d128 for simulation, and Granite-top-d0 for illustration. Its extra 206.30 allocated seconds beyond recorded backend execution wall time show that choosing four individually capable workers has a material execution cost. Because selection used tryout results, this observation demonstrates complementarity within the pilot. Held-out packs will determine its generality.

The Granite circuit manager run also passed. All four proposed assignment values were invalid setting IDs, so the controller used its price-list specialist defaults for every skill. The Qwen and GLM managers supplied valid initial IDs. Across all five completed manager traces, eight of 20 assignment slots contained accepted IDs and 12 used fallback assignments. One of the eight accepted choices hired the manager's own family. All five review objects parsed, and zero proposed revisions were accepted. Mistral's recognized simulation key held a nested object where the parser required an ID string.

The review prompt supplied the schematic example `{"revisions":{"skill":"setting"}}`. Four managers copied its literal `skill` key. This ambiguity is a plausible contributor to the observed review failures. The assignment prompt requested an available setting for each skill, with exact menu-ID matching enforced by the parser. Qwen and GLM's compliant assignment replies each used 60 tokens. OLMo added explanation to fenced JSON, and Mistral exhausted 450 tokens on prose, commented JSON, and an unfinished rationale. These measurements concern compatibility among the prompts, greedy decoder, token limits, and strict parser. A future approved protocol could explicitly list legal task keys, require exact menu IDs, and show a concrete valid example such as `{"revisions":{"simulation":"mistral-top-d128"}}`, then measure its effects in paired trials.

Let $V$ denote an initial assignment with four valid setting IDs. End-to-end pipeline success obeys the mixture identity

\[
P(R_{\mathrm{pipeline}}=1)=
P(V)P(R_{\mathrm{pipeline}}=1\mid V)
+P(\neg V)P(R_{\mathrm{pipeline}}=1\mid\neg V).
\]

The second term includes the controller's fallback policy. The circuit example has $V$ false and a successful fallback outcome. Assignment validity, fallback use, and accepted revisions therefore matter alongside final pack quality. A comparison with the fixed specialist workflow would help identify the contribution of the manager model beyond the automated defaults. The budget-focused manager-versus-solo proposals estimate end-to-end workflow effects.

The subsequent circuit tournament used five top-tier d0 settings. Its candidate pool contained zero passing articles, three passing derivations, zero passing simulations, and one renderable illustration. All five neutral rating sets were missing after schema validation. The selected pack failed, and every recombination of unchanged candidates also lacks a passing article and simulation. The successful specialist and fallback-assisted circuit packs used d128 writing and simulation candidates outside that pool.

For candidate sets $\mathcal C_s$, define the pool oracle reward by

\[
R^*_{\mathrm{pool}}=
\max_{a_s\in\mathcal C_s,\ s\in\{A,D,S,I\}}
R(a_A,a_D,a_S,a_I).
\]

If any skill has no passing candidate, $R^*_{\mathrm{pool}}=0$. The circuit tournament therefore has zero observed full-pack selection regret relative to its own pool, alongside its failed judge outputs. Recombining candidates cannot repair a missing necessary skill within that fixed pool. This comparison also varies the effort settings available to the policies, which belongs in the interpretation of management-style effects.

Under a simplified model with conditionally independent skill successes $p_s(c_s)$ and additive cost, maximizing pack success means maximizing $\sum_s\log p_s(c_s)$. Interior allocations equalize $d\log p_s/dc_s$. For discrete upgrades, the corresponding comparison is $\Delta\log p_s/\Delta C_s$. Cross-part dependencies and checkpoint setup costs modify that calculation. Empirical zeroes from five packs also require uncertainty estimates before taking logarithms.

## When low effort followed by a retry saves resources

Let $c_L$ be the full low-setting cost, $c_H$ the full high-setting cost, $p_L$ the low-setting pass probability, and $h$ additional checking or switching cost paid only after low failure. Then

\[
\mathbb E[C_{L\to H}]=c_L+(1-p_L)(h+c_H).
\]

Assume the high attempt has the same expected cost after low failure as when run alone. The ladder is cheaper than always-high when

\[
p_Lc_H>c_L+(1-p_L)h.
\]

The high attempt's conditional success probability matters separately. With a reliable verdict, ladder success is $p_L+(1-p_L)p_{H\mid L\text{ fails}}$. Positive error correlation can make $p_{H\mid L\text{ fails}}$ substantially smaller than unconditional high-setting success. A price list should therefore support both cost and conditional failure analysis.

## The cost of yielding and restarting

Define one restartable unfinished request with deterministic load time $s$ and useful execution time $t$. Write $L=s+t$. Assume foreign interruptions arrive independently at Poisson rate $\lambda$ during resident execution and erase unfinished progress. Completed replies survive. An uninterrupted attempt succeeds with probability $q=e^{-\lambda L}$.

If $X\sim\operatorname{Exp}(\lambda)$, the renewal equation is

\[
\mathbb E[A]=\mathbb E[\min(X,L)]+(1-q)\mathbb E[A].
\]

Consequently,

\[
\boxed{\mathbb E[A]=\frac{e^{\lambda L}-1}{\lambda}}.
\]

This counts resident time across all attempts. Expected attempts are $e^{\lambda L}$. If charged release verification takes $r$ after every attempt, and a failed attempt leads to mean noncharged waiting $w$, calendar time becomes

\[
\mathbb E[T]=\frac{e^{\lambda L}-1}{\lambda}
+r e^{\lambda L}+w(e^{\lambda L}-1),
\]

plus initial admission waiting. As $\lambda\to0$, resident time approaches $L$, as required.

The following sensitivity example assumes a mean interruption interval of 180 seconds. This rate is hypothetical.

| Load plus unfinished work | Chance of one uninterrupted attempt | Expected resident seconds | Inflation over uninterrupted execution |
| ---: | ---: | ---: | ---: |
| 60 s | 71.65% | 71.21 | 1.19 times |
| 150 s | 43.46% | 234.18 | 1.56 times |
| 330 s | 15.99% | 945.85 | 2.87 times |

Long uninterrupted units become disproportionately costly. Shorter requests and preserved completed artifacts reduce the amount that each interruption discards. Excessively small units introduce extra cold loads, so minimizing request length alone also has a cost. CPU state persistence could shift this tradeoff if its save and restoration costs are lower than the recomputation it avoids.

The renewal argument also works when residual idle-window lengths $U$ are independent and identically distributed across retries under the same admission rule. If $S(u)=P(U\ge u)$ and $S(L)>0$, then

\[
\mathbb E[A]=\frac{\int_0^L S(u)\,du}{S(L)}.
\]

This expresses the same tradeoff using the observed idle-window distribution. For total idle-window length $H$, admission after an idle age $a$ gives residual survival $P(H>a+u)/P(H>a)$ under a stationary renewal model. A desktop workload can have increasing or decreasing interruption hazard, so five fresh idle samples establish current availability while future request completion still depends on the residual window. Estimation should retain completed attempts as censored availability observations and account for context-dependent request durations and changes in workload.

The current 40-hour cap truncates retries and creates noncompletion risk. A mean forecast cannot guarantee completion. Real desktop activity also violates stationary Poisson assumptions. An empirical forecast should resample observed idle and busy blocks, retain request durations and model-specific loads, enforce the cap, and report both charged cost and probability of reaching completion by a calendar deadline. The existing watcher continues using its current guards.

## Budget arithmetic and identifiable questions

With $P$ packs, $r$ repeats, five scarcity conditions, $S$ retained styles, $M$ manager families, $J$ manager policies, and $V$ visibility levels, the run count is

\[
N=5Pr\left[(S-1)+MJV\right]
\]

when manager-and-workers is retained. The ordinary styles contribute $S-1$, and manager variants contribute $MJV$.

| Scope | Pack runs | Questions supported |
| --- | ---: | --- |
| Full registered design | 8,800 | All registered factors |
| Registered minimum after permitted cuts | 720 | Five styles, four policies, two visibility levels, one manager family |
| Five styles with one manager configuration | 300 | Style and scarcity comparisons |
| Solo and one manager configuration | 120 | Delegation and scarcity comparisons |
| One manager configuration | 60 | Within-manager scarcity comparisons |

Every row retains five scarcity conditions and at least 12 main packs. The three smaller scopes change factors beyond the registered cut sequence and require Gate 2 approval. Their cost includes the completed pilot and future judging. At the final 19 November 09:22 UTC snapshot, 81,555.9167 allocated seconds had been settled, using 22.6544 of 40 GPU-hours and leaving 17.3456 hours. A 720-run main study would have at most 86.73 allocated seconds per run, including judging, to fit. That allowance is below every completed workflow trace's observed allocation. The registered minimum projects 422.79 total GPU-hours under the common maximum-cost method.

A one-visibility design has no information about the told versus not-told effect. One manager policy cannot estimate the effort-policy contrasts. One manager family restricts conclusions about family-specific hiring behavior. A proposed scope should name its estimand before ranking configurations by retained style count.

For a compact solo-versus-manager study, one direct estimand for scarcity condition \(c\) is

\[
\theta_c=(\mu_{M,c}-\mu_{S,c})-(\mu_{M,0}-\mu_{S,0}),
\]

where \(0\) is unlimited. This asks how scarcity changes the management advantage. Evaluating the four outcomes on the same pack produces a paired interaction estimate. The pack-level vector must remain together during bootstrap resampling, preserving the covariance across styles and conditions.

For a fixed linear contrast $\tau=\sum_i a_i\mu_i$, independent cell means with variances $\sigma_i^2/n_i$, and per-observation costs $c_i$, minimizing contrast variance under budget $B$ gives

\[
n_i=\frac{B\,|a_i|\sigma_i/\sqrt{c_i}}
{\sum_j|a_j|\sigma_j\sqrt{c_j}}.
\]

This follows directly from a Lagrange multiplier with positive known costs and variances and continuously divisible sample sizes. Paired pack differences use their difference variance and combined cost. Required minimum coverage, indivisible runs, uncertain variances, and multiple contrasts add constraints. The formula explains why a design selected solely to maximize the number of retained styles can spend resources inefficiently for a specific scientific question.

### A smaller design that retains manager family variation

A balanced rotation can preserve all five manager families within 60 manager cells. Use 12 packs and five conditions, with one family assigned to each pack-condition cell. Every pack encounters all five families across its conditions. Each family receives 12 cells overall and two or three cells within every condition. The assignment hashes the pack and family labels with seed 20261118, independently of outcomes. It retains manager-choice policy and told visibility.

Adding the solo baseline on every pack-condition cell gives 120 runs. Under a common manager cost estimate, its projected cost equals that of the fixed-Qwen two-style proposal,

\[
C_{\mathrm{project}}=C_{\mathrm{stage}}+C_{\mathrm{fixed}}
+60C_{\mathrm{manager,global}}+60C_{\mathrm{solo}}.
\]

The family rotation preserves variation needed to study hiring across families, while replacing the full manager-family crossing with an incomplete block design. It changes the scope and requires Gate 2 approval.

If 120 runs exceed the budget, an 84-run alternative keeps all 60 manager cells and adds 24 solo controls under unlimited and compute-cap conditions. Its primary paired estimand is the management-by-compute interaction $\theta_{\mathrm{compute}}$, adjusted for family effects in the stated model. Deadline, quota, and additional queue contention then support comparisons within the manager arm. Under the same common-cost assumption, the cost becomes

\[
C_{\mathrm{project}}=C_{\mathrm{stage}}+C_{\mathrm{fixed}}
+60C_{\mathrm{manager,global}}+24C_{\mathrm{solo}}.
\]

Condition-specific cost overrides replace the corresponding terms when supplied. A 60-run manager-only alternative removes the solo term and its management-versus-solo contrasts.

The CPU analysis verifies the following ranks using the actual proposed assignment.

| Model | Observations | Rank and columns |
| --- | ---: | ---: |
| Manager pack, condition, and family main effects | 60 | 20 / 20 |
| Manager model with family-by-condition interactions | 60 | 32 / 36 |
| Paired model with management-by-condition interactions | 120 | 25 / 25 |
| Paired model also including family-by-condition interactions | 120 | 41 / 41 |
| Same paired model with arbitrary manager-by-pack effects | 120 | 48 / 52 |
| Focused controls with the compute interaction | 84 | 22 / 22 |
| Focused model with arbitrary manager-by-pack effects | 84 | 33 / 33 |

Full column rank establishes estimability under the specified model. The 41-column model uses shared additive pack effects across solo and manager observations. Allowing arbitrary manager-by-pack effects restores four aliased interaction directions. The focused compute interaction remains estimable with those nuisance effects and additive family effects. Arbitrary family-by-condition heterogeneity requires further assumptions or observations. Its other three style-by-condition interactions have no matching solo observations.

There are still 12 pack clusters. Rank supplies no guarantee of useful precision, and rare binary successes could make large models unstable. Policy and visibility effects are absent from these restricted alternatives. Their budget feasibility depends on the final measured envelopes. The analysis script prints the assignment matrix, exact alias relations, and proposed costs, and the current pilot continues under its existing design.

### Family conditioned cost forecasts

The manager trials have substantially different recorded allocation costs. Define $J$ as the pilot panel allocation per case, and use the matched-family estimate

\[
\widehat C_{M,f}=J+\max_{i:\,f_i=f} C_i,
\]

where $C_i$ is the allocation charged to a completed manager trace. The common estimate instead takes the maximum across all manager families. A balanced rotation with 12 cells per family has the conditional projection

\[
\widehat C_{\mathrm{project}}=
C_{\mathrm{stage}}+C_{\mathrm{fixed}}+
12\sum_f\widehat C_{M,f}+n_S\widehat C_S.
\]

Here $n_S$ is 60, 24, or zero for the three control choices. A fourth proposal fixes Qwen, the first registered manager family, and keeps the 24 focused solo controls. Its manager term is $60\widehat C_{M,\mathrm{Qwen}}$. This retains the primary within-family management-by-compute question and removes comparisons between manager families.

Each family has one unlimited pilot trace. These point estimates combine its pack, hiring decisions, loading, and actual interruption period. They provide no causal ranking of architecture speed or confidence bound on future cost. The pilot uses default manager-choice assignment without resource disclosures. Finite-resource told prompts are an extrapolation from those observations.

Each observed manager trace contains six requests and zero accepted revisions. A clarified review schema could activate up to four additional worker requests. Holding initial work fixed, its extra allocation is $\Delta C_{\mathrm{revision}}=\sum_s\mathbf 1\{\text{valid and admitted revision of }s\}C^{\mathrm{revision}}_s$. Each revision's cost includes its own loading, interrupted attempts, and release verification. Across 60 manager cells, those increments add to the project forecast. Changing initial assignments adds a separate cost difference. Fresh-generation execution means omit both longer revision prompts and allocation overhead, so inserting those means would underdescribe the cost basis. The current priced scopes concern the observed prompt and controller behavior. Costs for the proposed prompt intervention remain unmeasured.

The report therefore shows both the family-conditioned projection and a sensitivity total using the common maximum for every manager cell. It shows sample counts, budget headroom, and any global fallback used when a matched estimate is unavailable. Explicit condition-level cost overrides take priority. The hard project allocation cap governs execution.

The final point projections support three unapproved scope choices within 40 GPU-hours under the observed prompt and controller behavior.

| Proposed scope | Main runs | Total GPU-hours | Headroom | Common-global sensitivity total |
| --- | ---: | ---: | ---: | ---: |
| Fixed Qwen with focused solo controls | 84 | 37.07 | 2.93 | 63.30 |
| Balanced family rotation, manager only | 60 | 37.30 | 2.70 | 56.46 |
| Fixed Qwen, manager only | 60 | 30.23 | 9.77 | 56.46 |

The 84-run choice retains the within-Qwen management-by-compute contrast, with solo controls under unlimited and compute-cap conditions. The balanced 60-run choice retains family variation across all five conditions. The fixed-family 60-run choice supplies additional budget headroom and within-manager scarcity comparisons. All use 12 packs, one repeat, manager-choice policy, and told visibility. Policy and visibility contrasts are absent. The full price list, frozen-limit support, and cost arithmetic appear in the local archive at `runs/open-pilot/desktop-pilot-01/gate2.md`. The final study and saved-output audit are in the [main report](../reports/main.md).

## Calibration and inference limits

The registered calibration chooses an inclusive observed limit whose strict exceedance share is closest to one half, breaking ties toward the highest limit. The final execution-time limit is 399.593 seconds and the deadline is 934.851 seconds. Each is exceeded by 12 of 25 references, or 48%. The rolling quota is one call per family per 60 seconds, exceeded by 10 of 25 references, or 40%. Discrete call counts prevent an exact half-sample split. Queue contention adds 32.519 seconds per request while using the same execution cap. The retained Qwen-manager and solo references show zero quota exceedances, so that reduced scope has weak observed support for quota pressure.

The full reference set contains five traces per style, with the manager family rotated across packs. After restricting to one manager family, only one manager trace supports that specific configuration. Pooling it with five traces from every ordinary style also weights manager behavior less heavily than the equal-run main design. Gate 2 should display the retained reference counts and break shares for each proposed scope, including an equal-style weighted diagnostic, while preserving the original calibration as the registered reference.

The 135 worker groups share only five tryout packs. Treating them as 135 independent draws would give a one-sided 95% zero-success upper bound of $1-0.05^{1/135}\approx2.19\%$. That calculation assumes independent identically distributed attempts, which this grid does not supply. Pack-level resampling and the held-out main split better match the intended generalization. Five tryout packs still give sparse uncertainty information.

With 12 main packs, paired differences have only 12 independent pack units under the pack-sampling model. As a normal planning approximation, 80% power at two-sided 5% significance requires an effect around $0.81$ paired-difference standard deviations. For binary outcomes, exact paired tests depend on discordant packs. Five discordances all favoring one arm give a two-sided sign-test value of .0625, while six give .03125. Small effects will remain difficult to resolve, and multiple hypotheses require an explicit multiplicity plan.

GPU availability adds a temporal variable. Fixed style order can associate a style with a busy period, and pack pairing alone does not remove that association. A main design should randomize or block execution order where dependencies permit, log actual interruptions, and separate generation time, resident allocation, and calendar waiting. In this local pilot every style already uses one physical GPU. The additional queue-contention treatment measures the imposed waiting and cap under that hardware setting.

## Judge coverage and sensitivity bounds

All 228 blind judge requests returned replies. Valid article ratings range from 21 to 35 of 35 eligible parsed articles. Valid picture ratings range from zero to 13 of 14 eligible rendered images. Schema validity therefore changes which observations enter the mean.

For a fixed set of $N$ eligible normalized scores in $[0,1]$, with $m$ valid ratings summing to $S$, the sharp bounds on the full eligible-item mean are

\[
\frac{S}{N}\le\mu\le\frac{S+N-m}{N}.
\]

These bounds require no missing-at-random assumption. For equal-weight case-level panel outcomes, calculate them within each case before averaging. Parsing and rendering define eligibility here. Missing worker artifacts already receive zero under the existing task rubric. Available-rating averages, rating coverage, own-family exclusion, and these sensitivity bounds answer distinct aspects of score reliability.

## What one manager family can reveal about self preference

Raw own-family hiring share mixes preference with competence, price, and the number of eligible settings. A hypothetical choice model makes the identification problem explicit. Let candidate $a$ have skill-adjusted utility $\alpha_{a,k}$ for skill $k$, and let manager $m$ add a same-family effect $\beta$. A conditional logit model would use

\[
P(a\mid m,k)\propto
\exp\{\alpha_{a,k}-\gamma C_a-\delta T_a+
\beta\mathbf1[f(a)=f(m)]\}.
\]

With one fixed manager family, the same-family indicator depends only on the candidate. Its effect can be absorbed into $\alpha'_{a,k}=\alpha_{a,k}+\beta\mathbf1[f(a)=f(m)]$. Every value of $\beta$ then has an observationally equivalent set of unrestricted candidate utilities. Independent skill measurements can constrain the utilities, but those constraints introduce measurement and modeling assumptions. Manager rotations or a declared identity intervention provide additional variation.

A one-family scope can describe how its manager routes relative to the measured price list. Generalizing a distinct same-family preference coefficient requires stronger design or assumptions. This cost of cutting manager rotations belongs beside their GPU-hour savings.

## Gate 2 decisions supported by this analysis

1. Finish the unchanged local pilot and preserve its strict scoring, GPU yielding, and allocation ledger. Report the full 25-trace calibration alongside the final price list.
2. Evaluate proposed scopes against explicit scientific contrasts and the remaining project allocation. Show which factors each cut removes and how much calibration support remains.
3. Prefer held-out, paired pack comparisons for any approved main study. Keep formatting, executable validity, numerical correctness, and full completion as separate recorded outcomes.
4. Treat grammar constraints, bounded format repair, resumable CPU state, and adaptive evaluation as proposed interventions with measured costs. Their effects need paired tests under a declared protocol.
5. Show forecast uncertainty and interruption exposure alongside point cost estimates. Main execution requires a hard shared allocation limit even when its forecast fits.

The recorded pilot numbers and illustrative calculations can be regenerated on CPU with `node scripts/analyze-pilot-math.mjs desktop-pilot-01`. The script reads the completed run, and its snapshot timestamp records the time of analysis.
