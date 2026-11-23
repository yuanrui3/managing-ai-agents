import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalPilot, atomicJson, python, readProjectJson, runCommand } from '../src/local-pilot.mjs';
import { planGpu, proposeBudgetScopes, STYLES } from '../src/gpu-planning.mjs';
import { costFamilyRotationProposals, familyRotationProposal, managerDecisionCoverage } from './analyze-pilot-math.mjs';

const [runId, mode = 'pilot'] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(runId ?? '') || !['smoke', 'pilot'].includes(mode) || process.argv.length > 4) {
  throw new Error('Usage: node scripts/run-local-pilot.mjs <run-id> [smoke|pilot]');
}

const directory = fileURLToPath(new URL(`../runs/open-pilot/${runId}/`, import.meta.url));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const controller = new LocalPilot(directory);
await controller.init();
const modelFile = join(directory, 'roster.json');
const roster = existsSync(modelFile) ? await json(modelFile) : await readProjectJson('data/open-weight-models.json');
const smokeModel = roster.workers.find(model => model.id === 'qwen-cheap');
if (!smokeModel) throw new Error('The pinned smoke-test checkpoint is missing.');
const smoke = join(directory, 'smoke');
const smokeId = 'gpu-smoke';
const smokeReceipt = join(smoke, 'smoke-result.json');
if (!existsSync(smokeReceipt)) {
  await mkdir(join(smoke, 'inbox'), { recursive: true });
  const hasRequest = ['inbox', 'inflight', 'outbox'].some(queue => existsSync(join(smoke, queue, `${smokeId}.json`)));
  if (!hasRequest) {
    await atomicJson(join(smoke, 'inbox', `${smokeId}.json`), {
      id: smokeId, prompt: 'Reply with the single word READY.', seed: 20261115, max_output_tokens: 12, draft_tokens: 0,
    });
  }
  await atomicJson(join(smoke, 'sealed.json'), { requests: 1 });
  const receipt = await controller.runQueue({ model: smokeModel, role: 'worker', queue: smoke, maxGpuSeconds: 600, smoke: true });
  const response = await json(join(smoke, 'outbox', `${smokeId}.json`));
  if (response.status !== 'ok' || response.site !== 'desktop-windows' || response.checkpoint !== smokeModel.checkpoint ||
    response.revision !== smokeModel.revision || !/^READY[.!]?$/i.test(response.text?.trim()) || response.output_tokens <= 0 ||
    !Number.isFinite(response.model_cuda_allocated_bytes) || response.model_cuda_allocated_bytes <= 0) {
    throw new Error('The CUDA smoke response did not verify model generation.');
  }
  await atomicJson(smokeReceipt, { receipt, response });
}
const smokeTest = await json(smokeReceipt);
console.log(`CUDA smoke passed for ${smokeTest.response.checkpoint}; the watchdog verified VRAM release.`);
if (mode === 'smoke') process.exit(0);

async function stageQueues(phase, models, role) {
  for (const model of models) {
    const queue = join(directory, phase, model.id);
    const { tasks } = await json(join(queue, 'manifest.json'));
    const before = new Set(await readdir(join(queue, 'outbox')));
    if (tasks.every(task => before.has(`${task.id}.json`))) continue;
    console.log(`${phase}: ${model.id}, ${tasks.length - before.size} requests pending`);
    await controller.runQueue({ model, role, queue });
    const after = new Set(await readdir(join(queue, 'outbox')));
    if (tasks.some(task => !after.has(`${task.id}.json`))) { throw new Error(`Incomplete ${phase} batch for ${model.id}.`); }
  }
}

const env = { ...process.env, PILOT_PYTHON: python };
const openPilot = command => runCommand(process.execPath, ['scripts/open-pilot.mjs', command, runId], env);
if (!existsSync(modelFile)) await openPilot('prepare-workers');
await stageQueues('workers', roster.workers, 'worker');
if (!existsSync(join(directory, 'panel', roster.judges.at(-1).id, 'manifest.json'))) await openPilot('prepare-panel');
await stageQueues('panel', roster.judges, 'judge');
await openPilot('price-list');

