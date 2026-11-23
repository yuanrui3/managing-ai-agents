import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { judgePrompt, mean, panelValue, renderPanelPng, skillScore } from '../src/blind-panel.mjs';
import { GPU_BUDGET_SECONDS } from '../src/gpu-planning.mjs';
import { atomicJson, atomicWrite, GpuBudgetStop, python } from '../src/local-pilot.mjs';
import { skills } from '../src/pilot.mjs';

const judgeSeed = 20261115;
const bootstrapSeed = 20261119;
const bootstrapDraws = 10_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const hasResult = trace => trace.status === 'complete' || trace.status === 'budget-truncated';

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return undefined;
}

function isUnder(directory, candidate) {
  const path = relative(directory, candidate);
  return path !== '' && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path);
}

function ledgerFor(controller, directory) {
  return controller.terminals.filter(receipt => isUnder(directory, receipt.queue));
}

const total = (rows, field) => rows.reduce((sum, row) => sum + (Number.isFinite(row[field]) ? row[field] : 0), 0);

async function panelCases(traces, packs) {
  const packById = new Map(packs.map(pack => [pack.id, pack]));
  const entries = traces.filter(hasResult).map(trace => ({ trace, id: `case-${digest(trace.id).slice(0, 20)}` }))
    .sort((first, second) => first.id.localeCompare(second.id));
  const cases = [];
  for (const { trace, id } of entries) {
    const article = typeof trace.parts.article === 'string' ? trace.parts.article.replace(/\{\{result:\s*([^}]+)\}\}/g, '$1') : null;
    if (!article && !trace.svg) continue;
    const image = trace.svg ? await renderPanelPng(trace.svg, python) : null;
    const checklist = image ? packById.get(trace.packId).picture_checklist : [];
    const request = {
      id, seed: judgeSeed + cases.length, draft_tokens: 0, max_output_tokens: 300,
      prompt: judgePrompt(article, checklist, Boolean(image)), ...(image && { image_base64: image }),
    };
    cases.push({ id, cellId: trace.id, hasArticle: Boolean(article), pictureCount: checklist.length, request });
  }
  return cases;
}

async function savePanelQueue(queue, model, cases) {
  const manifest = {
    modelId: model.id, checkpoint: model.checkpoint, revision: model.revision,
    tasks: cases.map(({ request, ...task }) => ({ ...task, contentHash: digest(JSON.stringify(request)) })),
  };
  const manifestPath = join(queue, 'manifest.json');
  const previous = await optionalJson(manifestPath);
  if (previous && JSON.stringify(previous) !== JSON.stringify(manifest)) {
    throw new Error(`Saved blind-panel inputs differ for ${model.id}.`);
  }
  await mkdir(join(queue, 'inbox'), { recursive: true });
  await mkdir(join(queue, 'outbox'), { recursive: true });
  for (const { id, request } of cases) {
    let found = false;
    for (const folder of ['outbox', 'inflight', 'inbox']) {
      const file = await optionalJson(join(queue, folder, `${id}.json`));
      if (!file) continue;
      if (folder !== 'outbox' && JSON.stringify(file) !== JSON.stringify(request)) {
        throw new Error(`Saved blind-panel request differs for ${id}.`);
      }
      found = true;
    }
    if (!found) await atomicJson(join(queue, 'inbox', `${id}.json`), request);
  }
  if (!previous) await atomicJson(manifestPath, manifest);
  await atomicJson(join(queue, 'sealed.json'), { requests: cases.length });
}

function scoreTrace(trace, ratings, familyBySetting) {
  const bySkill = Object.fromEntries(skills.map(skill => {
    const makerFamily = familyBySetting.get(trace.selectedSettings?.[skill]);
    return [skill, {
      makerFamily: makerFamily ?? null,
      allJudges: skillScore(trace, skill, ratings),
      excludingMakerFamily: skillScore(trace, skill, ratings.filter(rating => rating.family !== makerFamily)),
    }];
  }));
  function score(field) {
    const values = skills.map(skill => bySkill[skill][field]);
    return values.every(Number.isFinite) ? mean(values) : null;
  }
  return { bySkill, allJudges: score('allJudges'), excludingMakerFamily: score('excludingMakerFamily') };
}

