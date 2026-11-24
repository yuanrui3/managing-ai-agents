import { formulaFunctionNames } from './sandbox.mjs';

const maxCharacters = 4096;
const maxTokens = 1200;
const maxNodes = 1200;
const maxDepth = 32;
const functions = new Set(formulaFunctionNames);
const binaryOperators = new Map([
  ['+', { left: 10, right: 11, ast: '+' }],
  ['-', { left: 10, right: 11, ast: '-' }],
  ['*', { left: 20, right: 21, ast: '*' }],
  ['/', { left: 20, right: 21, ast: '/' }],
  ['^', { left: 40, right: 40, ast: 'pow' }],
]);

function fail(message, position) {
  throw new SyntaxError(`${message} at character ${position + 1}.`);
}

function tokenize(source) {
  const tokens = [];
  let position = 0;
  while (position < source.length) {
    if (/\s/.test(source[position])) {
      position += 1;
      continue;
    }
    if (tokens.length === maxTokens) fail(`Formula exceeds the ${maxTokens}-token limit`, position);
    const start = position;
    const rest = source.slice(position);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)?.[0];
    if (number !== undefined) {
      const value = Number(number);
      if (!Number.isFinite(value)) fail('Numeric literals must be finite', start);
      tokens.push({ kind: 'number', value, position: start });
      position += number.length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
    if (name !== undefined) {
      if (name.length > 32) fail('Input and function names must contain at most 32 characters', start);
      if (name === 'Infinity' || name === 'NaN') fail('Nonfinite numeric constants are not supported', start);
      tokens.push({ kind: 'name', value: name, position: start });
      position += name.length;
      continue;
    }
    const operator = rest.startsWith('**') ? '**' : source[position];
    if (!['+', '-', '*', '/', '^', '(', ')', ','].includes(operator) && operator !== '**') {
      fail(`Unsupported character ${JSON.stringify(source[position])}; use arithmetic expressions only`, start);
    }
    tokens.push({ kind: operator === '**' ? '^' : operator, value: operator, position: start });
    position += operator.length;
  }
  tokens.push({ kind: 'end', position: source.length });
  return tokens;
}

/** Translate bounded arithmetic text to the numeric simulation AST without evaluating it. */
export function formulaProgram(source) {
  if (typeof source !== 'string') fail('Formula source must be a string', 0);
  if (source.length > maxCharacters) fail(`Formula exceeds the ${maxCharacters}-character limit`, maxCharacters);
  const tokens = tokenize(source);
  let index = 0;
  let nodes = 0;
  const current = () => tokens[index];
  const take = () => tokens[index++];

  function node(value, depth, position) {
    nodes += 1;
    if (nodes > maxNodes) fail(`Formula exceeds the ${maxNodes}-node limit`, position);
    if (depth > maxDepth) fail(`Formula exceeds the ${maxDepth}-level expression depth limit`, position);
    return { value, depth };
  }

  function expectClose() {
    if (current().kind !== ')') fail("Missing closing ')'", current().position);
    take();
  }

  function prefix(depth) {
    const token = take();
    if (token.kind === 'number') return node(token.value, 1, token.position);
    if (token.kind === '+' || token.kind === '-') {
      // Power binds more tightly than unary signs; its right operand may itself have a sign.
      const operand = expression(30, depth + 1);
      return token.kind === '+' ? operand : node(['neg', operand.value], operand.depth + 1, token.position);
    }
    if (token.kind === '(') {
      const grouped = expression(0, depth + 1);
      expectClose();
      return grouped;
    }
    if (token.kind === 'name') {
      if (current().kind !== '(') return node(token.value, 1, token.position);
      if (!functions.has(token.value)) fail(`Unknown formula function ${JSON.stringify(token.value)}`, token.position);
      take();
      const args = [];
      if (current().kind !== ')') {
        while (true) {
          args.push(expression(0, depth + 1));
          if (current().kind !== ',') break;
          take();
        }
      }
      expectClose();
      return node([token.value, ...args.map(arg => arg.value)],
        1 + Math.max(0, ...args.map(arg => arg.depth)), token.position);
    }
    const found = token.kind === 'end' ? 'end of input' : JSON.stringify(token.value);
    fail(`Expected a number, input name, or expression; found ${found}`, token.position);
  }

  function expression(minimum, depth) {
    if (depth > maxDepth) fail(`Formula exceeds the ${maxDepth}-level nesting limit`, current().position);
    let left = prefix(depth);
    while (true) {
      const operator = binaryOperators.get(current().kind);
      if (!operator || operator.left < minimum) break;
      const token = take();
      const right = expression(operator.right, depth + 1);
      left = node([operator.ast, left.value, right.value], 1 + Math.max(left.depth, right.depth), token.position);
    }
    return left;
  }

  const result = expression(0, 0);
  if (current().kind !== 'end') fail('Unexpected trailing text; use an explicit arithmetic operator', current().position);
  return { locals: [], body: [], result: result.value };
}