const { runCalibration, medianWorkerServiceMs } = await import('./calibrate-local.mjs');
const { grid } = await readProjectJson('data/open-weight-grid.json');
const { packs } = await readProjectJson('data/packs.json');
const { rows: priceList, panelCoverage = [] } = await json(join(directory, 'price-list.json'));
const traces = join(directory, 'unlimited-traces.json');
const completed = existsSync(traces) ? await json(traces) : [];
let previous = controller.allocatedSeconds;
const calibration = await runCalibration({
  packs: packs.filter(pack => pack.split === 'tryout'), roster, priceList, managerFamilies: grid.managerFamilies,
  invoke: request => controller.invoke(request), completedTraces: completed, idPrefix: `cal-${randomUUID().slice(0, 8)}`,
  onRun: async trace => {
    trace.allocatedSeconds = controller.allocatedSeconds - previous;
    previous = controller.allocatedSeconds;
    completed.push(trace);
    await atomicJson(traces, completed);
    console.log(`Calibration: ${trace.packId} / ${trace.style}`);
  },
});
const observed = Array.isArray(calibration) ? calibration : completed;
const panelPilotSeconds = controller.terminals.filter(run => run.queue.startsWith(join(directory, 'panel')))
  .reduce((total, run) => total + run.allocatedSeconds, 0);
const neutral = roster.judges.find(judge => judge.neutral);
const { tasks: panelCases } = await json(join(directory, 'panel', neutral.id, 'manifest.json'));
const panelPerRun = panelPilotSeconds / panelCases.length;
const perCellGpuSeconds = Object.fromEntries(STYLES.map(style => [style,
  panelPerRun + Math.max(...observed.filter(run => run.style === style).map(run => run.allocatedSeconds))]));
const managerFamilyGpuSeconds = {};
const managerFamilySampleCounts = {};
for (const family of grid.managerFamilies) {
  const samples = observed.filter(run => run.style === 'manager-and-workers' && run.managerFamily === family
    && Number.isFinite(run.allocatedSeconds) && run.allocatedSeconds >= 0);
  managerFamilySampleCounts[family] = samples.length;
  if (samples.length) managerFamilyGpuSeconds[family] = panelPerRun + Math.max(...samples.map(run => run.allocatedSeconds));
}
const telemetry = {
  site: 'desktop-windows', unlimited: observed, stageGpuSeconds: controller.allocatedSeconds, grid,
  slotExtraDelayMs: medianWorkerServiceMs(observed), perCellGpuSeconds,
  fixedMainGpuSeconds: 0,
  managerFamilyGpuSeconds, managerFamilySampleCounts, panelPerRunGpuSeconds: panelPerRun,
  managerFamilyCostContext: 'Unlimited default-assignment runs without resource disclosures. Each family estimate reflects its observed pack and interruption period. Finite-resource told prompts are extrapolations.',
};
await atomicJson(join(directory, 'gpu-telemetry.json'), telemetry);
const projection = planGpu(telemetry);
const scopeProposals = projection.projection.status === 'blocked-budget' ? proposeBudgetScopes(telemetry) : null;
if (scopeProposals) projection.scopeProposals = scopeProposals;
const rotation = familyRotationProposal(grid);
const mathematicalProposals = { ...costFamilyRotationProposals(rotation, { ...telemetry, calibration: projection.calibration }), rotation };
projection.mathematicalProposals = mathematicalProposals;
await atomicJson(join(directory, 'gate2.json'), projection);
const { calibration: limits, projection: budget } = projection;
const fit = budget.selected;
const number = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const hours = seconds => Number.isFinite(seconds) ? number(seconds / 3600) : 'Unavailable';
const globalManagerCase = Object.entries(managerFamilyGpuSeconds).sort((first, second) => second[1] - first[1])[0];
const managerCostRows = grid.managerFamilies.map(family => `| ${family} | ${managerFamilySampleCounts[family]} | ` +
  `${number(managerFamilyGpuSeconds[family] - panelPerRun)} | ${number(panelPerRun)} | ${number(managerFamilyGpuSeconds[family])} |`);
