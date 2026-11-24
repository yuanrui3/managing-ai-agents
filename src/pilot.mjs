import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GatewayError } from './gateway.mjs';
import { diagramFormat, renderDiagram } from './diagram.mjs';
import { legacySimulationFormat, runSimulation, simulationFormat } from './sandbox.mjs';

export const originalSimulationProtocol = 'original-v1';
export const checkedSimulationProtocol = 'checked-v2';
export const skills = ['article', 'derivation', 'simulation', 'illustration'];
const instructions = {
  article: 'Write a reader-facing 600-word explainer (550 to 650 words) giving the actual primary-case answer. Return {"article":"your prose"}. Mark each occurrence of the requested final scalar inline as {{result: NUMBER}}, with the specified unit outside the marker. Other quantities and input values are ordinary numbers.',
  derivation: 'Write a worked derivation with mathematical steps and numerical substitutions, ending with the actual primary-case answer. Return {"derivation":"your derivation"}. Mark the requested final scalar inline as {{result: NUMBER}}, with the specified unit outside the marker.',
  illustration: `Draw one illustration of the primary setup. Return {"illustration":DIAGRAM}. DIAGRAM follows this format:\n${diagramFormat}`,
};

export function skillPrompt(pack, skill, simulationProtocol = checkedSimulationProtocol) {
  const checklist = skill === 'illustration' ? `\nPicture checklist: ${JSON.stringify(pack.picture_checklist)}` : '';
  if (![originalSimulationProtocol, checkedSimulationProtocol].includes(simulationProtocol)) {
    throw new Error(`Unknown simulation protocol: ${simulationProtocol}`);
  }
  const format = simulationProtocol === originalSimulationProtocol ? legacySimulationFormat : simulationFormat;
  const instruction = skill === 'simulation'
    ? `Write a numerical simulation that computes the requested scalar from the named parameters, and works when their values change. Approximate the underlying setup numerically where applicable. Return {"simulation":PROGRAM}. PROGRAM follows this format:\n${format}`
    : instructions[skill];
  return `Produce the ${skill} part of a physics or maths explainer pack.
Topic: ${pack.topic}
Task: ${pack.task}
Primary parameters: ${JSON.stringify(pack.primary.parameters)}
Report the requested scalar in ${pack.unit === '1' ? 'dimensionless units' : pack.unit}.
Required absolute numerical accuracy: ${pack.tolerance}.${checklist}
${instruction}
Return a single JSON object without Markdown fences or commentary outside the JSON.`;
}

function markedValues(prose) {
  if (typeof prose !== 'string') return [];
  return Array.from(prose.matchAll(/\{\{result:\s*([^}]+)\}\}/g), ([, result]) => {
    const scalar = result.trim();
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(scalar) ? Number(scalar) : NaN;
  });
}

function publishedProse(prose) {
  return prose.replace(/\{\{result:\s*([^}]+)\}\}/g, (_, number) => number.trim());
}

export async function evaluatePack(pack, parts, { includeSecondary = true } = {}) {
  const article = markedValues(parts.article);
  const derivation = markedValues(parts.derivation);
  const wordCount = typeof parts.article === 'string'
    ? [...new Intl.Segmenter('en', { granularity: 'word' }).segment(publishedProse(parts.article))].filter(word => word.isWordLike).length
    : 0;
  const simulate = async params => {
    if (!parts.simulation) return { error: 'Missing simulation.' };
    try { return await runSimulation(parts.simulation, params); }
    catch (error) { return { error: error.message }; }
  };
  const primary = await simulate(pack.primary.parameters);
  const secondary = includeSecondary ? await simulate(pack.secondary.parameters) : undefined;
  const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= pack.tolerance;
  const passesAll = (numbers, reference) => numbers.length > 0 && numbers.every(number => close(number, reference));
  const numbers = [...article, ...derivation, primary.value];
  let svg;
  let illustrationError;
  try { svg = renderDiagram(parts.illustration, pack.topic); }
  catch (error) { illustrationError = error.message; }
  const checks = {
    article_length: wordCount >= 550 && wordCount <= 650,
    article_reference: passesAll(article, pack.primary.reference),
    derivation_reference: passesAll(derivation, pack.primary.reference),
    simulation_primary: close(primary.value, pack.primary.reference),
    primary_numbers_agree: article.length > 0 && derivation.length > 0 && numbers.every(Number.isFinite) &&
      Math.max(...numbers) - Math.min(...numbers) <= pack.tolerance,
    ...(includeSecondary && { simulation_secondary: close(secondary.value, pack.secondary.reference) && !close(secondary.value, primary.value) }),
    illustration_rendered: Boolean(svg),
  };
  return { svg, result: { pass: includeSecondary && Object.values(checks).every(Boolean), checks, wordCount, article, derivation,
    primary, secondary, illustrationError, artMode: svg ? 'code-drawn SVG' : null, tolerance: pack.tolerance,
    primaryReference: pack.primary.reference, ...(includeSecondary && { secondaryReference: pack.secondary.reference }) } };
}

