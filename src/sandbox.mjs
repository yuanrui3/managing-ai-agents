import { execFile } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const sandboxFile = fileURLToPath(import.meta.url);
const childFlag = '--isolated-simulation-child';
const maxInputBytes = 64 * 1024;
const maxNames = 64;
const maxNodes = 1200;
const maxDepth = 32;
const fuelLimit = 250000;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

// The only functions reachable from a generated program take and return f64.
const mathFunctions = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  exp: Math.exp,
  log: Math.log,
  log1p: Math.log1p,
  expm1: Math.expm1,
  pow: Math.pow,
  atan2: Math.atan2,
  hypot: (x, y) => Math.hypot(x, y),
  mod: (x, y) => x % y,
};
const mathNames = Object.keys(mathFunctions);
const unaryOps = { abs: 0x99, neg: 0x9a, ceil: 0x9b, floor: 0x9c, trunc: 0x9d, sqrt: 0x9f };
const binaryOps = { '+': 0xa0, '-': 0xa1, '*': 0xa2, '/': 0xa3, min: 0xa4, max: 0xa5 };
const compareOps = { '==': 0x61, '!=': 0x62, '<': 0x63, '>': 0x64, '<=': 0x65, '>=': 0x66 };
export const formulaFunctionNames = [...Object.keys(unaryOps), 'min', 'max', ...mathNames];

export const legacySimulationFormat = [
  'Simulation must be an object with exactly three fields: locals (array of names), body (array of statements), result (expression).',
  'Expressions are finite numeric literals, names of input parameters or locals, or arrays [operator, operand, ...].',
  `Unary operators: ${[...Object.keys(unaryOps), ...mathNames.filter((name) => mathFunctions[name].length === 1)].join(', ')}.`,
  `Binary operators: ${[...Object.keys(binaryOps), ...Object.keys(compareOps), ...mathNames.filter((name) => mathFunctions[name].length === 2)].join(', ')}.`,
  'Comparisons yield 0 or 1. A condition is true when its numeric value is nonzero. A conditional expression is ["if", condition, whenTrue, whenFalse].',
  'Statements are ["set", localName, expression], ["while", condition, statementArray], or ["if", condition, trueStatementArray, optionalFalseStatementArray].',
  `Names are case sensitive and must match ${namePattern}. Locals begin at 0. Only locals can be assigned.`,
  `Use at most ${maxNames} total names, ${maxNodes} expression/statement nodes, ${maxDepth} levels of nesting, and ${fuelLimit} executed statements plus loop iterations.`,
  'Use the same program for both parameter sets. The runner prints the final result as a single number.',
].join('\n');

export const simulationFormat = [
  'Prefer a single arithmetic formula when it solves the task. Write it as ordinary math inside a JSON string.',
  'Use the exact input names, decimal constants, parentheses, +, -, *, / and ^ for powers. Multiply explicitly. ' +
    `Functions: ${formulaFunctionNames.join(', ')}. Use function calls like sqrt(x).`,
  'If the problem requires a loop, you can return {"simulation":{"locals":[...],"body":[...],"result":...}} instead.',
  'In this program form, write expressions as nested arrays such as ["+", ["*", "gain", "x"], "bias"]. ' +
    'Use ["set", localName, expression], ["while", condition, statementArray], or ["if", condition, trueStatementArray, falseStatementArray]. ' +
    'Comparisons use ==, !=, <, >, <= or >=. All assignments must name a declared local. Locals start at zero.',
  'Loop example for accumulating amount over count steps: ' +
    '{"simulation":{"locals":["i","total"],"body":[["while",["<","i","count"],[["set","total",["+","total","amount"]],["set","i",["+","i",1]]]]],"result":"total"}}',
  `Check the initial loop condition and update it each iteration. The sandbox allows ${fuelLimit} executed statements and loop iterations.`,
  'Complete example reply for a direct calculation:',
  '{"simulation":{"formula":"gain * x + bias"}}',
  'This example gives 7 for x=2, gain=3, bias=1, and 13 when x changes to 4. Use the relationship and input names of the actual task.',
].join('\n');

const f64 = 0x7c;
const i32 = 0x7f;
const end = 0x0b;
const localGet = 0x20;
const localSet = 0x21;

function requireValid(valid, message) {
  if (!valid) throw new Error(message);
}