const fraction = limit => `${limit.breaks}/${limit.runs} (${(limit.breakShare * 100).toFixed(0)}%)`;
const limitRows = limits.status === 'calibrated' ? [
  `| Execution-time cap | ${number(limits.computeCap.activeSeconds)} s | ${fraction(limits.computeCap)} |`,
  `| Deadline | ${number(limits.deadline.wallSeconds)} s | ${fraction(limits.deadline)} |`,
  `| Call quota | ${limits.callQuota.maxCallsPerFamily} per family per 60 s | ${fraction(limits.callQuota)} |`,
  `| Queue contention | Same compute cap plus ${limits.oneGpuSlot.extraDelayMsPerCall} ms per request | ${fraction(limits.oneGpuSlot)} |`,
] : [];
const resultRows = priceList.map(row => `| ${row.worker} | ${row.draft} | ${row.skill} | ${number(row.quality)} (${row.scored}/${row.tryouts}) | ` +
  `${number(row.qualityExcludingOwnFamily)} (${row.scoredExcludingOwnFamily}/${row.tryouts}) | ` +
  `${number(row.meanGpuSeconds)} | ${number(row.meanServiceSeconds)} | ${number(row.apiUsd)} | ${row.returned}/${row.tryouts} |`);
const rosterRows = [
  ...roster.workers.map(model => `| ${model.id} | Worker | ${model.checkpoint} | ${model.revision} |`),
  ...roster.judges.map(model => `| ${model.id} | ${model.neutral ? 'Neutral judge' : 'Judge'} | ${model.checkpoint} | ${model.revision} |`),
];
const smokeRuntime = smokeTest.response;
const runtimeFields = [
  smokeRuntime.gpu,
  Number.isFinite(smokeRuntime.gpu_memory_bytes) ? `${number(smokeRuntime.gpu_memory_bytes / 2 ** 30)} GiB VRAM` : null,
  smokeRuntime.dtype,
  smokeRuntime.python_version ? `Python ${smokeRuntime.python_version}` : null,
  smokeRuntime.torch_version ? `PyTorch ${smokeRuntime.torch_version}` : null,
  smokeRuntime.transformers_version ? `Transformers ${smokeRuntime.transformers_version}` : null,
  smokeRuntime.decoding ? `${smokeRuntime.decoding} decoding` : null,
].filter(Boolean);
const coverageRows = panelCoverage.map(row => `| ${row.judge}${row.neutral ? ' (neutral)' : ''} | ` +
  `${row.returned}/${row.requests} | ${row.articleRated}/${row.articleEligible} | ${row.pictureRated}/${row.pictureEligible} |`);
const budgetRows = (budget.evaluated ?? []).map(candidate =>
  `| ${candidate.packs} | ${candidate.repeats} | ${candidate.managerRotations} | ${candidate.runs} | ` +
  `${number(candidate.projectedMainGpuSeconds / 3600)} | ${number(candidate.projectedProjectGpuSeconds / 3600)} |`);
const budgetText = fit
  ? `The first grid within budget uses ${fit.packs} packs, ${fit.repeats} repeat(s), ${fit.managerRotations} manager rotation(s), and all five conditions. ` +
    `It projects ${number(fit.projectedProjectGpuSeconds / 3600)} GPU-hours including the pilot.`
  : 'The required grid does not fit the measured allocation envelope under the registered cuts. Review the candidate grids before main runs.';
