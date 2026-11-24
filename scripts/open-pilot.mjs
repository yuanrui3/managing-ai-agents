import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgePrompt, mean, panelValue, renderPanelPng, skillScore } from '../src/blind-panel.mjs';
import { evaluatePack, originalSimulationProtocol, outputLimit, parseSkillResponse, skillPrompt, skills } from '../src/pilot.mjs';

const here = new URL('.', import.meta.url);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) => {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
};
const [command, runId] = process.argv.slice(2);
if (!['prepare-workers', 'retry-worker-oom', 'prepare-panel', 'price-list'].includes(command) ||
  !/^[a-z0-9][a-z0-9-]{0,39}$/.test(runId ?? '') || process.argv.length !== 4) {
  throw new Error('Usage: node scripts/open-pilot.mjs <prepare-workers|retry-worker-oom|prepare-panel|price-list> <run-id>');
}

const root = fileURLToPath(new URL(`../runs/open-pilot/${runId}/`, here));
const phases = phase => join(root, phase);
const seeds = { worker: 20261114, judge: 20261115 };
const drafts = [0, 128, 512];
const liveData = name => readJson(new URL(`../data/${name}.json`, here));
const packs = (await liveData('packs')).packs.filter(pack => pack.split === 'tryout');
const modelSlug = /^[a-z0-9][a-z0-9-]{0,39}$/;

function assertRoster(roster) {
  const all = [...roster.workers, ...roster.judges];
  if (new Set(all.map(entry => entry.id)).size !== all.length || all.some(entry =>
    !modelSlug.test(entry.id) || !modelSlug.test(entry.family) || !/^[a-f0-9]{40}$/.test(entry.revision) ||
    !/^[\w.-]+\/[\w.-]+$/.test(entry.checkpoint) || !['causal', 'vision'].includes(entry.loader))) {
    throw new Error('The open-weight roster contains an invalid ID or unpinned checkpoint.');
  }
  const families = new Set(roster.workers.map(worker => worker.family));
  const neutral = roster.judges.filter(judge => judge.neutral);
  const panel = roster.judges.filter(judge => !judge.neutral);
  if (families.size !== 5 || neutral.length !== 1 || families.has(neutral[0].family) || panel.length !== families.size ||
    [...families].some(family => panel.filter(judge => judge.family === family).length !== 1) ||
    roster.judges.some(judge => judge.loader !== 'vision')) {
    throw new Error('The blind panel needs a vision judge for each worker family and one distinct neutral vision judge.');
  }
}

async function writeQueue(phase, model, tasks) {
  const folder = join(phases(phase), model.id);
  await mkdir(join(folder, 'inbox'), { recursive: true });
  await mkdir(join(folder, 'outbox'), { recursive: true });
  for (const task of tasks) await writeJson(join(folder, 'inbox', `${task.id}.json`), task.request);
  await writeJson(join(folder, 'manifest.json'), { model, tasks: tasks.map(({ request, ...row }) => row) });
  await writeJson(join(folder, 'sealed.json'), { requests: tasks.length });
}

async function readQueues(phase, roster) {
  const replies = [];
  const missing = [];
  for (const { id } of roster) {
    const directory = join(phases(phase), id);
    const { model, tasks } = await readJson(join(directory, 'manifest.json'));
    const configured = roster.find(item => item.id === id);
    if (model.id !== id || model.revision !== configured.revision || model.checkpoint !== configured.checkpoint) {
      throw new Error(`Model provenance mismatch in ${phase}/${id}.`);
    }
    for (const task of tasks) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(task.id)) throw new Error('Invalid gateway request ID.');
      try {
        const response = await readJson(join(directory, 'outbox', `${task.id}.json`));
        if (response.id !== task.id || response.checkpoint !== model.checkpoint || response.revision !== model.revision ||
          !['ok', 'error'].includes(response.status) || (response.status === 'ok' &&
          (!Number.isFinite(response.active_seconds) || response.active_seconds < 0 || typeof response.text !== 'string'))) {
          throw new Error(`Invalid or misrouted reply ${phase}/${id}/${task.id}.`);
        }
        replies.push({ ...task, model, response });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing.push(`${id}/${task.id}`);
      }
    }
  }
  if (missing.length) throw new Error(`${missing.length} ${phase} replies are missing. First missing reply: ${missing[0]}.`);
  return replies;
}

