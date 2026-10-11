import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join, basename, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EXIT } from '../../src/lib/constants.mjs';

const root = resolve(import.meta.dirname, '../..');
assert.ok(process.env.QUALITY_CONTROL_HEADER_FIXTURE, 'QUALITY_CONTROL_HEADER_FIXTURE is required');
const fixture = JSON.parse(await readFile(process.env.QUALITY_CONTROL_HEADER_FIXTURE, 'utf8'));
assert.ok(fixture.revision && fixture.repository && fixture.limits, 'fixture requires revision, repository and limits');
for (const kind of ['block', 'docstring', 'afterCode']) {
  assert.equal(typeof fixture.cases?.[kind], 'string', `fixture.cases.${kind} must name a real tracked file`);
}
const output = join(root, '.build/header-qualification', randomUUID());
await mkdir(output, { recursive: true });
const commands = [];
const run = (executable, args, cwd) => {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  commands.push({ executable, args, cwd, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  return result;
};
let failure;
const observed = {};
try {
  const source = run('git', ['rev-parse', 'HEAD'], root);
  assert.equal(source.status, EXIT.clean, source.stderr);
  assert.equal(source.stdout.trim(), fixture.revision);
  const dirty = run('git', ['status', '--porcelain'], root);
  assert.equal(dirty.status, EXIT.clean, dirty.stderr);
  assert.equal(dirty.stdout, '', 'qualification requires committed checker source');
  const repository = resolve(fixture.repository);
  const state = run('git', ['rev-parse', 'HEAD'], repository);
  assert.equal(state.status, EXIT.clean, state.stderr);
  observed.repositoryRevision = state.stdout.trim();
  const limits = JSON.parse(await readFile(fixture.limits, 'utf8'));
  const maximum = limits.max_file_lines?.value;
  assert.ok(Number.isSafeInteger(maximum), 'fixture limits must declare the actual line limit');
  for (const [kind, file] of Object.entries(fixture.cases)) {
    assert.equal(basename(file), file, 'qualification inputs must be root files, not excluded trees');
    assert.ok(['.js', '.py'].includes(extname(file)), 'qualification requires non-exempt source extensions');
    const tracked = run('git', ['ls-files', '--error-unmatch', '--', file], repository);
    assert.equal(tracked.status, EXIT.clean, tracked.stderr);
    const bytes = await readFile(join(repository, file));
    const text = bytes.toString('utf8');
    assert.equal(bytes.includes('\0'), false, 'qualification sources must not be binary assets');
    const leading = text.trimStart();
    if (kind === 'block') {
      assert.ok(leading.startsWith('/*\n'), 'block case must begin a multiline block comment');
      assert.ok(leading.includes('\ngenerated\n') && leading.includes('\ndo not edit\n'),
        'block notice must occur on interior lines without comment prefixes');
    } else if (kind === 'docstring') {
      assert.ok(leading.startsWith('"""\n'), 'docstring case must begin a multiline docstring');
      assert.ok(leading.includes('\ngenerated\n') && leading.includes('\ndo not edit\n'),
        'docstring notice must occur on interior lines');
    } else {
      assert.ok(leading.startsWith('const '), 'afterCode case must begin actual JavaScript');
      assert.ok(leading.includes('generated') && leading.includes('do not edit'), 'late notice is required');
    }
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    assert.ok(lines.length > maximum, `${file} must genuinely exceed the declared limit`);
    observed[kind] = { file, lines: lines.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const result = run(process.execPath, [join(root, 'src/check-file-limits.mjs'), '--all', '--limits', resolve(fixture.limits), '--json'], repository);
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, EXIT.findings, result.stderr);
  const report = JSON.parse(result.stdout);
  for (const kind of ['block', 'docstring']) {
    assert.equal(report.violations.some(item => item.file === fixture.cases[kind] && item.rule === 'file-lines'), false,
      `${kind} generated header was not recognized through its actual closing delimiter`);
  }
  assert.equal(report.violations.some(item => item.file === fixture.cases.afterCode && item.rule === 'file-lines'), true,
    'a generated notice after actual code must not exempt that file');
  observed.report = report;
} catch (error) {
  failure = { cause: String(error), stack: error.stack };
  process.exitCode = EXIT.findings;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ fixture, commands, observed, failure }, null, '\t'));
}
if (failure) throw new Error(failure.cause);
