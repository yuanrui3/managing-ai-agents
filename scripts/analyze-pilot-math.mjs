import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CONDITIONS, designBudget, GPU_BUDGET_SECONDS, managerProposalEstimate, planGpu, STYLES } from '../src/gpu-planning.mjs';

function countCells(grid, styles) {
  const managerVariants = grid.managerFamilies.length * grid.managerPolicies.length * grid.visibility.length;
  const runsPerPack = styles.reduce((total, style) => total + (style === 'manager-and-workers' ? managerVariants : 1), 0);
  return grid.packIds.length * grid.repeats * CONDITIONS.length * runsPerPack;
}

function seededOrder(values, seed, domain) {
  return values.map(value => ({ value, key: createHash('sha256').update(`${seed}/${domain}/${value}`).digest('hex') }))
    .sort((first, second) => first.key.localeCompare(second.key) || first.value.localeCompare(second.value))
    .map(entry => entry.value);
}

function analyzeDesignMatrix(columns, rows) {
  const matrix = rows.map(row => [...row]);
  const tolerance = 1e-10;
  const pivotColumns = [];
  for (let column = 0; column < columns.length; column += 1) {
    const pivotIndex = pivotColumns.length;
    let pivotRow = pivotIndex;
    while (pivotRow < matrix.length && Math.abs(matrix[pivotRow][column]) <= tolerance) pivotRow += 1;
    if (pivotRow === matrix.length) continue;
    [matrix[pivotIndex], matrix[pivotRow]] = [matrix[pivotRow], matrix[pivotIndex]];
    const pivot = matrix[pivotIndex][column];
    for (let index = column; index < columns.length; index += 1) matrix[pivotIndex][index] /= pivot;
    for (let row = 0; row < matrix.length; row += 1) {
      if (row === pivotIndex) continue;
      const multiple = matrix[row][column];
      for (let index = column; index < columns.length; index += 1) {
        matrix[row][index] -= multiple * matrix[pivotIndex][index];
      }
    }
    pivotColumns.push(column);
  }
  const freeColumns = columns.map((name, index) => index).filter(index => !pivotColumns.includes(index));
  const aliasRelations = freeColumns.map(freeColumn => ({
    freeColumn: columns[freeColumn],
    terms: [
      ...pivotColumns.map((column, row) => ({ column: columns[column], coefficient: -matrix[row][freeColumn] })),
      { column: columns[freeColumn], coefficient: 1 },
    ].filter(term => Math.abs(term.coefficient) > tolerance)
      .map(term => ({ ...term, coefficient: Number(term.coefficient.toPrecision(12)) })),
  }));
  return { rows: rows.length, columns, rank: pivotColumns.length, nullity: freeColumns.length, aliasRelations };
}