function workerTasks(roster) {
  return drafts.flatMap((draft, level) => packs.flatMap((pack, index) => skills.map((skill, part) => {
    const id = `${pack.id}-${skill}-${draft}`;
    return { id, packId: pack.id, skill, draft, request: { id, seed: seeds.worker + level * 100 + index * 10 + part,
      prompt: skillPrompt(pack, skill, roster.simulationProtocol ?? originalSimulationProtocol) + '\nOmit mentions of your identity, model, and provider.',
      max_output_tokens: outputLimit[skill], draft_tokens: draft } };
  })));
}

async function retryWorkerOom(roster) {
  if (existsSync(phases('panel'))) throw new Error('Worker replies already fed into the blind panel.');
  const tasks = new Map(workerTasks(roster).map(task => [task.id, task]));
  let count = 0;
  for (const model of roster.workers) {
    const queue = join(phases('workers'), model.id);
    const archive = join(queue, 'oom-attempts');
    const manifest = await readJson(join(queue, 'manifest.json'));
    if (manifest.model.checkpoint !== model.checkpoint || manifest.model.revision !== model.revision) {
      throw new Error(`Model provenance mismatch in workers/${model.id}.`);
    }
    for (const { id, draft, packId, skill } of manifest.tasks) {
      const task = tasks.get(id);
      if (!task || task.draft !== draft || task.packId !== packId || task.skill !== skill) {
        throw new Error(`Worker task no longer matches its manifest in workers/${model.id}.`);
      }
      const outbox = join(queue, 'outbox', `${id}.json`);
      if (!existsSync(outbox)) continue;
      const reply = await readJson(outbox);
      if (reply.error_type !== 'OutOfMemoryError' || reply.status !== 'error') continue;
      if (reply.id !== id || reply.revision !== model.revision || reply.checkpoint !== model.checkpoint ||
        reply.site !== 'desktop-windows') throw new Error(`Invalid OOM reply for ${id}.`);
      const time = Date.parse(reply.request_started_at);
      if (!Number.isFinite(time)) throw new Error(`Invalid OOM timestamp for ${id}.`);
      await mkdir(archive, { recursive: true });
      // Publish the request first so restarting this command after an interruption is safe.
      await writeJson(join(queue, 'inbox', `${id}.json`), task.request);
      await rename(outbox, join(archive, `${id}-${time}.json`));
      count++;
    }
  }
  return count;
}

const keyFor = (modelId, packId, draft) => `${modelId}/${packId}/${draft}`;
const blindId = key => `case-${createHash('sha256').update(`${runId}/${key}`).digest('hex').slice(0, 20)}`;

