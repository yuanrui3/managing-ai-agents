import assert from 'node:assert/strict';
import test from 'node:test';
import { CONDITIONS, designBudget, GPU_BUDGET_SECONDS, planGpu, proposeBudgetScopes, STYLES } from '../src/gpu-planning.mjs';

const grid = {
  packIds: Array.from({ length: 20 }, (_, index) => `main-${index + 1}`),
  managerFamilies: ['family-a', 'family-b', 'family-c', 'family-d', 'family-e'],
  managerPolicies: ['always-top', 'cheapest-passing', 'manager-choice', 'escalate-on-failure'],
  visibility: ['told', 'not-told'],
  repeats: 2,
};
const call = (startedMs, family = 'family-a') => ({ family, settingId: `${family}-small`, startedMs });
const run = (packId, activeSeconds, wallSeconds, calls) => ({ packId, style: 'solo-best', activeSeconds, wallSeconds, calls });
const unlimited = [
  run('tryout-01', 10, 70, [call(60_000), call(0), call(0, 'family-b')]),
  run('tryout-02', 20, 70, [call(5_000)]),
  run('tryout-03', 20, 100, [call(59_999), call(0), call(60_000)]),
  { ...run('tryout-04', 40, 110, [call(0), call(0), call(1)]), style: 'manager-and-workers', managerFamily: 'family-a' },
];
const envelope = seconds => Object.fromEntries(STYLES.map(style => [style, seconds]));

test('calibration measures inclusive breaks and a sliding per-family window', () => {
  const { calibration, projection } = planGpu({ unlimited, slotExtraDelayMs: 125 });
  assert.deepEqual(calibration.computeCap, { activeSeconds: 20, breaks: 1, runs: 4, breakShare: 0.25 });
  assert.deepEqual(calibration.deadline, { wallSeconds: 70, breaks: 2, runs: 4, breakShare: 0.5 });
  assert.equal(calibration.callQuota.maxCallsPerFamily, 1);
  assert.equal(calibration.callQuota.breakShare, 0.5);
  assert.deepEqual(calibration.samples.map(row => row.peakFamilyCalls), [1, 1, 2, 3]);
  assert.equal(calibration.samples[3].managerFamily, 'family-a');
  assert.equal(calibration.oneGpuSlot.breakShare, 0.25);
  assert.equal(calibration.oneGpuSlot.extraDelayMsPerCall, 125);
  assert.equal(projection.status, 'unavailable');
});

test('budget cuts keep all conditions, the same packs across cells, and the rotation priority', () => {
  const { projection } = planGpu({
    unlimited, slotExtraDelayMs: 125, grid,
    stageGpuSeconds: 3000, fixedMainGpuSeconds: 1000,
    perCellGpuSeconds: envelope(170), conditionOverrides: { 'one-gpu-slot': { tournament: 680 } },
  });
  assert.equal(projection.status, 'projected-fit');
  assert.deepEqual(projection.evaluated.map(row => row.cut), [
    'none', 'one-repeat', ...Array(8).fill('remove-pack'), ...Array(4).fill('remove-manager-rotation'),
  ]);
  assert.deepEqual(projection.selected.conditions, CONDITIONS);
  assert.deepEqual(projection.selected.grid.packIds, grid.packIds.slice(0, 12));
  assert.deepEqual(projection.selected.grid.managerFamilies, grid.managerFamilies.slice(0, 1));
  assert.equal(projection.selected.runs, 720);
  assert.equal(projection.selected.projectedProjectGpuSeconds, 132_520);
});