export function familyRotationProposal(grid) {
  const seed = 20261118;
  const packIds = seededOrder(grid.packIds.slice(0, 12), seed, 'pack');
  const families = seededOrder(grid.managerFamilies, seed, 'family');
  if (packIds.length !== 12 || families.length !== 5 || CONDITIONS.length !== 5) {
    throw new Error('The proposed rotation requires twelve packs, five families, and five conditions.');
  }
  const cells = packIds.flatMap((packId, packIndex) => CONDITIONS.map((condition, conditionIndex) => ({
    packId, condition, family: families[(packIndex + conditionIndex) % families.length],
  })));
  const packLevels = packIds.slice(1);
  const conditionLevels = CONDITIONS.slice(1);
  const familyLevels = families.slice(1);
  const additiveColumns = ['intercept', ...packLevels.map(pack => `pack=${pack}`),
    ...conditionLevels.map(condition => `condition=${condition}`), ...familyLevels.map(family => `family=${family}`)];
  const additiveRow = cell => [1, ...packLevels.map(pack => Number(cell.packId === pack)),
    ...conditionLevels.map(condition => Number(cell.condition === condition)),
    ...familyLevels.map(family => Number(cell.family === family))];
  const interactionColumns = familyLevels.flatMap(family => conditionLevels.map(condition => `family=${family} * condition=${condition}`));
  const interactionRow = cell => familyLevels.flatMap(family => conditionLevels.map(condition =>
    Number(cell.family === family && cell.condition === condition)));
  const styleColumns = ['style=manager', ...conditionLevels.map(condition => `style=manager * condition=${condition}`)];
  const jointColumns = [...additiveColumns, ...styleColumns];
  const jointCells = cells.flatMap(cell => [{ ...cell, manager: true }, { ...cell, family: null, manager: false }]);
  const jointRows = jointCells.map(cell => [
    ...additiveRow(cell), Number(cell.manager),
    ...conditionLevels.map(condition => Number(cell.manager && cell.condition === condition)),
  ]);
  const jointInteractionRows = jointRows.map((row, index) => [...row, ...interactionRow(jointCells[index])]);
  const managerPackColumns = packLevels.map(pack => `style=manager * pack=${pack}`);
  const jointManagerPackRows = jointInteractionRows.map((row, index) => [...row,
    ...packLevels.map(pack => Number(jointCells[index].manager && jointCells[index].packId === pack)),
  ]);
  const controlConditions = ['unlimited', 'compute-cap'];
  const focused = jointCells.map((cell, index) => ({ cell, row: jointRows[index] }))
    .filter(({ cell }) => cell.manager || controlConditions.includes(cell.condition));
  const omittedStyleColumns = conditionLevels.filter(condition => !controlConditions.includes(condition))
    .map(condition => `style=manager * condition=${condition}`);
  const focusedColumns = jointColumns.filter(column => !omittedStyleColumns.includes(column));
  const focusedRows = focused.map(({ row }) => row.filter((value, index) => !omittedStyleColumns.includes(jointColumns[index])));
  const focusedFullMatrix = analyzeDesignMatrix(jointColumns, focused.map(({ row }) => row));
  const focusedReducedMatrix = analyzeDesignMatrix(focusedColumns, focusedRows);
  const focusedManagerPackMatrix = analyzeDesignMatrix([...focusedColumns, ...managerPackColumns],
    focusedRows.map((row, index) => [...row,
      ...packLevels.map(pack => Number(focused[index].cell.manager && focused[index].cell.packId === pack)),
    ]));
  const primaryInteractionColumn = 'style=manager * condition=compute-cap';
  const controlCellCount = focused.filter(({ cell }) => !cell.manager).length;
  return {
    status: 'proposed-unapproved',
    seed,
    registeredFirstManagerFamily: grid.managerFamilies[0],
    assignmentRule: 'Order the first twelve registered pack labels and all family labels by SHA-256 of seed/domain/ID, then use family[(packPosition + conditionPosition) modulo 5]. Outcomes do not enter assignment.',
    managerPolicy: 'manager-choice', visibility: 'told',
    referenceLevels: { pack: packIds[0], condition: CONDITIONS[0], family: families[0], style: 'solo-best' },
    conditions: CONDITIONS,
    counts: { packs: packIds.length, managerCells: cells.length, matchedSoloCells: cells.length, totalCells: 2 * cells.length },
    managerCellsByFamily: Object.fromEntries(families.map(family => [family, cells.filter(cell => cell.family === family).length])),
    managerCellsByConditionAndFamily: Object.fromEntries(CONDITIONS.map(condition => [condition,
      Object.fromEntries(families.map(family => [family, cells.filter(cell => cell.condition === condition && cell.family === family).length])),
    ])),
    assignmentMatrix: packIds.map(packId => ({ packId, familyByCondition: Object.fromEntries(cells.filter(cell => cell.packId === packId)
      .map(cell => [cell.condition, cell.family])) })),
    designMatrices: {
      managerAdditive: analyzeDesignMatrix(additiveColumns, cells.map(additiveRow)),
      jointSoloStyleByCondition: analyzeDesignMatrix(jointColumns, jointRows),
      managerFamilyByCondition: analyzeDesignMatrix([...additiveColumns, ...interactionColumns],
        cells.map(cell => [...additiveRow(cell), ...interactionRow(cell)])),
      jointFamilyByCondition: analyzeDesignMatrix([...jointColumns, ...interactionColumns], jointInteractionRows),
      jointFamilyByConditionWithManagerPack: analyzeDesignMatrix([...jointColumns, ...interactionColumns, ...managerPackColumns],
        jointManagerPackRows),
    },
    aliasInterpretation: 'Each reported relation has design columns whose weighted sum is zero. The joint family-by-condition model is identifiable under shared additive pack effects. Four null directions occur in the manager-only interaction model and return when arbitrary manager-by-pack nuisance effects are added to the joint model.',
    costExpression: `stageGpuSeconds + fixedMainGpuSeconds + ${cells.length} * soloEnvelopeSeconds + ${cells.length} * globalManagerEnvelopeSeconds`,
    focusedControlProposal: {
      status: 'proposed-unapproved',
      counts: { packs: packIds.length, managerCells: cells.length, matchedSoloCells: controlCellCount,
        totalCells: focused.length },
      soloConditions: controlConditions,
      managerConditions: CONDITIONS,
      primaryContrast: {
        expression: '(manager at compute-cap - solo at compute-cap) - (manager at unlimited - solo at unlimited)',
        coefficient: primaryInteractionColumn,
        estimableInFullMatrix: focusedFullMatrix.aliasRelations.every(relation =>
          relation.terms.every(term => term.column !== primaryInteractionColumn)),
        estimableWithManagerPackNuisance: focusedManagerPackMatrix.aliasRelations.every(relation =>
          relation.terms.every(term => term.column !== primaryInteractionColumn)),
      },
      omittedStyleColumns,
      designMatrices: {
        fullStyleByCondition: focusedFullMatrix,
        reducedStyleByCondition: focusedReducedMatrix,
        reducedWithManagerPack: focusedManagerPackMatrix,
      },
      costExpression: `stageGpuSeconds + fixedMainGpuSeconds + ${cells.length} * globalManagerEnvelopeSeconds + ${controlCellCount} * soloEnvelopeSeconds`,
      assumptions: [
        'Use the same seeded family assignment and twelve pack clusters as the 120-cell rotation. Outcomes do not enter assignment.',
        'The primary management-by-compute interaction uses matched solo controls in unlimited and compute-cap conditions under additive family effects.',
        'Deadline, call-quota, and one-gpu-slot conditions support manager-only comparisons. Their solo effects and management-by-scarcity contrasts remain unobserved.',
        'Dropping the three aliased style-by-condition columns reparameterizes observed manager-only effects and supplies no information about missing solo conditions.',
        'Policy and visibility contrasts are lost. Rank calculations establish identifiability under the stated models and supply no precision or completion guarantee.',
      ],
    },
    assumptions: [
      'The paired study has twelve pack clusters. Its 120 cells are repeated observations within those packs.',
      'Family main effects require the stated additive model or declared interaction restrictions. Matrix rank alone gives no precision or power guarantee.',
      'Joint family-by-condition identification uses shared additive pack effects across solo and manager observations. Allowing arbitrary manager-by-pack effects restores four aliased directions.',
      'Only manager-choice policy and told visibility are retained, so policy and visibility contrasts are lost.',
      'Every pack sees all five families across conditions, while each condition has only two or three packs per family. The manager-only family-by-scarcity interaction model has four unidentified directions after pack adjustment.',
      'The common-global symbolic expression is a sensitivity calculation. Supported family observations give separate conditional projections including loading, interruptions, and judging as applicable.',
      'Manager-choice follows the default pilot assignment rule. The cost references are unlimited runs without resource disclosures. Future finite-resource told prompts are extrapolations.',
    ],
  };
}

