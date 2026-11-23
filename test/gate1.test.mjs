import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Gateway } from '../src/gateway.mjs';
import { runGatePack, skills } from '../src/pilot.mjs';
import { runSimulation } from '../src/sandbox.mjs';

const fakeKey = 'offline-fixture-key';
const setting = 'fixture-gemini';
const efforts = { default: 'minimal' };
const settings = {
  [setting]: { id: 'gemini-fixture', vendor: 'gemini', efforts: ['minimal'], rates: { input: 1, output: 4, cachedRead: 0.25 } },
};
const fixtureCostNano = 2_987_500;
const blue = '#163fac';
const gray = '#303030';

const packFixtures = {
  'tryout-01': {
    references: [24.522050042935017, 39.56353623959211],
    simulation: {
      locals: ['angle', 'vertical', 'lo', 'hi', 't'],
      body: [
        ['set', 'angle', ['*', 'angle_deg', Math.PI / 180]],
        ['set', 'vertical', ['*', 'speed_m_s', ['sin', 'angle']]],
        ['set', 'hi', ['+', 1, ['/', ['*', 2, 'speed_m_s'], 'gravity_m_s2']]],
        ['while', ['>', ['-', 'hi', 'lo'], 1e-8], [
          ['set', 't', ['*', 0.5, ['+', 'hi', 'lo']]],
          ['if', ['>', ['-', ['*', 'vertical', 't'], ['*', ['*', 0.5, 'gravity_m_s2'], ['*', 't', 't']]], 0],
            [['set', 'lo', 't']], [['set', 'hi', 't']]],
        ]],
      ],
      result: ['*', ['*', 'speed_m_s', ['cos', 'angle']], 't'],
    },
    elements: [
      ['line', 40, 300, 560, 300, gray],
      ['polyline', [[70, 300], [180, 190], [290, 150], [400, 190], [510, 300]], blue],
      ['line', 70, 300, 180, 222, gray],
      ['text', 100, 270, '35°', gray],
      ['text', 230, 340, 'Horizontal range', gray],
    ],
  },
  'tryout-02': {
    references: [112, 178.125],
    simulation: {
      locals: [], body: [], result: ['+', 'series_ohm', ['/', ['*', 'branch_a_ohm', 'branch_b_ohm'], ['+', 'branch_a_ohm', 'branch_b_ohm']]],
    },
    elements: [
      ['circle', 40, 180, 4, blue], ['rect', 90, 166, 70, 28, gray],
      ['polyline', [[40, 180], [210, 180], [210, 95], [500, 95], [500, 260], [210, 260], [210, 180]], blue],
      ['rect', 310, 81, 70, 28, gray], ['rect', 310, 246, 70, 28, gray],
      ['line', 500, 180, 580, 180, blue], ['circle', 580, 180, 4, blue],
      ['text', 20, 220, 'Input', gray], ['text', 550, 220, 'Output', gray],
    ],
  },
  'tryout-03': {
    references: [20, 37.33333333333333],
    simulation: { locals: [], body: [], result: ['/', 1, ['-', ['/', 1, 'focal_length_cm'], ['/', 1, 'object_distance_cm']]] },
    elements: [
      ['line', 30, 200, 600, 200, gray], ['line', 310, 60, 310, 340, blue],
      ['line', 70, 200, 70, 115, gray], ['line', 470, 200, 470, 257, gray],
      ['polyline', [[70, 115], [310, 115], [470, 257]], blue],
      ['polyline', [[70, 115], [310, 200], [470, 257]], blue],
      ['text', 300, 50, 'Lens <center>', gray],
    ],
  },
};

function geminiResponse(text) {
  return Response.json({
    model: settings[setting].id, status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 211, total_output_tokens: 659, total_thought_tokens: 37, total_cached_tokens: 10 },
  });
}

function makeGateway(fetchImpl, path = ':memory:', clock = Date.now) {
  return new Gateway({ path, settings, fetchImpl, env: { GEMINI_API_KEY: fakeKey }, clock });
}

