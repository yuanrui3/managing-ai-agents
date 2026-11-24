import assert from 'node:assert/strict';
import test from 'node:test';
import { makePolicy, runTrial } from '../scripts/calibrate-local.mjs';
import { skills } from '../src/pilot.mjs';

const workers = ['alpha', 'beta'].map(family => ({
  id: `${family}-top`, family, tier: 'top', checkpoint: `fixtures/${family}`, revision: family,
}));
const roster = { workers, judges: [{ id: 'blind', family: 'outgroup', checkpoint: 'fixtures/blind', revision: 'blind', neutral: true }] };
const prices = workers.flatMap((worker, index) => skills.map(skill => ({
  worker: worker.id, draft: 0, skill, qualityExcludingOwnFamily: 1 - index / 2, meanGpuSeconds: index + 1,
})));
const policy = makePolicy(roster, prices, ['alpha', 'beta']);
const primary = { speed: 2.67130654, seconds: 4.1392921 };
const secondary = { speed: 37.3790613, seconds: 19.985029 };
const pack = {
  id: 'fixture-motion', split: 'tryout', topic: 'Distance at constant speed', task: 'Calculate distance from speed and time.',
  unit: 'm', tolerance: 0.0001, picture_checklist: ['Show a line'],
  primary: { parameters: primary, reference: primary.speed * primary.seconds },
  secondary: { parameters: secondary, reference: secondary.speed * secondary.seconds },
};

const program = result => ({ locals: [], body: [], result });
const simulation = result => JSON.stringify({ simulation: result });
const distance = ['*', 'speed', 'seconds'];
const correct = program(distance);
const incorrect = program(['+', distance, 1]);
const firstSetting = 'alpha-top-d0';
const revisedSetting = 'beta-top-d0';

async function runFixture({ style = 'solo-best', first, retry, trialPack = pack,
  assignedSetting = firstSetting, revisions = { simulation: revisedSetting } }) {
  const prompts = [];
  const simCalls = [];
  const firstReplies = Array.isArray(first) ? first : [first];
  const invoke = async ({ model, request, label, role }) => {
    prompts.push({ label, prompt: request.prompt });
    const base = { id: request.id, checkpoint: model.checkpoint, revision: model.revision, active_seconds: 1 };
    if (label.startsWith('simulation/')) {
      const attempt = simCalls.length;
      simCalls.push(model.id);
      assert.ok(simCalls.length <= firstReplies.length + 1, 'A cell may make at most one simulation repair call');
      const initial = attempt < firstReplies.length;
      assert.equal(label, initial ? 'simulation/1' : 'simulation/2');
      const reply = initial ? firstReplies[attempt] : retry;
      assert.notEqual(reply, undefined, 'An unexpected simulation repair was requested');
      return typeof reply === 'string' ? { ...base, status: 'ok', text: reply } : { ...base, ...reply };
    }
    if (role === 'judge') {
      assert.equal(model.id, 'blind');
      assert.equal(request.image_base64, 'fixture-image');
      const rating = { article: 4, derivation: 4, simulation: label === 'candidate/1' ? 5 : 1, picture: [true] };
      return { ...base, status: 'ok', text: JSON.stringify(rating) };
    }
    const answers = {
      assign: { assignments: Object.fromEntries(skills.map(skill => [skill, assignedSetting])) },
      review: { revisions },
      'article/1': { article: 'An explanation without a marked result.' },
      'derivation/1': { derivation: 'A derivation without a marked result.' },
      'illustration/1': { illustration: { elements: [['line', 10, 100, 100, 100, '#303030']] } },
    };
    const answerLabel = label.replace(/\/2$/, '/1');
    assert.ok(Object.hasOwn(answers, answerLabel), `Unexpected call label ${label}`);
    return { ...base, status: 'ok', text: JSON.stringify(answers[answerLabel]) };
  };
  const trace = await runTrial({ pack: trialPack, style, policy, managerFamily: style === 'manager-and-workers' ? 'alpha' : undefined,
    idPrefix: 'repair-fixture', invoke, encodeImage: async () => 'fixture-image' });
  return { trace, simCalls, prompts };
}