function rotationCalibrationSupport(calibration, families) {
  const managerStyle = 'manager-and-workers';
  let support = { status: 'unavailable', reason: 'The frozen registered calibration was not supplied.' };
  if (calibration?.status === 'calibrated') {
    const byStyle = {};
    for (const style of [managerStyle, 'solo-best']) {
      const samples = calibration.samples.filter(sample => sample.style === style
        && (style !== managerStyle || families.includes(sample.managerFamily)));
      const pressure = {};
      for (const [condition, field, limit] of [
        ['computeCap', 'activeSeconds', calibration.computeCap.activeSeconds],
        ['deadline', 'wallSeconds', calibration.deadline.wallSeconds],
        ['callQuota', 'peakFamilyCalls', calibration.callQuota.maxCallsPerFamily],
      ]) {
        const breaks = samples.filter(sample => sample[field] > limit).length;
        pressure[condition] = { breaks, runs: samples.length, breakShare: samples.length ? breaks / samples.length : null };
      }
      byStyle[style] = { samples: samples.length,
        sampleReferences: samples.map(({ packId, managerFamily }) => ({ packId, managerFamily })), ...pressure };
    }
    support = {
      status: 'diagnostic-only', limitSource: 'registered-full-pilot',
      frozenLimits: { activeSeconds: calibration.computeCap.activeSeconds, wallSeconds: calibration.deadline.wallSeconds,
        maxCallsPerFamily: calibration.callQuota.maxCallsPerFamily, quotaWindowMs: calibration.callQuota.windowMs,
        queueDelayMsPerCall: calibration.oneGpuSlot.extraDelayMsPerCall },
      managerSamplesByFamily: Object.fromEntries(families.map(family =>
        [family, byStyle[managerStyle].sampleReferences.filter(sample => sample.managerFamily === family).length])),
      byStyle,
    };
  }
  return support;
}

