export const GPU_BUDGET_SECONDS = 40 * 3600;
export const QUOTA_WINDOW_MS = 60_000;
export const CONDITIONS = ['unlimited', 'compute-cap', 'deadline', 'call-quota', 'one-gpu-slot'];
export const STYLES = ['solo-best', 'specialists', 'manager-and-workers', 'tournament', 'cheap-first'];

const managerStyle = 'manager-and-workers';
const minPacks = 12;

function requireSeconds(value, field, positive = false) {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new Error(`${field} must be a finite ${positive ? 'positive' : 'nonnegative'} number of seconds.`);
  }
}

function requireDistinct(names, field, minLength = 1) {
  if (!Array.isArray(names) || names.length < minLength || new Set(names).size !== names.length
      || names.some(name => typeof name !== 'string' || !name.trim())) {
    throw new Error(`${field} must contain at least ${minLength} distinct nonempty names.`);
  }
}

function namesOfGrid(grid) {
  const { packIds, managerFamilies, managerPolicies, visibility, repeats } = grid;
  requireDistinct(packIds, 'grid.packIds', minPacks);
  requireDistinct(managerFamilies, 'grid.managerFamilies');
  requireDistinct(managerPolicies, 'grid.managerPolicies');
  requireDistinct(visibility, 'grid.visibility');
  if (![1, 2].includes(repeats)) throw new Error('grid.repeats must be one or two.');
  return { packIds, managerFamilies, managerPolicies, visibility, repeats };
}

function* budgetGrids(grid) {
  let candidate = namesOfGrid(grid);
  yield { cut: 'none', grid: candidate };
  if (candidate.repeats === 2) {
    candidate = { ...candidate, repeats: 1 };
    yield { cut: 'one-repeat', grid: candidate };
  }
  while (candidate.packIds.length > minPacks) {
    candidate = { ...candidate, packIds: candidate.packIds.slice(0, -1) };
    yield { cut: 'remove-pack', grid: candidate };
  }
  while (candidate.managerFamilies.length > 1) {
    candidate = { ...candidate, managerFamilies: candidate.managerFamilies.slice(0, -1) };
    yield { cut: 'remove-manager-rotation', grid: candidate };
  }
}

function cellCounts(grid, styles = STYLES) {
  const ordinaryRuns = grid.packIds.length * grid.repeats;
  const managerVariants = grid.managerFamilies.length * grid.managerPolicies.length * grid.visibility.length;
  const runsPerCondition = Object.fromEntries(styles.map(style => [
    style, ordinaryRuns * (style === managerStyle ? managerVariants : 1),
  ]));
  const runs = Object.values(runsPerCondition).reduce((sum, count) => sum + count, 0) * CONDITIONS.length;
  return {
    packs: grid.packIds.length,
    repeats: grid.repeats,
    managerRotations: grid.managerFamilies.length,
    runsPerCondition,
    runs,
  };
}

function largestQuotaWindow(calls) {
  const timesByFamily = new Map();
  for (const { family, startedMs } of calls) {
    if (!timesByFamily.has(family)) timesByFamily.set(family, []);
    timesByFamily.get(family).push(startedMs);
  }
  let maximum = 0;
  for (const starts of timesByFamily.values()) {
    starts.sort((first, second) => first - second);
    let first = 0;
    for (let last = 0; last < starts.length; last += 1) {
      while (starts[last] - starts[first] >= QUOTA_WINDOW_MS) first += 1;
      maximum = Math.max(maximum, last - first + 1);
    }
  }
  return maximum;
}

function closestToHalf(values, minLimit) {
  const candidates = [...new Set([minLimit, ...values.filter(value => value >= minLimit)])].sort((a, b) => a - b);
  let bestDistance = Infinity;
  let selected;
  for (const limit of candidates) {
    const breaks = values.filter(value => value > limit).length;
    const distance = Math.abs(2 * breaks - values.length);
    if (distance <= bestDistance) {
      bestDistance = distance;
      selected = { limit, breaks, runs: values.length, breakShare: breaks / values.length };
    }
  }
  return selected;
}