export async function runMainPanel({ directory, roster, packs, traces, controller, onProgress = async () => {} }) {
  const cases = await panelCases(traces, packs);
  const panelDir = join(directory, 'panel');
  const articleEligible = cases.filter(task => task.hasArticle).length;
  const pictureEligible = cases.filter(task => task.pictureCount > 0).length;
  const ratings = new Map(cases.map(task => [task.cellId, []]));
  const coverage = [];
  let budgetLimited = false;
  let reason = null;

  for (const model of roster.judges) {
    const queue = join(panelDir, model.id);
    if (cases.length && !budgetLimited) {
      await savePanelQueue(queue, model, cases);
      await onProgress({ phase: 'panel', judge: model.id, judgesFinished: coverage.length, eligibleCases: cases.length });
      try { await controller.runQueue({ model, role: 'judge', queue, resume: true }); }
      catch (error) {
        if (!(error instanceof GpuBudgetStop)) throw error;
        budgetLimited = true;
        reason = error.message;
      }
    }

    const result = { judge: model.id, family: model.family, neutral: Boolean(model.neutral), requests: cases.length,
      returned: 0, articleEligible, articleRated: 0, pictureEligible, pictureRated: 0 };
    for (const task of cases) {
      const response = await optionalJson(join(queue, 'outbox', `${task.id}.json`));
      if (!response) continue;
      if (response.id !== task.id || response.checkpoint !== model.checkpoint || response.revision !== model.revision ||
          response.role !== 'judge' || response.site !== 'desktop-windows' || !['ok', 'error'].includes(response.status) ||
          (response.status === 'ok' && typeof response.text !== 'string')) {
        throw new Error(`Blind-panel reply has invalid provenance or shape for ${model.id}/${task.id}.`);
      }
      const rating = panelValue({ ...task, response });
      result.returned++;
      result.articleRated += Number(Number.isFinite(rating.clarity));
      result.pictureRated += Number(Number.isFinite(rating.picture));
      ratings.get(task.cellId).push({ judge: model.id, family: model.family, ...rating });
    }
    if (!budgetLimited && result.returned !== cases.length) throw new Error(`Blind-panel batch incomplete for ${model.id}.`);
    coverage.push(result);
  }

  const familyBySetting = new Map(roster.workers.flatMap(model => [0, 128, 512].map(draft => [`${model.id}-d${draft}`, model.family])));
  const scores = Object.fromEntries(traces.filter(hasResult).map(trace => [trace.id,
    scoreTrace(trace, ratings.get(trace.id) ?? [], familyBySetting)]));
  const panel = {
    status: budgetLimited ? 'budget-limited' : 'complete', reason,
    allocatedSeconds: total(ledgerFor(controller, panelDir), 'allocatedSeconds'),
    eligibleCases: cases.length, coverage, scores, ratingsByCell: Object.fromEntries(ratings),
  };
  await atomicJson(join(directory, 'panel-results.json'), panel);
  return panel;
}

function pairedBootstrap(differences) {
  const pairs = differences.length;
  if (!pairs) return { pairs, difference: null, lower: null, upper: null };
  let state = bootstrapSeed;
  const sampled = Array.from({ length: bootstrapDraws }, () => {
    let sum = 0;
    for (let index = 0; index < pairs; index++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      sum += differences[Math.floor(state * pairs / 0x100000000)];
    }
    return sum / pairs;
  }).sort((first, second) => first - second);
  return { pairs, difference: mean(differences), lower: sampled[Math.floor(bootstrapDraws * 0.025)],
    upper: sampled[Math.ceil(bootstrapDraws * 0.975) - 1] };
}

