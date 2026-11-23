import { readFile } from 'node:fs/promises';
import { designBudget, planGpu } from '../src/gpu-planning.mjs';

const args = process.argv.slice(2);
const [modeOrPath, designPath] = args;
const designOnly = modeOrPath === '--design-only';
if (!modeOrPath || args.length > (designOnly ? 2 : 1)) {
  console.error('Usage: node scripts/plan-gpu.mjs <pilot.json> | --design-only [design.json]');
  process.exit(1);
}

try {
  const { packs } = JSON.parse(await readFile(new URL('../data/packs.json', import.meta.url), 'utf8'));
  const tryoutPackIds = new Set(packs.filter(pack => pack.split === 'tryout').map(pack => pack.id));
  const mainPackIds = new Set(packs.filter(pack => pack.split === 'main').map(pack => pack.id));
  const path = designOnly ? designPath : modeOrPath;
  const input = path ? JSON.parse(await readFile(path, 'utf8')) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Planning input must be a JSON object.');

  if (designOnly) {
    input.grid = {
      packIds: [...mainPackIds],
      managerFamilies: ['rotation-1', 'rotation-2', 'rotation-3', 'rotation-4', 'rotation-5'],
      managerPolicies: ['always-top', 'cheapest-passing', 'manager-choice', 'escalate-on-failure'],
      visibility: ['told', 'not-told'],
      repeats: 2,
      ...input.grid,
    };
  }
  if (Array.isArray(input.grid?.packIds) && input.grid.packIds.some(id => !mainPackIds.has(id))) {
    throw new Error('grid.packIds must use registered main packs. Supply them in the preregistered retention order.');
  }
  if (!designOnly && Array.isArray(input.unlimited) && input.unlimited.some(run => !tryoutPackIds.has(run?.packId))) {
    throw new Error('unlimited pilot traces must come from registered tryout packs.');
  }
  const result = designOnly ? designBudget(input) : planGpu(input);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'blocked') process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