test('three tryouts produce checked artifacts through the injected Gemini gateway', async () => {
  const { packs } = JSON.parse(await readFile(new URL('../data/tryout-packs.json', import.meta.url), 'utf8'));
  const requiredPacks = Object.keys(packFixtures).map(id => packs.find(pack => pack.id === id && pack.split === 'tryout'));
  await using scratch = await mkdtempDisposable(join(await realpath(tmpdir()), 'agent-gate1-test-'));
  const ledger = join(scratch.path, 'calls.sqlite');
  const requests = [];
  let expectedPack;
  let hardCoded = false;
  const gateway = makeGateway((url, options) => {
    const body = JSON.parse(options.body);
    const skill = /^Produce the (\w+) part/.exec(body.input)?.[1];
    const fixture = packFixtures[expectedPack.id];
    const [reference] = fixture.references;
    const result = `{{result: ${reference}}}`;
    const parts = {
      article: `${Array(599).fill('measurement').join(' ')} ${result}`,
      derivation: `Fixture derivation. The result is ${result}.`,
      simulation: hardCoded ? { locals: [], body: [], result: reference } : fixture.simulation,
      illustration: { elements: fixture.elements },
    };
    requests.push({ url, options, body, skill });
    return geminiResponse(JSON.stringify({ [skill]: parts[skill] }));
  }, ledger);
  try {
    for (const pack of requiredPacks) {
      const runId = pack.id;
      const dir = join(scratch.path, runId);
      expectedPack = pack;
      const [reference, alternate] = packFixtures[runId].references;
      assert.ok(Math.abs(pack.primary.reference - reference) <= pack.tolerance);
      assert.ok(Math.abs(pack.secondary.reference - alternate) <= pack.tolerance);

      const result = await runGatePack({ gateway, pack, dir, setting, efforts, seed: 9001, runId });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.wordCount, 600);
      assert.ok(Math.abs(result.primary.value - reference) <= pack.tolerance);
      assert.ok(Math.abs(result.secondary.value - alternate) <= pack.tolerance);
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'checks.json'), 'utf8')).checks, result.checks);
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'simulation.json'), 'utf8')), packFixtures[runId].simulation);
      assert.doesNotMatch(await readFile(join(dir, 'article.md'), 'utf8'), /\{\{result:/);
      assert.doesNotMatch(await readFile(join(dir, 'derivation.md'), 'utf8'), /\{\{result:/);
      const svg = await readFile(join(dir, 'illustration.svg'), 'utf8');
      assert.match(svg, /^<svg /);
      if (runId === 'tryout-03') assert.match(svg, /Lens &lt;center&gt;/);

      const madeForPack = requests.splice(0);
      assert.deepEqual(madeForPack.map(request => request.skill), skills);
      for (const { url, options, body } of madeForPack) {
        assert.equal(new URL(url).host, 'generativelanguage.googleapis.com');
        assert.equal(options.headers['x-goog-api-key'], fakeKey);
        assert.equal(body.generation_config.thinking_level, 'minimal');
        assert.ok(body.input.includes(JSON.stringify(pack.primary.parameters)));
        assert.ok(!body.input.includes(JSON.stringify(pack.secondary.parameters)));
      }
    }

    hardCoded = true;
    expectedPack = requiredPacks[0];
    const result = await runGatePack({ gateway, pack: expectedPack, dir: join(scratch.path, 'constant-answer'),
      setting, efforts, seed: 9001, runId: 'constant-answer' });
    assert.equal(result.pass, false);
    assert.deepEqual(Object.keys(result.checks).filter(check => !result.checks[check]), ['simulation_secondary']);
  } finally {
    gateway.close();
  }

  const reopened = makeGateway(() => assert.fail('Reading the ledger must not dispatch a request.'), ledger);
  try {
    for (const { id } of requiredPacks) {
      const calls = reopened.callsFor(id);
      assert.deepEqual(calls.map(call => call.caller), skills.map(skill => `gate1/${skill}`));
      assert.deepEqual(calls.map(call => call.seed), [9001, 9002, 9003, 9004]);
      for (const call of calls) {
        assert.equal(call.status, 'settled');
        assert.equal(call.input_tokens, 211);
        assert.equal(call.output_tokens, 696);
        assert.equal(call.reasoning_tokens, 37);
        assert.equal(call.cached_read, 10);
        assert.equal(call.cost_nano, fixtureCostNano);
        assert.match(call.prompt_sha256, /^[0-9a-f]{64}$/);
        assert.ok(!JSON.stringify(call).includes(fakeKey));
      }
    }
  } finally {
    reopened.close();
  }
});

test('pending spend, call quota, and deadlines refuse a call before transport', async () => {
  const reply = Promise.withResolvers();
  let requests = 0;
  const now = 123456789;
  const gateway = makeGateway(() => {
    requests += 1;
    return reply.promise;
  }, ':memory:', () => now);
  const request = { setting, effort: 'minimal', prompt: 'fixture', stage: 'pilot', seed: 99, outputLimit: 2000,
    runId: 'reservation', packId: 'fixture', caller: 'test' };
  try {
    const pending = gateway.call(request);
    const [held] = gateway.callsFor(request.runId);
    assert.equal(held.status, 'reserved');
    const cap = held.reserved_nano * 1.5 / 1e9;
    await assert.rejects(gateway.call({ ...request, limits: { dollarCap: cap } }), { code: 'pack_cap' });
    await assert.rejects(gateway.call({ ...request, limits: { quota: { calls: 1, windowMs: 1000 } } }),
      { code: 'quota', retryAt: now + 1000 });
    await assert.rejects(gateway.call({ ...request, limits: { deadlineMs: now } }), { code: 'deadline' });
    assert.equal(requests, 1);
    reply.resolve(geminiResponse('{}'));
    assert.equal((await pending).costUsd, fixtureCostNano / 1e9);
    assert.deepEqual(gateway.callsFor(request.runId).map(call => [call.status, call.error]), [
      ['settled', null], ['refused', 'pack_cap'], ['refused', 'quota'], ['refused', 'deadline'],
    ]);
  } finally {
    gateway.close();
  }
});

test('simulation rejects host operators and stops unbounded programs', async () => {
  await assert.rejects(runSimulation({ locals: [], body: [], result: ['fetch', 'url'] }, {}), /unknown operator/);
  await assert.rejects(runSimulation({ locals: [], body: [['while', 1, []]], result: 0 }, {}), /instruction budget/);
  await assert.rejects(runSimulation({ locals: [], body: [], result: 1 }, {}, { timeoutMs: 1 }), /wall-time limit/);
});