async function scoreWorkers(roster) {
  const groups = new Map();
  const replies = await readQueues('workers', roster.workers);
  for (const { model, packId, skill, draft, response } of replies) {
    const key = keyFor(model.id, packId, draft);
    const group = groups.get(key) ?? { caseId: blindId(key), packId, draft, worker: model.id, family: model.family, parts: {}, calls: {} };
    const { text, ...usage } = response;
    group.calls[skill] = usage;
    if (response.status === 'ok') {
      try { group.parts[skill] = parseSkillResponse(text, skill); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const pack = packs.find(pack => pack.id === group.packId);
    const { result, svg } = await evaluatePack(pack, group.parts);
    Object.assign(group, { result, svg });
  }
  return [...groups.values()];
}

async function preparePanel(roster) {
  const scored = await scoreWorkers(roster);
  await writeJson(join(root, 'worker-scores.json'), scored);
  const tasks = [];
  for (const [index, row] of scored.sort((a, b) => a.caseId.localeCompare(b.caseId)).entries()) {
    const pack = packs.find(pack => pack.id === row.packId);
    const article = typeof row.parts.article === 'string' ? row.parts.article.replace(/\{\{result:\s*([^}]+)\}\}/g, '$1') : null;
    if (!article && !row.svg) continue;
    const image = row.svg ? await renderPanelPng(row.svg) : null;
    const id = row.caseId;
    const checklist = image ? pack.picture_checklist : [];
    const request = { id, seed: seeds.judge + index, draft_tokens: 0, max_output_tokens: 300,
      prompt: judgePrompt(article, checklist, Boolean(image)), ...(image && { image_base64: image }) };
    tasks.push({ id, hasArticle: Boolean(article), pictureCount: checklist.length, request });
  }
  for (const judge of roster.judges) await writeQueue('panel', judge, tasks);
  return tasks.length;
}

async function priceList(roster) {
  const workers = await readJson(join(root, 'worker-scores.json'));
  const reviews = await readQueues('panel', roster.judges);
  const byCase = new Map();
  const panelCoverage = new Map(roster.judges.map(model => [model.id, {
    judge: model.id, family: model.family, neutral: model.neutral,
    requests: 0, returned: 0, articleEligible: 0, articleRated: 0, pictureEligible: 0, pictureRated: 0,
  }]));
  for (const task of reviews) {
    const rating = panelValue(task);
    const coverage = panelCoverage.get(task.model.id);
    coverage.requests++;
    coverage.returned += Number(task.response.status === 'ok');
    coverage.articleEligible += Number(task.hasArticle);
    coverage.articleRated += Number(Number.isFinite(rating.clarity));
    coverage.pictureEligible += Number(task.pictureCount > 0);
    coverage.pictureRated += Number(Number.isFinite(rating.picture));
    const entries = byCase.get(task.id) ?? [];
    entries.push({ judge: task.model.id, family: task.model.family, ...rating });
    byCase.set(task.id, entries);
  }
  const table = [];
  for (const worker of roster.workers) for (const draft of drafts) for (const skill of skills) {
    const rows = workers.filter(row => row.worker === worker.id && row.draft === draft);
    if (rows.length !== packs.length) throw new Error('Price-list row has incorrect tryout coverage.');
    const full = rows.map(row => skillScore(row, skill, byCase.get(row.caseId) ?? [])).filter(Number.isFinite);
    const external = rows.map(row => skillScore(row, skill,
      (byCase.get(row.caseId) ?? []).filter(r => r.family !== worker.family))).filter(Number.isFinite);
    const usage = rows.map(row => row.calls[skill]);
    const durations = usage.filter(row => Number.isFinite(row.active_seconds));
    const elapsed = usage.map(row => (Date.parse(row.request_finished_at) - Date.parse(row.request_started_at)) / 1000)
      .filter(seconds => Number.isFinite(seconds) && seconds >= 0);
    table.push({ worker: worker.id, family: worker.family, tier: worker.tier, draft, skill, tryouts: rows.length,
      quality: mean(full), qualityExcludingOwnFamily: mean(external), scored: full.length,
      scoredExcludingOwnFamily: external.length, returned: usage.filter(row => row.status === 'ok').length,
      meanGpuSeconds: mean(durations.map(row => row.active_seconds)), measured: durations.length,
      meanServiceSeconds: mean(elapsed), meanInputTokens: mean(usage.map(row => row.input_tokens).filter(Number.isFinite)),
      meanOutputTokens: mean(usage.map(row => row.output_tokens).filter(Number.isFinite)),
      meanDraftTokens: mean(usage.map(row => row.draft_tokens).filter(Number.isFinite)), apiUsd: 0 });
  }
  await writeJson(join(root, 'price-list.json'), { rows: table, panelCoverage: [...panelCoverage.values()] });
  return table.length;
}

const rosterFile = join(root, 'roster.json');
const roster = command === 'prepare-workers' ? await liveData('open-weight-models') : await readJson(rosterFile);
assertRoster(roster);
if (command === 'prepare-workers') {
  await mkdir(root, { recursive: true });
  await writeFile(rosterFile, `${JSON.stringify(roster, null, 2)}\n`, { flag: 'wx' });
  const tasks = workerTasks(roster);
  for (const model of roster.workers) await writeQueue('workers', model, tasks);
  console.log(`${tasks.length * roster.workers.length} prepared worker requests in ${root}`);
} else if (command === 'retry-worker-oom') {
  console.log(`${await retryWorkerOom(roster)} Windows GPU OOM attempts archived and requeued in ${root}`);
} else if (command === 'prepare-panel') {
  console.log(`${await preparePanel(roster) * roster.judges.length} prepared panel requests in ${root}`);
} else {
  console.log(`${await priceList(roster)} price-list rows in ${join(root, 'price-list.json')}`);
}
