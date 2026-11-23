import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManagerReviewPrompt, medianWorkerServiceMs, runCalibration } from '../scripts/calibrate-local.mjs';
import { STYLES } from '../src/gpu-planning.mjs';
import { skills } from '../src/pilot.mjs';

test('the clarified review shows a legal task key and a real exact setting ID string', () => {
  const context = { managementContext: 'Task menu', checks: { simulation_primary: false }, previews: {} };
  const legacy = buildManagerReviewPrompt(context);
  const clarified = buildManagerReviewPrompt({ ...context, exampleSettingId: 'epsilon-top-d0' });
  assert.match(legacy, /\{"revisions":\{"skill":"setting"\}\}/);
  assert.doesNotMatch(clarified, /"skill"|"setting"/);
  assert.match(clarified, /exact task keys article, derivation, simulation, illustration/);
  assert.match(clarified, /one exact setting ID string/);
  assert.deepEqual([...clarified.matchAll(/\{"revisions":\{[^}]*\}\}/g)].map(([sample]) => JSON.parse(sample)),
    [{ revisions: { simulation: 'epsilon-top-d0' } }, { revisions: {} }]);
  const evidence = '\nTask menu\nChecks: {"simulation_primary":false}\nArtifact excerpts: {}';
  assert.ok(legacy.endsWith(evidence));
  assert.ok(clarified.endsWith(evidence));
});

test('the controller pairs all five unlimited styles, rotates managers, and sends anonymous images to the neutral judge', async () => {
  const packs = Array.from({ length: 5 }, (_, index) => ({ id: `tryout-0${index + 1}`, split: 'tryout',
    topic: 'Fixture topic', task: 'Report value.', unit: '1', tolerance: 0.01,
    primary: { parameters: { value: 10 }, reference: 10 }, secondary: { parameters: { value: 20 }, reference: 20 },
    picture_checklist: ['A line is drawn'] }));
  const managerFamilies = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const workers = managerFamilies.map(family => ({ id: `${family}-top`, family, tier: 'top',
    checkpoint: `fixtures/${family}`, revision: family }));
  const neutral = { id: 'neutral-judge', family: 'outgroup', checkpoint: 'fixtures/judge', revision: 'judge', neutral: true };
  const roster = { workers, judges: [neutral] };
  const priceList = { rows: workers.flatMap((model, index) => skills.map(skill => ({ skill, draft: 0, worker: model.id,
    qualityExcludingOwnFamily: (index + 1) / 5, meanGpuSeconds: index + 1 }))) };
  const saved = [];
  const requests = [];
  const started = '2026-11-15T06:00:00.000Z';
  const finished = '2026-11-15T06:00:00.006Z';
  const invoke = async ({ model, request, role }) => {
    requests.push({ model, request, role });
    let answer;
    if (role === 'judge') {
      assert.equal(model.id, neutral.id);
      assert.ok(request.image_base64);
      assert.doesNotMatch(request.prompt, /alpha-top|beta-top|gamma-top|delta-top|epsilon-top/);
      answer = { article: 4, derivation: 4, simulation: null, picture: [true] };
    } else if (request.id === 'cal-tryout-03-specialists-3') {
      return { id: request.id, checkpoint: model.checkpoint, revision: model.revision, status: 'error' };
    } else if (request.prompt.startsWith('Plan the four skills')) {
      answer = { assignments: Object.fromEntries(skills.map(skill => [skill, `${model.id}-d0`])) };
    } else if (request.prompt.startsWith('Review the anonymous artifact')) {
      answer = { revisions: {} };
    } else {
      const skill = /^Produce the (\w+) part/.exec(request.prompt)?.[1];
      const value = {
        article: `${Array(598).fill('measurement').join(' ')} {{result: 10}}`,
        derivation: 'The result is {{result: 10}}.',
        simulation: null,
        illustration: { width: 640, height: 400, elements: [['line', 10, 100, 100, 100, '#303030']] },
      }[skill];
      answer = { [skill]: value };
    }
    return { id: request.id, checkpoint: model.checkpoint, revision: model.revision, status: 'ok',
      text: JSON.stringify(answer), active_seconds: 0, request_started_at: started, request_finished_at: finished,
      load_seconds: 0, watchdog_hold_ms: 2 };
  };
  const encodeImage = async svg => {
    assert.match(svg, /<line/);
    return 'fixture-image';
  };
  const traces = await runCalibration({ packs, roster, priceList, managerFamilies, invoke, encodeImage, onRun: trace => saved.push(trace.id) });
  assert.equal(traces.length, 25);
  assert.deepEqual(saved, traces.map(trace => trace.id));
  assert.deepEqual(traces.filter(trace => trace.style === 'manager-and-workers').map(trace => trace.managerFamily), managerFamilies);
  assert.equal(new Set(requests.map(({ request }) => request.id)).size, requests.length);
  for (const style of STYLES) {
    assert.deepEqual(traces.filter(trace => trace.style === style).map(trace => trace.packId), packs.map(pack => pack.id));
  }
  const tournament = traces.find(trace => trace.style === 'tournament');
  assert.equal(tournament.calls.length, 25);
  assert.ok(tournament.calls.slice(-5).every(call => call.role === 'judge'));
  assert.equal(tournament.decisions[0].candidates.length, 5);
  assert.equal(tournament.calls[0].watchdogHoldMs, 2);
  const cheapFirst = traces.find(trace => trace.style === 'cheap-first');
  assert.deepEqual(cheapFirst.decisions[0].settings, { simulation: 'epsilon-top-d0' });
  assert.equal(traces.find(trace => trace.id === 'cal-tryout-03-specialists').activeSeconds, null);
  assert.equal(medianWorkerServiceMs(traces), 6);

  const firstTrial = traces[0];
  requests.length = 0;
  saved.length = 0;
  const resumed = await runCalibration({ packs, roster, priceList: priceList.rows, managerFamilies, invoke, encodeImage,
    completedTraces: traces.slice(1).reverse(), idPrefix: 'cal-retry', onRun: trace => saved.push(trace.id) });
  assert.deepEqual(resumed.map(trace => trace.id), traces.map(trace => trace.id));
  assert.deepEqual(saved, [firstTrial.id]);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ request }) => request.id.startsWith('cal-retry-tryout-01-solo-best-')));
});