function diagnosticName(value) {
  if (typeof value !== 'string') return `<${typeof value}>`;
  return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}...` : value);
}

function unsignedLeb128(value) {
  const bytes = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(value ? next | 0x80 : next);
  } while (value);
  return bytes;
}

function f64Constant(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  return [0x44, ...bytes];
}

function vector(items) {
  return [...unsignedLeb128(items.length), ...items.flat()];
}

function section(id, bytes) {
  return [id, ...unsignedLeb128(bytes.length), ...bytes];
}

function wasmName(value) {
  return vector([...Buffer.from(value)]);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compile(program, params, requireInput = false) {
  requireValid(isObject(program) && Object.keys(program).length === 3 && Object.hasOwn(program, 'result')
    && Array.isArray(program.locals) && Array.isArray(program.body),
  'Simulation must contain locals, body, and result.');
  requireValid(isObject(params), 'Simulation parameters must be an object.');

  const parameterNames = Object.keys(params);
  const names = [...parameterNames, ...program.locals];
  requireValid(names.length <= maxNames && new Set(names).size === names.length
    && names.every((name) => typeof name === 'string' && namePattern.test(name)),
  'Parameter and local names must be valid, unique, and within the name limit.');
  requireValid(Object.values(params).every(Number.isFinite), 'Simulation parameters must be finite numbers.');

  const indexes = new Map(names.map((name, index) => [name, unsignedLeb128(index)]));
  const inputs = new Set(parameterNames);
  const locals = new Set(program.locals);
  const fuelIndex = unsignedLeb128(names.length);
  let nodeCount = 0;
  let readsInput = false;

  function countNode(depth) {
    nodeCount += 1;
    requireValid(depth <= maxDepth && nodeCount <= maxNodes, 'Simulation exceeds the program size limit.');
  }

  function requireArity(node, arity) {
    requireValid(node.length === arity + 1,
      `Simulation operator ${diagnosticName(node[0])} has the wrong arity: expected ${arity} operands, got ${node.length - 1}.`);
  }

  function condition(value, depth) {
    return [...expression(value, depth), ...f64Constant(0), compareOps['!=']];
  }

  function expression(node, depth) {
    countNode(depth);
    if (Number.isFinite(node)) return f64Constant(node);
    if (typeof node === 'string') {
      requireValid(indexes.has(node), `Simulation references an unknown name ${diagnosticName(node)}.`);
      if (inputs.has(node)) readsInput = true;
      return [localGet, ...indexes.get(node)];
    }
    requireValid(Array.isArray(node) && typeof node[0] === 'string', 'Invalid simulation expression.');
    const [operator, left, right, otherwise] = node;
    if (operator === 'if') {
      requireArity(node, 3);
      return [...condition(left, depth + 1), 0x04, f64, ...expression(right, depth + 1),
        0x05, ...expression(otherwise, depth + 1), end];
    }
    if (Object.hasOwn(unaryOps, operator)) {
      requireArity(node, 1);
      return [...expression(left, depth + 1), unaryOps[operator]];
    }
    if (Object.hasOwn(binaryOps, operator)) {
      requireArity(node, 2);
      return [...expression(left, depth + 1), ...expression(right, depth + 1), binaryOps[operator]];
    }
    if (Object.hasOwn(compareOps, operator)) {
      requireArity(node, 2);
      return [...expression(left, depth + 1), ...expression(right, depth + 1), compareOps[operator], 0xb8];
    }
    requireValid(Object.hasOwn(mathFunctions, operator), `Simulation uses an unknown operator ${diagnosticName(operator)}.`);
    requireArity(node, mathFunctions[operator].length);
    const operands = node.slice(1).flatMap((operand) => expression(operand, depth + 1));
    return [...operands, 0x10, ...unsignedLeb128(mathNames.indexOf(operator))];
  }

  // Leave fuel - 1 in the local and trap if it reaches zero.
  const useFuel = [localGet, ...fuelIndex, 0x41, 1, 0x6b, 0x22, ...fuelIndex, 0x45,
    0x04, 0x40, 0x00, end];

  function statements(nodes, depth) {
    requireValid(Array.isArray(nodes), 'Simulation statement block must be an array.');
    return nodes.flatMap((node) => {
      countNode(depth);
      requireValid(Array.isArray(node), `Invalid simulation statement ${diagnosticName(node)}: expected an array.`);
      const [operator, first, second, third] = node;
      switch (operator) {
        case 'set':
          requireArity(node, 2);
          requireValid(locals.has(first), `Simulation can only assign to declared locals: ${diagnosticName(first)}.`);
          return [...useFuel, ...expression(second, depth + 1), localSet, ...indexes.get(first)];
        case 'while':
          requireArity(node, 2);
          return [0x02, 0x40, 0x03, 0x40, ...useFuel, ...condition(first, depth + 1),
            0x45, 0x0d, 1, ...statements(second, depth + 1), 0x0c, 0, end, end];
        case 'if': {
          requireValid(node.length === 3 || node.length === 4, 'Simulation if requires two or three operands.');
          const whenFalse = node.length === 4 ? [0x05, ...statements(third, depth + 1)] : [];
          return [...useFuel, ...condition(first, depth + 1), 0x04, 0x40,
            ...statements(second, depth + 1), ...whenFalse, end];
        }
        default:
          throw new Error(`Simulation uses an unknown statement ${diagnosticName(operator)}.`);
      }
    });
  }

  const type = (arity) => [0x60, ...vector(Array(arity).fill(f64)), ...vector([f64])];
  const imports = mathNames.map((name) => [
    ...wasmName('math'), ...wasmName(name), 0, mathFunctions[name].length - 1,
  ]);
  const wasmLocals = [[1, i32]];
  if (program.locals.length) wasmLocals.unshift([...unsignedLeb128(program.locals.length), f64]);
  // A positive signed LEB128 immediate needs one terminal zero if its sign bit is set.
  const fuelImmediate = unsignedLeb128(fuelLimit + 1);
  const finalByte = fuelImmediate.at(-1);
  if (finalByte & 0x40) fuelImmediate.splice(-1, 1, finalByte | 0x80, 0);
  const code = [...vector(wasmLocals), 0x41, ...fuelImmediate, localSet, ...fuelIndex,
    ...statements(program.body, 1), ...expression(program.result, 1), end];
  requireValid(!requireInput || (!Number.isFinite(program.result) && readsInput),
    'Simulation must read a named input parameter and cannot use a fixed numeric result.');
  return Uint8Array.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vector([type(1), type(2), type(parameterNames.length)])),
    ...section(2, vector(imports)),
    ...section(3, vector([2])),
    ...section(7, vector([[...wasmName('simulate'), 0, ...unsignedLeb128(imports.length)]])),
    ...section(10, vector([[...unsignedLeb128(code.length), ...code]])),
  ]);
}

async function executeChild() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    requireValid(size <= maxInputBytes, 'Simulation input exceeds the byte limit.');
    chunks.push(chunk);
  }
  const { program, params, requireInput = false } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const binary = compile(program, params, requireInput);
  const { instance } = await WebAssembly.instantiate(binary, { math: mathFunctions });
  const value = instance.exports.simulate(...Object.values(params));
  requireValid(Number.isFinite(value), 'Simulation result must be a finite number.');
  process.stdout.write(JSON.stringify(value));
}

export async function runSimulation(program, params, { timeoutMs = 3000, requireInput = false } = {}) {
  requireValid(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'Invalid sandbox timeout.');
  requireValid(typeof requireInput === 'boolean', 'Invalid simulation input requirement.');
  const input = JSON.stringify({ program, params, ...(requireInput ? { requireInput: true } : {}) });
  requireValid(Buffer.byteLength(input) <= maxInputBytes, 'Simulation input exceeds the byte limit.');
  const directory = await mkdtemp(join(tmpdir(), 'agent-experiment-'));
  const start = performance.now();
  const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
  try {
    const value = await new Promise((resolve, reject) => {
      const args = [
        '--permission', `--allow-fs-read=${sandboxFile}`, '--disallow-code-generation-from-strings',
        '--max-old-space-size=32', '--max-semi-space-size=2', '--stack-size=512', sandboxFile, childFlag,
      ];
      const child = execFile(process.execPath, args, {
        cwd: directory, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4096, windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          const message = error.killed ? 'Simulation exceeded the wall-time limit.' : stderr.trim();
          reject(new Error(message || `Sandbox process failed with ${error.code ?? 'unknown status'}.`));
          return;
        }
        const number = stdout.trim() === '' ? NaN : Number(stdout);
        if (Number.isFinite(number)) resolve(number);
        else reject(new Error('Simulation did not print a finite number.'));
      });
      child.stdin.on('error', () => {
        // The exit callback reports a failed or interrupted child.
      });
      child.stdin.end(input);
    });
    const elapsedMs = performance.now() - start;
    requireValid(elapsedMs <= timeoutMs, 'Simulation exceeded the wall-time limit.');
    return { value, seconds: elapsedMs / 1000 };
  } finally {
    await rmdir(directory);
  }
}

if (process.argv[1] === sandboxFile && process.argv[2] === childFlag) {
  try {
    await executeChild();
  } catch (error) {
    const message = error instanceof WebAssembly.RuntimeError ? 'Simulation exhausted its instruction budget.' : error.message;
    process.stderr.write(message);
    process.exitCode = 1;
  }
}