export function costFamilyRotationProposals(rotation, costs = {}) {
  const managerStyle = 'manager-and-workers';
  const conditionOverrides = costs.conditionOverrides ?? {};
  for (const field of ['stageGpuSeconds', 'fixedMainGpuSeconds']) {
    if (costs[field] !== undefined && (!Number.isFinite(costs[field]) || costs[field] < 0)) {
      throw new Error(`${field} must be finite nonnegative seconds.`);
    }
  }
  for (const [style, seconds] of Object.entries(costs.perCellGpuSeconds ?? {})) {
    if (!STYLES.includes(style) || !Number.isFinite(seconds) || seconds <= 0) throw new Error(`Invalid allocation estimate for ${style}.`);
  }
  for (const [condition, overrides] of Object.entries(conditionOverrides)) {
    if (!CONDITIONS.includes(condition)) throw new Error(`Unknown condition override ${condition}.`);
    for (const [style, seconds] of Object.entries(overrides)) {
      if (!STYLES.includes(style) || !Number.isFinite(seconds) || seconds <= 0) throw new Error(`Invalid allocation override for ${style}.`);
    }
  }
  const families = Object.keys(rotation.managerCellsByFamily);
  const fixedFamily = rotation.registeredFirstManagerFamily;
  const project = cellSeconds => {
    const priced = Number.isFinite(cellSeconds) && Number.isFinite(costs.stageGpuSeconds) && Number.isFinite(costs.fixedMainGpuSeconds);
    const main = priced ? costs.fixedMainGpuSeconds + cellSeconds : null;
    const total = priced ? costs.stageGpuSeconds + main : null;
    return { mainCellGpuSeconds: cellSeconds, projectedMainGpuSeconds: main, projectedProjectGpuSeconds: total,
      remainingGpuSeconds: priced ? GPU_BUDGET_SECONDS - total : null, fitsBudget: priced ? total <= GPU_BUDGET_SECONDS : null };
  };
  const variants = [
    { id: 'family-rotation-full-pairing', name: 'Full solo pairing', soloConditions: [...CONDITIONS],
      retainedQuestions: 'Manager advantage across all five conditions and additive family differences.',
      lostQuestions: 'Policy and visibility comparisons.' },
    { id: 'family-rotation-focused-solo', name: 'Focused solo controls', soloConditions: ['unlimited', 'compute-cap'],
      retainedQuestions: 'Management by compute-cap interaction and manager-only comparisons in the other three scarcity conditions.',
      lostQuestions: 'Policy and visibility comparisons and solo contrasts in the other three scarcity conditions.' },
    { id: 'family-rotation-manager-only', name: 'Manager only', soloConditions: [],
      retainedQuestions: 'Manager-family and scarcity comparisons under the stated model.',
      lostQuestions: 'Solo, policy and visibility comparisons.' },
    { id: 'fixed-family-focused-solo', name: `Fixed ${fixedFamily} focused controls`, soloConditions: ['unlimited', 'compute-cap'],
      fixedFamily, retainedQuestions: `Management by compute-cap interaction for ${fixedFamily} and its manager-only comparisons in the other three scarcity conditions.`,
      lostQuestions: 'Family, policy and visibility comparisons and solo contrasts in the other three scarcity conditions.' },
  ];
  const evaluated = variants.map(variant => {
    const assignmentMatrix = variant.fixedFamily ? rotation.assignmentMatrix.map(row => ({ packId: row.packId,
      familyByCondition: Object.fromEntries(CONDITIONS.map(condition => [condition, variant.fixedFamily])) })) : rotation.assignmentMatrix;
    const includedFamilies = variant.fixedFamily ? [variant.fixedFamily] : families;
    const cellsPerCondition = Object.fromEntries(CONDITIONS.map(condition => [condition,
      { manager: rotation.counts.packs, solo: variant.soloConditions.includes(condition) ? rotation.counts.packs : 0,
        managerByFamily: Object.fromEntries(includedFamilies.map(family =>
          [family, assignmentMatrix.filter(row => row.familyByCondition[condition] === family).length])) }]));
    let mainCellGpuSeconds = 0;
    let globalCellGpuSeconds = 0;
    const byCondition = {};
    const fallbackFamilies = new Set();
    for (const condition of CONDITIONS) {
      const cells = cellsPerCondition[condition];
      byCondition[condition] = {};
      for (const family of includedFamilies) {
        const estimate = managerProposalEstimate(costs, family, condition);
        byCondition[condition][family] = estimate;
        if (estimate.source === 'global-fallback') fallbackFamilies.add(family);
        mainCellGpuSeconds = estimate.seconds === null ? null
          : mainCellGpuSeconds === null ? null : mainCellGpuSeconds + cells.managerByFamily[family] * estimate.seconds;
        globalCellGpuSeconds = estimate.globalSeconds === null ? null
          : globalCellGpuSeconds === null ? null : globalCellGpuSeconds + cells.managerByFamily[family] * estimate.globalSeconds;
      }
      if (cells.solo) {
        const soloSeconds = conditionOverrides[condition]?.['solo-best'] ?? costs.perCellGpuSeconds?.['solo-best'];
        mainCellGpuSeconds = soloSeconds === undefined || mainCellGpuSeconds === null ? null : mainCellGpuSeconds + cells.solo * soloSeconds;
        globalCellGpuSeconds = soloSeconds === undefined || globalCellGpuSeconds === null ? null : globalCellGpuSeconds + cells.solo * soloSeconds;
      }
    }
    const matchedSoloCells = Object.values(cellsPerCondition).reduce((sum, cells) => sum + cells.solo, 0);
    return {
      ...variant, status: 'proposed-unapproved', approvalRequired: true,
      seed: rotation.seed, repeats: 1, managerPolicy: rotation.managerPolicy, visibility: rotation.visibility,
      managerFamilies: includedFamilies, managerConditions: [...CONDITIONS], cellsPerCondition, assignmentMatrix,
      managerCellsByFamily: Object.fromEntries(includedFamilies.map(family =>
        [family, Object.values(cellsPerCondition).reduce((sum, cells) => sum + cells.managerByFamily[family], 0)])),
      counts: { packs: rotation.counts.packs, managerCells: rotation.counts.managerCells, matchedSoloCells,
        totalCells: rotation.counts.managerCells + matchedSoloCells },
      costExpression: `stageGpuSeconds + fixedMainGpuSeconds + sum of manager family cell counts times supported family estimates or global fallbacks + ${matchedSoloCells} * soloEnvelopeSeconds, with condition overrides taking priority`,
      ...project(mainCellGpuSeconds), globalSensitivity: project(globalCellGpuSeconds),
      managerCostSupport: { byCondition, fallbackFamilies: [...fallbackFamilies],
        sampleCounts: Object.fromEntries(includedFamilies.map(family => [family, costs.managerFamilySampleCounts?.[family] ?? null])) },
      calibrationSupport: rotationCalibrationSupport(costs.calibration, includedFamilies),
    };
  });
  return {
    status: 'proposed-unapproved', approvalRequired: true,
    costStatus: evaluated.some(candidate => candidate.fitsBudget !== null) ? 'conditional-allocation-projection' : 'symbolic-only',
    budgetGpuSeconds: GPU_BUDGET_SECONDS,
    stageGpuSeconds: costs.stageGpuSeconds ?? null, fixedMainGpuSeconds: costs.fixedMainGpuSeconds ?? null,
    perCellGpuSeconds: costs.perCellGpuSeconds ?? null, conditionOverrides,
    managerFamilyGpuSeconds: costs.managerFamilyGpuSeconds ?? null, managerFamilySampleCounts: costs.managerFamilySampleCounts ?? null,
    costBasis: 'These conditional projections use supported family observations and explicitly flagged global fallbacks. They include loading, interrupted attempts, release checks and batched judging. Each family observation reflects its pack and interruption period. Unlimited nondisclosure costs extrapolate to future finite-resource told prompts. Observed maxima are not upper bounds or completion guarantees. Gate 2 approval is required.',
    calibrationSupport: rotationCalibrationSupport(costs.calibration, families), evaluated,
  };
}