function estimateComparisons(traces, panel) {
  const packs = new Map();
  for (const trace of traces.filter(item => item.status === 'complete')) {
    if (!packs.has(trace.packId)) packs.set(trace.packId, new Map());
    packs.get(trace.packId).set(`${trace.style}/${trace.condition}`, trace);
  }
  const contrasts = [
    { label: 'Team minus solo under unlimited', terms: [[1, 'manager-and-workers/unlimited'], [-1, 'solo-best/unlimited']] },
    { label: 'Team minus solo under the execution cap', terms: [[1, 'manager-and-workers/compute-cap'], [-1, 'solo-best/compute-cap']] },
    { label: 'Change in team advantage under the execution cap', terms: [[1, 'manager-and-workers/compute-cap'],
      [-1, 'solo-best/compute-cap'], [-1, 'manager-and-workers/unlimited'], [1, 'solo-best/unlimited']] },
  ];
  const metrics = {
    completion: trace => Number(trace.result.pass),
    quality: trace => panel?.scores[trace.id]?.allJudges,
    qualityExcludingMakerFamily: trace => panel?.scores[trace.id]?.excludingMakerFamily,
  };
  return contrasts.map(({ label, terms }) => ({ label, ...Object.fromEntries(Object.entries(metrics).map(([metric, measure]) => {
    const differences = [...packs.values()].flatMap(cells => {
      const observations = terms.map(([weight, id]) => {
        const value = cells.has(id) ? measure(cells.get(id)) : null;
        return Number.isFinite(value) ? weight * value : NaN;
      });
      return observations.every(Number.isFinite) ? [observations.reduce((sum, value) => sum + value, 0)] : [];
    });
    return [metric, pairedBootstrap(differences)];
  })) }));
}

function summarizeArms(cells, traceById, panel) {
  const groups = new Map();
  for (const cell of cells) {
    const key = `${cell.style}/${cell.condition}`;
    if (!groups.has(key)) groups.set(key, { style: cell.style, condition: cell.condition, cells: [] });
    groups.get(key).cells.push(cell);
  }
  return [...groups.values()].map(({ style, condition, cells: group }) => {
    const observed = group.map(cell => traceById.get(cell.id)).filter(Boolean);
    const comparable = observed.filter(trace => trace.status === 'complete');
    const passed = comparable.filter(trace => trace.result.pass).length;
    const quality = comparable.map(trace => panel?.scores[trace.id]?.allJudges).filter(Number.isFinite);
    const external = comparable.map(trace => panel?.scores[trace.id]?.excludingMakerFamily).filter(Number.isFinite);
    const usage = comparable.flatMap(trace => trace.calls);
    const failed = comparable.filter(trace => !trace.result.pass);
    const checks = Object.fromEntries([...new Set(comparable.flatMap(trace => Object.keys(trace.result.checks)))].map(check =>
      [check, comparable.filter(trace => trace.result.checks[check]).length]));
    const conditionRefusals = Object.fromEntries(['execution_cap', 'deadline', 'call_quota'].map(reason =>
      [reason, usage.filter(call => call.status === 'error' && call.telemetry?.error_type === reason).length]));
    return {
      style, condition, planned: group.length, comparable: comparable.length, budgetTruncated: observed.length - comparable.length,
      notRun: group.length - observed.length, passed, checks, conditionRefusals,
      quality: mean(quality), qualityCount: quality.length,
      excludingMakerFamily: mean(external), excludingMakerFamilyCount: external.length,
      activeSeconds: mean(comparable.map(trace => trace.activeSeconds).filter(Number.isFinite)),
      wallSeconds: mean(comparable.map(trace => trace.wallSeconds).filter(Number.isFinite)),
      allocatedSeconds: total(observed, 'allocatedSeconds'), failedPackAllocatedSeconds: total(failed, 'allocatedSeconds'),
      secondaryFailures: comparable.filter(trace => !trace.result.checks.simulation_secondary).length,
      primaryPassSecondaryFail: comparable.filter(trace => trace.result.checks.simulation_primary && !trace.result.checks.simulation_secondary).length,
      imposedWaitSeconds: usage.reduce((sum, call) => sum + (call.telemetry?.imposed_wait_ms ?? 0) / 1000, 0),
      interruptedExecutionCalls: usage.filter(call => call.telemetry?.interrupted_execution_unavailable).length,
    };
  });
}

