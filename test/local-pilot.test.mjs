import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { atomicJson, GpuBudgetStop, LocalPilot } from '../src/local-pilot.mjs';

const model = { id: 'test-model', checkpoint: 'fixtures/model', revision: 'a'.repeat(40) };
const request = { id: 'fixture-1', prompt: 'Write one word.', seed: 11, max_output_tokens: 10, draft_tokens: 0 };
const role = 'worker';

async function fixture(t) {
  const parent = await realpath(fileURLToPath(new URL('./', import.meta.url)));
  const directory = await mkdtemp(join(parent, '.local-pilot-test-'));
  t.after(async () => {
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), parent);
    assert.equal(resolved, directory);
    await rm(resolved, { recursive: true });
  });
  const queueRoot = join(directory, 'queues');
  const queue = join(queueRoot, request.id);
  const controller = new LocalPilot(directory, { queueRoot, offlineOnly: true });
  return { queue, controller };
}

async function saveDispatch(queue, deadlineAtMs, receipt, id = 'saved-dispatch') {
  await mkdir(queue, { recursive: true });
  const dispatch = {
    id, started: Date.now() - 2000,
    job: { modelId: model.id, checkpoint: model.checkpoint, revision: model.revision, role, smoke: false, deadlineAtMs },
  };
  await atomicJson(join(queue, 'gpu-request.json'), request);
  await atomicJson(join(queue, 'gpu-dispatch.json'), dispatch);
  if (receipt) await atomicJson(join(queue, 'gpu-usage.json'), { ...receipt, dispatchId: dispatch.id });
  return dispatch;
}

test('an expired deadline journals the exact request and launches no GPU work', async t => {
  const { queue, controller } = await fixture(t);
  const deadlineAtMs = Date.now() - 1;
  const response = await controller.invoke({ model, request, role, deadlineAtMs });
  assert.equal(response.error, 'deadline');
  assert.equal(response.active_seconds, 0);
  assert.equal(response.queue_admitted_at_ms, null);
  assert.equal(controller.allocatedSeconds, 0);
  assert.equal(existsSync(join(queue, 'gpu-dispatch.json')), false);
  assert.deepEqual(await controller.invoke({ model, request, role, deadlineAtMs }), response);
  await assert.rejects(controller.invoke({ model, request: { ...request, prompt: 'Changed.' }, role, deadlineAtMs }), /request differs/);
});

test('resume adopts a saved receipt once and returns the original published result', async t => {
  const { queue, controller } = await fixture(t);
  const deadlineAtMs = Date.now() - 1;
  const dispatch = await saveDispatch(queue, deadlineAtMs, {
    status: 'deadline', allocatedSeconds: 32, released: true, waitMs: 10,
    attempts: [{ startedWork: true, yieldReason: 'wait-deadline' }],
  });
  await mkdir(join(queue, 'outbox'));
  await atomicJson(join(queue, 'outbox', `${request.id}.json`), {
    id: request.id, status: 'ok', text: 'READY', checkpoint: model.checkpoint, revision: model.revision,
    ready_at: new Date().toISOString(), started_at: new Date().toISOString(),
  });
  const response = await controller.invoke({ model, request, role, deadlineAtMs });
  assert.equal(response.text, 'READY');
  assert.equal(response.watchdog_status, 'deadline');
  assert.equal(response.queue_admitted_at_ms, dispatch.started);
  assert.ok(Number.isFinite(response.outbox_published_at_ms));
  assert.ok(response.interrupted_execution_unavailable);
  assert.deepEqual(await controller.invoke({ model, request, role, deadlineAtMs }), response);
  const ledger = JSON.parse(await readFile(controller.ledger));
  assert.equal(ledger.length, 1);
  assert.equal(controller.remainingGpuSeconds, 40 * 3600 - 32);
});

test('unaccounted dispatches fail closed and a zero budget starts no watchdog', async t => {
  const { queue, controller } = await fixture(t);
  await saveDispatch(queue, null);
  await assert.rejects(controller.invoke({ model, request, role }), /Unaccounted GPU dispatch/);
  await assert.rejects(controller.runQueue({ queue: join(queue, 'next'), model, role, maxGpuSeconds: 31, resume: true }), GpuBudgetStop);
  assert.equal(existsSync(controller.ledger), false);
});

