import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EXIT, MAX_OUTPUT_BYTES } from '../../src/lib/constants.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = path.join(PACKAGE_ROOT, '.build');
const CHECKER = path.join(PACKAGE_ROOT, 'src/check-no-fallbacks.mjs');
const GIT_IDENTITY = ['-c', 'user.name=quality-control-tests', '-c', 'user.email=tests@quality-control.invalid'];

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
}

function git(args, cwd) {
  const result = run('git', [...GIT_IDENTITY, ...args], cwd);
  assert.equal(result.status, EXIT.clean, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(name, files) {
  mkdirSync(BUILD, { recursive: true });
  const directory = path.join(BUILD, `no-fallbacks-test-${name}-${process.pid}-${Date.now()}`);
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

function report(directory) {
  const result = run(process.execPath, [CHECKER, '--all', '--json'], directory);
  return { status: result.status, violations: JSON.parse(result.stdout).violations, stderr: result.stderr };
}

test('a positional dictionary substitute, a nullish substitute and an optional try are findings', () => {
  const directory = repository('findings', {
    'src/config.py': 'value = settings.get("timeout", 30)\n',
    'src/config.mjs': 'const port = options.port ?? 8080;\n',
    'Sources/App/Config.swift': 'let data = try? Data(contentsOf: url)\n',
  });
  try {
    const { status, violations } = report(directory);
    assert.equal(status, EXIT.findings);
    assert.deepEqual(
      violations.map(violation => [violation.file, violation.rule]).sort(),
      [['Sources/App/Config.swift', 'optional-try'], ['src/config.mjs', 'nullish-default'], ['src/config.py', 'dictionary-default']]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boolean logic around a logical-or is not a substitute; a value on its right is', () => {
  const directory = repository('boolean', {
    'src/filter.js': [
      'const visible = !query || haystack.includes(query);',
      'const ready = count > limit || state === "done";',
      'if (',
      '  sessionFile &&',
      '  reason !== Shutdown &&',
      '  (closedByHand || finished)',
      ') {',
      '  retire(sessionFile);',
      '}',
      '',
    ].join('\n'),
    'src/port.js': 'const port = options.port || 8080;\n',
  });
  try {
    const { status, violations } = report(directory);
    assert.equal(status, EXIT.findings);
    assert.deepEqual(violations.map(violation => [violation.file, violation.rule]), [['src/port.js', 'logical-default']]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an HTTP get with keyword arguments and a lookup compared afterwards are not dictionary substitutes', () => {
  const directory = repository('lookups', {
    'src/client.py': [
      'def list_vectors(self, params):',
      '    return self.http_client.get("/control_vectors", params=params)',
      '',
      'def is_valid(loaded):',
      '    return isinstance(loaded.get("attempts"), dict)',
      '',
      'def same_journey(bundle):',
      '    return bundle.get("journey_version_id") not in (None, JOURNEY_VERSION_ID)',
      '',
    ].join('\n'),
  });
  try {
    const { status, violations, stderr } = report(directory);
    assert.deepEqual(violations, []);
    assert.equal(status, EXIT.clean, stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