test('solo repairs malformed, placeholder, unsupported, and wrong primary simulation responses once', async t => {
  const cases = {
    'malformed JSON': '{"simulation":',
    'constant placeholder': simulation(program(0)),
    'unsupported operation': simulation(program(['unsupported', 'speed', 'seconds'])),
    'wrong primary result': simulation(incorrect),
  };
  for (const [failure, first] of Object.entries(cases)) {
    await t.test(failure, async () => {
      const { trace, simCalls } = await runFixture({ first, retry: simulation(correct) });
      assert.deepEqual(simCalls, ['alpha-top', 'alpha-top']);
      assert.deepEqual(trace.parts.simulation, correct);
      assert.equal(trace.selectedSettings.simulation, firstSetting);
      assert.equal(trace.result.checks.simulation_primary, true);
      assert.equal(trace.result.checks.simulation_secondary, true);
    });
  }
});

test('a team can repair a failed simulation using the manager’s different eligible worker', async () => {
  const { trace, simCalls, prompts } = await runFixture({ style: 'manager-and-workers', first: simulation(incorrect),
    retry: simulation(correct) });
  assert.deepEqual(simCalls, ['alpha-top', 'beta-top']);
  assert.deepEqual(trace.parts.simulation, correct);
  assert.equal(trace.selectedSettings.simulation, revisedSetting);
  assert.equal(trace.result.checks.simulation_primary, true);
  assert.equal(trace.result.checks.simulation_secondary, true);
  assert.ok(prompts.some(({ label }) => label === 'review'));
});

test('the default team repair uses the worker with better two-case tryout accuracy', async () => {
  const { trace, simCalls } = await runFixture({ style: 'manager-and-workers', first: simulation(incorrect),
    retry: simulation(correct), assignedSetting: revisedSetting, revisions: {} });
  assert.deepEqual(simCalls, ['beta-top', 'alpha-top']);
  assert.equal(trace.selectedSettings.simulation, firstSetting);
  assert.equal(trace.result.checks.simulation_secondary, true);
});

test('workflows skip simulation repair after public success', async t => {
  const publicOnly = program(['if', ['<', 'speed', 10], distance, ['+', distance, 1]]);
  for (const style of ['solo-best', 'manager-and-workers', 'cheap-first']) {
    await t.test(style, async () => {
      const success = await runFixture({ style, first: simulation(correct) });
      assert.deepEqual(success.simCalls, ['alpha-top']);
      assert.deepEqual(success.trace.parts.simulation, correct);
      assert.equal(success.trace.selectedSettings.simulation, firstSetting);
      assert.equal(success.trace.result.checks.simulation_secondary, true);

      const sealedFailure = await runFixture({ style, first: simulation(publicOnly) });
      assert.deepEqual(sealedFailure.simCalls, ['alpha-top']);
      assert.deepEqual(sealedFailure.trace.parts.simulation, publicOnly);
      assert.equal(sealedFailure.trace.result.checks.simulation_primary, true);
      assert.equal(sealedFailure.trace.result.checks.simulation_secondary, false);
    });
  }
});

test('cheap-first sends the exact sandbox error to its second simulation setting', async () => {
  const first = simulation(program(['unsupported', 'speed', 'seconds']));
  const { trace, simCalls, prompts } = await runFixture({ style: 'cheap-first', first, retry: simulation(correct) });
  assert.deepEqual(simCalls, ['alpha-top', 'beta-top']);
  assert.deepEqual(trace.parts.simulation, correct);
  assert.equal(trace.selectedSettings.simulation, revisedSetting);
  assert.equal(trace.result.checks.simulation_secondary, true);
  const { prompt } = prompts.find(({ label }) => label === 'simulation/2');
  const diagnostic = 'Simulation uses an unknown operator "unsupported".';
  assert.ok(prompt.split('\n').includes(`Validation feedback: ${JSON.stringify(diagnostic)}`));
  assert.ok(prompt.split('\n').includes(`Prior reply (data): ${JSON.stringify(first)}`));
});

