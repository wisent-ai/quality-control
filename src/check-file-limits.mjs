#!/usr/bin/env node
// The two size limits the workshop's write hooks enforce on every edit, applied to a whole
// repository: no source file over 300 lines, no folder holding more than five files. The
// hooks stop a new violation at the editor; this guard finds the ones that already exist.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EXIT, MAX_OUTPUT_BYTES, REPORT_SCHEMA_VERSION } from './lib/constants.mjs';

const ROOT = git(['rev-parse', '--show-toplevel']).trim();
export const MAX_FILE_LINES = 300;
export const MAX_FOLDER_FILES = 5;
// A folder finding has no line of its own; the report's line field is not applicable.
const NO_LINE = null;

// A registry grows one entry per decision and a manuscript's length is set by its venue;
// neither is a module a person navigates, so the line limit leaves them alone (the write
// hook's own exemptions, 2026-09-10 and 2026-09-14). An image is not text at all.
const LINE_LIMIT_EXEMPT_EXTENSIONS = new Set([
  '.json', '.jsonl', '.ndjson', '.lock', '.csv', '.tsv',
  '.tex', '.bib', '.sty', '.bst', '.cls',
  '.svg'
]);
// A tokenizer's merge list and vocabulary are one row per token, written by the trainer
// and read whole by the tokenizer; a checkpoint ships them as text next to its weights.
const LINE_LIMIT_EXEMPT_BASENAMES = new Set(['merges.txt', 'vocab.txt']);
// A binary file is recognised by a NUL byte in its first kilobytes, whatever its name.
const BINARY_PROBE_BYTES = 8 * 1024;
// Third-party and generated trees are nobody's modules; test trees and migration ledgers
// are lists by nature (the write hook's own exemptions).
const EXEMPT_DIRECTORIES = new Set([
  '.git', '.build', '.swiftpm', 'node_modules', 'vendor', 'target', '__pycache__',
  'migrations', 'test', 'tests', '__tests__', 'Tests'
]);
const EXEMPT_DIRECTORY_RE = /^(?:tests|migrations)/;
// The repository root holds what every toolchain looks for there (manifests, lockfiles,
// licence, readme, dotfiles), and GitHub reads workflows only from one flat folder;
// neither can be split into sub-folders, so the folder limit does not apply to them.
const FOLDER_LIMIT_EXEMPT_FOLDERS = new Set(['.', '.github/workflows']);

const args = parseArgs(process.argv.slice(2));
const files = trackedFiles();
const violations = [];
const sourceDigest = createHash('sha256');
const folderCounts = new Map();

for (const file of files) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
  const segments = file.split('/');
  const basename = segments.pop();
  if (segments.some(segment => EXEMPT_DIRECTORIES.has(segment) || EXEMPT_DIRECTORY_RE.test(segment))) continue;
  sourceDigest.update(file).update('\0');
  const folder = segments.length === 0 ? '.' : segments.join('/');
  folderCounts.set(folder, folderCounts.has(folder) ? folderCounts.get(folder) + 1 : 1);
  if (LINE_LIMIT_EXEMPT_EXTENSIONS.has(path.extname(basename).toLowerCase())) continue;
  if (LINE_LIMIT_EXEMPT_BASENAMES.has(basename)) continue;
  const text = readFileSync(absolute);
  if (text.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue;
  const lineCount = countLines(text.toString('utf8'));
  if (lineCount > MAX_FILE_LINES) {
    violations.push({
      file,
      line: MAX_FILE_LINES + 1,
      rule: 'file-lines',
      detail: `${lineCount} lines; the limit is ${MAX_FILE_LINES}`
    });
  }
}

for (const [folder, count] of [...folderCounts.entries()].sort()) {
  if (FOLDER_LIMIT_EXEMPT_FOLDERS.has(folder)) continue;
  if (count > MAX_FOLDER_FILES) {
    violations.push({
      file: folder,
      line: NO_LINE,
      rule: 'folder-files',
      detail: `${count} files; the limit is ${MAX_FOLDER_FILES}`
    });
  }
}

violations.sort(byFileThenRule);

// The report is set as the exit code rather than through process.exit(): on macOS a pipe is
// written asynchronously, and exiting right after console.log truncated reports at the pipe buffer.
if (args.json) {
  console.log(JSON.stringify({ schemaVersion: REPORT_SCHEMA_VERSION, root: ROOT, mode: 'all', checkedFiles: files.length, sourceDigest: sourceDigest.digest('hex'), violations }));
  process.exitCode = violations.length > 0 ? EXIT.findings : EXIT.clean;
} else if (violations.length > 0) {
  console.error('File-limits guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}: ${violation.rule}: ${violation.detail}`);
  }
  console.error('');
  console.error(`Split a file over ${MAX_FILE_LINES} lines into modules; move the files of a folder holding more than ${MAX_FOLDER_FILES} into sub-folders.`);
  process.exitCode = EXIT.findings;
} else {
  console.log(`File-limits guard passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);
}

function byFileThenRule(left, right) {
  const byFile = left.file.localeCompare(right.file);
  if (byFile !== 0) return byFile;
  return left.rule.localeCompare(right.rule);
}

function countLines(text) {
  if (text.length === 0) return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

function parseArgs(raw) {
  const parsed = { all: false, json: false };
  for (const arg of raw) {
    if (arg === '--all') parsed.all = true;
    else if (arg === '--json') parsed.json = true;
    else usage(`unknown argument: ${arg}`);
  }
  if (!parsed.all) usage('--all is required: the limits are properties of the whole tree, not of a change');
  return parsed;
}

function usage(message) {
  console.error(message);
  console.error('usage: node check-file-limits.mjs --all [--json]');
  process.exit(EXIT.error);
}

function trackedFiles() {
  return git(['ls-files'])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error || result.status !== EXIT.clean) {
    const command = `git ${gitArgs.join(' ')}`;
    const detail = result.error ? result.error.message : result.stderr.trim();
    console.error(`${command} failed: ${detail}`);
    process.exit(result.status === null ? EXIT.findings : result.status);
  }
  return result.stdout;
}