test('a verified budget stop is charged exactly once and can be distinguished from infrastructure failure', async t => {
  const { queue, controller } = await fixture(t);
  await saveDispatch(queue, null, { status: 'budget', allocatedSeconds: 30, released: true });
  for (let read = 0; read < 2; read += 1) {
    await assert.rejects(controller.invoke({ model, request, role }), error =>
      error instanceof GpuBudgetStop && error.receipt.allocatedSeconds === 30 && error.queue === queue);
  }
  assert.equal(controller.allocatedSeconds, 30);
});

test('an authorized exact memory retry keeps the original charge and reuses its own distinct receipt', async t => {
  const { queue, controller } = await fixture(t);
  const original = { status: 'stopped', allocatedSeconds: 30, released: true, error: 'Worker exited with code 1.' };
  await saveDispatch(queue, null, original);
  await mkdir(join(queue, 'outbox'));
  const failed = { id: request.id, checkpoint: model.checkpoint, revision: model.revision, role, status: 'error',
    error_type: 'OutOfMemoryError', active_seconds: 0.5 };
  const failedPath = join(queue, 'outbox', `${request.id}.json`);
  await atomicJson(failedPath, failed);
  const retry = controller.queuePath(request.id, { retryMemoryGuard: true });
  const invoke = controller.invoke.bind(controller);
  await assert.rejects(invoke({ model, request, role, retryMemoryGuard: true }), /settled, verified OOM/);
  assert.equal(existsSync(retry), false);
  await assert.rejects(controller.runQueue({ model, role, queue, resume: true }), /Worker exited with code 1/);
  await assert.rejects(invoke({ model, request: { ...request, seed: 20 }, role, retryMemoryGuard: true }), /identical request/);
  assert.equal(existsSync(retry), false);
  await saveDispatch(retry, null, { status: 'complete', allocatedSeconds: 42, released: true }, 'memory-retry');
  await mkdir(join(retry, 'outbox'));
  await atomicJson(join(retry, 'outbox', `${request.id}.json`), {
    id: request.id, status: 'ok', text: 'READY', checkpoint: model.checkpoint, revision: model.revision,
    ready_at: new Date().toISOString(), started_at: new Date().toISOString(),
  });
  const response = await invoke({ model, request, role, retryMemoryGuard: true });
  assert.equal(response.text, 'READY');
  assert.equal(response.memory_guard_retried, true);
  assert.equal(response.prior_memory_guard_allocated_seconds, 30);
  assert.equal(response.prior_memory_guard_execution_seconds, 0.5);
  assert.equal(response.watchdog_allocated_seconds, 42);
  assert.equal(controller.allocatedSeconds, 72);
  assert.deepEqual(await invoke({ model, request, role, retryMemoryGuard: true }), response);
  assert.deepEqual(JSON.parse(await readFile(failedPath)), failed);
  assert.equal(JSON.parse(await readFile(controller.ledger)).length, 2);
});

