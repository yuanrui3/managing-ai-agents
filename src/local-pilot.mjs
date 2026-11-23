import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const runs = join(root, 'runs');
export const runtime = join(runs, 'local-runtime');
export const python = join(runtime, 'venv', 'Scripts', 'python.exe');
const gpuPython = join(runtime, 'python', 'cpython-3.12-windows-x86_64-none', 'python.exe');
const hub = join(runtime, 'huggingface', 'hub');
const maxAllocation = 40 * 3600;
const maxQueueAllocation = 4 * 3600;
const releaseReserveSeconds = 31;
const recoverableTelemetryStops = new Set([
  'GPU telemetry did not become valid. No worker was started.',
  'GPU telemetry stopped producing samples.',
]);
const maxTelemetryRetries = 32;
const handoff = join(runtime, 'gpu-handoff.request');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export const readProjectJson = path => json(join(root, path));

export async function atomicWrite(path, body) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, body, 'utf8');
  for (let retry = 0; ; retry++) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      // Another Windows process can briefly hold the destination without delete sharing.
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || retry >= 6) throw error;
      await delay(50 * 2 ** retry);
    }
  }
}

export function atomicJson(path, value) {
  return atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function processDone(file, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export async function runCommand(file, args, env = process.env) {
  const { code, signal } = await processDone(file, args, env);
  if (code !== 0) throw new Error(`Command ${file} exited with ${code ?? signal}.`);
}

function workspaceSnapshot(model) {
  return join(hub, `models--${model.checkpoint.replace('/', '--')}`, 'snapshots', model.revision);
}

export async function stage(model, { offlineOnly = false } = {}) {
  const snapshot = workspaceSnapshot(model);
  const marker = join(snapshot, 'local-stage.json');
  if (offlineOnly) {
    if (!existsSync(marker)) throw new Error(`The pinned offline snapshot for ${model.id} is missing.`);
    const pinned = await json(marker);
    if (pinned.checkpoint !== model.checkpoint || pinned.revision !== model.revision) {
      throw new Error(`The offline snapshot marker for ${model.id} does not match the pinned revision.`);
    }
    return snapshot;
  }
  if (existsSync(marker)) return snapshot;
  const env = { ...process.env, HF_HOME: dirname(hub), HF_HUB_CACHE: hub,
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_XET: '1' };
  for (const name of ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN']) delete env[name];
  await runCommand(python, ['-B', join(root, 'local', 'stage-checkpoint.py'), model.checkpoint, model.revision, hub], env);
  await atomicJson(marker, { checkpoint: model.checkpoint, revision: model.revision });
  return snapshot;
}

export class GpuBudgetStop extends Error {
  constructor(message, { queue, availableSeconds, receipt } = {}) {
    super(message);
    this.name = 'GpuBudgetStop';
    this.queue = queue;
    this.availableSeconds = availableSeconds;
    this.receipt = receipt;
  }
}

function validUsage(usage) {
  return Number.isFinite(usage?.allocatedSeconds) && usage.allocatedSeconds >= 0 && typeof usage.released === 'boolean';
}

function deadlineReceipt() {
  return { status: 'deadline', stopReason: 'wait-deadline', allocatedSeconds: 0, released: true, waitMs: null, attempts: [] };
}

function pinnedJob({ model, role, smoke = false, deadlineAtMs }) {
  return { modelId: model.id, checkpoint: model.checkpoint, revision: model.revision, role, smoke,
    deadlineAtMs: deadlineAtMs ?? null };
}

export class LocalPilot {
  constructor(directory, { queueRoot, offlineOnly = false } = {}) {
    this.directory = directory;
    this.ledger = join(directory, 'desktop-gpu-ledger.json');
    this.queueRoot = queueRoot ?? join(directory, 'calibration-queues');
    this.reusableQueues = queueRoot !== undefined;
    this.offlineOnly = offlineOnly;
    this.terminals = [];
  }

  async init() {
    if (!existsSync(python) || !existsSync(gpuPython)) throw new Error('The workspace CUDA inference runtime is unavailable.');
    await mkdir(this.directory, { recursive: true });
    if (existsSync(this.ledger)) this.terminals = await json(this.ledger);
    if (!Array.isArray(this.terminals) || this.terminals.some(usage => !validUsage(usage))) {
      throw new Error('Invalid project GPU accounting ledger.');
    }
  }

  get allocatedSeconds() {
    return this.terminals.reduce((total, run) => total + run.allocatedSeconds, 0);
  }

  get remainingGpuSeconds() {
    return Math.max(0, maxAllocation - this.allocatedSeconds);
  }

  queuePaths(requestId, { retryMemoryGuard = false, retryTelemetry = false } = {}) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) throw new Error('Invalid GPU request ID.');
    const retries = retryTelemetry === true ? 1 : retryTelemetry === false ? 0 : retryTelemetry;
    if (retryTelemetry !== false && (!Number.isSafeInteger(retries) || retries < 1 || retries > maxTelemetryRetries)) {
      throw new Error(`Select a telemetry retry number from 1 to ${maxTelemetryRetries}.`);
    }
    if (retryMemoryGuard && retryTelemetry) throw new Error('Select one recovery for the GPU request.');
    if ((retryMemoryGuard || retryTelemetry) && !this.reusableQueues) throw new Error('GPU recovery requires resumable queues.');
    const original = join(this.queueRoot, requestId);
    if (retryMemoryGuard) return [original, `${original}-oom-retry-1`];
    return [original, ...Array.from({ length: retries }, (_, index) => `${original}-telemetry-retry-${index + 1}`)];
  }

  queuePath(requestId, options) {
    return this.queuePaths(requestId, options).at(-1);
  }

  async recordUsage({ queue, model, role, started, usage }) {
    if (!validUsage(usage)) throw new Error('Invalid GPU accounting receipt.');
    const entry = { ...usage, queue, modelId: model.id, role, started, finished: Date.now() };
    const updated = [...this.terminals, entry];
    await atomicJson(this.ledger, updated);
    this.terminals = updated;
    return entry;
  }

  queueOutcome(usage, queue, code = 0, signal = null) {
    if (usage.released !== true) {
      throw new Error(`GPU watchdog release verification failed for ${queue}.`);
    }
    if (usage.status === 'budget') {
      throw new GpuBudgetStop('The GPU allowance for this queue was reached. Published responses were retained.',
        { queue, availableSeconds: this.remainingGpuSeconds, receipt: usage });
    }
    if (code !== 0 || !['complete', 'deadline'].includes(usage.status)) {
      throw new Error(`GPU watchdog stopped for ${queue} (exit ${code ?? signal}): ${usage.error ?? usage.status}.`);
    }
    return usage;
  }

  async runQueue({ model, role, queue, maxGpuSeconds = maxQueueAllocation, smoke = false, deadlineAtMs, resume = false }) {
    if (!Number.isFinite(maxGpuSeconds) || maxGpuSeconds < 0) throw new Error('Invalid queue GPU allowance.');
    if (deadlineAtMs !== undefined && (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0)) {
      throw new Error('A queue deadline must be an absolute timestamp in milliseconds.');
    }
    if (this.offlineOnly && this.terminals.some(usage => !usage.released)) {
      throw new Error('The project contains an allocation without verified GPU release.');
    }
    const receipt = join(queue, 'gpu-usage.json');
    const dispatchPath = join(queue, 'gpu-dispatch.json');
    const job = pinnedJob({ model, role, smoke, deadlineAtMs });
    if (resume && existsSync(dispatchPath)) {
      const dispatch = await json(dispatchPath);
      if (!isDeepStrictEqual(dispatch.job, job) || typeof dispatch.id !== 'string' || !Number.isSafeInteger(dispatch.started)) {
        throw new Error(`Saved GPU dispatch does not match this queue's pinned job: ${queue}.`);
      }
      if (!existsSync(receipt)) throw new Error(`Unaccounted GPU dispatch for ${queue}. Check the watchdog and recover its receipt before resuming.`);
      const usage = await json(receipt);
      if (usage.dispatchId !== dispatch.id) throw new Error(`GPU receipt does not match the saved dispatch for ${queue}.`);
      const settled = this.terminals.find(row => row.dispatchId === dispatch.id);
      if (settled && (settled.queue !== queue || settled.allocatedSeconds !== usage.allocatedSeconds || settled.released !== usage.released
        || settled.status !== usage.status)) throw new Error(`GPU receipt disagrees with settled accounting for ${queue}.`);
      if (!settled) await this.recordUsage({ queue, model, role, started: dispatch.started, usage });
      return this.queueOutcome({ ...usage, queueAdmittedAtMs: dispatch.started }, queue);
    }
    if (resume && (existsSync(receipt) || existsSync(join(queue, 'gpu-watch.jsonl')) || this.terminals.some(row => row.queue === queue))) {
      throw new Error(`GPU activity exists without a resumable dispatch record for ${queue}.`);
    }
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) return deadlineReceipt();
    const allowance = Math.floor(Math.min(this.remainingGpuSeconds, maxGpuSeconds, maxQueueAllocation));
    if (allowance <= releaseReserveSeconds) {
      throw new GpuBudgetStop('The remaining GPU allowance is reserved for verified release.', { queue, availableSeconds: allowance });
    }
    const snapshot = await stage(model, { offlineOnly: this.offlineOnly });
    const peak = Math.ceil(model.nominalParametersB * 2e9 / 2 ** 20 + 1750);
    const started = Date.now();
    if (deadlineAtMs !== undefined && started >= deadlineAtMs) return deadlineReceipt();
    const dispatchId = resume ? randomUUID() : null;
    if (dispatchId) await atomicJson(dispatchPath, { id: dispatchId, started, job });
    const { code, signal } = await processDone('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(root, 'local', 'run-queue.ps1'),
      '-Python', gpuPython, '-Queue', queue, '-Snapshot', snapshot, '-Checkpoint', model.checkpoint, '-Revision', model.revision,
      '-Role', role, '-Loader', model.loader, '-PlannedPeakMiB', String(peak), '-HandoffFile', handoff,
      '-MaxGpuSeconds', String(allowance), ...(deadlineAtMs === undefined ? [] : ['-DeadlineAtMs', String(deadlineAtMs)]),
      ...(dispatchId ? ['-DispatchId', dispatchId] : []), ...(smoke ? ['-Smoke'] : [])]);
    if (!existsSync(receipt) || (!dispatchId && (await stat(receipt)).mtimeMs < started)) {
      throw new Error(`No current GPU watchdog receipt for ${model.id} (exit ${code ?? signal}).`);
    }
    const usage = await json(receipt);
    if (dispatchId && usage.dispatchId !== dispatchId) throw new Error(`GPU receipt does not match the current dispatch for ${queue}.`);
    await this.recordUsage({ queue, model, role, started, usage });
    return this.queueOutcome({ ...usage, queueAdmittedAtMs: started }, queue, code, signal);
  }

  async checkStoppedDispatch({ model, request, role, deadlineAtMs }, invalidMessage, queue = this.queuePath(request.id)) {
    const [original, dispatch, receipt] = await Promise.all([
      json(join(queue, 'gpu-request.json')), json(join(queue, 'gpu-dispatch.json')), json(join(queue, 'gpu-usage.json')),
    ]);
    const rows = this.terminals.filter(row => row.dispatchId === dispatch.id);
    if (!isDeepStrictEqual(original, JSON.parse(JSON.stringify(request))) || !isDeepStrictEqual(dispatch.job, pinnedJob({ model, role, deadlineAtMs }))
      || typeof dispatch.id !== 'string' || !Number.isSafeInteger(dispatch.started) || receipt.dispatchId !== dispatch.id
      || !validUsage(receipt) || !receipt.released || receipt.status !== 'stopped' || rows.length !== 1) {
      throw new Error(invalidMessage);
    }
    const { queue: settledQueue, modelId, role: settledRole, started, finished, ...settledUsage } = rows[0];
    if (settledQueue !== queue || modelId !== model.id || settledRole !== role || started !== dispatch.started
      || !Number.isSafeInteger(finished) || !isDeepStrictEqual(settledUsage, receipt)) {
      throw new Error(`The settled GPU accounting does not match the original queue for ${request.id}.`);
    }
    return { queue, original, receipt };
  }

  async checkMemoryRetry(args) {
    const { model, request, role } = args;
    const invalidMessage = `Memory retry requires an identical request and a settled, verified OOM reply for ${request.id}.`;
    const { queue, receipt } = await this.checkStoppedDispatch(args, invalidMessage);
    const reply = await json(join(queue, 'outbox', `${request.id}.json`));
    if (reply.id !== request.id || reply.role !== role || reply.checkpoint !== model.checkpoint || reply.revision !== model.revision
      || reply.status !== 'error' || reply.error_type !== 'OutOfMemoryError') throw new Error(invalidMessage);
    return { memory_guard_retried: true, prior_memory_guard_allocated_seconds: receipt.allocatedSeconds,
      prior_memory_guard_execution_seconds: Number.isFinite(reply.active_seconds) && reply.active_seconds >= 0 ? reply.active_seconds : null };
  }

  async checkTelemetryRetry(args, options = { retryTelemetry: true }) {
    const { request } = args;
    const invalidMessage = `Telemetry retry requires an identical pending request and a settled, verified telemetry stop for ${request.id}.`;
    const previousQueues = this.queuePaths(request.id, options).slice(0, -1);
    const filename = `${request.id}.json`;
    let priorSeconds = 0;
    let interrupted = false;
    for (const queue of previousQueues) {
      const { original, receipt } = await this.checkStoppedDispatch(args, invalidMessage, queue);
      if (existsSync(join(queue, 'outbox', filename))) throw new Error(`The stopped GPU queue already published a reply for ${request.id}.`);
      const pending = ['inbox', 'inflight'].map(folder => join(queue, folder, filename)).filter(existsSync);
      if (!recoverableTelemetryStops.has(receipt.error) || !Array.isArray(receipt.attempts)
        || receipt.attempts.some(attempt => attempt?.verified !== true) || pending.length !== 1
        || !isDeepStrictEqual(await json(pending[0]), original)) throw new Error(invalidMessage);
      priorSeconds += receipt.allocatedSeconds;
      interrupted ||= receipt.attempts.some(attempt => attempt.startedWork && attempt.yieldReason);
    }
    return { telemetry_retried: true, telemetry_retry_number: previousQueues.length, prior_telemetry_allocated_seconds: priorSeconds,
      interrupted_execution_unavailable: interrupted };
  }

  async invoke({ model, request, role, deadlineAtMs, maxGpuSeconds, retryMemoryGuard = false, retryTelemetry = false }) {
    const queue = this.queuePath(request.id, { retryMemoryGuard, retryTelemetry });
    const args = { model, request, role, deadlineAtMs };
    let recovery = {};
    if (retryMemoryGuard) recovery = await this.checkMemoryRetry(args);
    if (retryTelemetry) recovery = await this.checkTelemetryRetry(args, { retryTelemetry });
    const inbox = join(queue, 'inbox', `${request.id}.json`);
    const inflight = join(queue, 'inflight', `${request.id}.json`);
    const outbox = join(queue, 'outbox', `${request.id}.json`);
    const dispatch = join(queue, 'gpu-dispatch.json');
    await mkdir(join(queue, 'inbox'), { recursive: true });
    if (this.reusableQueues) {
      const savedRequest = JSON.parse(JSON.stringify(request));
      const journal = join(queue, 'gpu-request.json');
      if (existsSync(journal)) {
        if (!isDeepStrictEqual(await json(journal), savedRequest)) throw new Error(`Saved GPU request differs for ${request.id}.`);
      } else {
        if ([inbox, inflight, outbox, dispatch].some(existsSync)) {
          throw new Error(`GPU request journal is missing for ${request.id}.`);
        }
        await atomicJson(journal, savedRequest);
      }
      for (const pending of [inbox, inflight]) {
        if (existsSync(pending) && !isDeepStrictEqual(await json(pending), savedRequest)) {
          throw new Error(`Pending GPU request differs for ${request.id}.`);
        }
      }
      if (!existsSync(dispatch)) {
        if ([inflight, outbox].some(existsSync)) throw new Error(`GPU processing exists without a dispatch record for ${request.id}.`);
        if (!existsSync(inbox)) await atomicJson(inbox, savedRequest);
      }
    } else {
      await atomicJson(inbox, request);
    }
    const seal = join(queue, 'sealed.json');
    if (!existsSync(seal)) await atomicJson(seal, { requests: 1 });
    const usage = await this.runQueue({ model, role, queue, deadlineAtMs, maxGpuSeconds, resume: this.reusableQueues });
    const watchdog = {
      ...recovery,
      watchdog_hold_ms: usage.waitMs ?? null,
      watchdog_status: usage.status,
      watchdog_allocated_seconds: usage.allocatedSeconds,
      queue_admitted_at_ms: usage.queueAdmittedAtMs ?? null,
      interrupted_execution_unavailable: Boolean(recovery.interrupted_execution_unavailable
        || usage.attempts?.some(attempt => attempt.startedWork && attempt.yieldReason)),
    };
    if (!existsSync(outbox) && usage.status === 'deadline') {
      return { id: request.id, checkpoint: model.checkpoint, revision: model.revision, role, status: 'error', error: 'deadline',
        active_seconds: 0, outbox_published_at_ms: null, ...watchdog };
    }
    const response = await json(outbox);
    if (response.error_type === 'OutOfMemoryError') throw new Error(`CUDA memory limit reached for ${request.id}. The original reply and usage were retained.`);
    return { ...response, watchdog_hold_ms: usage.waitMs ?? null,
      ...(this.reusableQueues && { ...watchdog, outbox_published_at_ms: (await stat(outbox)).mtimeMs }),
      load_seconds: (Date.parse(response.ready_at) - Date.parse(response.started_at)) / 1000 };
  }
}
