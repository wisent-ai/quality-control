#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EXIT, REPORT_SCHEMA_VERSION, MAX_OUTPUT_BYTES, RESULT } from '../lib/constants.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The guards a fleet audit can run: the script and the flags that make it read the whole tree.
const CHECKERS = {
  'magic-numbers': { script: 'src/check-no-magic-constants.mjs', flags: ['--all', '--numbers-only', '--json'] },
  'file-limits': { script: 'src/check-file-limits.mjs', flags: ['--all', '--json'] },
  'fallbacks': { script: 'src/check-no-fallbacks.mjs', flags: ['--all', '--json'] },
};

// A command that could not be started at all is an error here and now, not a record
// with empty output; what the command printed is then always a string.
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error) throw new Error(`${[command, ...args].join(' ')}: ${result.error.message}`);
  return { command: [command, ...args], exitStatus: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

function git(args, cwd) {
  const result = run('git', args, cwd);
  if (result.exitStatus !== EXIT.clean) {
    throw new Error(`${result.command.join(' ')}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  const skip = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--skip') {
      skip.add(value);
      continue;
    }
    if (!['--workspace', '--output', '--checker'].includes(key) || options[key]) throw new Error(`unknown or repeated argument: ${key}`);
    options[key] = value;
  }
  for (const required of ['--workspace', '--checker', '--output']) {
    if (!options[required]) throw new Error(`${required} is required`);
  }
  const checkerName = options['--checker'];
  if (!CHECKERS[checkerName]) throw new Error(`--checker must be one of ${Object.keys(CHECKERS).join(', ')}`);
  const workspace = realpathSync(options['--workspace']);
  const build = path.join(PACKAGE_ROOT, '.build');
  mkdirSync(build, { recursive: true });
  const output = path.resolve(options['--output']);
  // A direct child prevents symlinked parents from writing outside the owned build directory.
  if (path.dirname(output) !== build || realpathSync(build) !== build) throw new Error('--output must be a new direct child of quality-control/.build');
  if (existsSync(output)) throw new Error(`output already exists: ${output}`);
  return { workspace, output, skip, checkerName };
}

function main() {
  const { workspace, output, skip, checkerName } = parseArgs();
  const checkerScript = path.join(PACKAGE_ROOT, CHECKERS[checkerName].script);
  const entries = readdirSync(workspace, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const checker = {
    name: checkerName,
    revision: git(['rev-parse', 'HEAD'], PACKAGE_ROOT),
    status: git(['status', '--porcelain'], PACKAGE_ROOT),
    sha256: createHash('sha256').update(readFileSync(checkerScript)).digest('hex'),
  };
  mkdirSync(output);
  const report = { schemaVersion: REPORT_SCHEMA_VERSION, startedAt: new Date().toISOString(), workspace, checker, repositories: [], skipped: [] };
  for (const entry of entries) {
    const directory = path.join(workspace, entry.name);
    if (!entry.isDirectory() || !existsSync(path.join(directory, '.git'))) {
      report.skipped.push({ name: entry.name, reason: 'not an immediate Git repository directory' });
      continue;
    }
    if (skip.has(entry.name)) {
      report.skipped.push({ name: entry.name, reason: 'named by --skip' });
      continue;
    }
    const record = { name: entry.name, directory };
    report.repositories.push(record);
    try {
      const root = realpathSync(git(['rev-parse', '--show-toplevel'], directory));
      if (root !== realpathSync(directory)) throw new Error(`not a canonical repository root: ${root}`);
      record.revision = git(['rev-parse', 'HEAD'], directory);
      record.branch = git(['branch', '--show-current'], directory);
      record.status = git(['status', '--porcelain', '--untracked-files=no'], directory);
      const origin = run('git', ['remote', 'get-url', 'origin'], directory);
      record.origin = origin.exitStatus === EXIT.clean ? origin.stdout.trim() : null;
      const result = run(process.execPath, [checkerScript, ...CHECKERS[checkerName].flags], directory);
      const evidence = path.join(output, entry.name);
      mkdirSync(evidence);
      writeFileSync(path.join(evidence, 'stdout.json'), result.stdout);
      writeFileSync(path.join(evidence, 'stderr.log'), result.stderr);
      writeFileSync(path.join(evidence, 'execution.json'), `${JSON.stringify({ ...result, stdout: undefined, stderr: undefined }, null, 2)}\n`);
      record.command = result.command;
      record.exitStatus = result.exitStatus;
      if (![EXIT.clean, EXIT.findings].includes(result.exitStatus)) {
        throw new Error(`checker exited ${result.exitStatus}: ${result.stderr.trim()}`);
      }
      const scan = JSON.parse(result.stdout);
      if (scan.schemaVersion !== REPORT_SCHEMA_VERSION || !Array.isArray(scan.violations) || !Number.isInteger(scan.checkedFiles)) {
        throw new Error('invalid checker report');
      }
      record.checkedFiles = scan.checkedFiles;
      record.sourceDigest = scan.sourceDigest;
      record.violations = scan.violations;
      record.result = scan.violations.length ? RESULT.findings : RESULT.clean;
    } catch (error) {
      record.result = RESULT.error;
      record.error = error.message;
    }
    console.log(`${record.name}: ${record.result}${record.violations ? ` (${record.violations.length} findings)` : `: ${record.error}`}`);
    // Persist progress so an interrupted fleet audit never loses completed repositories.
    writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  report.finishedAt = new Date().toISOString();
  report.counts = Object.fromEntries(Object.keys(EXIT).map(kind => [kind, report.repositories.filter(record => record.result === kind).length]));
  report.counts.repositories = report.repositories.length;
  report.counts.violations = report.repositories
    .filter(record => record.result !== RESULT.error)
    .reduce((count, record) => count + record.violations.length, 0);
  if (report.repositories.length === 0) {
    report.error = 'workspace contains no immediate Git repositories';
  }
  writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const ranking = report.repositories
    .filter(record => record.result === RESULT.findings)
    .sort(byFindingsThenName)
    .map(record => `${record.violations.length}\t${record.name}`);
  writeFileSync(path.join(output, 'ranking.tsv'), ranking.length ? `${ranking.join('\n')}\n` : '');
  console.log(`Report: ${path.join(output, 'report.json')}`);
  console.log(`Ranking: ${path.join(output, 'ranking.tsv')}`);
  console.log(JSON.stringify(report.counts));
  if (report.error || report.counts.error) process.exitCode = EXIT.error;
  else if (report.counts.findings) process.exitCode = EXIT.findings;
  else process.exitCode = EXIT.clean;
}

function byFindingsThenName(left, right) {
  const byFindings = right.violations.length - left.violations.length;
  if (byFindings !== 0) return byFindings;
  return left.name.localeCompare(right.name);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  console.error(`usage: node src/magic-numbers/audit.mjs --workspace <directory> --checker ${Object.keys(CHECKERS).join('|')} --output <new quality-control/.build/directory> [--skip <repository>]...`);
  process.exitCode = EXIT.error;
}