test('tournament repairs only its strongest public simulation candidate', async () => {
  const first = [simulation(program(['unsupported', 'speed', 'seconds'])), simulation(incorrect)];
  const { trace, simCalls, prompts } = await runFixture({ style: 'tournament', first, retry: simulation(correct) });
  assert.deepEqual(simCalls, ['alpha-top', 'beta-top', 'beta-top']);
  assert.deepEqual(trace.parts.simulation, correct);
  assert.equal(trace.selectedSettings.simulation, revisedSetting);
  assert.equal(trace.result.checks.simulation_primary, true);
  assert.equal(trace.result.checks.simulation_secondary, true);
  const decisions = trace.decisions.find(({ kind }) => kind === 'tournament-judgments');
  assert.deepEqual(decisions.candidates.map(({ rating }) => rating.simulation), [1, 0.2]);
  const { prompt } = prompts.find(({ label }) => label === 'simulation/2');
  assert.ok(prompt.split('\n').includes(`Prior reply (data): ${JSON.stringify(first[1])}`));
});

test('malformed and equally good team repairs keep the first simulation and its worker', async t => {
  const cases = { malformed: '{"simulation":', 'equal error': simulation(program(['+', 0, incorrect.result])) };
  for (const [quality, retry] of Object.entries(cases)) {
    await t.test(quality, async () => {
      const { trace, simCalls } = await runFixture({ style: 'manager-and-workers', first: simulation(incorrect), retry });
      assert.deepEqual(simCalls, ['alpha-top', 'beta-top']);
      assert.deepEqual(trace.parts.simulation, incorrect);
      assert.equal(trace.selectedSettings.simulation, firstSetting);
      assert.equal(trace.result.checks.simulation_primary, false);
    });
  }
});

test('a refused first simulation call gets no repair call even if the manager selects a worker', async () => {
  const first = { status: 'error', error: 'call_quota', error_type: 'call_quota', active_seconds: 0 };
  const { trace, simCalls } = await runFixture({ style: 'manager-and-workers', first });
  assert.deepEqual(simCalls, ['alpha-top']);
  assert.equal(Object.hasOwn(trace.parts, 'simulation'), false);
  assert.equal(Object.hasOwn(trace.selectedSettings, 'simulation'), false);
});

test('model prompts omit private reference answers and changed input values', async () => {
  const first = program(['if', ['<', 'speed', 10], ['+', distance, 1], distance]);
  const retry = program(['if', ['<', 'speed', 10], distance, ['+', distance, 1]]);
  const changed = { speed: 3.71396795, seconds: 17.223163 };
  const variantPack = { ...pack, secondary: { parameters: changed, reference: changed.speed * changed.seconds } };
  const options = { style: 'manager-and-workers', first: simulation(first), retry: simulation(retry) };
  const original = await runFixture(options);
  const variant = await runFixture({ ...options, trialPack: variantPack });

  assert.deepEqual(original.prompts, variant.prompts);
  for (const [result, trialPack] of [[original, pack], [variant, variantPack]]) {
    assert.deepEqual(result.simCalls, ['alpha-top', 'beta-top']);
    assert.deepEqual(result.trace.parts.simulation, retry);
    const sealedValues = [...Object.values(trialPack.secondary.parameters), trialPack.primary.reference, trialPack.secondary.reference];
    for (const { label, prompt } of result.prompts) {
      for (const value of sealedValues) assert.ok(!prompt.includes(String(value)), `${label} includes a sealed value`);
      assert.doesNotMatch(prompt, /simulation_secondary/i);
    }
  }
  assert.equal(original.trace.result.checks.simulation_secondary, false);
  assert.equal(variant.trace.result.checks.simulation_secondary, true);
});