export function managerDecisionCoverage(traces, priceList) {
  const skills = ['article', 'derivation', 'simulation', 'illustration'];
  const rows = Array.isArray(priceList) ? priceList : priceList.rows;
  const eligible = Object.fromEntries(skills.map(skill => [skill, new Map(rows
    .filter(row => row.skill === skill && Number.isFinite(row.qualityExcludingOwnFamily) && Number.isFinite(row.meanGpuSeconds))
    .map(row => [`${row.worker}-d${row.draft}`, row.family]))]));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  // Match the live controller's strict JSON and optional whole-response fence handling.
  const parseProposal = (trace, label, field) => {
    const call = trace.calls.find(entry => entry.role === 'manager' && entry.label === label);
    const text = trace.records?.find(record => record.requestId === call?.requestId)?.text;
    let parsed;
    try {
      if (call?.status === 'ok' && typeof text === 'string') {
        parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n|\n```$/gi, ''));
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { calls: Number(Boolean(call)), repliesOk: Number(call?.status === 'ok'),
      outerObjects: Number(object(parsed)), fieldObjects: Number(object(parsed?.[field])) };
  };
  const numericFields = ['completedTraces', 'fullPasses', 'assignmentCalls', 'assignmentRepliesOk',
    'assignmentOuterObjects', 'assignmentFieldObjects', 'assignmentSlots', 'recognizedAssignmentKeys',
    'validAssignmentIds', 'fallbackAssignments', 'validOwnFamilyAssignments', 'reviewCalls', 'reviewRepliesOk',
    'reviewOuterObjects', 'reviewFieldObjects', 'nonemptyReviewProposals', 'placeholderSkillKeyReviews',
    'recognizedRevisionKeys', 'validRevisionIds', 'revisionWorkerCalls'];
  const details = traces.filter(trace => trace.style === 'manager-and-workers').map(trace => {
    const assignment = trace.decisions.find(decision => decision.kind === 'manager-assign');
    const review = trace.decisions.find(decision => decision.kind === 'manager-review');
    const assignmentProposal = object(assignment?.proposed) ? assignment.proposed : {};
    const reviewProposal = object(review?.proposed) ? review.proposed : {};
    const assignmentParsing = parseProposal(trace, 'assign', 'assignments');
    const reviewParsing = parseProposal(trace, 'review', 'revisions');
    const modelChoiceSkills = skills.filter(skill => eligible[skill].has(assignmentProposal[skill]));
    const fallbackSkills = assignment?.fallbackSkills ?? [];
    const recognizedRevisionSkills = skills.filter(skill => Object.hasOwn(reviewProposal, skill));
    const validRevisionSkills = recognizedRevisionSkills.filter(skill => eligible[skill].has(reviewProposal[skill]));
    return {
      packId: trace.packId, managerFamily: trace.managerFamily, fullPass: trace.result.pass,
      completedTraces: 1, fullPasses: Number(trace.result.pass),
      assignmentCalls: assignmentParsing.calls, assignmentRepliesOk: assignmentParsing.repliesOk,
      assignmentOuterObjects: assignmentParsing.outerObjects, assignmentFieldObjects: assignmentParsing.fieldObjects,
      assignmentSlots: skills.length,
      recognizedAssignmentKeys: skills.filter(skill => Object.hasOwn(assignmentProposal, skill)).length,
      validAssignmentIds: modelChoiceSkills.length, fallbackAssignments: fallbackSkills.length,
      validOwnFamilyAssignments: modelChoiceSkills.filter(skill => eligible[skill].get(assignmentProposal[skill]) === trace.managerFamily).length,
      reviewCalls: reviewParsing.calls, reviewRepliesOk: reviewParsing.repliesOk,
      reviewOuterObjects: reviewParsing.outerObjects, reviewFieldObjects: reviewParsing.fieldObjects,
      nonemptyReviewProposals: Number(Object.keys(reviewProposal).length > 0),
      placeholderSkillKeyReviews: Number(Object.hasOwn(reviewProposal, 'skill')),
      recognizedRevisionKeys: recognizedRevisionSkills.length, validRevisionIds: validRevisionSkills.length,
      revisionWorkerCalls: trace.calls.filter(call => call.role === 'worker' && skills.some(skill => call.label === `${skill}/2`)).length,
      proposedAssignments: assignment?.proposed ?? null, modelChoiceSkills, fallbackSkills,
      fallbackLogMatchesValidity: skills.every(skill => fallbackSkills.includes(skill) === !modelChoiceSkills.includes(skill)),
      initialWorkerSettings: Object.fromEntries(skills.map(skill => [skill,
        trace.calls.find(call => call.role === 'worker' && call.label === `${skill}/1`)?.settingId ?? null])),
      selectedSettings: trace.selectedSettings,
      proposedRevisions: review?.proposed ?? null, recognizedRevisionSkills, validRevisionSkills,
      unrecognizedRevisionKeys: Object.keys(reviewProposal).filter(key => !skills.includes(key)),
    };
  });
  const sum = entries => Object.fromEntries(numericFields.map(field =>
    [field, entries.reduce((total, entry) => total + entry[field], 0)]));
  const families = [...new Set([...rows.map(row => row.family), ...details.map(trace => trace.managerFamily)])];
  return {
    ...sum(details),
    basis: 'Saved strict-JSON parsing, recognized task fields, per-skill eligible setting IDs, logged fallbacks, and actual revision worker calls are counted separately. Fallback assignments are excluded from model hiring and own-family choice counts. Selected settings include only parsed final artifacts and are not a complete decision log. Each family currently appears on its registered tryout topic, so these observations do not isolate family or self-preference effects.',
    byFamily: families.map(family => ({ family, ...sum(details.filter(trace => trace.managerFamily === family)) })),
    traces: details,
  };
}

async function analyze() {
  const [runId = 'desktop-pilot-01'] = process.argv.slice(2);
  if (process.argv.length > 3 || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(runId)) {
    throw new Error('Usage: node scripts/analyze-pilot-math.mjs [run-id]');
  }
  const run = new URL(`../runs/open-pilot/${runId}/`, import.meta.url);
  const readJson = async url => JSON.parse(await readFile(url, 'utf8'));
  const [ledger, priceList, workers, traces, registration, telemetry] = await Promise.all([
    readJson(new URL('desktop-gpu-ledger.json', run)),
    readJson(new URL('price-list.json', run)),
    readJson(new URL('worker-scores.json', run)),
    readJson(new URL('unlimited-traces.json', run)),
    readJson(new URL('../data/open-weight-grid.json', import.meta.url)),
    readJson(new URL('gpu-telemetry.json', run)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
  ]);
  if (!Array.isArray(ledger) || ledger.some(entry => !Number.isFinite(entry.allocatedSeconds) || entry.allocatedSeconds < 0)
      || !Array.isArray(priceList.rows) || !Array.isArray(workers) || !Array.isArray(traces)) {
    throw new Error('Expected settled allocation entries, price-list rows, worker groups, and completed traces.');
  }
  const allocatedSeconds = ledger.reduce((total, entry) => total + entry.allocatedSeconds, 0);
  const remainingSeconds = GPU_BUDGET_SECONDS - allocatedSeconds;
  const registeredCounts = designBudget(registration).evaluated;
  const reducedGrid = {
    ...registration.grid,
    packIds: registration.grid.packIds.slice(0, 12),
    repeats: 1,
    managerFamilies: registration.grid.managerFamilies.slice(0, 1),
    managerPolicies: registration.grid.managerPolicies.filter(policy => policy === 'manager-choice'),
    visibility: registration.grid.visibility.filter(visibility => visibility === 'told'),
  };
  if (reducedGrid.managerPolicies.length !== 1 || reducedGrid.visibility.length !== 1) {
    throw new Error('The registered grid must include manager-choice and told visibility.');
  }
  const designs = [
    { name: 'registered-full', approval: 'registered', cells: registeredCounts[0].runs },
    { name: 'registered-minimum', approval: 'registered', cells: registeredCounts.at(-1).runs },
    { name: 'five-styles-one-manager-policy-visibility', approval: 'proposed-unapproved', cells: countCells(reducedGrid, STYLES) },
    { name: 'solo-and-manager-one-policy-visibility', approval: 'proposed-unapproved', cells: countCells(reducedGrid, ['solo-best', 'manager-and-workers']) },
    { name: 'manager-only-one-policy-visibility', approval: 'proposed-unapproved', cells: countCells(reducedGrid, ['manager-and-workers']) },
  ].map(design => ({
    ...design,
    remainingSecondsPerCell: Math.max(0, remainingSeconds) / design.cells,
  }));
  const articlePasses = group => group.result.checks.article_length && group.result.checks.article_reference;
  const simulationPasses = group => group.result.checks.simulation_primary && group.result.checks.simulation_secondary;
  const countGroups = predicate => workers.filter(predicate).length;
  const necessary = {
    articleBoth: countGroups(articlePasses),
    derivation: countGroups(group => group.result.checks.derivation_reference),
    simulationBoth: countGroups(simulationPasses),
    renderedIllustration: countGroups(group => group.result.checks.illustration_rendered),
    articleSimulationIntersection: countGroups(group => articlePasses(group) && simulationPasses(group)),
  };
  const independentGateProduct = [necessary.articleBoth, necessary.derivation,
    necessary.simulationBoth, necessary.renderedIllustration]
    .reduce((product, passes) => product * passes / workers.length, 1);
  const tournamentPools = traces.filter(trace => trace.decisions.some(decision => decision.kind === 'tournament-judgments')).map(trace => {
    const candidates = trace.decisions.filter(decision => decision.kind === 'tournament-judgments').flatMap(decision => decision.candidates);
    const countCandidates = predicate => candidates.filter(predicate).length;
    const necessaryGatePassingCounts = {
      articleBoth: countCandidates(candidate => candidate.automatic.article_length && candidate.automatic.article_reference),
      derivation: countCandidates(candidate => candidate.automatic.derivation_reference),
      simulationBoth: countCandidates(candidate => candidate.automatic.simulation_primary && candidate.automatic.simulation_secondary),
      renderedIllustration: countCandidates(candidate => candidate.automatic.illustration_rendered),
    };
    return {
      packId: trace.packId,
      candidateSettings: candidates.map(candidate => candidate.settingId),
      necessaryGatePassingCounts,
      fullPassImpossibleFromUnchangedPool: Object.values(necessaryGatePassingCounts).some(count => count === 0),
      selectedFullPass: trace.result.pass,
      candidatesWithAllRatingsNull: countCandidates(candidate => ['article', 'derivation', 'simulation', 'picture']
        .every(field => candidate.rating?.[field] === null)),
    };
  });
  const interruptionRate = 1 / 180;
  const rotation = familyRotationProposal(registration.grid);
  const mathematicalProposals = costFamilyRotationProposals(rotation, telemetry
    ? { ...telemetry, calibration: planGpu(telemetry).calibration } : {});
  return {
    snapshotAt: new Date().toISOString(),
    runId,
    accounting: {
      budgetGpuHours: GPU_BUDGET_SECONDS / 3600,
      settledEntries: ledger.length,
      settledGpuSeconds: allocatedSeconds,
      settledGpuHours: allocatedSeconds / 3600,
      remainingAfterSettledGpuSeconds: remainingSeconds,
      remainingAfterSettledGpuHours: remainingSeconds / 3600,
      basis: 'Settled ledger entries. Ongoing work and outstanding reservations are excluded from this snapshot.',
    },
    priceList: { rows: priceList.rows.length, panelCoverage: priceList.panelCoverage ?? [] },
    workers: {
      groups: workers.length,
      fullPasses: countGroups(group => group.result.pass),
      parsedArticles: countGroups(group => typeof group.parts.article === 'string'),
      parsedSimulations: countGroups(group => group.parts.simulation != null),
      executedSimulations: countGroups(group => Number.isFinite(group.result.primary.value)),
      necessary,
    },
    hypotheticalIndependentSkillGates: {
      status: 'hypothetical-independent-gates',
      groups: workers.length,
      productOfPooledMarginals: independentGateProduct,
      expectedSuccessfulGroups: independentGateProduct * workers.length,
      assumptions: 'The four necessary skill gates are treated as independent using pooled empirical shares. The pilot has shared topics and settings, and its article-simulation intersection is empty. This product illustrates serial bottlenecks and does not estimate generalization.',
    },
    calibration: {
      completedTraces: traces.length,
      fullPasses: traces.filter(trace => trace.result.pass).length,
      specialistPasses: traces.filter(trace => trace.style === 'specialists' && trace.result.pass).map(trace => ({
        packId: trace.packId, activeGpuSeconds: trace.activeSeconds,
        allocatedGpuSeconds: trace.allocatedSeconds, wallSeconds: trace.wallSeconds,
        selectedSettings: trace.selectedSettings,
      })),
    },
    tournamentPools,
    managerDecisionCoverage: managerDecisionCoverage(traces, priceList),
    restrictedFamilyRotation: rotation,
    mathematicalProposals,
    designs: {
      conditions: CONDITIONS,
      breakEvenBasis: 'Remaining settled-budget seconds divided by cells. Future pilot, panel, loading, release, failed-attempt, and other occupied time must fit inside this allowance.',
      candidates: designs,
    },
    hypotheticalRestart: {
      status: 'hypothetical-unfitted',
      interruptionRatePerSecond: interruptionRate,
      assumptions: 'Independent exponential interruptions during a deterministic cold-load-plus-work attempt. Every interrupted attempt loses its progress. Retries continue until success. Release and busy waiting are excluded.',
      examples: [60, 150, 330].map(attemptSeconds => ({
        uninterruptedSeconds: attemptSeconds,
        successProbabilityPerAttempt: Math.exp(-interruptionRate * attemptSeconds),
        expectedAttempts: Math.exp(interruptionRate * attemptSeconds),
        expectedChargedResidentSeconds: Math.expm1(interruptionRate * attemptSeconds) / interruptionRate,
      })),
    },
    hypotheticalZeroSuccessBound: {
      status: 'hypothetical-iid',
      successes: 0,
      trials: workers.length,
      confidence: 0.95,
      oneSidedUpperProbability: 1 - 0.05 ** (1 / workers.length),
      assumptions: 'A common Bernoulli success probability and independent identically distributed trials. The pilot repeats settings on five topics and does not satisfy this sampling assumption.',
    },
    normalPlanningApproximation: {
      status: 'hypothetical-normal-approximation',
      pairedPacks: reducedGrid.packIds.length,
      twoSidedSignificance: 0.05,
      targetPower: 0.8,
      significanceNormalQuantile: 1.96,
      powerNormalQuantile: 0.841621,
      approximateEffectInPairedDifferenceStandardDeviations: (1.96 + 0.841621) / Math.sqrt(reducedGrid.packIds.length),
      assumptions: 'Independent paired pack differences with a common variance and a normal planning approximation using known standard deviation. This calculation does not account for small-sample t critical values, discrete outcomes, or multiple comparisons.',
    },
    hypotheticalPairedSignTests: {
      status: 'hypothetical-exact-sign-tests',
      examples: [5, 6].map(discordances => ({
        discordances,
        allFavorOneArm: true,
        twoSidedPValue: 2 * 0.5 ** discordances,
      })),
      assumptions: 'Conditional on the discordant pack count, independent signs have equal probability under the null. Every discordance favors the same arm, concordant pairs are omitted, and no multiple-comparison correction is applied.',
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await analyze(), null, 2));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
