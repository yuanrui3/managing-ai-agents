import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { costFamilyRotationProposals, familyRotationProposal } from '../scripts/analyze-pilot-math.mjs';
import { CONDITIONS, GPU_BUDGET_SECONDS, planGpu, proposeBudgetScopes, STYLES } from '../src/gpu-planning.mjs';

const grid = {
  packIds: Array.from({ length: 20 }, (_, index) => `main-${index + 1}`), repeats: 2,
  managerFamilies: ['qwen', 'granite', 'glm', 'olmo', 'mistral'],
  managerPolicies: ['always-top', 'cheapest-passing', 'manager-choice', 'escalate-on-failure'], visibility: ['told', 'not-told'],
};
const rotation = familyRotationProposal(grid);
const costs = { stageGpuSeconds: 1000, fixedMainGpuSeconds: 2000,
  perCellGpuSeconds: { 'manager-and-workers': 100, 'solo-best': 50 } };

test('importing the analysis module does not run its CLI from unrelated arguments or working directories', async () => {
  const moduleUrl = new URL('../scripts/analyze-pilot-math.mjs', import.meta.url).href;
  const source = `process.argv = [process.execPath, 'unrelated-cli.mjs', 'invalid-run-id!'];
    const analysis = await import(${JSON.stringify(moduleUrl)});
    if (typeof analysis.familyRotationProposal !== 'function' || typeof analysis.costFamilyRotationProposals !== 'function') {
      throw new Error('Missing pure analysis exports');
    }`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source],
    { cwd: tmpdir(), encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('family-rotation costs cover 120, 84, and 60 cells and apply overrides only to included controls', () => {
  const before = structuredClone(rotation);
  const result = costFamilyRotationProposals(rotation, costs);
  assert.deepEqual(rotation, before);
  assert.deepEqual(result.evaluated.map(candidate => candidate.counts.totalCells), [120, 84, 60, 84]);
  assert.deepEqual(result.evaluated.map(candidate => candidate.counts.matchedSoloCells), [60, 24, 0, 24]);
  assert.deepEqual(result.evaluated.map(candidate => candidate.projectedProjectGpuSeconds), [12_000, 10_200, 9000, 10_200]);
  assert.ok(result.evaluated.every(candidate => candidate.projectedProjectGpuSeconds === candidate.globalSensitivity.projectedProjectGpuSeconds));
  for (const candidate of result.evaluated) {
    assert.equal(candidate.status, 'proposed-unapproved');
    assert.equal(candidate.approvalRequired, true);
    assert.equal(candidate.seed, rotation.seed);
    assert.equal(candidate.repeats, 1);
    assert.equal(candidate.managerPolicy, 'manager-choice');
    assert.equal(candidate.visibility, 'told');
    assert.equal(candidate.counts.managerCells, 60);
    for (const condition of CONDITIONS) {
      assert.equal(candidate.cellsPerCondition[condition].manager, 12);
      assert.equal(candidate.cellsPerCondition[condition].solo, candidate.soloConditions.includes(condition) ? 12 : 0);
    }
  }
  assert.deepEqual(result.evaluated[1].soloConditions, ['unlimited', 'compute-cap']);
  const overridden = costFamilyRotationProposals(rotation, { ...costs, conditionOverrides: {
    'compute-cap': { 'manager-and-workers': 200, 'solo-best': 80 },
    deadline: { 'manager-and-workers': 150, 'solo-best': 500 },
  } });
  assert.deepEqual(overridden.evaluated.map(candidate => candidate.mainCellGpuSeconds), [16_560, 9360, 7800, 9360]);
  assert.deepEqual(overridden.evaluated.map(candidate => candidate.projectedProjectGpuSeconds), [19_560, 12_360, 10_800, 12_360]);
});

test('rotation projections respect the inclusive budget and stay symbolic without allocation envelopes', () => {
  const atLimit = { ...costs, fixedMainGpuSeconds: 0, stageGpuSeconds: GPU_BUDGET_SECONDS - 9000 };
  const exact = costFamilyRotationProposals(rotation, atLimit);
  assert.equal(exact.evaluated[0].fitsBudget, true);
  assert.equal(exact.evaluated[0].remainingGpuSeconds, 0);
  const over = costFamilyRotationProposals(rotation, { ...atLimit, stageGpuSeconds: atLimit.stageGpuSeconds + 1 });
  assert.equal(over.evaluated[0].fitsBudget, false);
  assert.equal(over.evaluated[0].remainingGpuSeconds, -1);
  assert.equal(Object.hasOwn(exact, 'selected'), false);
  const symbolic = costFamilyRotationProposals(rotation);
  assert.equal(symbolic.costStatus, 'symbolic-only');
  assert.ok(symbolic.evaluated.every(candidate => candidate.fitsBudget === null
    && candidate.projectedProjectGpuSeconds === null && candidate.remainingGpuSeconds === null));
  assert.throws(() => costFamilyRotationProposals(rotation, { ...costs, fixedMainGpuSeconds: -1 }), /nonnegative/);
  assert.ok(costFamilyRotationProposals(rotation, { stageGpuSeconds: 0, fixedMainGpuSeconds: 0 })
    .evaluated.every(candidate => candidate.fitsBudget === null));
});

test('rotation support uses all five manager and solo references at frozen limits and leaves the nine proposals intact', () => {
  const unlimited = Array.from({ length: 5 }, (_, packIndex) => STYLES.map((style, styleIndex) => ({
    packId: `tryout-${packIndex + 1}`, style,
    ...(style === 'manager-and-workers' && { managerFamily: grid.managerFamilies[packIndex] }),
    activeSeconds: 10 * (styleIndex + 1) + packIndex, wallSeconds: 100 + 10 * (styleIndex + 1) + packIndex,
    calls: Array.from({ length: styleIndex + 1 }, (_, index) =>
      ({ family: 'qwen', settingId: 'qwen-top', startedMs: index })),
  }))).flat();
  const input = { ...costs, grid, unlimited, slotExtraDelayMs: 125,
    perCellGpuSeconds: Object.fromEntries(STYLES.map(style => [style, style === 'manager-and-workers' ? 100 : 50])) };
  const before = structuredClone(input);
  const originalPlan = planGpu(input);
  const nineBefore = proposeBudgetScopes(input);
  const result = costFamilyRotationProposals(rotation, { ...input, calibration: originalPlan.calibration });
  assert.deepEqual(input, before);
  assert.deepEqual(planGpu(input), originalPlan);
  assert.deepEqual(proposeBudgetScopes(input), nineBefore);
  assert.equal(nineBefore.evaluated.length, 9);
  const support = result.calibrationSupport;
  assert.equal(support.status, 'diagnostic-only');
  assert.equal(support.limitSource, 'registered-full-pilot');
  assert.deepEqual(support.frozenLimits, {
    activeSeconds: 32, wallSeconds: 132, maxCallsPerFamily: 3, quotaWindowMs: 60_000, queueDelayMsPerCall: 125,
  });
  assert.equal(support.byStyle['manager-and-workers'].samples, 5);
  assert.equal(support.byStyle['solo-best'].samples, 5);
  assert.ok(Object.values(support.managerSamplesByFamily).every(count => count === 1));
  assert.equal(support.byStyle['manager-and-workers'].computeCap.breaks, 2);
  assert.equal(support.byStyle['manager-and-workers'].computeCap.breakShare, 0.4);
  assert.equal(support.byStyle['solo-best'].computeCap.breaks, 0);
  assert.equal(support.byStyle['manager-and-workers'].callQuota.breaks, 0);
  const fixed = result.evaluated.at(-1);
  assert.equal(fixed.fixedFamily, grid.managerFamilies[0]);
  assert.equal(fixed.calibrationSupport.byStyle['manager-and-workers'].samples, 1);
  assert.equal(fixed.calibrationSupport.byStyle['solo-best'].samples, 5);
  assert.deepEqual(fixed.managerCellsByFamily, { qwen: 60 });
  assert.ok(fixed.assignmentMatrix.every(row => Object.values(row.familyByCondition).every(family => family === 'qwen')));
  assert.match(fixed.lostQuestions, /Family, policy and visibility/);
});

test('heterogeneous family estimates use assigned family counts and expose common-global sensitivity', () => {
  const input = { ...costs, perCellGpuSeconds: { 'manager-and-workers': 1000, 'solo-best': 50 },
    managerFamilyGpuSeconds: { qwen: 100, granite: 200, glm: 300, olmo: 400, mistral: 500 },
    managerFamilySampleCounts: Object.fromEntries(grid.managerFamilies.map(family => [family, 1])) };
  const before = structuredClone(input);
  const result = costFamilyRotationProposals(rotation, input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.evaluated.map(candidate => candidate.projectedProjectGpuSeconds), [24_000, 22_200, 21_000, 10_200]);
  assert.deepEqual(result.evaluated.map(candidate => candidate.globalSensitivity.projectedProjectGpuSeconds), [66_000, 64_200, 63_000, 64_200]);
  for (const candidate of result.evaluated.slice(0, 3)) {
    assert.deepEqual(candidate.managerCellsByFamily, Object.fromEntries(Object.keys(rotation.managerCellsByFamily).map(family => [family, 12])));
    assert.deepEqual(candidate.managerCostSupport.fallbackFamilies, []);
  }
  const overrides = Object.fromEntries(CONDITIONS.map(condition => [condition,
    { 'manager-and-workers': 75, 'solo-best': 20 }]));
  const overridden = costFamilyRotationProposals(rotation, { ...input, conditionOverrides: overrides });
  assert.deepEqual(overridden.evaluated.map(candidate => candidate.projectedProjectGpuSeconds), [8700, 7980, 7500, 7980]);
  assert.ok(overridden.evaluated.every(candidate => candidate.projectedProjectGpuSeconds === candidate.globalSensitivity.projectedProjectGpuSeconds));
});

test('missing family support uses a labeled valid global fallback and otherwise leaves incomplete candidates unpriced', () => {
  const input = { ...costs, perCellGpuSeconds: { 'manager-and-workers': 1000, 'solo-best': 50 },
    managerFamilyGpuSeconds: { qwen: 100 }, managerFamilySampleCounts: { qwen: 1 } };
  const result = costFamilyRotationProposals(rotation, input);
  assert.deepEqual(result.evaluated.map(candidate => candidate.projectedProjectGpuSeconds), [55_200, 53_400, 52_200, 10_200]);
  assert.equal(result.evaluated[0].managerCostSupport.fallbackFamilies.length, 4);
  assert.ok(result.evaluated.every(candidate => candidate.fitsBudget === true));
  const unsupportedQwen = costFamilyRotationProposals(rotation, { ...input, managerFamilySampleCounts: { qwen: 0 } }).evaluated.at(-1);
  assert.equal(unsupportedQwen.projectedProjectGpuSeconds, 64_200);
  assert.deepEqual(unsupportedQwen.managerCostSupport.fallbackFamilies, ['qwen']);
  assert.equal(unsupportedQwen.fitsBudget, true);
  const noGlobal = costFamilyRotationProposals(rotation, { ...input, perCellGpuSeconds: { 'solo-best': 50 } });
  assert.ok(noGlobal.evaluated.slice(0, 3).every(candidate => candidate.fitsBudget === null));
  assert.equal(noGlobal.evaluated.at(-1).projectedProjectGpuSeconds, 10_200);
  assert.equal(noGlobal.evaluated.at(-1).fitsBudget, true);
  assert.ok(noGlobal.evaluated.every(candidate => candidate.globalSensitivity.fitsBudget === null));
  const overridden = costFamilyRotationProposals(rotation, { stageGpuSeconds: 1000, fixedMainGpuSeconds: 2000,
    conditionOverrides: Object.fromEntries(CONDITIONS.map(condition => [condition,
      { 'manager-and-workers': 75, 'solo-best': 20 }])) });
  assert.deepEqual(overridden.evaluated.map(candidate => candidate.projectedProjectGpuSeconds), [8700, 7980, 7500, 7980]);
});
