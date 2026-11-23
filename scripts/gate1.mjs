import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway, modelSettings } from '../src/gateway.mjs';
import { runGatePack } from '../src/pilot.mjs';

const settings = modelSettings();
const [setting = 'gemini-cheap'] = process.argv.slice(2);
if (process.argv.length > 3 || !Object.hasOwn(settings, setting) || settings[setting].tier !== 'cheap') {
  throw new Error('Usage: node scripts/gate1.mjs [configured-cheap-setting]');
}
const root = fileURLToPath(new URL('../runs/', import.meta.url));
const stamp = `gate1-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const { packs } = JSON.parse(await readFile(new URL('../data/packs.json', import.meta.url), 'utf8'));
const tryouts = ['tryout-01', 'tryout-02', 'tryout-03'].map(id => packs.find(pack => pack.id === id && pack.split === 'tryout'));
if (tryouts.some(pack => !pack)) throw new Error('Missing the three Gate 1 tryout specs.');
const gateway = new Gateway({ path: join(root, 'calls.sqlite'), settings });
const summaries = [];
try {
  for (const [index, pack] of tryouts.entries()) {
    const runId = `${stamp}/${pack.id}`;
    const result = await runGatePack({ gateway, pack, dir: join(root, runId), setting,
      efforts: { default: settings[setting].efforts[0] }, seed: 20261114 + index * 10, runId });
    const calls = gateway.callsFor(runId);
    const postedCostUsd = calls.reduce((sum, call) => sum + (call.cost_nano ?? 0), 0) / 1e9;
    const heldUsd = calls.reduce((sum, call) => sum + (call.cost_nano === null ? call.reserved_nano : 0), 0) / 1e9;
    summaries.push({ ...result, postedCostUsd, heldUsd });
    console.log(`${pack.id} ${result.pass ? 'PASS' : 'FAIL'} $${postedCostUsd.toFixed(6)}${heldUsd ? ` ($${heldUsd.toFixed(6)} held)` : ''}`);
    if (result.accessBlocked) break;
  }
} finally {
  gateway.close();
}
const report = join(root, stamp, 'summary.json');
await writeFile(report, `${JSON.stringify(summaries, null, 2)}\n`);
console.log(report);
if (summaries.length !== 3 || summaries.some(summary => !summary.pass)) process.exitCode = 1;