function pilotSample({ packId, style, managerFamily, activeSeconds, wallSeconds, calls, gpuQueueDelayMs }) {
  if (typeof packId !== 'string' || !packId || !STYLES.includes(style) || !Array.isArray(calls)) {
    throw new Error('Each unlimited run must identify the pack, management style, and call list.');
  }
  if (style === managerStyle && (typeof managerFamily !== 'string' || !managerFamily)) {
    throw new Error('Each manager-and-workers unlimited run must identify the assigned manager family.');
  }
  requireSeconds(activeSeconds, 'unlimited.activeSeconds');
  requireSeconds(wallSeconds, 'unlimited.wallSeconds');
  if (activeSeconds > wallSeconds) throw new Error('Active GPU time exceeded wall time in a one-GPU pilot run.');
  if (gpuQueueDelayMs !== undefined && (!Number.isFinite(gpuQueueDelayMs) || gpuQueueDelayMs < 0)) {
    throw new Error('unlimited.gpuQueueDelayMs must be finite nonnegative milliseconds.');
  }
  const callsBySetting = new Map();
  for (const { family, settingId, startedMs } of calls) {
    if (typeof family !== 'string' || !family || typeof settingId !== 'string' || !settingId
        || !Number.isFinite(startedMs) || startedMs < 0) {
      throw new Error('Each inference call must identify its model family, setting ID, and start time in milliseconds.');
    }
    const key = JSON.stringify([family, settingId]);
    if (!callsBySetting.has(key)) callsBySetting.set(key, { family, settingId, calls: 0 });
    callsBySetting.get(key).calls += 1;
  }
  return {
    packId, style, managerFamily, activeSeconds, wallSeconds, gpuQueueDelayMs,
    peakFamilyCalls: largestQuotaWindow(calls),
    callsBySetting: [...callsBySetting.values()],
  };
}

function calibrate(unlimited, slotExtraDelayMs) {
  if (unlimited === undefined || (Array.isArray(unlimited) && !unlimited.length)) {
    return { status: 'unavailable', reason: 'No measured unlimited pilot traces were supplied.' };
  }
  if (!Array.isArray(unlimited)) throw new Error('unlimited must be an array of measured pilot runs.');
  if (!Number.isSafeInteger(slotExtraDelayMs) || slotExtraDelayMs < 0) {
    throw new Error('slotExtraDelayMs must be the rounded median successful worker service time in milliseconds.');
  }
  const samples = unlimited.map(pilotSample);
  const { limit: activeSeconds, ...computeBreaks } = closestToHalf(samples.map(row => row.activeSeconds), 0);
  const { limit: wallSeconds, ...deadlineBreaks } = closestToHalf(samples.map(row => row.wallSeconds), 0);
  const { limit: maxCallsPerFamily, ...quotaBreaks } = closestToHalf(samples.map(row => row.peakFamilyCalls), 1);
  return {
    status: 'calibrated',
    limitRule: 'Observed values strictly greater than the inclusive limit break it. Ties prefer the highest limit.',
    computeCap: { activeSeconds, ...computeBreaks },
    deadline: { wallSeconds, ...deadlineBreaks },
    callQuota: { windowMs: QUOTA_WINDOW_MS, maxCallsPerFamily, scope: 'sliding window within each pack and family', ...quotaBreaks },
    oneGpuSlot: {
      activeSeconds, ...computeBreaks,
      extraDelayMsPerCall: slotExtraDelayMs,
      delaySource: 'Supplied rounded median successful worker service time from the pilot.',
      breakRule: 'The added wait changes elapsed time. Cap breaks use backend execution wall time.',
    },
    samples,
  };
}

function projectionCosts({ stageGpuSeconds, fixedMainGpuSeconds, perCellGpuSeconds, conditionOverrides = {} }) {
  requireSeconds(stageGpuSeconds, 'stageGpuSeconds');
  requireSeconds(fixedMainGpuSeconds, 'fixedMainGpuSeconds');
  for (const style of STYLES) requireSeconds(perCellGpuSeconds[style], `perCellGpuSeconds.${style}`, true);
  for (const style of Object.keys(perCellGpuSeconds)) {
    if (!STYLES.includes(style)) throw new Error(`Unknown style in perCellGpuSeconds: ${style}`);
  }
  for (const [condition, overrides] of Object.entries(conditionOverrides)) {
    if (!CONDITIONS.includes(condition)) throw new Error(`Unknown condition in conditionOverrides: ${condition}`);
    for (const [style, seconds] of Object.entries(overrides)) {
      if (!STYLES.includes(style)) throw new Error(`Unknown style in conditionOverrides.${condition}: ${style}`);
      requireSeconds(seconds, `conditionOverrides.${condition}.${style}`, true);
    }
  }
  return { stageGpuSeconds, fixedMainGpuSeconds, perCellGpuSeconds, conditionOverrides };
}

