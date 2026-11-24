import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { evaluatePack, originalSimulationProtocol, parseSkillResponse, skills } from '../src/pilot.mjs';

const [stamp] = process.argv.slice(2);
if (process.argv.length !== 3 || !/^gate1-[0-9TZ-]+-[a-f0-9]{8}$/.test(stamp)) {
  throw new Error('Usage: node scripts/replay-gate1.mjs <run-directory-name>');
}
const root = fileURLToPath(new URL('../runs/', import.meta.url));
const { packs } = JSON.parse(await readFile(new URL('../data/packs.json', import.meta.url), 'utf8'));
const summaries = JSON.parse(await readFile(join(root, stamp, 'summary.json'), 'utf8'));
const db = new DatabaseSync(join(root, 'calls.sqlite'), { readOnly: true });
const usage = db.prepare(`SELECT count(*) AS calls, coalesce(sum(cost_nano), 0) AS cost_nano,
  coalesce(sum(CASE WHEN cost_nano IS NULL THEN reserved_nano ELSE 0 END), 0) AS held_nano
  FROM calls WHERE run_id = ? AND status != 'refused'`);
let totalCost = 0;
let totalHeld = 0;
let totalCalls = 0;
try {
  for (const summary of summaries) {
    const pack = packs.find(item => item.id === summary.packId && item.split === 'tryout');
    assert.ok(pack, `Unknown tryout in Gate 1 summary: ${summary.packId}`);
    const parts = {};
    for (const skill of skills) {
      try {
        const response = await readFile(join(root, stamp, pack.id, `${skill}.response.txt`), 'utf8');
        parts[skill] = parseSkillResponse(response, skill, originalSimulationProtocol);
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    const { result } = await evaluatePack(pack, parts);
    for (const key of ['pass', 'checks', 'wordCount', 'article', 'derivation', 'tolerance', 'primaryReference', 'secondaryReference']) {
      assert.deepEqual(JSON.parse(JSON.stringify(result[key])), summary[key], `${pack.id} ${key}`);
    }
    for (const key of ['primary', 'secondary']) {
      assert.deepEqual(result[key].value, summary[key].value, `${pack.id} ${key} value`);
      assert.deepEqual(result[key].error, summary[key].error, `${pack.id} ${key} error`);
    }
    const row = usage.get(`${stamp}/${pack.id}`);
    assert.equal(row.cost_nano / 1e9, summary.postedCostUsd, `${pack.id} billed cost`);
    assert.equal(row.held_nano / 1e9, summary.heldUsd, `${pack.id} unresolved reserve`);
    totalCost += row.cost_nano;
    totalHeld += row.held_nano;
    totalCalls += row.calls;
    console.log(JSON.stringify({ pack: pack.id, ...result, calls: row.calls, costUsd: row.cost_nano / 1e9 }));
  }
  console.log(JSON.stringify({ packs: summaries.length, calls: totalCalls, costUsd: totalCost / 1e9, heldUsd: totalHeld / 1e9 }));
} finally {
  db.close();
}
