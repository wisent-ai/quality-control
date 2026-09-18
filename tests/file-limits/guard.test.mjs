import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EXIT, MAX_OUTPUT_BYTES } from '../../src/lib/constants.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = path.join(PACKAGE_ROOT, '.build');
const CHECKER = path.join(PACKAGE_ROOT, 'src/check-file-limits.mjs');
const AUDIT = path.join(PACKAGE_ROOT, 'src/magic-numbers/audit.mjs');
const GIT_IDENTITY = ['-c', 'user.name=quality-control-tests', '-c', 'user.email=tests@quality-control.invalid'];
// The limits under test: the hooks' 300 lines and five files.
const MAX_FILE_LINES = 300;
const MAX_FOLDER_FILES = 5;

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
  const root = path.join(BUILD, `file-limits-test-${name}-${process.pid}-${Date.now()}`);
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

function sourceOf(lineCount) {
  return `${Array.from({ length: lineCount }, (_, index) => `export const line${index} = '${index}';`).join('\n')}\n`;
}

function folderOf(folder, fileCount) {
  return Object.fromEntries(Array.from({ length: fileCount }, (_, index) => [`${folder}/module${index}.mjs`, sourceOf(1)]));
}

test('a file over the line limit and a folder over the file limit are findings; the limits themselves are not', () => {
  const workspace = fixtureRoot('findings');
  try {
    const directory = repository(workspace, 'crowded', {
      'src/long.mjs': sourceOf(MAX_FILE_LINES + 1),
      'src/exact.mjs': sourceOf(MAX_FILE_LINES),
      ...folderOf('lib', MAX_FOLDER_FILES + 1),
      ...folderOf('ok', MAX_FOLDER_FILES),
    });
    const result = run(process.execPath, [CHECKER, '--all', '--json'], directory);
    assert.equal(result.status, EXIT.findings, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.violations.map(violation => [violation.file, violation.rule]),
      [['lib', 'folder-files'], ['src/long.mjs', 'file-lines']]
    );
    assert.match(report.violations[1].detail, new RegExp(`^${MAX_FILE_LINES + 1} lines`));
    const text = run(process.execPath, [CHECKER, '--all'], directory);
    assert.equal(text.status, EXIT.findings);
    assert.match(text.stderr, /src\/long\.mjs: file-lines/);
    assert.match(text.stderr, /lib: folder-files/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('registries, manuscripts, tokenizer lists, rendered files, test trees and migrations are exempt, as the write hooks exempt them', () => {
  const workspace = fixtureRoot('exempt');
  try {
    const directory = repository(workspace, 'exempt', {
      'data/registry.json': `[${Array.from({ length: MAX_FILE_LINES + 1 }, () => '0').join(',\n')}]\n`,
      'paper/main.tex': sourceOf(MAX_FILE_LINES + 1),
      'checkpoint/merges.txt': Array.from({ length: MAX_FILE_LINES + 1 }, (_, i) => `a b${i}`).join('\n') + '\n',
      'dist/bundle.py': `# Generated from src/ by tools/render.py; do not edit.\n${sourceOf(MAX_FILE_LINES + 1)}`,
      ...folderOf('tests/unit', MAX_FOLDER_FILES + 1),
      ...folderOf('supabase/migrations', MAX_FOLDER_FILES + 1),
      'src/index.mjs': sourceOf(1),
    });
    const result = run(process.execPath, [CHECKER, '--all', '--json'], directory);
    assert.equal(result.status, EXIT.clean, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).violations, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the guard refuses to run without --all', () => {
  const result = run(process.execPath, [CHECKER], PACKAGE_ROOT);
  assert.equal(result.status, EXIT.error);
  assert.match(result.stderr, /--all is required/);
});

test('the fleet audit runs the file-limits guard when asked and records which guard ran', () => {
  const workspace = fixtureRoot('audit');
  const output = path.join(BUILD, `file-limits-audit-${process.pid}-${Date.now()}`);
  try {
    repository(workspace, 'crowded', folderOf('lib', MAX_FOLDER_FILES + 1));
    repository(workspace, 'tidy', { 'src/index.mjs': sourceOf(1) });
    const result = run(process.execPath, [AUDIT, '--workspace', workspace, '--checker', 'file-limits', '--output', output], PACKAGE_ROOT);
    assert.equal(result.status, EXIT.findings, result.stderr);
    const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8'));
    assert.equal(report.checker.name, 'file-limits');
    assert.deepEqual(report.repositories.map(record => [record.name, record.result]), [['crowded', 'findings'], ['tidy', 'clean']]);
    assert.equal(readFileSync(path.join(output, 'ranking.tsv'), 'utf8'), '1\tcrowded\n');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});
