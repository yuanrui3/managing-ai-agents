import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { LocalPilot, GpuBudgetStop, atomicJson, readProjectJson } from '../src/local-pilot.mjs';
import { makePolicy, runTrial } from './calibrate-local.mjs';
import { checkedSimulationProtocol, originalSimulationProtocol } from '../src/pilot.mjs';
import { runMainPanel, writeMainReport } from './report-local-main.mjs';

const studyId = 'qwen-team-vs-solo-84';
const pilotDirectory = fileURLToPath(new URL('../runs/open-pilot/desktop-pilot-01/', import.meta.url));
const directory = join(pilotDirectory, studyId);
const ledgerLimit = 40 * 3600;
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function balancedOrder(arms, packIndex) {
  const shift = packIndex % arms.length;
  const rotated = [...arms.slice(shift), ...arms.slice(0, shift)];
  return Math.floor(packIndex / arms.length) % 2 ? rotated.reverse() : rotated;
}

export function buildManifest(gate, packs, roster, priceList, pilotGpuSeconds, panelShare) {
  const proposal = gate.mathematicalProposals.evaluated.find(item => item.id === 'fixed-family-focused-solo');
  const expectedConditions = ['unlimited', 'compute-cap', 'deadline', 'call-quota', 'one-gpu-slot'];
  if (proposal?.fixedFamily !== 'qwen' || proposal.repeats !== 1 || proposal.managerPolicy !== 'manager-choice'
      || proposal.visibility !== 'told' || proposal.assignmentMatrix.length !== 12
      || JSON.stringify(proposal.managerConditions) !== JSON.stringify(expectedConditions)
      || JSON.stringify(proposal.soloConditions) !== '["unlimited","compute-cap"]'
      || gate.calibration.status !== 'calibrated') {
    throw new Error('The approved fixed-Qwen Gate 2 design could not be verified.');
  }
  const packIds = gate.scopeProposals.evaluated[0].grid.packIds;
  const approvedIds = new Set(proposal.assignmentMatrix.map(row => row.packId));
  const selected = packIds.map(id => packs.find(pack => pack.id === id));
  if (packIds.length !== 12 || new Set(packIds).size !== 12 || packIds.some(id => !approvedIds.has(id))
      || selected.some(pack => pack?.split !== 'main')
      || ['easy', 'medium', 'hard'].some(difficulty => selected.filter(pack => pack.difficulty === difficulty).length !== 4)) {
    throw new Error('The approved packs must be distinct held-out packs with four at each difficulty.');
  }
  const manager = condition => ({ style: 'manager-and-workers', condition });
  const solo = condition => ({ style: 'solo-best', condition });
  const matched = [manager('unlimited'), solo('unlimited'), manager('compute-cap'), solo('compute-cap')];
  const managerOnly = expectedConditions.slice(2).map(manager);
  const blocks = packIds.map((packId, packIndex) => {
    const wrap = arm => ({ id: [packId, arm.style, arm.condition].join('--'), packId, ...arm });
    return { matched: balancedOrder(matched, packIndex).map(wrap), managerOnly: balancedOrder(managerOnly, packIndex).map(wrap) };
  });
  // Protect the primary four-cell contrast on all held-out packs if the project reaches its hard cap.
  const cells = [...blocks.flatMap(block => block.matched), ...blocks.flatMap(block => block.managerOnly)];
  const { computeCap, deadline, callQuota, oneGpuSlot } = gate.calibration;
  const limits = {
    executionSeconds: computeCap.activeSeconds, deadlineSeconds: deadline.wallSeconds,
    maxCallsPerFamily: callQuota.maxCallsPerFamily, quotaWindowSeconds: callQuota.windowMs / 1000,
    slotDelaySeconds: oneGpuSlot.extraDelayMsPerCall / 1000,
  };
  if (Object.values(limits).some(value => !Number.isFinite(value) || value <= 0)
      || cells.length !== 84 || new Set(cells.map(cell => cell.id)).size !== 84
      || !Number.isFinite(panelShare) || panelShare <= 0
      || !Number.isFinite(pilotGpuSeconds) || pilotGpuSeconds < 0 || pilotGpuSeconds >= ledgerLimit) {
    throw new Error('Invalid approved main-study inputs.');
  }
  return {
    studyId, order: 'Matched four-cell pack blocks first, then balanced manager-only blocks in registered pack order.',
    pilotGpuSeconds, budgetGpuSeconds: ledgerLimit, panelReserveSeconds: Math.ceil(panelShare * cells.length),
    panelAllocationSecondsPerEligibleCase: panelShare, apiUsd: 0,
    managerFamily: 'qwen', managerPolicy: 'manager-choice', visibility: 'told', repeats: 1,
    reviewPrompt: 'Concrete legal task keys and exact menu ID strings. At most one revision for each skill.',
    ...(roster.simulationProtocol && { simulationProtocol: roster.simulationProtocol }),
    packIds, limits, cells, inputHashes: { roster: digest(roster), priceList: digest(priceList), packs: digest(selected) },
  };
}

