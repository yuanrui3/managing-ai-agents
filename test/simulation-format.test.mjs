import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseSkillResponse, skillPrompt } from '../src/pilot.mjs';
import { legacySimulationFormat, runSimulation, simulationFormat } from '../src/sandbox.mjs';

const requireInput = { requireInput: true };
const empty = result => ({ locals: [], body: [], result });

test('the historical simulation format remains frozen', () => {
  assert.equal(createHash('sha256').update(legacySimulationFormat).digest('hex'),
    '7656b8832811c7d027b9546ea73943406c00f1af0ba6237df74e8528b8e5732d');
});

test('the worked example extracted from the simulation prompt executes on changed inputs', async () => {
  const pack = { topic: 'Toy arithmetic', task: 'Compute gain*x+bias.', unit: '1', tolerance: 1e-9,
    primary: { parameters: { x: 2, gain: 3, bias: 1 } } };
  const prompt = skillPrompt(pack, 'simulation');
  assert.ok(prompt.includes(simulationFormat));
  const match = /Complete example reply for a direct calculation:\n(\{[^\n]+\})\n/.exec(prompt);
  assert.ok(match, 'The prompt must include a complete executable JSON example.');
  const program = parseSkillResponse(match[1], 'simulation');
  assert.equal((await runSimulation(program, pack.primary.parameters, requireInput)).value, 7);
  assert.equal((await runSimulation(program, { x: 4, gain: 3, bias: 1 }, requireInput)).value, 13);
  const loop = parseSkillResponse(/Loop example for accumulating amount over count steps: (\{[^\n]+\})/.exec(prompt)[1], 'simulation');
  assert.equal((await runSimulation(loop, { count: 3, amount: 7 }, requireInput)).value, 21);
});

test('input qualification rejects fixed results while preserving historical constant execution', async () => {
  assert.equal((await runSimulation(empty(0), { x: 3 })).value, 0);
  await assert.rejects(runSimulation(empty(0), { x: 3 }, requireInput), /fixed numeric result/);
  await assert.rejects(runSimulation(empty(['+', 1, 2]), { x: 3 }, requireInput), /read a named input/);
  await assert.rejects(runSimulation({ locals: ['unused'], body: [['set', 'unused', 'x']], result: 7 },
    { x: 3 }, requireInput), /fixed numeric result/);
  await assert.rejects(runSimulation({ locals: ['uninitialized'], body: [], result: 'uninitialized' },
    { x: 3 }, requireInput), /read a named input/);
});

test('input qualification accepts empty bodies and valid zero results', async () => {
  assert.equal((await runSimulation(empty(['*', 'x', 2]), { x: 3 }, requireInput)).value, 6);
  assert.equal((await runSimulation(empty('x'), { x: 0 }, requireInput)).value, 0);
  assert.equal((await runSimulation(empty(['-', 'x', 'x']), { x: 3 }, requireInput)).value, 0);
});

test('a bounded loop reads inputs and advances its counter using supported statements', async () => {
  const program = { locals: ['i', 'sum'], body: [
    ['while', ['<', 'i', 'count'], [
      ['set', 'sum', ['+', 'sum', 'increment']],
      ['set', 'i', ['+', 'i', 1]],
    ]],
  ], result: 'sum' };
  assert.equal((await runSimulation(program, { count: 4, increment: 2 }, requireInput)).value, 8);
  assert.equal((await runSimulation(program, { count: 0, increment: 2 }, requireInput)).value, 0);
});

test('compiler diagnostics identify unsupported operations, names, locals and arity', async () => {
  await assert.rejects(runSimulation(empty(['rand', 1]), {}), /unknown operator "rand"/);
  await assert.rejects(runSimulation(empty('gain*x+bias'), {}), /unknown name "gain\*x\+bias"/);
  await assert.rejects(runSimulation({ locals: [], body: [['set', 'acc', 1]], result: 0 }, {}),
    /only assign to declared locals: "acc"/);
  await assert.rejects(runSimulation({ locals: [], body: [['set', 'x', 1]], result: 'x' }, { x: 2 }),
    /only assign to declared locals: "x"/);
  await assert.rejects(runSimulation(empty(['*', 1, 2, 3]), {}), /"\*".*expected 2 operands, got 3/);
  await assert.rejects(runSimulation(empty(['sqrt', 4, 9]), {}), /"sqrt".*expected 1 operands, got 2/);
  await assert.rejects(runSimulation({ locals: [], body: ['set acc', 1], result: 0 }, {}),
    /Invalid simulation statement "set acc": expected an array/);
});

test('diagnostics bound offending text and do not disclose supplied parameters', async () => {
  const unknown = 'a'.repeat(1000);
  await assert.rejects(runSimulation(empty(unknown), { private_input: 123.456789 }), error => {
    assert.match(error.message, /unknown name "a{64}\.\.\."/);
    assert.ok(error.message.length < 200);
    assert.doesNotMatch(error.message, /private_input|123\.456789/);
    return true;
  });
  await assert.rejects(runSimulation(empty('x'), { x: 1 }, { requireInput: 'yes' }),
    /Invalid simulation input requirement/);
});