function project(input) {
  if ([input.grid, input.stageGpuSeconds, input.fixedMainGpuSeconds, input.perCellGpuSeconds].some(value => value === undefined)) {
    return { status: 'unavailable', reason: 'Measured allocation time, main shared overhead, cell envelopes, and the registered grid are required.' };
  }
  const costs = projectionCosts(input);
  const evaluated = [];
  let selected = null;
  for (const { cut, grid } of budgetGrids(input.grid)) {
    const counts = cellCounts(grid);
    let mainCellGpuSeconds = 0;
    for (const condition of CONDITIONS) {
      for (const style of STYLES) {
        const seconds = costs.conditionOverrides[condition]?.[style] ?? costs.perCellGpuSeconds[style];
        mainCellGpuSeconds += counts.runsPerCondition[style] * seconds;
      }
    }
    const projectedMainGpuSeconds = costs.fixedMainGpuSeconds + mainCellGpuSeconds;
    const projectedProjectGpuSeconds = costs.stageGpuSeconds + projectedMainGpuSeconds;
    const projection = {
      cut, ...counts, mainCellGpuSeconds, projectedMainGpuSeconds, projectedProjectGpuSeconds,
      remainingGpuSeconds: GPU_BUDGET_SECONDS - projectedProjectGpuSeconds,
    };
    evaluated.push(projection);
    if (projectedProjectGpuSeconds <= GPU_BUDGET_SECONDS) {
      selected = { grid, conditions: CONDITIONS, ...projection };
      break;
    }
  }
  return {
    status: selected ? 'projected-fit' : 'blocked-budget',
    budgetGpuSeconds: GPU_BUDGET_SECONDS,
    costBasis: 'Allocated GPU time. Stage time is measured, and future per-cell envelopes plus shared overhead are supplied projections.',
    ...costs, evaluated, selected,
  };
}

export function planGpu(input) {
  const calibration = calibrate(input.unlimited, input.slotExtraDelayMs);
  const projection = calibration.status === 'calibrated'
    ? project(input)
    : { status: 'unavailable', reason: 'Allocation estimates require measured pilot traces. Use design-only for conditional budget arithmetic.' };
  return { status: projection.status === 'projected-fit' ? 'projected-fit' : 'blocked', calibration, projection };
}

function calibrationSupportSummary(samples, styles, limits) {
  const countsByStyle = Object.fromEntries(styles.map(style => [style, samples.filter(sample => sample.style === style).length]));
  const managerSamplesByFamily = {};
  for (const sample of samples.filter(sample => sample.style === managerStyle)) {
    managerSamplesByFamily[sample.managerFamily] = (managerSamplesByFamily[sample.managerFamily] ?? 0) + 1;
  }
  const pressure = {};
  for (const [condition, field, limit] of [
    ['computeCap', 'activeSeconds', limits.computeCap.activeSeconds],
    ['deadline', 'wallSeconds', limits.deadline.wallSeconds],
    ['callQuota', 'peakFamilyCalls', limits.callQuota.maxCallsPerFamily],
  ]) {
    const byStyle = Object.fromEntries(styles.map(style => {
      const runs = countsByStyle[style];
      const breaks = samples.filter(sample => sample.style === style && sample[field] > limit).length;
      return [style, { breaks, runs, breakShare: runs ? breaks / runs : null }];
    }));
    const breaks = Object.values(byStyle).reduce((sum, row) => sum + row.breaks, 0);
    const shares = Object.values(byStyle).map(row => row.breakShare);
    pressure[condition] = {
      breaks, runs: samples.length, breakShare: samples.length ? breaks / samples.length : null,
      equalStyleBreakShare: shares.every(Number.isFinite) ? shares.reduce((sum, share) => sum + share, 0) / styles.length : null,
      byStyle,
    };
  }
  return {
    sampleCount: samples.length, countsByStyle, managerSamplesByFamily,
    sampleReferences: samples.map(({ packId, style, managerFamily }) => ({ packId, style, managerFamily })), ...pressure,
  };
}