test('budget infeasibility is reported at the smallest allowed grid', () => {
  const result = planGpu({
    unlimited, slotExtraDelayMs: 125, grid,
    stageGpuSeconds: 3000, fixedMainGpuSeconds: 1000, perCellGpuSeconds: envelope(200),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.projection.status, 'blocked-budget');
  assert.equal(result.projection.selected, null);
  assert.equal(result.projection.evaluated.at(-1).remainingGpuSeconds, -4000);
});

test('design arithmetic is available without creating a measured estimate', () => {
  const result = planGpu({ grid, stageGpuSeconds: 0, fixedMainGpuSeconds: 1000, perCellGpuSeconds: envelope(1) });
  assert.equal(result.status, 'blocked');
  assert.equal(result.calibration.status, 'unavailable');
  assert.equal(result.projection.status, 'unavailable');
  const design = designBudget({ grid });
  assert.equal(design.status, 'design-only');
  assert.equal(design.evaluated[0].runs, 8800);
  assert.equal(design.evaluated.at(-1).maximumAverageGpuSecondsPerCell, 200);
});

test('scope proposals enumerate all optional style subsets with exact grid counts and allocation costs', () => {
  const input = {
    grid, stageGpuSeconds: 1000, fixedMainGpuSeconds: 2000, perCellGpuSeconds: envelope(100),
    conditionOverrides: { 'one-gpu-slot': { tournament: 200 } },
  };
  const before = structuredClone(input);
  const proposals = proposeBudgetScopes(input);
  assert.deepEqual(input, before);
  assert.equal(proposals.status, 'proposed-unapproved');
  assert.equal(proposals.approvalRequired, true);
  assert.equal(proposals.evaluated.length, 9);
  assert.equal(new Set(proposals.evaluated.map(candidate => candidate.styles.join(','))).size, 9);
  assert.deepEqual(proposals.evaluated.map(candidate => candidate.styles.length), [5, 4, 4, 4, 3, 3, 3, 2, 1]);
  for (const candidate of proposals.evaluated) {
    assert.deepEqual(candidate.grid, {
      packIds: grid.packIds.slice(0, 12), repeats: 1, managerFamilies: ['family-a'],
      managerPolicies: ['manager-choice'], visibility: ['told'],
    });
    assert.deepEqual(candidate.conditions, CONDITIONS);
    assert.deepEqual(candidate.runsPerCondition, Object.fromEntries(candidate.styles.map(style => [style, 12])));
    assert.equal(candidate.runs, candidate.styles.length * 60);
    assert.equal(candidate.status, 'proposed-unapproved');
    assert.equal(candidate.approvalRequired, true);
    assert.equal(candidate.calibrationSupport.status, 'unavailable');
    if (candidate.styles.length > 1) {
      assert.ok(candidate.styles.includes('solo-best'));
      assert.ok(candidate.styles.includes('manager-and-workers'));
    }
  }
  assert.equal(proposals.evaluated[0].mainCellGpuSeconds, 31_200);
  assert.equal(proposals.evaluated[0].projectedMainGpuSeconds, 33_200);
  assert.equal(proposals.evaluated[0].projectedProjectGpuSeconds, 34_200);
  assert.equal(proposals.evaluated.at(-1).projectedProjectGpuSeconds, 9000);
  assert.deepEqual(proposals.selected.styles, STYLES);
});

test('scope selection prefers the most styles that fit and then the lowest exact projected cost', () => {
  const proposals = proposeBudgetScopes({
    grid, stageGpuSeconds: 72_000, fixedMainGpuSeconds: 3600,
    perCellGpuSeconds: { 'solo-best': 200, specialists: 100, 'manager-and-workers': 400, tournament: 1000, 'cheap-first': 300 },
  });
  assert.deepEqual(proposals.selected.styles, ['solo-best', 'specialists', 'manager-and-workers', 'cheap-first']);
  assert.equal(proposals.selected.runs, 240);
  assert.equal(proposals.selected.mainCellGpuSeconds, 60_000);
  assert.equal(proposals.selected.projectedMainGpuSeconds, 63_600);
  assert.equal(proposals.selected.projectedProjectGpuSeconds, 135_600);
  assert.equal(proposals.selected.remainingGpuSeconds, 8400);
  assert.equal(proposals.selected.fitsBudget, true);
  for (let index = 1; index < proposals.evaluated.length; index += 1) {
    const previous = proposals.evaluated[index - 1];
    const current = proposals.evaluated[index];
    if (previous.styles.length === current.styles.length) {
      assert.ok(previous.projectedProjectGpuSeconds <= current.projectedProjectGpuSeconds);
    }
  }
});

test('manager-only proposals respect the inclusive project budget and return no selection when none fit', () => {
  const input = { grid, stageGpuSeconds: 84_000, fixedMainGpuSeconds: 0, perCellGpuSeconds: envelope(1000) };
  const proposals = proposeBudgetScopes(input);
  assert.deepEqual(proposals.selected.styles, ['manager-and-workers']);
  assert.equal(proposals.selected.runs, 60);
  assert.equal(proposals.selected.projectedProjectGpuSeconds, GPU_BUDGET_SECONDS);
  assert.equal(proposals.selected.remainingGpuSeconds, 0);
  assert.equal(proposals.approvalRequired, true);
  const blocked = proposeBudgetScopes({ ...input, stageGpuSeconds: input.stageGpuSeconds + 1 });
  assert.equal(blocked.selected, null);
  assert.ok(blocked.evaluated.every(candidate => !candidate.fitsBudget));
  assert.equal(blocked.status, 'proposed-unapproved');
  assert.throws(() => proposeBudgetScopes({ ...input, grid: { ...grid, visibility: ['not-told'] } }), /told visibility/);
  assert.throws(() => proposeBudgetScopes({ ...input, grid: { ...grid, managerPolicies: ['always-top'] } }), /manager-choice policy/);
});

test('scope support filters manager families and styles while measuring frozen limits with equal style weights', () => {
  const traces = Array.from({ length: 5 }, (_, packIndex) => STYLES.map(style => {
    const [activeSeconds, wallSeconds, quotaPeak] = {
      'solo-best': [10, 20, 1], specialists: [30, 40, 2],
      'manager-and-workers': packIndex === 0 ? [70, 80, 4] : [50, 60, 3],
      tournament: [90, 100, 5], 'cheap-first': [110, 120, 6],
    }[style];
    return {
      packId: `tryout-${packIndex + 1}`, style, activeSeconds, wallSeconds,
      calls: Array.from({ length: quotaPeak }, (_, index) => call(index)),
      ...(style === 'manager-and-workers' && { managerFamily: grid.managerFamilies[packIndex] }),
    };
  })).flat();
  const input = { unlimited: traces, slotExtraDelayMs: 125, grid,
    stageGpuSeconds: 1000, fixedMainGpuSeconds: 0, perCellGpuSeconds: envelope(100) };
  const before = structuredClone(input);
  const originalPlan = planGpu(input);
  const proposals = proposeBudgetScopes(input);
  assert.deepEqual(input, before);
  assert.deepEqual(planGpu(input), originalPlan);
  const support = proposals.evaluated.find(candidate => candidate.styles.length === 2).calibrationSupport;
  assert.equal(support.status, 'diagnostic-only');
  assert.equal(support.limitSource, 'registered-full-pilot');
  assert.deepEqual(support.frozenLimits, {
    activeSeconds: 50, wallSeconds: 60, maxCallsPerFamily: 3, quotaWindowMs: 60_000, queueDelayMsPerCall: 125,
  });
  assert.equal(support.original.sampleCount, 25);
  assert.deepEqual(support.original.countsByStyle, Object.fromEntries(STYLES.map(style => [style, 5])));
  assert.deepEqual(support.original.managerSamplesByFamily, Object.fromEntries(grid.managerFamilies.map(family => [family, 1])));
  assert.equal(support.retained.sampleCount, 6);
  assert.deepEqual(support.retained.countsByStyle, { 'solo-best': 5, 'manager-and-workers': 1 });
  assert.deepEqual(support.retained.managerSamplesByFamily, { 'family-a': 1 });
  assert.ok(support.retained.sampleReferences.every(sample => sample.style === 'solo-best' || sample.managerFamily === 'family-a'));
  assert.ok(support.retained.sampleReferences.every(sample => sample.packId.startsWith('tryout-')));
  for (const condition of ['computeCap', 'deadline', 'callQuota']) {
    assert.equal(support.original[condition].breaks, 11);
    assert.equal(support.original[condition].breakShare, 11 / 25);
    assert.ok(Math.abs(support.original[condition].equalStyleBreakShare - 11 / 25) < Number.EPSILON);
    assert.deepEqual(support.retained[condition].byStyle['manager-and-workers'], { breaks: 1, runs: 1, breakShare: 1 });
    assert.equal(support.retained[condition].breaks, 1);
    assert.equal(support.retained[condition].breakShare, 1 / 6);
    assert.equal(support.retained[condition].equalStyleBreakShare, 0.5);
    assert.equal(proposals.selected.calibrationSupport.retained[condition].equalStyleBreakShare, 0.6);
  }
  assert.match(support.notes.join(' '), /has 1 retained calibration sample/);
  assert.match(support.notes.join(' '), /solo-best samples show zero observed pressure/);
  const managerOnly = proposals.evaluated.at(-1).calibrationSupport;
  assert.equal(managerOnly.retained.sampleCount, 1);
  assert.equal(managerOnly.retained.computeCap.breaks, 1);
  assert.equal(managerOnly.frozenLimits.activeSeconds, 50);
});

test('scope support exposes zero quota pressure and missing-style support without retuning limits', () => {
  const traces = unlimited.map(trace => ({ ...trace, calls: [call(0)] }));
  const input = { unlimited: traces, slotExtraDelayMs: 125, grid,
    stageGpuSeconds: 1000, fixedMainGpuSeconds: 0, perCellGpuSeconds: envelope(100) };
  const proposals = proposeBudgetScopes(input);
  const support = proposals.selected.calibrationSupport;
  assert.equal(support.frozenLimits.maxCallsPerFamily, 1);
  assert.equal(support.retained.callQuota.breaks, 0);
  assert.equal(support.retained.callQuota.breakShare, 0);
  assert.equal(support.retained.callQuota.equalStyleBreakShare, null);
  assert.match(support.notes.join(' '), /zero observed quota pressure/);
  assert.match(support.notes.join(' '), /included style has no reference samples/);
  const supported = proposals.evaluated.find(candidate => candidate.styles.length === 2).calibrationSupport;
  assert.equal(supported.retained.callQuota.equalStyleBreakShare, 0);
  assert.deepEqual(supported.retained.computeCap.byStyle['solo-best'], { breaks: 0, runs: 3, breakShare: 0 });
  assert.equal(supported.frozenLimits.activeSeconds, 20);
});

test('fixed-family proposals use supported family costs while registered planning keeps the global curve', () => {
  const input = { unlimited, slotExtraDelayMs: 125, grid, stageGpuSeconds: 1000, fixedMainGpuSeconds: 2000,
    perCellGpuSeconds: Object.fromEntries(STYLES.map(style => [style,
      style === 'manager-and-workers' ? 1000 : style === 'solo-best' ? 50 : 100])) };
  const legacyPlan = planGpu(input);
  const legacy = proposeBudgetScopes(input);
  const familyInput = { ...input, managerFamilyGpuSeconds: { 'family-a': 100 }, managerFamilySampleCounts: { 'family-a': 1 } };
  const before = structuredClone(familyInput);
  const conditioned = proposeBudgetScopes(familyInput);
  assert.deepEqual(familyInput, before);
  assert.deepEqual(planGpu(familyInput), legacyPlan);
  assert.equal(conditioned.evaluated.length, 9);
  for (const candidate of conditioned.evaluated) {
    const common = legacy.evaluated.find(row => row.styles.join(',') === candidate.styles.join(','));
    assert.equal(candidate.projectedProjectGpuSeconds, common.projectedProjectGpuSeconds - 54_000);
    assert.equal(candidate.globalSensitivity.projectedProjectGpuSeconds, common.projectedProjectGpuSeconds);
    assert.equal(candidate.managerCostSupport.byCondition.unlimited.source, 'family-conditioned');
    assert.equal(candidate.managerCostSupport.byCondition.unlimited.samples, 1);
  }
  const overrideInput = { ...familyInput, conditionOverrides: { 'compute-cap': { 'manager-and-workers': 200 } } };
  const managerOnly = proposeBudgetScopes(overrideInput).evaluated.find(candidate => candidate.styles.length === 1);
  assert.equal(managerOnly.projectedProjectGpuSeconds, 10_200);
  assert.equal(managerOnly.globalSensitivity.projectedProjectGpuSeconds, 53_400);
  assert.equal(managerOnly.managerCostSupport.byCondition['compute-cap'].source, 'condition-override');
});

test('missing or unsupported matched-family costs keep explicitly labeled global fallback pricing', () => {
  const input = { grid, stageGpuSeconds: 1000, fixedMainGpuSeconds: 2000,
    perCellGpuSeconds: Object.fromEntries(STYLES.map(style => [style, 100])) };
  const legacy = proposeBudgetScopes(input);
  for (const familyData of [
    { managerFamilyGpuSeconds: {}, managerFamilySampleCounts: {} },
    { managerFamilyGpuSeconds: { 'family-a': 10 }, managerFamilySampleCounts: { 'family-a': 0 } },
    { managerFamilyGpuSeconds: { 'family-a': 10 } },
  ]) {
    const fallback = proposeBudgetScopes({ ...input, ...familyData });
    assert.deepEqual(fallback.evaluated.map(candidate => candidate.projectedProjectGpuSeconds),
      legacy.evaluated.map(candidate => candidate.projectedProjectGpuSeconds));
    assert.deepEqual(fallback.selected.styles, legacy.selected.styles);
    assert.equal(fallback.selected.fitsBudget, true);
    assert.equal(fallback.selected.managerCostSupport.byCondition.unlimited.source, 'global-fallback');
    assert.deepEqual(fallback.selected.managerCostSupport.fallbackConditions, CONDITIONS);
  }
  assert.equal(legacy.selected.managerCostSupport.byCondition.unlimited.source, 'common-global');
});