const scopeProposalSection = [];
if (scopeProposals) {
  const proposedGrid = scopeProposals.evaluated[0].grid;
  const proposed = scopeProposals.selected;
  const smallestRegistered = budget.evaluated.at(-1);
  const proposalRows = scopeProposals.evaluated.map(candidate => {
    const estimates = Object.values(candidate.managerCostSupport.byCondition);
    let basis = 'Condition overrides';
    if (estimates.some(estimate => estimate.source === 'common-global')) basis = 'Common global';
    if (estimates.some(estimate => estimate.source === 'family-conditioned')) {
      basis = `${candidate.managerCostSupport.family} n=${estimates.find(estimate => estimate.source === 'family-conditioned').samples}`;
    }
    if (candidate.managerCostSupport.fallbackConditions.length) basis = 'Global fallback';
    return `| ${candidate.styles.join(', ')} | ${STYLES.filter(style => !candidate.styles.includes(style)).join(', ') || 'None'} | ` +
      `${candidate.runs} | ${number(candidate.projectedMainGpuSeconds / 3600)} | ` +
      `${hours(candidate.projectedProjectGpuSeconds)} | ${hours(candidate.remainingGpuSeconds)} | ` +
      `${hours(candidate.globalSensitivity.projectedProjectGpuSeconds)} | ${hours(candidate.globalSensitivity.remainingGpuSeconds)} | ` +
      `${basis} | ${candidate.fitsBudget ? 'Yes' : 'No'} |`;
  });
  scopeProposalSection.push(
    '## Proposed scope revision requiring approval', '',
    `The smallest allowed registered grid projects ${number(smallestRegistered.projectedProjectGpuSeconds / 3600)} GPU-hours including the pilot ` +
      `and exceeds the 40 GPU-hour cap by ${number(-smallestRegistered.remainingGpuSeconds / 3600)} GPU-hours. ` +
      'Gate 2 approval is required before any proposed scope revision is executed.', '',
    `Proposals cover the first ${proposedGrid.packIds.length} registered packs, one repeat, the ${proposedGrid.managerFamilies[0]} manager family, ` +
      'the manager-choice policy, and told visibility. ' +
      `The registered factors contain ${grid.packIds.length} packs, ${grid.repeats} repeats, ${grid.managerFamilies.length} manager families, ` +
      `${grid.managerPolicies.length} manager policies, and ${grid.visibility.length} visibility levels.`, '',
    `The proposed pack IDs are ${proposedGrid.packIds.join(', ')}. ` +
      `Proposals cover all five conditions including ${scopeProposals.evaluated[0].conditions.join(', ')}.`, '',
    'Candidates with more styles appear first. Within each style count, candidates are ordered by projected project GPU time. ' +
      'Costs use charged stage allocations, fixed costs, and conditional per-cell estimates. ' +
      'Supported family estimates use the included manager family. Common-global sensitivity totals charge the global manager case. ' +
      'These projections are not measured upper bounds or completion guarantees.', '',
    '| Styles | Removed styles | Runs | Main GPUh | Point total GPUh | Point headroom GPUh | Global total GPUh | Global headroom GPUh | Manager cost basis | Conditional fit |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |', ...proposalRows, '',
    proposed
      ? `The proposed selection covers ${proposed.styles.join(', ')} for ${proposed.runs} cells and projects ` +
        `${number(proposed.projectedProjectGpuSeconds / 3600)} GPU-hours including the pilot. Gate 2 approval is required before this scope is used.`
      : 'Every evaluated scope proposal exceeds 40 GPU-hours. The proposed selection is empty.', '',
    'These scope revisions limit conclusions to one manager family, one policy, and one visibility level. ' +
      'The manager-only fallback supports within-manager scarcity comparisons.', '',
  );
  const support = proposed?.calibrationSupport;
  if (support?.status === 'diagnostic-only') {
    const { original, retained, frozenLimits } = support;
    const share = value => Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : 'Unavailable';
    const supportedFraction = row => row.runs ? fraction(row) : 'Unavailable';
    const countRows = STYLES.map(style =>
      `| ${style} | ${original.countsByStyle[style]} | ${retained.countsByStyle[style] ?? 0} |`);
    const pressureRows = [
      ['Execution-time cap', 'computeCap', `${number(frozenLimits.activeSeconds)} s`],
      ['Deadline', 'deadline', `${number(frozenLimits.wallSeconds)} s`],
      ['Call quota', 'callQuota', `${frozenLimits.maxCallsPerFamily} per family per ${frozenLimits.quotaWindowMs / 1000} s`],
    ].map(([label, condition, limit]) =>
      `| ${label} | ${limit} | ${supportedFraction(original[condition])} | ${share(original[condition].equalStyleBreakShare)} | ` +
      `${supportedFraction(retained[condition])} | ${share(retained[condition].equalStyleBreakShare)} |`);
    scopeProposalSection.push(
      '### Calibration support for the proposed selection', '',
      `The frozen registered limits use ${original.sampleCount} unlimited traces. ` +
        `The proposed selection has ${retained.sampleCount} matching traces after filtering by style and manager family. ` +
        'These diagnostics compare observed pressure with the original limits.', '',
      '| Style | Full reference samples | Retained reference samples |',
      '| --- | ---: | ---: |', ...countRows, '',
      '| Condition | Frozen limit | Full reference breaks | Full equal-style share | Retained reference breaks | Retained equal-style share |',
      '| --- | --- | ---: | ---: | ---: | ---: |', ...pressureRows, '',
      'Equal-style shares average the observed break rates across the styles in each reference. ' +
        'Each proposed style contributes the same number of main cells. A missing style makes the weighted share unavailable.', '',
      `Queue contention uses the compute row and the registered full-pilot worker median delay of ${frozenLimits.queueDelayMsPerCall} ms per call.`, '',
      ...support.notes.flatMap(note => [note, '']),
    );
  }
}
const mathematicalRows = mathematicalProposals.evaluated.map(candidate => {
  const estimates = Object.values(candidate.managerCostSupport.byCondition).flatMap(Object.values);
  let basis = 'Condition overrides';
  if (estimates.some(estimate => estimate.source === 'common-global')) basis = 'Common global';
  if (estimates.some(estimate => estimate.source === 'family-conditioned')) {
    basis = candidate.fixedFamily ? `${candidate.fixedFamily} n=${candidate.managerCostSupport.sampleCounts[candidate.fixedFamily]}` : 'Family observations';
  }
  if (candidate.managerCostSupport.fallbackFamilies.length) basis = `Global fallback for ${candidate.managerCostSupport.fallbackFamilies.join(', ')}`;
  if (estimates.some(estimate => estimate.source === 'unavailable')) basis = 'Incomplete pricing';
  return `| ${candidate.name} | ${candidate.counts.managerCells} | ${candidate.counts.matchedSoloCells} | ${candidate.counts.totalCells} | ` +
    `${hours(candidate.projectedMainGpuSeconds)} | ${hours(candidate.projectedProjectGpuSeconds)} | ` +
    `${hours(candidate.remainingGpuSeconds)} | ${hours(candidate.globalSensitivity.projectedProjectGpuSeconds)} | ` +
    `${hours(candidate.globalSensitivity.remainingGpuSeconds)} | ${basis} | ` +
    `${candidate.fitsBudget === null ? 'Unavailable' : candidate.fitsBudget ? 'Yes' : 'No'} | ${candidate.retainedQuestions} |`;
});
const familyMatrixRows = rotation.assignmentMatrix.map(row =>
  `| ${row.packId} | ${rotation.conditions.map(condition => row.familyByCondition[condition]).join(' | ')} |`);
