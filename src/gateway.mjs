import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const modelSettings = () => JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url), 'utf8')).settings;

const keys = {
  openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', qwen: 'DASHSCOPE_API_KEY',
};
const usd = nano => nano / 1e9;
const nanos = dollars => Math.round(dollars * 1e9);
const count = value => Number.isSafeInteger(value) && value >= 0;
const modelLabel = value => typeof value === 'string' && /^[a-z0-9][a-z0-9/_.:-]{0,99}$/i.test(value) ? value : null;

export class GatewayError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    Object.assign(this, { code, ...details });
  }
}

function request(setting, effort, prompt, outputLimit, seed, env) {
  const { id: model, vendor } = setting;
  const key = env[keys[vendor]];
  if (!key) throw new GatewayError('missing_key', `${keys[vendor]} is unavailable.`);
  const messages = [{ role: 'user', content: prompt }];
  switch (vendor) {
    case 'gemini':
      return ['https://generativelanguage.googleapis.com/v1beta/interactions', {
        'x-goog-api-key': key, 'Api-Revision': '2026-05-20',
      }, {
        model, input: prompt, store: false,
        generation_config: { thinking_level: effort, max_output_tokens: outputLimit },
      }];
    case 'anthropic':
      return ['https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
        model, messages, max_tokens: outputLimit, thinking: { type: 'adaptive' }, output_config: { effort },
      }];
    case 'openai':
      return ['https://api.openai.com/v1/responses', { authorization: `Bearer ${key}` }, {
        model, input: prompt, store: false, max_output_tokens: outputLimit, reasoning: { effort },
      }];
    case 'qwen': {
      const override = setting.baseUrlEnv ? env[setting.baseUrlEnv] : undefined;
      const baseUrl = override || setting.baseUrl;
      if (!baseUrl) throw new GatewayError('missing_endpoint', `${setting.baseUrlEnv ?? 'Qwen base URL'} is unavailable.`);
      let endpoint;
      try { endpoint = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`); }
      catch { throw new GatewayError('invalid_endpoint', 'Invalid Qwen base URL.'); }
      const isSingapore = endpoint.hostname === 'dashscope-intl.aliyuncs.com' ||
        /^[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com$/.test(endpoint.hostname);
      if (endpoint.protocol !== 'https:' || !isSingapore || endpoint.pathname !== '/compatible-mode/v1/' ||
        endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash) {
        throw new GatewayError('invalid_endpoint', 'Qwen endpoint must be the configured Singapore Model Studio API.');
      }
      if (setting.api === 'qwen-responses') {
        return [new URL('responses', endpoint), { authorization: `Bearer ${key}` }, {
          model, input: prompt, max_output_tokens: outputLimit, reasoning: { effort }, store: false,
        }];
      }
      const thinking = typeof effort === 'number' ? { enable_thinking: true, thinking_budget: effort } : { enable_thinking: false };
      return [new URL('chat/completions', endpoint), { authorization: `Bearer ${key}` }, {
        model, messages, max_completion_tokens: outputLimit, seed, ...thinking,
      }];
    }
    default: throw new GatewayError('invalid_vendor', 'No adapter for this vendor.');
  }
}

function decode(setting, body) {
  const u = body.usage ?? {};
  if (setting.vendor === 'gemini') {
    const reasoning = u.total_thought_tokens ?? 0;
    return {
      text: body.steps?.filter(s => s.type === 'model_output').flatMap(s => s.content)
        .filter(c => c.type === 'text').map(c => c.text).join('') ?? '',
      input: u.total_input_tokens, output: u.total_output_tokens + reasoning, reasoning,
      cachedRead: u.total_cached_tokens ?? 0, cachedWrite: 0, version: body.model, finish: body.status,
    };
  }
  if (setting.vendor === 'anthropic') {
    const cachedRead = u.cache_read_input_tokens ?? 0;
    const cachedWrite = u.cache_creation_input_tokens ?? 0;
    return {
      text: body.content?.filter(part => part.type === 'text').map(part => part.text).join('') ?? '',
      input: u.input_tokens + cachedRead + cachedWrite, output: u.output_tokens, reasoning: u.output_tokens_details?.reasoning_tokens ?? null,
      cachedRead, cachedWrite, version: body.model, finish: body.stop_reason,
    };
  }
  if (setting.api === 'qwen-chat') {
    const choice = body.choices?.[0];
    return {
      text: choice?.message?.content ?? '', input: u.prompt_tokens, output: u.completion_tokens,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? null, cachedRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      cachedWrite: 0, version: body.model, finish: choice?.finish_reason,
    };
  }
  return {
    text: body.output?.filter(item => item.type === 'message').flatMap(item => item.content)
      .filter(part => part.type === 'output_text').map(part => part.text).join('') ?? '',
    input: u.input_tokens, output: u.output_tokens, reasoning: u.output_tokens_details?.reasoning_tokens ?? null,
    cachedRead: u.input_tokens_details?.cached_tokens ?? 0, cachedWrite: u.input_tokens_details?.cache_write_tokens ?? 0,
    version: body.model, finish: body.status,
  };
}

function bill(rates, { input, output, cachedRead, cachedWrite }) {
  const fresh = input - cachedRead - cachedWrite;
  const perToken = dollarsPerMillion => Math.round(1000 * dollarsPerMillion);
  return fresh * perToken(rates.input) + output * perToken(rates.output) +
    cachedRead * perToken(rates.cachedRead ?? rates.input) + cachedWrite * perToken(rates.cachedWrite ?? rates.input);
}

export class Gateway {
  constructor({ path, settings = modelSettings(), fetchImpl = fetch, env = process.env, clock = Date.now }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY, stage TEXT, run_id TEXT, pack_id TEXT, caller TEXT, vendor TEXT,
        setting TEXT, model TEXT, effort TEXT, seed INTEGER, prompt_sha256 TEXT, started_ms INTEGER,
        status TEXT, reserved_nano INTEGER, cost_nano INTEGER, latency_ms INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cached_read INTEGER, cached_write INTEGER,
        model_version TEXT, finish TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS calls_run_vendor ON calls(run_id, vendor, started_ms);`);
    Object.assign(this, { settings, fetchImpl, env, clock });
  }

  reserve(row, limits) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const total = where => this.db.prepare(`SELECT coalesce(sum(coalesce(cost_nano, reserved_nano)),0) AS n FROM calls ${where}`);
      const project = total('').get().n;
      const pilot = total("WHERE stage = 'pilot'").get().n;
      const pack = total('WHERE run_id = ?').get(row.runId).n;
      let failure;
      if (row.started >= (limits.deadlineMs ?? Infinity)) {
        failure = new GatewayError('deadline', 'Pack deadline has passed.');
      } else if (project + row.reserved > nanos(150) || (row.stage === 'pilot' && pilot + row.reserved > nanos(15))) {
        failure = new GatewayError('project_cap', 'The project or pilot spend cap would be exceeded.');
      } else if (limits.dollarCap !== undefined && pack + row.reserved > nanos(limits.dollarCap)) {
        failure = new GatewayError('pack_cap', 'The pack spend cap would be exceeded.');
      }
      if (!failure && limits.quota) {
        const { calls, windowMs } = limits.quota;
        const { n, oldest } = this.db.prepare(`SELECT count(*) AS n, min(started_ms) AS oldest FROM calls
          WHERE run_id = ? AND vendor = ? AND started_ms > ? AND status != 'refused'`)
          .get(row.runId, row.vendor, row.started - windowMs);
        if (n >= calls) failure = new GatewayError('quota', 'Vendor call quota exceeded.', { retryAt: oldest + windowMs });
      }
      this.db.prepare(`INSERT INTO calls
        (id, stage, run_id, pack_id, caller, vendor, setting, model, effort, seed, prompt_sha256, started_ms, status, reserved_nano, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.stage, row.runId, row.packId, row.caller,
        row.vendor, row.setting, row.model, String(row.effort), row.seed, row.promptHash, row.started,
        failure ? 'refused' : 'reserved', failure ? 0 : row.reserved, failure?.code ?? null);
      this.db.exec('COMMIT');
      return failure;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async call({ setting: slug, effort, prompt, stage, runId, packId, caller, seed, outputLimit, limits = {} }) {
    const setting = Object.hasOwn(this.settings, slug) ? this.settings[slug] : null;
    if (!setting?.efforts?.includes(effort)) throw new GatewayError('setting', 'Unknown model setting or unsupported effort.');
    if (!['pilot', 'main'].includes(stage) || !count(seed) || !count(outputLimit) || !outputLimit || outputLimit > 32768) {
      throw new GatewayError('call_spec', 'Invalid stage, seed, or output limit.');
    }
    if ((limits.quota && (!count(limits.quota.calls) || !limits.quota.calls || !count(limits.quota.windowMs) || !limits.quota.windowMs)) ||
      (limits.dollarCap !== undefined && (!Number.isFinite(limits.dollarCap) || limits.dollarCap < 0)) ||
      (limits.deadlineMs !== undefined && !Number.isFinite(limits.deadlineMs))) {
      throw new GatewayError('limits', 'Invalid scarcity limits.');
    }
    const [url, headers, body] = request(setting, effort, prompt, outputLimit, seed, this.env);
    const payload = JSON.stringify(body);
    const inputBound = Buffer.byteLength(payload) + 2048;
    if (inputBound > Math.min(setting.maxPromptTokens ?? 32000, 32000)) {
      throw new GatewayError('prompt_size', 'Prompt exceeds the supported pricing bracket.');
    }
    const started = this.clock();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Indianapolis' }).format(started);
    const rates = setting.futureRates && date >= setting.futureRates.effectiveOn ? setting.futureRates : setting.rates;
    const reserved = bill({ ...rates, input: Math.max(rates.input, rates.cachedWrite ?? 0) }, {
      input: inputBound, output: outputLimit, cachedRead: 0, cachedWrite: 0,
    });
    const id = randomUUID();
    const promptHash = createHash('sha256').update(prompt).digest('hex');
    const row = { id, stage, runId, packId, caller, vendor: setting.vendor, setting: slug, model: setting.id, effort, seed, promptHash, started, reserved };
    const refused = this.reserve(row, limits);
    if (refused) throw refused;

    let decoded;
    try {
      const timeout = Math.max(1, Math.min(120_000, (limits.deadlineMs ?? Infinity) - this.clock()));
      const response = await this.fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload,
        redirect: 'error', signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new GatewayError('http', `${setting.vendor} returned HTTP ${response.status}.`, { httpStatus: response.status });
      decoded = decode(setting, await response.json());
      if (![decoded.input, decoded.output, decoded.cachedRead, decoded.cachedWrite].every(count) ||
        decoded.cachedRead + decoded.cachedWrite > decoded.input ||
        (decoded.reasoning !== null && (!count(decoded.reasoning) || decoded.reasoning > decoded.output))) {
        throw new GatewayError('missing_usage', `${setting.vendor} returned incomplete or inconsistent billing fields.`);
      }
    } catch (error) {
      const safeError = error instanceof GatewayError ? error : new GatewayError('transport', `${setting.vendor} request failed (${error.cause?.code === 'ENOTFOUND' ? 'DNS resolution' : 'network or response error'}).`);
      const rejected = [400, 401, 403, 404, 429].includes(safeError.httpStatus);
      this.db.prepare('UPDATE calls SET status = ?, cost_nano = ?, latency_ms = ?, error = ? WHERE id = ?')
        .run(rejected ? 'rejected' : 'unknown', rejected ? 0 : null, this.clock() - started, safeError.httpStatus ? `http_${safeError.httpStatus}` : safeError.code, id);
      throw safeError;
    }

    const cost = bill(rates, decoded);
    const latencyMs = this.clock() - started;
    const onTime = this.clock() < (limits.deadlineMs ?? Infinity);
    const overReservation = cost > reserved;
    this.db.prepare(`UPDATE calls SET status = 'settled', cost_nano = ?, latency_ms = ?, input_tokens = ?, output_tokens = ?,
      reasoning_tokens = ?, cached_read = ?, cached_write = ?, model_version = ?, finish = ?, error = ? WHERE id = ?`)
      .run(cost, latencyMs, decoded.input, decoded.output, decoded.reasoning, decoded.cachedRead, decoded.cachedWrite,
        modelLabel(decoded.version), modelLabel(decoded.finish), overReservation ? 'reservation_underrun' : onTime ? null : 'deadline', id);
    if (overReservation) throw new GatewayError('reservation_underrun', 'Reported usage exceeded the estimated reservation.');
    return { text: onTime ? decoded.text : '', latencyMs, costUsd: usd(cost), id };
  }

  callsFor(runId) {
    return this.db.prepare('SELECT * FROM calls WHERE run_id = ? ORDER BY started_ms, rowid').all(runId);
  }

  close() { this.db.close(); }
}