test('a second telemetry retry verifies both settled stops and adds their charges', async t => {
  const { queue, controller } = await fixture(t);
  const args = { request, model, role, retryTelemetry: 2 };
  const [original, first, second] = controller.queuePaths(request.id, args);
  assert.equal(original, queue);
  assert.equal(first, controller.queuePath(request.id, { retryTelemetry: true }));
  assert.equal(second, `${queue}-telemetry-retry-2`);
  for (const retryTelemetry of [0, -1, 1.5, 33, '2']) {
    assert.throws(() => controller.queuePath(request.id, { retryTelemetry }), /retry number/);
  }
  const stopped = { status: 'stopped', allocatedSeconds: 24, released: true, attempts: [] };
  await saveDispatch(original, null, { ...stopped, error: 'GPU telemetry did not become valid. No worker was started.' });
  await mkdir(join(original, 'inbox'));
  await atomicJson(join(original, 'inbox', `${request.id}.json`), request);
  await assert.rejects(controller.runQueue({ model, role, queue: original, resume: true }), /GPU telemetry did not become valid/);
  await assert.rejects(controller.invoke(args), { code: 'ENOENT' });
  assert.equal(existsSync(second), false);

  const error = 'GPU telemetry stopped producing samples.';
  await saveDispatch(first, null, { ...stopped, allocatedSeconds: 31, error,
    attempts: [{ verified: true, startedWork: true, yieldReason: 'telemetry-unavailable' }] }, 'first-retry');
  await mkdir(join(first, 'inflight'));
  await atomicJson(join(first, 'inflight', `${request.id}.json`), request);
  await assert.rejects(controller.runQueue({ model, role, queue: first, resume: true }), /stopped producing samples/);
  await saveDispatch(second, null, { status: 'complete', allocatedSeconds: 42, released: true }, 'second-retry');
  await mkdir(join(second, 'outbox'));
  await atomicJson(join(second, 'outbox', `${request.id}.json`), {
    id: request.id, status: 'ok', text: 'READY', checkpoint: model.checkpoint, revision: model.revision,
    ready_at: new Date().toISOString(), started_at: new Date().toISOString(),
  });
  const response = await controller.invoke(args);
  assert.equal(response.telemetry_retry_number, 2);
  assert.equal(response.prior_telemetry_allocated_seconds, 55);
  assert.equal(response.interrupted_execution_unavailable, true);
  assert.equal(response.watchdog_allocated_seconds, 42);
  assert.deepEqual(await controller.invoke(args), response);
  assert.equal(controller.allocatedSeconds, 97);
  assert.equal(JSON.parse(await readFile(controller.ledger)).length, 3);
});

test('a verified telemetry retry preserves the pending request and charges each queue once', async t => {
  const { queue, controller } = await fixture(t);
  const original = { status: 'stopped', allocatedSeconds: 31, released: true,
    error: 'GPU telemetry did not become valid. No worker was started.',
    attempts: [{ verified: true, startedWork: true, yieldReason: 'telemetry-unavailable' }] };
  await saveDispatch(queue, null, original);
  await mkdir(join(queue, 'inbox'));
  const pendingPath = join(queue, 'inbox', `${request.id}.json`);
  await atomicJson(pendingPath, request);
  const retry = controller.queuePath(request.id, { retryTelemetry: true });
  const args = { model, request, role, retryTelemetry: true };
  await assert.rejects(controller.invoke(args), /settled, verified telemetry stop/);
  await assert.rejects(controller.runQueue({ model, role, queue, resume: true }), /GPU telemetry did not become valid/);
  await assert.rejects(controller.invoke({ ...args, request: { ...request, seed: 12 } }), /identical pending request/);
  await mkdir(join(queue, 'outbox'));
  const reply = { id: request.id, status: 'ok', text: 'READY', checkpoint: model.checkpoint, revision: model.revision,
    ready_at: new Date().toISOString(), started_at: new Date().toISOString() };
  const outbox = join(queue, 'outbox', `${request.id}.json`);
  await atomicJson(outbox, reply);
  await assert.rejects(controller.invoke(args), /already published a reply/);
  assert.equal(existsSync(retry), false);
  await rm(outbox);
  await saveDispatch(retry, null, { status: 'complete', allocatedSeconds: 42, released: true }, 'telemetry-retry');
  await mkdir(join(retry, 'outbox'));
  await atomicJson(join(retry, 'outbox', `${request.id}.json`), reply);
  const response = await controller.invoke(args);
  assert.equal(response.telemetry_retried, true);
  assert.equal(response.prior_telemetry_allocated_seconds, 31);
  assert.equal(response.interrupted_execution_unavailable, true);
  assert.equal(response.watchdog_allocated_seconds, 42);
  assert.deepEqual(await controller.invoke(args), response);
  assert.deepEqual(JSON.parse(await readFile(pendingPath)), request);
  assert.equal(controller.allocatedSeconds, 73);
  assert.equal(JSON.parse(await readFile(controller.ledger)).length, 2);
});