function summarizeManager(traces) {
  const managed = traces.filter(trace => trace.status === 'complete' && trace.style === 'manager-and-workers');
  const assignments = managed.flatMap(trace => trace.decisions.filter(decision => decision.kind === 'manager-assign')
    .map(decision => ({ fallbackSlots: decision.fallbackSkills.length, pass: trace.result.pass })));
  const revisions = managed.flatMap(trace => trace.calls.filter(call => call.role === 'worker' && call.label.endsWith('/2')));
  const assignmentSlots = assignments.length * skills.length;
  const fallbackSlots = total(assignments, 'fallbackSlots');
  return {
    assignmentSlots, validAssignmentSlots: assignmentSlots - fallbackSlots, fallbackSlots,
    passingRunsUsingOnlyFallbacks: assignments.filter(item => item.pass && item.fallbackSlots === skills.length).length,
    revisionWorkerRequests: revisions.length, successfulRevisionWorkerReplies: revisions.filter(call => call.status === 'ok').length,
  };
}

function summarizeLedger(controller, directory, manifest) {
  const receipts = ledgerFor(controller, directory);
  const attempts = receipts.flatMap(receipt => receipt.attempts ?? []);
  const yieldReasons = {};
  for (const attempt of attempts.filter(item => item.yieldReason)) {
    yieldReasons[attempt.yieldReason] = (yieldReasons[attempt.yieldReason] ?? 0) + 1;
  }
  const waits = receipts.map(receipt => receipt.waitMs).filter(Number.isFinite).sort((first, second) => first - second);
  const percentile = fraction => waits.length ? waits[Math.ceil(fraction * waits.length) - 1] / 1000 : null;
  const mainAllocatedSeconds = controller.allocatedSeconds - manifest.pilotGpuSeconds;
  return {
    pilotAllocatedSeconds: manifest.pilotGpuSeconds, mainAllocatedSeconds,
    projectAllocatedSeconds: controller.allocatedSeconds,
    remainingGpuSeconds: Math.max(0, GPU_BUDGET_SECONDS - controller.allocatedSeconds),
    panelAllocatedSeconds: total(ledgerFor(controller, join(directory, 'panel')), 'allocatedSeconds'),
    queueReceipts: receipts.length, attempts: attempts.length, yieldReasons,
    firstAdmissionWait: { count: waits.length, medianSeconds: percentile(0.5), p90Seconds: percentile(0.9) },
  };
}

const number = (value, fractionDigits = 2) => Number.isFinite(value) ? value.toFixed(fractionDigits) : '—';
const hours = seconds => number(seconds / 3600);
const points = value => Number.isFinite(value) ? number(value * 100, 1) : '—';
const ordinaryText = value => String(value).replace(/[\r\n]+/g, ' ').replaceAll('|', '\\|');
const ordinarySentence = value => ordinaryText(value).trim().replace(/[.]+$/, '') + '.';

