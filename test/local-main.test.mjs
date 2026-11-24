import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makePolicy } from '../scripts/calibrate-local.mjs';
import { executeCell } from '../scripts/run-local-main.mjs';
import { GpuBudgetStop } from '../src/local-pilot.mjs';
import { skills } from '../src/pilot.mjs';

const model = { id: 'qwen-top', family: 'qwen', tier: 'top', checkpoint: 'fixture/qwen', revision: 'revision' };
const judge = { id: 'neutral', family: 'neutral', neutral: true };
const priceList = skills.map(skill => ({ skill, draft: 0, worker: model.id, qualityExcludingOwnFamily: 1, meanGpuSeconds: 2 }));
const policy = makePolicy({ workers: [model], judges: [judge] }, priceList, ['qwen']);
const pack = { id: 'main-01', split: 'main', topic: 'Fixture', task: 'Report 10.', unit: '1', tolerance: 0.01,
  primary: { parameters: { value: 10 }, reference: 10 }, secondary: { parameters: { value: 20 }, reference: 20 }, picture_checklist: [] };
const limits = { executionSeconds: 5, deadlineSeconds: 10, maxCallsPerFamily: 1, quotaWindowSeconds: 60, slotDelaySeconds: 0.001 };

async function fixture(t, condition, style = 'solo-best') {
  const parent = await realpath(fileURLToPath(new URL('./', import.meta.url)));
  const traceDirectory = await mkdtemp(join(parent, '.main-fixture-'));
  t.after(async () => {
    const resolved = await realpath(traceDirectory);
    assert.equal(resolved, traceDirectory);
    assert.equal(dirname(resolved), parent);
    await rm(resolved, { recursive: true });
  });
  const cell = { id: [pack.id, style, condition].join('--'), packId: pack.id, style, condition };
  const sent = [];
  const controller = {
    queueRoot: join(traceDirectory, 'queues'), terminals: [], remainingGpuSeconds: 1000,
    async invoke(call) {
      sent.push(call);
      this.terminals.push({ queue: join(this.queueRoot, call.request.id), allocatedSeconds: 8 });
      const text = call.request.prompt.startsWith('Plan the four skills')
        ? JSON.stringify({ assignments: Object.fromEntries(skills.map(skill => [skill, 'qwen-top-d0'])) })
        : call.request.prompt.startsWith('Review the anonymous')
          ? JSON.stringify({ revisions: {} })
          : JSON.stringify({ article: 'Fixture {{result:10}}' });
      return { id: call.request.id, checkpoint: model.checkpoint, revision: model.revision, status: 'ok', text,
        active_seconds: 5, outbox_published_at_ms: Date.now() };
    },
  };
  const options = { cell, pack, policy, controller, limits, panelReserve: 37, traceDirectory, resumed: false };
  return { options, sent, controller };
}

test('execution cap only dispatches admissible work and replays saved exchanges without spending', async t => {
  const { options, sent } = await fixture(t, 'compute-cap');
  const trace = await executeCell(options);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].request.max_execution_seconds, 5);
  assert.equal(sent[0].maxGpuSeconds, 963);
  assert.equal(trace.allocatedSeconds, 8);
  assert.equal(trace.activeSeconds, 5);
  assert.deepEqual(trace.calls.map(call => call.telemetry.error_type), [undefined, 'execution_cap', 'execution_cap', 'execution_cap']);
  const resumed = await executeCell({ ...options, resumed: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(resumed.records, trace.records);
  assert.equal(resumed.allocatedSeconds, 8);
});

test('quota limits accepted calls by family and exposes the rolling window to the manager', async t => {
  const { options, sent } = await fixture(t, 'call-quota', 'manager-and-workers');
  const trace = await executeCell(options);
  assert.equal(sent.length, 1);
  assert.match(sent[0].request.prompt, /Seconds until next call is allowed, by family = \{"qwen":0\}/);
  assert.equal(trace.calls.filter(call => call.telemetry.error_type === 'call_quota').length, 5);
  assert.ok(trace.calls[1].telemetry.retry_after_ms > 0);
  const review = trace.records.at(-1).prompt;
  assert.match(review, /\{"revisions":\{"simulation":"qwen-top-d0"\}\}/);
  assert.match(review, /"qwen":[1-9]/);
});

