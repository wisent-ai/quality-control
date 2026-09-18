// Which files and lines a guard reads: the mode flags every guard accepts, the Git
// commands that turn a mode into file names and changed line numbers, and the guards'
// own sources, which are left out because their patterns would trip the rules they enforce.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, MAX_OUTPUT_BYTES } from './constants.mjs';

const ZERO_SHA = /^0+$/;
const GUARD_PACKAGE_NAME = '@wisent-ai/quality-control';
// The files whose text is made of the patterns the guards look for.
const GUARD_PATTERN_FILE_RE = /^src\/(?:check-no-[a-z-]+\.mjs|lib\/source-lines\.mjs|magic-numbers\/literals\.mjs)$/;
export const MODE_SYNTAX = '[--all | --staged | --worktree | --base <sha> | --range <before>..<after>]';
const ONE_MODE_ONLY = 'choose only one of --all, --staged, --worktree, --base, or --range';
const MODE = Object.freeze({ all: 'all', staged: 'staged', worktree: 'worktree', base: 'base', range: 'range' });
// The Git diff every mode reads, in two shapes: the names of changed files, and one file's added lines.
const DIFF_FILTER = '--diff-filter=ACMR';
const DIFF_SELECTOR = {
  [MODE.staged]: () => ['--cached'],
  [MODE.worktree]: () => ['HEAD'],
  [MODE.base]: mode => [`${mode.base}...HEAD`],
  [MODE.range]: mode => [mode.range],
};
const GIT_LS_FILES = ['ls-files'];
const GIT_ROOT = ['rev-parse', '--show-toplevel'];
const TEXT = 'utf8';

export function usageOf(script, extraSyntax = '') {
  return message => {
    console.error(message);
    console.error(`usage: node ${script} ${MODE_SYNTAX}${extraSyntax}`);
    process.exit(EXIT.error);
  };
}

// `switches` names the guard's own boolean flags (`--json` → `json`); everything else is a mode flag.
export function parseArgs(raw, usage, switches = {}) {
  const parsed = { all: false, staged: false, worktree: false, base: '', range: '' };
  for (const key of Object.values(switches)) parsed[key] = false;
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === '--all') parsed.all = true;
    else if (arg === '--staged') parsed.staged = true;
    else if (arg === '--worktree') parsed.worktree = true;
    else if (arg === '--base' || arg === '--range') {
      const value = raw[++i];
      if (!value || value.startsWith('--')) usage(`${arg} requires a value`);
      parsed[arg.slice(2)] = value;
    }
    else if (Object.hasOwn(switches, arg)) parsed[switches[arg]] = true;
    else usage(`unknown argument: ${arg}`);
  }
  return parsed;
}

export function resolveMode(parsed, usage) {
  const selected = [parsed.all, parsed.staged, parsed.worktree, Boolean(parsed.base), Boolean(parsed.range)]
    .filter(Boolean).length;
  if (selected > 1) usage(ONE_MODE_ONLY);
  if (parsed.all) return { kind: MODE.all, all: true };
  if (parsed.staged) return { kind: MODE.staged, all: false };
  if (parsed.worktree) return { kind: MODE.worktree, all: false };
  if (parsed.base) return { kind: MODE.base, base: parsed.base, all: false };
  if (parsed.range) {
    const [before, after] = parsed.range.split('..');
    if (!before || !after) usage('--range must look like <before>..<after>');
    if (ZERO_SHA.test(before)) return { kind: MODE.all, all: true };
    return { kind: MODE.range, range: parsed.range, all: false };
  }
  return { kind: MODE.staged, all: false };
}

export function repositoryRoot() {
  return git(GIT_ROOT).trim();
}

// Inside the guards' own package, the files made of guard patterns are not product code.
export function isGuardSource(root, file) {
  if (!GUARD_PATTERN_FILE_RE.test(file)) return false;
  const manifest = path.join(root, 'package.json');
  if (!existsSync(manifest)) return false;
  return JSON.parse(readFileSync(manifest, TEXT)).name === GUARD_PACKAGE_NAME;
}

export function candidateFiles(mode, isScannedFile) {
  let output = mode.all
    ? git(GIT_LS_FILES)
    : git(['diff', ...DIFF_SELECTOR[mode.kind](mode), '--name-only', DIFF_FILTER]);
  if (mode.kind === MODE.worktree) {
    output = [output, git([...GIT_LS_FILES, '--others', '--exclude-standard'])].join('\n');
  }
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(isScannedFile);
}

// The line numbers a guard reads in one file: every line under --all or for a file Git
// does not know yet, and the lines the selected diff added in every other mode.
export function selectedLineNumbers(mode, file, lines, root) {
  if (mode.all || (mode.kind === MODE.worktree && !isTrackedFile(root, file))) return allLineNumbers(lines);
  return changedLineNumbers(mode, file);
}

function changedLineNumbers(mode, file) {
  const output = git(['diff', ...DIFF_SELECTOR[mode.kind](mode), '--unified=0', DIFF_FILTER, '--', file]);
  const numbers = new Set();
  let newLine = 0;

  for (const line of output.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine === 0) continue;
    if (line.startsWith('+++')) continue;
    if (line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      numbers.add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) continue;
    newLine += 1;
  }
  return numbers;
}

function allLineNumbers(lines) {
  const numbers = new Set();
  for (let i = 1; i <= lines.length; i += 1) numbers.add(i);
  return numbers;
}

function isTrackedFile(root, file) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd: root, encoding: 'utf8' });
  return result.status === EXIT.clean;
}

export function git(args) {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error || result.status !== EXIT.clean) {
    const command = `git ${args.join(' ')}`;
    const detail = result.error ? result.error.message : result.stderr.trim();
    console.error(`${command} failed: ${detail}`);
    process.exit(result.status === null ? EXIT.findings : result.status);
  }
  return result.stdout;
}