export function managerProposalEstimate(input, family, condition) {
  const override = input.conditionOverrides?.[condition]?.[managerStyle];
  const globalSeconds = override ?? input.perCellGpuSeconds?.[managerStyle];
  if (globalSeconds !== undefined) requireSeconds(globalSeconds, 'global manager allocation estimate', true);
  const familySeconds = input.managerFamilyGpuSeconds?.[family];
  const samples = input.managerFamilySampleCounts?.[family];
  if (familySeconds !== undefined) requireSeconds(familySeconds, `managerFamilyGpuSeconds.${family}`, true);
  if (samples !== undefined && (!Number.isSafeInteger(samples) || samples < 0)) {
    throw new Error(`managerFamilySampleCounts.${family} must be a nonnegative integer.`);
  }
  if (override !== undefined) {
    return { seconds: override, globalSeconds: override, source: 'condition-override', samples: samples ?? null };
  }
  if (familySeconds !== undefined && samples > 0) {
    return { seconds: familySeconds, globalSeconds: globalSeconds ?? null, source: 'family-conditioned', samples };
  }
  return {
    seconds: globalSeconds ?? null, globalSeconds: globalSeconds ?? null, samples: samples ?? null,
    source: globalSeconds === undefined ? 'unavailable'
      : input.managerFamilyGpuSeconds === undefined ? 'common-global' : 'global-fallback',
  };
}