async function loadOrCreate(path, data) {
  if (existsSync(path)) return json(path);
  await atomicJson(path, data);
  return data;
}

function refused(model, request, error, extra = {}) {
  return { id: request.id, checkpoint: model.checkpoint, revision: model.revision, site: 'desktop-windows',
    status: 'error', error, error_type: error, active_seconds: 0, ...extra };
}

function isComputeCondition(condition) {
  return condition === 'compute-cap' || condition === 'one-gpu-slot';
}

export async function executeCell({ cell, pack, policy, controller, limits, panelReserve, traceDirectory, resumed,
  simulationProtocol = checkedSimulationProtocol }) {
  const folder = join(traceDirectory, cell.id);
  await mkdir(folder, { recursive: true });
  const start = await loadOrCreate(join(folder, 'started.json'), { startedAtMs: Date.now() });
  const deadline = cell.condition === 'deadline' ? start.startedAtMs + Math.floor(limits.deadlineSeconds * 1000) : undefined;
  const compute = isComputeCondition(cell.condition);
  const queuePaths = new Set();
  const chargedForCell = () => controller.terminals.filter(entry => queuePaths.has(entry.queue))
    .reduce((total, entry) => total + entry.allocatedSeconds, 0);
  let activeSeconds = 0;
  let budgetTruncated = false;
  const admissions = [];
  const quotaWindowMs = limits.quotaWindowSeconds * 1000;
  const liveFamilyCalls = (family, now) => admissions.filter(call => call.family === family && now - call.at < quotaWindowMs);
  const quotaSeconds = (family, now) => {
    const starts = liveFamilyCalls(family, now);
    return starts.length < limits.maxCallsPerFamily ? 0 : Math.max(0, (starts[0].at + quotaWindowMs - now) / 1000);
  };

  async function describeResources(label) {
    const disclosurePath = join(folder, label + '-resources.json');
    if (existsSync(disclosurePath)) return (await json(disclosurePath)).text;
    const now = Date.now();
    const details = ['Current resources for this decision:', 'Condition = ' + cell.condition,
      'Remaining project GPU allocation seconds = ' + Math.max(0, controller.remainingGpuSeconds).toFixed(1)];
    if (compute) details.push('Remaining pack execution seconds = ' + Math.max(0, limits.executionSeconds - activeSeconds).toFixed(3));
    if (deadline !== undefined) details.push('Remaining pack wall-clock seconds = ' + Math.max(0, (deadline - now) / 1000).toFixed(3));
    if (cell.condition === 'call-quota') {
      const families = [...new Set([...policy.top.keys(), ...Object.values(policy.ranked).flat().map(setting => setting.model.family)])];
      details.push('Rolling quota = ' + limits.maxCallsPerFamily + ' call per family per ' + limits.quotaWindowSeconds + ' seconds',
        'Seconds until next call is allowed, by family = ' + JSON.stringify(Object.fromEntries(families.map(family =>
          [family, Number(quotaSeconds(family, now).toFixed(3))]))));
    }
    if (cell.condition === 'one-gpu-slot') details.push('Each admitted request waits ' + limits.slotDelaySeconds + ' seconds before dispatch');
    return (await loadOrCreate(disclosurePath, { text: '\n' + details.join('\n') })).text;
  }

  async function invoke({ model, request, role }) {
    queuePaths.add(join(controller.queueRoot, request.id));
    const secondsLeft = compute ? Math.max(0, limits.executionSeconds - activeSeconds) : undefined;
    const bounded = secondsLeft > 0 ? { ...request, max_execution_seconds: secondsLeft } : request;
    const exchangePath = join(folder, request.id + '.json');
    const exchange = await loadOrCreate(exchangePath, { request: bounded, modelId: model.id, role,
      proposedAtMs: Date.now(), admittedAtMs: null, response: null });
    if (digest(exchange.request) !== digest(bounded) || exchange.modelId !== model.id || exchange.role !== role) {
      throw new Error('A resumed cell proposed a different request for ' + request.id);
    }
    const recovery = { retryMemoryGuard: exchange.retryMemoryGuard === true, retryTelemetry: exchange.retryTelemetry ?? false };
    const isRetry = recovery.retryMemoryGuard || recovery.retryTelemetry;
    if (isRetry) for (const path of controller.queuePaths(request.id, recovery)) queuePaths.add(path);
    let response = exchange.response;
    if (!response) {
      const waitMs = cell.condition === 'one-gpu-slot' ? Math.round(limits.slotDelaySeconds * 1000) : 0;
      let now = Date.now();
      const delay = quotaSeconds(model.family, now);
      if (budgetTruncated) response = refused(model, request, 'project_budget');
      else if (deadline !== undefined && now >= deadline && exchange.admittedAtMs === null) response = refused(model, request, 'deadline');
      else if (secondsLeft === 0) response = refused(model, request, 'execution_cap');
      else if (cell.condition === 'call-quota' && exchange.admittedAtMs === null && delay > 0) {
        response = refused(model, request, 'call_quota', { retry_after_ms: Math.ceil(delay * 1000) });
      } else {
        if (exchange.admittedAtMs === null) {
          const delayLeft = exchange.proposedAtMs + waitMs - now;
          if (delayLeft > 0) await sleep(delayLeft);
          now = Date.now();
          exchange.admittedAtMs = now;
          exchange.maxGpuSeconds = Math.max(0, Math.floor(controller.remainingGpuSeconds - panelReserve));
          await atomicJson(exchangePath, exchange);
        }
        try {
          const maxGpuSeconds = isRetry ? Math.max(0, Math.min(exchange.maxGpuSeconds,
            Math.floor(controller.remainingGpuSeconds - panelReserve))) : exchange.maxGpuSeconds;
          response = await controller.invoke({ model, request: bounded, role, deadlineAtMs: deadline,
            maxGpuSeconds, ...recovery });
          const publishedAt = response.outbox_published_at_ms ?? Date.parse(response.request_finished_at);
          if (deadline !== undefined && response.status === 'ok' && (!Number.isFinite(publishedAt) || publishedAt > deadline)) {
            const { text, ...late } = response;
            response = { ...late, status: 'error', error: 'deadline', error_type: 'deadline', artifact_arrived_after_deadline: true };
          }
          if (response.error === 'deadline') response.error_type = 'deadline';
          if (waitMs > 0) response.imposed_wait_ms = waitMs;
        } catch (error) {
          if (!(error instanceof GpuBudgetStop)) throw error;
          response = refused(model, request, 'project_budget', {
            watchdog_allocated_seconds: error.receipt?.allocatedSeconds ?? 0,
            interrupted_execution_unavailable: Boolean(error.receipt?.allocatedSeconds),
          });
        }
      }
      const admittedAt = exchange.admittedAtMs ?? exchange.proposedAtMs;
      response.cell_call_started_ms = Math.max(0, admittedAt - start.startedAtMs);
      response.cell_call_received_ms = Math.max(0, Date.now() - start.startedAtMs);
      exchange.response = response;
      await atomicJson(exchangePath, exchange);
    }
    if (response.error_type === 'project_budget') budgetTruncated = true;
    if (exchange.admittedAtMs !== null && response.error_type !== 'project_budget') {
      admissions.push({ family: model.family, at: exchange.admittedAtMs });
    }
    if (Number.isFinite(response.active_seconds) && response.active_seconds >= 0) activeSeconds += response.active_seconds;
    return response;
  }

  const idPrefix = ('m84-' + cell.condition);
  const trace = await runTrial({ id: cell.id, pack, style: cell.style,
    managerFamily: cell.style === 'manager-and-workers' ? 'qwen' : undefined, idPrefix, policy, invoke,
    clarifyReviewPrompt: true, cellStartedAtMs: start.startedAtMs, describeResources, simulationProtocol });
  return { ...trace, condition: cell.condition, status: budgetTruncated ? 'budget-truncated' : 'complete',
    allocatedSeconds: chargedForCell(), resumed, panelReserveSeconds: panelReserve };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--plan') throw new Error('Usage: node scripts/run-local-main.mjs [--plan]');
  const [gate, roster, priceList, telemetry, packsFile] = await Promise.all([
    json(join(pilotDirectory, 'gate2.json')), json(join(pilotDirectory, 'roster.json')),
    json(join(pilotDirectory, 'price-list.json')), json(join(pilotDirectory, 'gpu-telemetry.json')), readProjectJson('data/packs.json'),
  ]);
  const packs = packsFile.packs;
  const manifest = buildManifest(gate, packs, roster, priceList, telemetry.stageGpuSeconds, telemetry.panelPerRunGpuSeconds);
  const policy = makePolicy(roster, priceList, ['qwen']);
  manifest.soloSetting = policy.solo.id;
  if (args.includes('--plan')) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  await mkdir(directory, { recursive: true });
  const lock = new DatabaseSync(join(directory, 'driver-lock.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
    const controller = new LocalPilot(pilotDirectory, { queueRoot: join(directory, 'queues'), offlineOnly: true });
    await controller.init();
    const manifestPath = join(directory, 'manifest.json');
    const pinned = await loadOrCreate(manifestPath, manifest);
    if (digest(pinned) !== digest(manifest)) throw new Error('The existing main manifest differs from the approved experiment.');
    const traceDirectory = join(directory, 'cells');
    await mkdir(traceDirectory, { recursive: true });
    const packById = new Map(packs.map(pack => [pack.id, pack]));
    const traces = [];
    for (const cell of manifest.cells) {
      const tracePath = join(traceDirectory, cell.id, 'trace.json');
      if (existsSync(tracePath)) {
        const trace = await json(tracePath);
        if (trace.id !== cell.id || trace.packId !== cell.packId || trace.style !== cell.style || trace.condition !== cell.condition) {
          throw new Error('Saved trace does not match the approved cell ' + cell.id);
        }
        traces.push(trace);
      }
    }
    const done = new Set(traces.map(trace => trace.id));
    let phase = 'generation';
    let current = null;
    async function progress(details = {}) {
      await atomicJson(join(directory, 'status.json'), { studyId, phase, current, updatedAt: new Date().toISOString(),
        completedCells: traces.filter(trace => trace.status === 'complete').length, plannedCells: manifest.cells.length,
        allocatedSeconds: controller.allocatedSeconds, remainingSeconds: controller.remainingGpuSeconds, apiUsd: 0, ...details });
    }

    try {
      let stopped = traces.some(trace => trace.status === 'budget-truncated');
      for (const cell of manifest.cells) {
        if (stopped) break;
        if (done.has(cell.id)) continue;
        current = cell;
        await progress();
        console.log('Main ' + (traces.length + 1) + '/84 ' + cell.id + ' started');
        const eligibleSoFar = traces.filter(trace => typeof trace.parts.article === 'string' || trace.svg).length;
        const reserve = Math.ceil((eligibleSoFar + 1) * manifest.panelAllocationSecondsPerEligibleCase);
        const trace = await executeCell({ cell, pack: packById.get(cell.packId), policy, controller, limits: manifest.limits,
          simulationProtocol: pinned.simulationProtocol ?? originalSimulationProtocol,
          panelReserve: reserve, traceDirectory, resumed: existsSync(join(traceDirectory, cell.id, 'started.json')) });
        await atomicJson(join(traceDirectory, cell.id, 'trace.json'), trace);
        traces.push(trace);
        stopped = trace.status === 'budget-truncated';
        console.log('Main ' + traces.length + '/84 ' + cell.id + ' ' + trace.status + ', automatic pass=' + trace.result.pass +
          ', project GPU hours=' + (controller.allocatedSeconds / 3600).toFixed(3));
        await progress();
      }

      phase = 'panel';
      current = null;
      await progress();
      const panel = await runMainPanel({ directory, roster, packs, traces, controller, onProgress: progress });
      const status = stopped || panel.status === 'budget-limited' ? 'budget-limited' : 'complete';
      const reason = stopped ? 'The remaining allocation was reserved for blind judging and verified GPU release.'
        : panel.status === 'budget-limited' ? 'The project GPU cap stopped the panel before all eligible replies.' : null;
      await writeMainReport({ directory, manifest, traces, panel, controller, status, reason });
      phase = status;
      await progress({ reason, report: join(directory, 'main.md') });
      console.log('Main study ' + status + ' at ' + (controller.allocatedSeconds / 3600).toFixed(3) + ' total GPU-hours');
    } catch (error) {
      phase = 'paused';
      await progress({ reason: error.message });
      throw error;
    }
  } finally {
    lock.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