export const outputLimit = { article: 2300, derivation: 1800, simulation: 2600, illustration: 3500 };

export function parseSkillResponse(text, skill) {
  const json = text.trim().replace(/^```(?:json)?\s*\n|\n```$/gi, '');
  const part = JSON.parse(json)?.[skill];
  if (part === undefined || part === null) throw new SyntaxError('Missing part in JSON response.');
  return part;
}

// Only the published case is available during drafting. The changed case is for final scoring.
export async function checkSimulationDraft(text, primary, tolerance) {
  if (!Number.isFinite(primary.reference) || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('Simulation checking requires a finite reference value and a nonnegative finite tolerance.');
  }
  let program;
  try {
    program = parseSkillResponse(text, 'simulation');
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { stage: 'format', feedback: `Invalid simulation reply: ${error.message.slice(0, 240)}` };
  }
  let value;
  try {
    ({ value } = await runSimulation(program, primary.parameters, { requireInput: true }));
  } catch (error) {
    return { stage: 'program', program, feedback: error.message.slice(0, 400) };
  }
  if (Math.abs(value - primary.reference) > tolerance) {
    return { stage: 'number', program, feedback: `Your program returned ${value} on the stated inputs, outside the required tolerance. Recheck the calculation, units, and any loop's starting condition.` };
  }
  return { stage: 'passed', program };
}

export async function runGatePack({ gateway, pack, dir, setting, efforts, seed, runId }) {
  const started = performance.now();
  await mkdir(dir, { recursive: true });
  const parts = {};
  const production = {};
  let accessBlocked = false;
  for (const [index, skill] of skills.entries()) {
    if (accessBlocked) break;
    const prompt = skillPrompt(pack, skill, originalSimulationProtocol);
    const effort = efforts[skill] ?? efforts.default;
    try {
      const response = await gateway.call({ setting, effort, prompt, stage: 'pilot', runId, packId: pack.id,
        caller: `gate1/${skill}`, seed: seed + index, outputLimit: outputLimit[skill] });
      production[skill] = { callId: response.id, latencyMs: response.latencyMs, costUsd: response.costUsd };
      await writeFile(join(dir, `${skill}.response.txt`), response.text, 'utf8');
      parts[skill] = parseSkillResponse(response.text, skill);
    } catch (error) {
      if (error instanceof GatewayError) {
        production[skill] = { error: error.message, code: error.code, httpStatus: error.httpStatus };
        accessBlocked = ['missing_key', 'missing_endpoint', 'invalid_endpoint', 'transport', 'reservation_underrun', 'project_cap'].includes(error.code) ||
          [400, 401, 403, 404].includes(error.httpStatus);
      } else if (error instanceof SyntaxError) {
        production[skill].error = 'Response did not contain the expected JSON part.';
      } else {
        throw error;
      }
    }
  }

  const { svg, result } = await evaluatePack(pack, parts);
  for (const skill of ['article', 'derivation']) {
    if (typeof parts[skill] === 'string') await writeFile(join(dir, `${skill}.md`), publishedProse(parts[skill]), 'utf8');
  }
  if (parts.simulation) await writeFile(join(dir, 'simulation.json'), `${JSON.stringify(parts.simulation, null, 2)}\n`);
  if (svg) await writeFile(join(dir, 'illustration.svg'), svg, 'utf8');
  const summary = { packId: pack.id, topic: pack.topic, setting, efforts, seed, accessBlocked, production,
    seconds: (performance.now() - started) / 1000, ...result };
  await writeFile(join(dir, 'checks.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