const mathematicalSection = [
  '## Mathematical alternatives requiring Gate 2 approval', '',
  'Three report-only alternatives rotate all five manager families. The fourth focuses on the first registered family. ' +
    'They use manager-choice policy, told visibility, one repeat, and the same twelve packs. ' +
    'Point projections use the assigned family estimates when supported, with explicitly listed global fallbacks. ' +
    'Supplied condition overrides take priority. Common-global sensitivity totals use the global manager case for every manager cell. ' +
    'Gate 2 approval is required before any alternative is executed.', '',
  '| Alternative | Manager cells | Solo cells | Total cells | Main GPUh | Point total GPUh | Point headroom GPUh | Global total GPUh | Global headroom GPUh | Manager cost basis | Conditional fit | Retained questions |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |', ...mathematicalRows, '',
  'The 84-cell alternative includes solo controls only for unlimited and compute-cap. ' +
    'Deadline, call-quota, and one-gpu-slot provide manager-only comparisons in that alternative. ' +
    'The 60-cell alternative covers manager-only observations across all five conditions. ' +
    `The fixed ${rotation.registeredFirstManagerFamily} 84-cell alternative assigns that family to all sixty manager cells and includes twenty-four focused solo controls. ` +
    'It gives up family, policy and visibility comparisons.', '',
  `The following matrix applies to the three balanced rotation alternatives. The seeded assignment uses ${rotation.seed}. ${rotation.assignmentRule}`, '',
  `| Pack | ${rotation.conditions.join(' | ')} |`,
  `| --- | ${rotation.conditions.map(() => '---').join(' | ')} |`, ...familyMatrixRows, '',
  'In the three rotated alternatives every pack encounters all five families. Each family has twelve manager cells, and each condition has two or three cells per family. ' +
    'The twelve packs are repeated-observation clusters. Model rank establishes identifiability under the stated pack-effect assumptions, ' +
    'with sparse family-topic coverage and no precision guarantee. Policy and visibility effects are outside these alternatives.', '',
];
const mathematicalSupport = mathematicalProposals.calibrationSupport;
if (mathematicalSupport.status === 'diagnostic-only') {
  const { byStyle, frozenLimits } = mathematicalSupport;
  const manager = byStyle['manager-and-workers'];
  const solo = byStyle['solo-best'];
  const supportedFraction = row => row.runs ? fraction(row) : 'Unavailable';
  const pressureRows = [
    ['Execution-time cap', 'computeCap', `${number(frozenLimits.activeSeconds)} s`],
    ['Deadline', 'deadline', `${number(frozenLimits.wallSeconds)} s`],
    ['Call quota', 'callQuota', `${frozenLimits.maxCallsPerFamily} per family per ${frozenLimits.quotaWindowMs / 1000} s`],
  ].map(([label, condition, limit]) =>
    `| ${label} | ${limit} | ${supportedFraction(manager[condition])} | ${supportedFraction(solo[condition])} |`);
  mathematicalSection.push(
    '### Frozen-limit reference support', '',
    `For the three rotated alternatives the original calibration supplies ${manager.samples} manager references across the five families and ${solo.samples} solo references. ` +
      'These observed break shares use the frozen registered limits.', '',
    '| Condition | Frozen limit | Manager reference breaks | Solo reference breaks |',
    '| --- | --- | ---: | ---: |', ...pressureRows, '',
    `Manager references by family are ${Object.entries(mathematicalSupport.managerSamplesByFamily)
      .map(([family, count]) => `${family} ${count}`).join(', ')}. ` +
      'Pooled manager support gives limited evidence about any individual family-topic combination. ' +
      `Queue contention uses the same execution cap and the original ${frozenLimits.queueDelayMsPerCall} ms worker-median delay.`, '',
  );
}
const fixedProposal = mathematicalProposals.evaluated.find(candidate => candidate.fixedFamily);
const fixedSupport = fixedProposal.calibrationSupport;
if (fixedSupport.status === 'diagnostic-only') {
  const manager = fixedSupport.byStyle['manager-and-workers'];
  const solo = fixedSupport.byStyle['solo-best'];
  const supportedFraction = row => row.runs ? fraction(row) : 'Unavailable';
  const fixedRows = [['Execution-time cap', 'computeCap'], ['Deadline', 'deadline'], ['Call quota', 'callQuota']]
    .map(([label, condition]) => `| ${label} | ${supportedFraction(manager[condition])} | ${supportedFraction(solo[condition])} |`);
  mathematicalSection.push(
    `The fixed ${fixedProposal.fixedFamily} alternative has ${manager.samples} matching manager reference(s) and ${solo.samples} solo references. ` +
      'This is sparse family-specific support. Its pressure shares use the original frozen limits.', '',
    '| Condition | Fixed-family manager breaks | Solo reference breaks |',
    '| --- | ---: | ---: |', ...fixedRows, '',
  );
}
const workerGroups = await json(join(directory, 'worker-scores.json'));
const workerPasses = workerGroups.filter(group => group.result.pass).length;
const articlePasses = workerGroups.filter(group => group.result.checks.article_length && group.result.checks.article_reference).length;
const calibrationPasses = observed.filter(run => run.result.pass).length;
const managerDecisions = managerDecisionCoverage(observed, priceList);
const managerDecisionRows = managerDecisions.byFamily.map(family =>
  `| ${family.family} | ${family.completedTraces} | ${family.assignmentOuterObjects}/${family.assignmentCalls} | ` +
  `${family.validAssignmentIds}/${family.assignmentSlots} | ${family.fallbackAssignments} | ` +
  `${family.reviewOuterObjects}/${family.reviewCalls} | ${family.recognizedRevisionKeys} | ` +
  `${family.validRevisionIds} | ${family.revisionWorkerCalls} |`);
