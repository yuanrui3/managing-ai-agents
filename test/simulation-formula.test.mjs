import assert from 'node:assert/strict';
import test from 'node:test';
import { formulaProgram } from '../src/simulation-formula.mjs';
import { runSimulation } from '../src/sandbox.mjs';

function rejectsFormula(source, pattern) {
  assert.throws(() => formulaProgram(source), error => {
    assert.ok(error instanceof SyntaxError);
    assert.match(error.message, /at character \d+\./);
    if (pattern) assert.match(error.message, pattern);
    assert.ok(error.message.length < 250);
    return true;
  });
}

test('ordinary formulas become numeric ASTs with no assignments or interpreter source', async () => {
  const program = formulaProgram(' gain * x + bias ');
  assert.deepEqual(program, { locals: [], body: [], result: ['+', ['*', 'gain', 'x'], 'bias'] });
  assert.equal((await runSimulation(program, { gain: 3, x: 2, bias: 1 }, { requireInput: true })).value, 7);
  assert.equal((await runSimulation(program, { gain: 3, x: 4, bias: 1 }, { requireInput: true })).value, 13);
  assert.deepEqual(formulaProgram('\n(_x2 + 1.e2) / .5\t').result, ['/', ['+', '_x2', 100], 0.5]);
  assert.deepEqual(formulaProgram('1e-3 + 2E+2').result, ['+', 0.001, 200]);
});

test('powers bind more tightly than unary signs and associate to the right', async () => {
  assert.deepEqual(formulaProgram('-2^2').result, ['neg', ['pow', 2, 2]]);
  assert.deepEqual(formulaProgram('2^-2').result, ['pow', 2, ['neg', 2]]);
  assert.deepEqual(formulaProgram('2**3^2').result, ['pow', 2, ['pow', 3, 2]]);
  const cases = [
    ['-2^2', -4], ['(-2)^2', 4], ['2^-2', 0.25], ['2**-2', 0.25],
    ['2^3^2', 512], ['2**3^2', 512], ['-2^-2', -0.25], ['1-2-3', -4],
    ['8/4/2', 1], ['2*-3^2', -18], ['--2^2', 4], ['+-2', -2],
    ['2^+3', 8], ['(2+3)*4', 20], ['2^(-2)^2', 16], ['(-2)^-2', 0.25],
  ];
  for (const [source, expected] of cases) {
    assert.equal((await runSimulation(formulaProgram(source), {})).value, expected, source);
  }
});

test('allowlisted functions accept nested comma-separated arithmetic arguments', async () => {
  const program = formulaProgram('sqrt(16) + abs(-3) + max(2, min(8,5)) + pow(2,3)');
  assert.equal((await runSimulation(program, {})).value, 20);
  assert.equal((await runSimulation(formulaProgram('mod(7,4) + hypot(3,4)'), {})).value, 8);
  assert.equal((await runSimulation(formulaProgram('log1p(0)+expm1(0)+atan2(0,1)'), {})).value, 0);
  assert.equal((await runSimulation(formulaProgram('neg(2) + floor(2.9) + ceil(1.1)'), {})).value, 2);
});

test('the sandbox retains responsibility for parameter membership, function arity and finite results', async () => {
  assert.deepEqual(formulaProgram('sin()').result, ['sin']);
  await assert.rejects(runSimulation(formulaProgram('sin()'), {}), /wrong arity/);
  await assert.rejects(runSimulation(formulaProgram('pow(2,3,4)'), {}), /wrong arity/);
  await assert.rejects(runSimulation(formulaProgram('missing + 1'), { x: 2 }), /unknown name "missing"/);
  await assert.rejects(runSimulation(formulaProgram('1/0'), {}), /finite number/);
  await assert.rejects(runSimulation(formulaProgram('sqrt(-1)'), {}), /finite number/);
});

test('invalid characters, unsafe calls and nonfinite constants receive controlled syntax errors', () => {
  for (const source of [
    'x.y', 'Math.sqrt(4)', 'process.exit()', 'x[0]', '[1,2]', '{x:1}',
    'x=1', 'x+=1', 'x;1', 'x=>1', 'x ? 1 : 2', '1%2', '1&2', '1<2',
    '"x"', "'x'", '`x`', '1/* comment */+2', '1//comment', '∞', '\0',
    'fetch(1)', 'constructor(1)', 'eval(1)', '__proto__(1)', 'round(1)',
    'Infinity', '-Infinity', 'NaN', '1e309', '9.99E999',
  ]) rejectsFormula(source);
  rejectsFormula('x + @', /character 5/);
  rejectsFormula('x.y', /character 2/);
  rejectsFormula('fetch(1)', /Unknown formula function "fetch"/);
});

test('malformed operands, separators, parentheses and trailing text are rejected', () => {
  for (const source of [
    '', '   ', '+', '1+', '*2', '2***3', '1..2', '.', '1e', '1e-', '1_000', '0x10',
    '()', '(1', '1)', 'sin(1', 'sin(,1)', 'sin(1,)', 'sin(1,,2)', 'sin(1 2)',
    '(1,2)', '1 2', 'x y', '2(x+1)', 'sin(1)(2)', 'x and y',
  ]) rejectsFormula(source);
  rejectsFormula('(1+2', /Missing closing '\)'/);
  rejectsFormula('sin(1', /Missing closing '\)'/);
});

test('source, tokens, syntax recursion and generated AST depth have hard limits', () => {
  rejectsFormula(' '.repeat(4097), /character limit/);
  rejectsFormula(`max(${Array(600).fill('1').join(',')})`, /token limit/);
  rejectsFormula('('.repeat(33) + 'x' + ')'.repeat(33), /nesting limit/);
  rejectsFormula('-'.repeat(80) + 'x', /nesting limit/);
  rejectsFormula('+'.repeat(80) + 'x', /nesting limit/);
  rejectsFormula(Array(80).fill('x').join('^'), /nesting limit/);
  rejectsFormula(Array(80).fill('x').join('+'), /expression depth limit/);
  rejectsFormula('sqrt('.repeat(33) + 'x' + ')'.repeat(33), /nesting limit/);
  rejectsFormula('x'.repeat(33), /names must contain at most 32/);
  for (const source of [null, undefined, 1, {}, []]) rejectsFormula(source, /must be a string/);
});