export async function writeMainReport({ directory, manifest, traces, panel, controller, status, reason }) {
  const traceById = new Map(traces.map(trace => [trace.id, trace]));
  const arms = summarizeArms(manifest.cells, traceById, panel);
  const comparisons = estimateComparisons(traces, panel);
  const manager = summarizeManager(traces);
  const gpu = summarizeLedger(controller, directory, manifest);
  const resumedCells = traces.filter(trace => trace.resumed).map(trace => ({ packId: trace.packId, style: trace.style, condition: trace.condition }));
  const planned = manifest.cells.length;
  const comparable = total(arms, 'comparable');
  const budgetTruncated = total(arms, 'budgetTruncated');
  const summary = {
    studyId: manifest.studyId, status, reason: reason ?? null, updatedAt: new Date().toISOString(),
    planned, comparable, budgetTruncated, notRun: planned - comparable - budgetTruncated,
    passed: total(arms, 'passed'), paidApiCalls: 0, limits: manifest.limits, gpu, arms, comparisons, manager, resumedCells,
    bootstrap: { seed: bootstrapSeed, draws: bootstrapDraws, confidenceLevel: 0.95, resamplingUnit: 'pack' },
    panel: panel ? { status: panel.status, reason: panel.reason, eligibleCases: panel.eligibleCases, coverage: panel.coverage } : null,
  };

  const statusLabel = { complete: 'Complete', 'budget-limited': 'Stopped at the project budget', paused: 'Paused' }[status] ?? status;
  const pair = comparison => `${comparison.pairs} | ${points(comparison.difference)} | ${points(comparison.lower)} to ${points(comparison.upper)}`;
  const armsTable = arms.map(arm => `| ${arm.style} | ${arm.condition} | ${arm.comparable}/${arm.planned} | ${arm.passed}/${arm.comparable} | ` +
    `${arm.budgetTruncated} | ${arm.notRun} | ${number(arm.quality)} (${arm.qualityCount}) | ` +
    `${number(arm.excludingMakerFamily)} (${arm.excludingMakerFamilyCount}) |`);
  const accountingTable = arms.map(arm => `| ${arm.style} | ${arm.condition} | ${number(arm.activeSeconds)} | ${number(arm.wallSeconds)} | ` +
    `${hours(arm.allocatedSeconds)} | ${hours(arm.failedPackAllocatedSeconds)} | ${arm.primaryPassSecondaryFail} | ${number(arm.imposedWaitSeconds)} | ` +
    `${Object.values(arm.conditionRefusals).reduce((sum, value) => sum + value, 0)} |`);
  const coverageTable = panel?.coverage.map(row => `| ${row.judge} | ${row.returned}/${row.requests} | ` +
    `${row.articleRated}/${row.articleEligible} | ${row.pictureRated}/${row.pictureEligible} |`) ?? [];
  const yieldRows = Object.entries(gpu.yieldReasons).map(([key, count]) => `| ${key} | ${count} |`);
  const limits = manifest.limits;
  const lines = [
    '# Qwen-led team and solo experiment', '',
    `**${statusLabel}.** ${comparable} of ${planned} planned cells produced comparable results, with ${summary.passed} packs passing every automatic check. ` +
      `The project used ${hours(gpu.projectAllocatedSeconds)} GPU-hours, including ${hours(gpu.pilotAllocatedSeconds)} in the pilot and ` +
      `${hours(gpu.mainAllocatedSeconds)} in the main study. Paid API calls were zero.`, '',
    ...(reason ? [ordinarySentence(reason), ''] : []),
    '## Completion and artifact quality', '',
    '| Style | Condition | Comparable / planned | Pass / comparable | Budget-truncated | Unrun | Quality (rated packs) | Quality excluding maker-family judges (rated packs) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...armsTable, '',
    'Comparable cells include failures caused by their assigned compute, deadline, quota, or queue condition. Cells curtailed by the shared project budget and unrun cells are separate. Quality averages the four skill scores when all are available. Automatic failures score zero. Missing eligible judge scores remain unavailable.', '',
    `In comparable team runs, the manager supplied ${manager.validAssignmentSlots}/${manager.assignmentSlots} valid assignment IDs. The controller used ${manager.fallbackSlots} specialist defaults. ` +
      `${manager.passingRunsUsingOnlyFallbacks} passing team runs used four defaults. Revision worker requests yielded ` +
      `${manager.successfulRevisionWorkerReplies}/${manager.revisionWorkerRequests} successful replies before artifact parsing.`, '',
    '## Paired differences', '',
    '| Contrast | Outcome | Packs | Difference in points | 95% bootstrap interval |',
    '| --- | --- | ---: | ---: | ---: |',
    ...comparisons.flatMap(contrast => [
      `| ${contrast.label} | Completion | ${pair(contrast.completion)} |`,
      `| ${contrast.label} | Quality | ${pair(contrast.quality)} |`,
      `| ${contrast.label} | Quality excluding maker-family judges | ${pair(contrast.qualityExcludingMakerFamily)} |`,
    ]), '',
    'The interaction compares the team-minus-solo difference under the execution cap with the team-minus-solo difference under unlimited resources. Each estimate uses its available matched packs, and the interval resamples whole packs with a fixed seed over 10,000 draws. Few packs or discordant outcomes limit interval interpretation.', '',
    ...(comparable > 0 && summary.passed === 0 ? ['All observed completion outcomes are zero, so the completion bootstrap intervals collapse to zero. This gives limited information about completion rates on new packs.', ''] : []),
    '## Resource use and withheld checks', '',
    '| Style | Condition | Mean execution s | Mean elapsed s | Charged GPUh | GPUh for failed comparable packs | Primary passes that fail withheld check | Imposed wait s | Condition cutoff calls |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...accountingTable, '',
    `Interrupted execution time was unavailable for ${total(arms, 'interruptedExecutionCalls')} calls in comparable cells. The GPU allocation ledger includes those attempts.`, '',
    `The blind panel used ${hours(gpu.panelAllocatedSeconds)} GPU-hours. The project has ${hours(gpu.remainingGpuSeconds)} GPU-hours remaining. The study ledger records ${gpu.attempts} worker attempts across ${gpu.queueReceipts} queue receipts.`, '',
    `Time to first admission was recorded for ${gpu.firstAdmissionWait.count} queues. The median was ${number(gpu.firstAdmissionWait.medianSeconds)} seconds and the 90th percentile was ${number(gpu.firstAdmissionWait.p90Seconds)} seconds. This includes waiting for verified idle. Later interruptions can add further waits.`, '',
    ...(yieldRows.length ? ['| Logged interruption reason | Attempts |', '| --- | ---: |', ...yieldRows, ''] : []),
    '## Blind-panel coverage', '',
    ...(panel ? [
      `The six-judge schedule includes anonymized articles or rendered illustrations from ${panel.eligibleCases} eligible run outputs. ` +
        'Same-family exclusion follows the maker of each artifact, including revised artifacts.', '',
      '| Judge | Returned / planned | Valid article ratings / eligible | Valid picture ratings / eligible |',
      '| --- | ---: | ---: | ---: |', ...coverageTable, '',
      ...(panel.reason ? [`Panel stop reason is ${ordinaryText(panel.reason)}.`, ''] : []),
    ] : ['Panel results are pending.', '']),
    '## Method', '',
    'The design uses 12 held-out packs. The fixed Qwen manager chooses worker settings with resource information and can request one revision per skill. The solo control uses the highest-ranked complete setting from the pilot. Both styles run under unlimited resources and an execution-time cap. Deadline, call quota, and queue contention run for the manager alone.', '',
    `The frozen execution cap is ${number(limits.executionSeconds, 3)} seconds. The deadline is ${number(limits.deadlineSeconds, 3)} elapsed seconds. ` +
      `The quota is ${limits.maxCallsPerFamily} call per family per ${number(limits.quotaWindowSeconds, 0)} seconds, and queue contention adds ${number(limits.slotDelaySeconds, 3)} seconds per request to the execution cap condition.`, '',
    'Execution time covers backend processing. Charged allocation also includes loads, interrupted attempts, and release checks. Existing GPU work retains priority throughout the experiment.', '',
    ...(resumedCells.length ? [
      'Elapsed times include interruptions and gaps between launcher sessions. Replaying saved requests preserves the initial time origin and any deadline. Interpret elapsed-time means with the resumed cells in view.', '',
      '| Resumed pack | Style | Condition |', '| --- | --- | --- |',
      ...resumedCells.map(cell => `| ${cell.packId} | ${cell.style} | ${cell.condition} |`), '',
    ] : []),
  ];
  await atomicJson(join(directory, 'main-results.json'), summary);
  await atomicWrite(join(directory, 'main.md'), lines.join('\n'));
  return summary;
}