const fallbackPassNotes = managerDecisions.traces.filter(trace => trace.fullPass && trace.fallbackAssignments === 4)
  .map(trace => `The passing ${trace.managerFamily} manager run on ${trace.packId} used specialist defaults for all four skills.`);
await writeFile(join(directory, 'gate2.md'), [
  '# Gate 2 desktop GPU pilot', '',
  `The local Windows pilot used ${number(controller.allocatedSeconds / 3600)} GPU-hours and zero paid API calls. ${budgetText}`,
  `${workerPasses}/${workerGroups.length} worker pack-setting groups passed every automatic check. ` +
    `${articlePasses} articles met both the length and reference checks. ` +
    `${calibrationPasses}/${observed.length} unlimited management runs passed every automatic check.`, '',
  'Worker reply failures included unescaped newlines and invalid escapes in JSON strings, unfinished JSON at the output token ceiling, ' +
    'and drawings containing comments or missing the required elements array. Articles also failed the length and reference checks. ' +
    'These scores apply to this output format, token ceiling, and task suite.', '',
  'Manager assignments are accepted when a recognized task field contains an available setting ID. ' +
    'Invalid assignments use the price-list specialist for that skill, and invalid revision requests are ignored. ' +
    'Hiring and own-family choice counts include accepted setting IDs only.', '',
  '| Manager family | Traces | Assignment JSON / calls | Valid IDs / slots | Fallback slots | Review JSON / calls | Recognized review keys | Valid revision IDs | Revision worker calls |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...managerDecisionRows, '',
  `${managerDecisions.validAssignmentIds}/${managerDecisions.assignmentSlots} initial assignment slots contained accepted model choices, ` +
    `and ${managerDecisions.fallbackAssignments} used specialist defaults. ` +
    `${managerDecisions.placeholderSkillKeyReviews} saved reviews contained the literal key skill, which is not one of the four task names. ` +
    'JSON columns count parseable outer objects. Valid IDs require both a recognized task field and an available setting.', '',
  'The pilot review prompt used the schematic example {"revisions":{"skill":"setting"}}. ' +
    'Its placeholder key can invite literal copying. The assignment prompt requested an available setting for each skill, while the parser required an exact menu ID. ' +
    'These results measure compatibility among this prompt, the decoder, token limits, and the strict schema. ' +
    'A clarified schema example is a proposed protocol change for Gate 2 review. ' +
    'The proposed review instruction accepts article, derivation, simulation, and illustration as task keys, with exact menu IDs as string values. ' +
    'A concrete example is {"revisions":{"simulation":"mistral-top-d128"}}. ' +
    'Unchanged tasks are omitted, and an empty revisions object requests zero revisions.', '',
  ...fallbackPassNotes, ...(fallbackPassNotes.length ? [''] : []),
  ...(runtimeFields.length ? [`The verified smoke response records ${runtimeFields.join(', ')}.`, ''] : []),
  '| Local ID | Role | Checkpoint | Pinned revision |',
  '| --- | --- | --- | --- |', ...rosterRows, '',
  'The per-cell envelope combines the maximum observed allocation per management style with the pilot blind panel allocation per case. ' +
    'Queue allocations include model loading, resident idle time, interrupted attempts, and release checks. ' +
    'The main blind panel remains batched across cases. All identified GPU setup is included in these envelopes and the fixed main allowance is zero.', '',
  'The budget curve reports evaluated grids in the registered cut order through the first fit or the smallest allowed grid.', '',
  '| Packs | Repeats | Manager rotations | Runs | Projected main GPUh | Total GPUh |',
  '| ---: | ---: | ---: | ---: | ---: | ---: |', ...budgetRows, '',
  'Family-conditioned proposal costs use each family\'s maximum completed manager-trace allocation plus the same panel share per case. ' +
    'The cost-support counts refer to completed allocation measurements. One trace provides sparse support for a family and task combination. ' +
    'Observed maxima are conditional point estimates and do not guarantee upper bounds or completion within forty GPU-hours.', '',
  'The default manager-choice assignment rule was used in unlimited pilot runs without resource disclosures. ' +
    'Future finite-resource told prompts are extrapolations from those references. ' +
    'Each family observation combines one tryout pack, its allocation decisions, and the actual interruption period. ' +
    'These observations do not isolate a causal architecture cost.', '',
  'Each manager-family cost reference contains six requests and zero accepted revisions. ' +
    'These projections describe the observed prompts and controller decisions. ' +
    'Clarifying the review schema could activate up to four additional worker requests and change assignments, call-quota pressure, loading, and interruption exposure. ' +
    'Costs for that prompt intervention remain unmeasured.', '',
  '| Manager family | Cost traces | Max trace allocation s | Panel share s | Conditional cell allocation s |',
  '| --- | ---: | ---: | ---: | ---: |', ...managerCostRows, '',
  `The common-global manager sensitivity uses the ${globalManagerCase?.[0] ?? 'largest observed'} case at ` +
    `${number(perCellGpuSeconds['manager-and-workers'])} seconds per cell including panel share. ` +
    `The fixed ${grid.managerFamilies[0]} proposals use that family's supported observation. ` +
    'A missing supported family estimate uses the valid global fallback, which is labeled in the proposal tables. ' +
    'The original registered budget curve uses the common-global method.', '',
  ...scopeProposalSection,
  ...mathematicalSection,
  '| Scarcity condition | Limit | Unlimited traces that broke it |', '| --- | --- | ---: |', ...limitRows, '',
  'The compute condition is calibrated in backend execution wall seconds. The 40 GPU-hour project budget uses charged allocation.', '',
  'The unlimited condition uses the overall project cap. Queue contention inherits the compute cap break share and adds waiting before dispatch.', '',
  '| Worker | Draft cap | Skill | Quality (scored) | Excluding own judge (scored) | Execution wall s | Service wall s | API USD | Worker replies |',
  '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...resultRows, '',
  'Quality ranges from 0 to 1. A dash marks an unavailable measurement. Timing uses backend wall timers, request timestamps, and the desktop watchdog.', '',
  'Execution wall seconds measure elapsed backend processing, including drafting, input preparation, CPU vision work where configured, synchronized generation, and decoding. ' +
    'Error replies include processing before failure. Service wall seconds use request timestamps and include request parsing. ' +
    'Pack wall time includes admission waits and desktop checks.', '',
  'Parentheses show scored cases out of the five tryouts. Successful worker replies have status ok. ' +
    'Automatic-check failures contribute zero, and panel means use available valid ratings.', '',
  '## Blind rating coverage', '',
  '| Judge | Returned / requests | Article ratings / eligible | Image ratings / eligible |',
  '| --- | ---: | ---: | ---: |', ...coverageRows, '',
  'Ratings count when their ranges and checklist lengths meet the scoring schema. Missing ratings are omitted from means.', '',
  'OLMo-2 1B uses its native 4,096-token context. Context-limit refusals count as failed artifacts, and their elapsed drafting time is included.', '',
  'GLM-4.6V-Flash uses BF16 with its vision encoder on CPU and its language model on CUDA. ' +
    'After a long-review calibration OOM, subsequent text requests use native Transformers prefill chunks of 1,024 tokens with caching. ' +
    'Image requests use native unchunked prefill. Reply metadata records both settings. ' +
    'The calibration includes both text prefill modes, which evaluate floating-point operations in different shapes. ' +
    'One matched GLM assignment reproduced identical CUDA text across the modes; the recovered 2,768-token review completed within the same memory guard. ' +
    'Ministral 3 8B BF16 also uses native 1,024-token cached text prefill after its long manager assignment exceeded the same reserve-constrained guard. ' +
    'Its earlier price-list calls used unchunked prefill, and image requests retain native unchunked prefill. ' +
    'Tiny CPU wrapper tests check greedy equivalence and configuration restoration. ' +
    'Earlier CUDA OOM replies were archived and their original requests retried. The GPU usage ledger retains the failed allocations.', '',
].join('\n'), 'utf8');
console.log(`Gate 2: ${projection.status}; inputs and results are in ${directory}`);