export function proposeBudgetScopes(input) {
  const registeredGrid = namesOfGrid(input.grid);
  const costs = projectionCosts(input);
  const registeredCalibration = calibrate(input.unlimited, input.slotExtraDelayMs);
  const originalSupport = registeredCalibration.status === 'calibrated'
    ? calibrationSupportSummary(registeredCalibration.samples, STYLES, registeredCalibration) : null;
  if (!registeredGrid.managerPolicies.includes('manager-choice') || !registeredGrid.visibility.includes('told')) {
    throw new Error('Scope proposals require the registered manager-choice policy and told visibility.');
  }
  const grid = {
    packIds: registeredGrid.packIds.slice(0, minPacks), repeats: 1,
    managerFamilies: registeredGrid.managerFamilies.slice(0, 1),
    managerPolicies: ['manager-choice'], visibility: ['told'],
  };
  const optionalStyles = ['specialists', 'tournament', 'cheap-first'];
  let styleSets = [['solo-best', managerStyle]];
  for (const optionalStyle of optionalStyles) {
    styleSets = styleSets.flatMap(styles => [styles, [...styles, optionalStyle]]);
  }
  styleSets = styleSets.map(styles => STYLES.filter(style => styles.includes(style)));
  styleSets.push([managerStyle]);
  const evaluated = styleSets.map(styles => {
    const counts = cellCounts(grid, styles);
    let mainCellGpuSeconds = 0;
    let globalMainCellGpuSeconds = 0;
    const managerEstimates = {};
    for (const condition of CONDITIONS) {
      for (const style of styles) {
        let seconds = costs.conditionOverrides[condition]?.[style] ?? costs.perCellGpuSeconds[style];
        globalMainCellGpuSeconds += counts.runsPerCondition[style] * seconds;
        if (style === managerStyle) {
          managerEstimates[condition] = managerProposalEstimate(input, grid.managerFamilies[0], condition);
          seconds = managerEstimates[condition].seconds;
        }
        mainCellGpuSeconds += counts.runsPerCondition[style] * seconds;
      }
    }
    const projectedMainGpuSeconds = costs.fixedMainGpuSeconds + mainCellGpuSeconds;
    const projectedProjectGpuSeconds = costs.stageGpuSeconds + projectedMainGpuSeconds;
    let calibrationSupport = { status: 'unavailable', reason: registeredCalibration.reason };
    if (originalSupport) {
      const retainedSamples = registeredCalibration.samples.filter(sample => styles.includes(sample.style)
        && (sample.style !== managerStyle || grid.managerFamilies.includes(sample.managerFamily)));
      const retained = calibrationSupportSummary(retainedSamples, styles, registeredCalibration);
      const managerSamples = retained.countsByStyle[managerStyle];
      const notes = [];
      if (managerSamples < 2) {
        notes.push(`The ${grid.managerFamilies[0]} manager has ${managerSamples} retained calibration sample(s). This is sparse support for manager-specific pressure.`);
      }
      if (retained.sampleCount && retained.callQuota.breaks === 0) {
        notes.push('No retained sample exceeded the frozen rolling call quota. This reference shows zero observed quota pressure.');
      } else {
        const zeroQuotaStyles = styles.filter(style => retained.callQuota.byStyle[style].runs > 0
          && retained.callQuota.byStyle[style].breaks === 0);
        if (zeroQuotaStyles.length) {
          notes.push(`The retained ${zeroQuotaStyles.join(', ')} samples show zero observed pressure under the frozen rolling call quota.`);
        }
      }
      if (styles.some(style => retained.countsByStyle[style] === 0)) {
        notes.push('An included style has no reference samples. Equal-style break shares are unavailable.');
      }
      calibrationSupport = {
        status: 'diagnostic-only', limitSource: 'registered-full-pilot',
        frozenLimits: {
          activeSeconds: registeredCalibration.computeCap.activeSeconds, wallSeconds: registeredCalibration.deadline.wallSeconds,
          maxCallsPerFamily: registeredCalibration.callQuota.maxCallsPerFamily, quotaWindowMs: registeredCalibration.callQuota.windowMs,
          queueDelayMsPerCall: registeredCalibration.oneGpuSlot.extraDelayMsPerCall,
        },
        weighting: 'Each included style has equal weight. A missing style makes the weighted share unavailable.',
        original: originalSupport, retained, notes,
      };
    }
    return {
      status: 'proposed-unapproved', approvalRequired: true, grid, styles, conditions: [...CONDITIONS], ...counts,
      mainCellGpuSeconds, projectedMainGpuSeconds, projectedProjectGpuSeconds,
      remainingGpuSeconds: GPU_BUDGET_SECONDS - projectedProjectGpuSeconds,
      fitsBudget: projectedProjectGpuSeconds <= GPU_BUDGET_SECONDS,
      projectionBasis: 'Conditional allocation estimates from unlimited nondisclosure traces. Future finite-resource told prompts are extrapolations. Observations combine pack content, allocation decisions and interruption periods. These are not causal architecture costs, upper bounds or completion guarantees.',
      managerCostSupport: { family: grid.managerFamilies[0], byCondition: managerEstimates,
        fallbackConditions: CONDITIONS.filter(condition => managerEstimates[condition].source === 'global-fallback') },
      globalSensitivity: {
        mainCellGpuSeconds: globalMainCellGpuSeconds,
        projectedMainGpuSeconds: costs.fixedMainGpuSeconds + globalMainCellGpuSeconds,
        projectedProjectGpuSeconds: costs.stageGpuSeconds + costs.fixedMainGpuSeconds + globalMainCellGpuSeconds,
        remainingGpuSeconds: GPU_BUDGET_SECONDS - costs.stageGpuSeconds - costs.fixedMainGpuSeconds - globalMainCellGpuSeconds,
        fitsBudget: costs.stageGpuSeconds + costs.fixedMainGpuSeconds + globalMainCellGpuSeconds <= GPU_BUDGET_SECONDS,
      },
      calibrationSupport,
    };
  }).sort((first, second) => {
    const byStyleCount = second.styles.length - first.styles.length;
    const byProjectCost = first.projectedProjectGpuSeconds - second.projectedProjectGpuSeconds;
    const byStyleNames = first.styles.join(',').localeCompare(second.styles.join(','));
    return byStyleCount || byProjectCost || byStyleNames;
  });
  return {
    status: 'proposed-unapproved', approvalRequired: true, budgetGpuSeconds: GPU_BUDGET_SECONDS,
    selectionRule: 'Prefer more management styles, then lower projected project GPU time. Every scope revision requires approval.',
    registeredGrid, ...costs,
    managerFamilyGpuSeconds: input.managerFamilyGpuSeconds ?? null,
    managerFamilySampleCounts: input.managerFamilySampleCounts ?? null,
    evaluated, selected: evaluated.find(candidate => candidate.fitsBudget) ?? null,
  };
}

export function designBudget({ grid, assumedStageGpuSeconds = 0, assumedFixedMainGpuSeconds = 0 }) {
  requireSeconds(assumedStageGpuSeconds, 'assumedStageGpuSeconds');
  requireSeconds(assumedFixedMainGpuSeconds, 'assumedFixedMainGpuSeconds');
  const availableGpuSeconds = GPU_BUDGET_SECONDS - assumedStageGpuSeconds - assumedFixedMainGpuSeconds;
  return {
    status: 'design-only',
    budgetGpuSeconds: GPU_BUDGET_SECONDS,
    assumedStageGpuSeconds,
    assumedFixedMainGpuSeconds,
    availableGpuSeconds,
    meaning: 'Conditional arithmetic only. The maximum mean allowance includes each cell’s share of allocations outside the assumed stage and fixed main costs.',
    conditions: CONDITIONS,
    evaluated: [...budgetGrids(grid)].map(({ cut, grid: candidate }) => {
      const counts = cellCounts(candidate);
      return { cut, ...counts, maximumAverageGpuSecondsPerCell: Math.max(0, availableGpuSeconds) / counts.runs };
    }),
  };
}
