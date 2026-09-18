import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EXIT, MAX_OUTPUT_BYTES } from '../../src/lib/constants.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = path.join(PACKAGE_ROOT, '.build');
const CHECKER = path.join(PACKAGE_ROOT, 'src/check-no-magic-constants.mjs');
const AUDIT = path.join(PACKAGE_ROOT, 'src/magic-numbers/audit.mjs');
const GIT_IDENTITY = ['-c', 'user.name=quality-control-tests', '-c', 'user.email=tests@quality-control.invalid'];
// Enough flagged lines that the checker's JSON report exceeds a pipe buffer; the report used to be cut there.
const FLAGGED_LINE_COUNT = 1500;
const SMALL_FLAGGED_LINE_COUNT = 4;

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
}

function git(args, cwd) {
  const result = run('git', [...GIT_IDENTITY, ...args], cwd);
  assert.equal(result.status, EXIT.clean, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixtureRoot(name) {
  mkdirSync(BUILD, { recursive: true });
  const root = path.join(BUILD, `magic-numbers-test-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root);
  return root;
}

function repository(workspace, name, files) {
  const directory = path.join(workspace, name);
  mkdirSync(directory);
  git(['init', '--quiet', '--initial-branch=main'], directory);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  }
  git(['add', '--all'], directory);
  git(['commit', '--quiet', '--message', 'Seed fixture'], directory);
  return directory;
}

function flaggedSource(lineCount) {
  const lines = [];
  for (let index = 0; index < lineCount; index += 1) lines.push(`let retries${index} = ${index + SMALL_FLAGGED_LINE_COUNT};`);
  return `${lines.join('\n')}\n`;
}

const CLEAN_SOURCE = 'export const RETRY_LIMIT = 3;\nexport function retries() {\n  return RETRY_LIMIT;\n}\n';
const RUST_SOURCE = 'pub const RETRY_LIMIT: u32 = 3;\npub fn retries() -> u32 {\n    let attempts = 5_u32;\n    attempts + RETRY_LIMIT\n}\n';
const RUST_TEST_SOURCE = 'fn ignored() -> u32 {\n    let attempts = 7;\n    attempts\n}\n';
const DISGUISED_SOURCE = [
  "const limit = Number('127');",
  'let width = "100%";',
  'if (Int("3") > 0) {}',
  'let port: u16 = "8080".parse().unwrap();',
  'let timeout = "120"',
  '    .parse::<u64>()',
  '    .expect("valid timeout");',
  'fn budget() -> u32 {',
  '    "30".parse().expect("static token budget")',
  '}',
  '*value ^= "54".parse::<u8>().expect("static ipad");',
  'sleep(Duration::from_secs("15".parse().expect("static number")));',
  ''
].join('\n');

test('checker --json reports every finding even when the report exceeds a pipe buffer', () => {
  const workspace = fixtureRoot('checker');
  try {
    const directory = repository(workspace, 'large', { 'src/retries.mjs': flaggedSource(FLAGGED_LINE_COUNT) });
    const result = run(process.execPath, [CHECKER, '--all', '--numbers-only', '--json'], directory);
    assert.equal(result.status, EXIT.findings, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.violations.length, FLAGGED_LINE_COUNT);
    assert.equal(report.checkedFiles, 1);
    assert.equal(report.violations.at(-1).line, FLAGGED_LINE_COUNT);
    assert.equal(report.violations.at(-1).rule, 'magic-number');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('checker scans Rust sources, skips the tests directory, and passes named constants', () => {
  const workspace = fixtureRoot('rust');
  try {
    const directory = repository(workspace, 'crate', { 'src/lib.rs': RUST_SOURCE, 'tests/retries.rs': RUST_TEST_SOURCE });
    const result = run(process.execPath, [CHECKER, '--all', '--numbers-only', '--json'], directory);
    assert.equal(result.status, EXIT.findings, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checkedFiles, 1);
    assert.deepEqual(report.violations.map(violation => [violation.file, violation.line, violation.detail]), [
      ['src/lib.rs', RUST_SOURCE.split('\n').findIndex(line => line.includes('5_u32')) + 1, 'number literal 5 is embedded in logic']
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('checker flags a number written as a string for a parser and leaves a dimension alone', () => {
  const workspace = fixtureRoot('disguised');
  try {
    const directory = repository(workspace, 'site', { 'src/limits.mjs': DISGUISED_SOURCE });
    const result = run(process.execPath, [CHECKER, '--all', '--numbers-only', '--json'], directory);
    assert.equal(result.status, EXIT.findings, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.violations.map(violation => [violation.line, violation.detail]), [
      [1, 'number literal 127 is hidden in a string'],
      [3, 'number literal 3 is hidden in a string'],
      [4, 'number literal 8080 is hidden in a string'],
      [5, 'number literal 120 is hidden in a string'],
      [9, 'number literal 30 is hidden in a string'],
      [11, 'number literal 54 is hidden in a string'],
      [12, 'number literal 15 is hidden in a string']
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('fleet audit records every repository, skips other directories, and exits with findings', () => {
  const workspace = fixtureRoot('audit');
  const output = path.join(BUILD, `${path.basename(workspace)}-out`);
  try {
    repository(workspace, 'clean', { 'src/retries.mjs': CLEAN_SOURCE });
    const flaggedDirectory = repository(workspace, 'flagged', { 'src/retries.mjs': flaggedSource(SMALL_FLAGGED_LINE_COUNT) });
    mkdirSync(path.join(workspace, 'notes'));
    writeFileSync(path.join(workspace, 'README.md'), 'not a repository\n');

    const result = run(process.execPath, [AUDIT, '--workspace', workspace, '--checker', 'magic-numbers', '--output', output], PACKAGE_ROOT);
    assert.equal(result.status, EXIT.findings, result.stderr);

    const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8'));
    assert.equal(report.counts.repositories, ['clean', 'flagged'].length);
    assert.equal(report.counts.clean, ['clean'].length);
    assert.equal(report.counts.findings, ['flagged'].length);
    assert.equal(report.counts.error, [].length);
    assert.equal(report.counts.violations, SMALL_FLAGGED_LINE_COUNT);
    assert.deepEqual(report.skipped.map(entry => entry.name).sort(), ['README.md', 'notes']);
    const flagged = report.repositories.find(record => record.name === 'flagged');
    assert.equal(flagged.result, 'findings');
    assert.equal(flagged.branch, 'main');
    assert.equal(flagged.revision, git(['rev-parse', 'HEAD'], flaggedDirectory));
    assert.equal(flagged.violations[0].file, 'src/retries.mjs');
    assert.ok(existsSync(path.join(output, 'flagged', 'stdout.json')));
    assert.ok(existsSync(path.join(output, 'flagged', 'execution.json')));
    assert.equal(report.repositories.find(record => record.name === 'clean').result, 'clean');
    assert.equal(report.checker.revision, git(['rev-parse', 'HEAD'], PACKAGE_ROOT));
    assert.equal(typeof report.finishedAt, 'string');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('fleet audit exits clean when no repository has findings', () => {
  const workspace = fixtureRoot('clean');
  const output = path.join(BUILD, `${path.basename(workspace)}-out`);
  try {
    repository(workspace, 'clean', { 'src/retries.mjs': CLEAN_SOURCE });
    const result = run(process.execPath, [AUDIT, '--workspace', workspace, '--checker', 'magic-numbers', '--output', output], PACKAGE_ROOT);
    assert.equal(result.status, EXIT.clean, result.stderr);
    const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8'));
    assert.equal(report.counts.findings, [].length);
    assert.equal(report.counts.violations, [].length);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('fleet audit refuses a missing workspace and an output outside its build directory', () => {
  const missing = run(process.execPath, [AUDIT], PACKAGE_ROOT);
  assert.equal(missing.status, EXIT.error);
  assert.match(missing.stderr, /^--workspace is required$/m);
  assert.match(missing.stderr, /usage: node src\/magic-numbers\/audit\.mjs --workspace <directory>/);

  const workspace = fixtureRoot('refusal');
  try {
    const outside = run(process.execPath, [AUDIT, '--workspace', workspace, '--checker', 'magic-numbers', '--output', path.join(workspace, 'out')], PACKAGE_ROOT);
    assert.equal(outside.status, EXIT.error);
    assert.match(outside.stderr, /^--output must be a new direct child of quality-control\/\.build$/m);
    assert.equal(existsSync(path.join(workspace, 'out')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