test('queue contention keeps the execution limit and records its separate wait', async t => {
  const { options, sent } = await fixture(t, 'one-gpu-slot');
  const trace = await executeCell(options);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].request.max_execution_seconds, 5);
  assert.equal(trace.calls[0].telemetry.imposed_wait_ms, 1);
});

test('responses arriving after the cell deadline cannot supply scored artifacts', async t => {
  const { options, controller } = await fixture(t, 'deadline');
  const realInvoke = controller.invoke;
  controller.invoke = async function(call) {
    return { ...await realInvoke.call(this, call), outbox_published_at_ms: call.deadlineAtMs + 1 };
  };
  const trace = await executeCell(options);
  assert.equal(trace.status, 'complete');
  assert.equal(Object.keys(trace.parts).length, 0);
  assert.ok(trace.calls.every(call => call.telemetry.error_type === 'deadline'));
});

test('a safe project budget stop records a partial cell and stops further dispatch', async t => {
  const { options, sent, controller } = await fixture(t, 'unlimited');
  const realInvoke = controller.invoke;
  controller.invoke = async function(call) {
    if (sent.length) throw new GpuBudgetStop('fixture budget');
    return realInvoke.call(this, call);
  };
  const trace = await executeCell(options);
  assert.equal(trace.status, 'budget-truncated');
  assert.equal(sent.length, 1);
  assert.equal(trace.allocatedSeconds, 8);
  assert.deepEqual(trace.calls.map(call => call.telemetry.error_type), [undefined, 'project_budget', 'project_budget', 'project_budget']);
  const started = JSON.parse(await readFile(join(options.traceDirectory, options.cell.id, 'started.json'), 'utf8'));
  assert.equal(trace.startedAt, new Date(started.startedAtMs).toISOString());
});

test('the repair uses the remaining cell allowance and replays through the same journal', async t => {
  const { options, sent, controller } = await fixture(t, 'compute-cap');
  options.limits = { ...limits, executionSeconds: 5 };
  const dispatch = controller.invoke;
  controller.invoke = async function(call) {
    const reply = await dispatch.call(this, call);
    const repair = call.request.prompt.includes('Validation feedback:');
    const text = call.request.prompt.startsWith('Produce the simulation')
      ? JSON.stringify({ simulation: { locals: [], body: [], result: repair ? 'value' : 0 } })
      : reply.text;
    return { ...reply, active_seconds: 1, text };
  };
  const first = await executeCell(options);
  assert.equal(sent.length, 5);
  assert.equal(first.calls.at(-1).label, 'simulation/2');
  assert.equal(sent.at(-1).request.max_execution_seconds, 1);
  assert.equal(first.activeSeconds, 5);
  assert.equal(first.result.checks.simulation_secondary, true);
  const replay = await executeCell({ ...options, resumed: true });
  assert.equal(sent.length, 5);
  assert.deepEqual(replay.records, first.records);
  assert.deepEqual(replay.decisions, first.decisions);
  assert.deepEqual(replay.result.checks, first.result.checks);
});

test('an exhausted cell records the refused simulation repair without dispatch', async t => {
  const { options, sent, controller } = await fixture(t, 'compute-cap');
  options.limits = { ...limits, executionSeconds: 4 };
  const dispatch = controller.invoke;
  controller.invoke = async function(call) {
    const reply = await dispatch.call(this, call);
    return { ...reply, active_seconds: 1 };
  };
  const trace = await executeCell(options);
  assert.equal(sent.length, 4);
  assert.equal(trace.calls.at(-1).label, 'simulation/2');
  assert.equal(trace.calls.at(-1).telemetry.error_type, 'execution_cap');
  assert.equal(trace.activeSeconds, 4);
});
