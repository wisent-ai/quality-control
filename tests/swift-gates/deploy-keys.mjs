#!/usr/bin/env node
// Runs swift-gates' "Configure private Git dependency deploy keys" step the way
// the runner runs it, from the committed workflow text:
//
//   QUALITY_CONTROL_DEPLOY_KEYS=<the secret's text> node tests/swift-gates/deploy-keys.mjs
//
// Each malformed `repository_deploy_keys` line must be refused naming what is
// wrong with it and how to write it again. With the real secret, every
// repository it names must then be read through plain git, with no global or
// system git configuration, exactly as SwiftPM fetches it. The report lands in
// .build/swift-gates-deploy-keys/<run>/report.json.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXIT } from '../../src/lib/constants.mjs';

const root = resolve(import.meta.dirname, '../..');
const secret = process.env.QUALITY_CONTROL_DEPLOY_KEYS;
assert.ok(
  secret,
  'QUALITY_CONTROL_DEPLOY_KEYS must hold the repository_deploy_keys secret text: one "<owner>/<repository> <base64 OpenSSH private key>" line per private package',
);

const STEP = '- name: Configure private Git dependency deploy keys';
const workflow = (await readFile(join(root, '.github/workflows/swift-gates.yml'), 'utf8')).split('\n');
const stepAt = workflow.findIndex((line) => line.trim() === STEP);
assert.notEqual(stepAt, -1, `swift-gates.yml has no step "${STEP}"`);
const runAt = workflow.findIndex((line, index) => index > stepAt && line.trim() === 'run: |');
assert.notEqual(runAt, -1, `the step "${STEP}" has no "run: |" block`);
const runIndent = workflow[runAt].search(/\S/);
const body = [];
for (const line of workflow.slice(runAt + 1)) {
  if (line.trim() && line.search(/\S/) <= runIndent) break;
  body.push(line);
}
const indent = body.find((line) => line.trim()).search(/\S/);
const script = body.map((line) => line.slice(indent)).join('\n');

const output = join(root, '.build/swift-gates-deploy-keys', randomUUID());
await mkdir(output, { recursive: true });
const runs = [];

const step = async (name, keys) => {
  const temp = join(output, name);
  const home = join(temp, 'home');
  await mkdir(home, { recursive: true });
  const githubEnv = join(temp, 'github-env');
  await writeFile(githubEnv, '');
  const result = spawnSync('bash', ['-e', '-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, RUNNER_TEMP: temp, GITHUB_ENV: githubEnv, REPOSITORY_DEPLOY_KEYS: keys },
  });
  const exported = Object.fromEntries(
    (await readFile(githubEnv, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  runs.push({ name, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, exported: Object.keys(exported) });
  return { ...result, exported, home };
};

const refused = async (name, keys, words) => {
  const result = await step(name, keys);
  assert.notEqual(result.status, EXIT.clean, `${name}: the step accepted ${JSON.stringify(keys)}`);
  assert.ok(result.stderr.includes(words), `${name}: the refusal does not say "${words}": ${result.stderr}`);
};

let failure;
try {
  const empty = await step('empty', '');
  assert.equal(empty.status, EXIT.clean, empty.stderr);
  assert.match(empty.stdout, /No repository_deploy_keys/);
  assert.deepEqual(Object.keys(empty.exported), []);

  const shape = "is not '<owner>/<repository> <base64 of the OpenSSH private key>'";
  await refused('no-key', 'wisent-ai/echo', shape);
  await refused('no-owner', 'echo AAAA', shape);
  await refused('extra-word', 'wisent-ai/echo AAAA more', shape);
  await refused('not-base64', 'wisent-ai/echo !!!', 'is not base64');
  await refused('not-a-key', `wisent-ai/echo ${Buffer.from('not a key').toString('base64')}`, 'is not an OpenSSH private key');

  const real = await step('real', secret);
  assert.equal(real.status, EXIT.clean, real.stderr);
  const repositories = secret.split('\n').filter((line) => line.trim()).map((line) => line.trim().split(' ')[0]);
  assert.equal(Number(real.exported.GIT_CONFIG_COUNT), repositories.length);
  for (const repository of repositories) {
    const read = spawnSync('git', ['ls-remote', `https://github.com/${repository}.git`, 'HEAD'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: real.home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...real.exported,
      },
    });
    runs.push({ name: `ls-remote ${repository}`, status: read.status, signal: read.signal, stdout: read.stdout, stderr: read.stderr });
    assert.equal(read.status, EXIT.clean, `git could not read ${repository} through its deploy key: ${read.stderr}`);
    assert.match(read.stdout, /^[0-9a-f]{40}\tHEAD$/m, `git read ${repository} but named no HEAD: ${read.stdout}`);
  }
} catch (error) {
  failure = error;
}
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
await writeFile(
  join(output, 'report.json'),
  `${JSON.stringify({ revision: revision.stdout.trim(), passed: !failure, failure: failure?.message, runs }, null, 2)}\n`,
);
console.log(`report: ${join(output, 'report.json')}`);
if (failure) throw failure;
