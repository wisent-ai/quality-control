#!/usr/bin/env node
// The two size limits the workshop's write hooks enforce on every edit, applied to a whole
// repository: no source file over the operator's `max_file_lines`, no folder holding more
// than his `max_folder_files`. Both are read from the numeric-provenance.json named by
// --limits — Tama's own statement of them — so a changed limit reaches this guard and the
// hooks alike. The hooks stop a new violation at the editor; this guard finds the ones that
// already exist.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EXIT, MAX_OUTPUT_BYTES, REPORT_SCHEMA_VERSION } from './lib/constants.mjs';
import { isGeneratedSource } from './lib/source-lines.mjs';

const ROOT = git(['rev-parse', '--show-toplevel']).trim();
const USAGE = 'usage: node check-file-limits.mjs --all --limits <numeric-provenance.json> [--json]';
// A folder finding has no line of its own; the report's line field is not applicable.
const NO_LINE = null;

// A registry grows one entry per decision, a manuscript's length is set by its venue, and
// a database schema holds one model per table; none is a module a person navigates, so the
// line limit leaves them alone. An image is not text at all.
const LINE_LIMIT_EXEMPT_EXTENSIONS = new Set([
  '.json', '.jsonl', '.ndjson', '.lock', '.csv', '.tsv',
  '.prisma'
]);
// A tokenizer's merge list and vocabulary are one row per token, written by the trainer
// and read whole by the tokenizer; a checkpoint ships them as text next to its weights.
// A licence text is reproduced verbatim from its author.
const LINE_LIMIT_EXEMPT_BASENAMES = new Set(['merges.txt', 'vocab.txt']);
const LICENCE_BASENAME_RE = /^(?:LICEN[CS]E|COPYING|NOTICE)(?:\.(?:md|txt))?$/i;
// YAML outside a workflows folder is a registry or a configuration document, one entry per
// decision; a workflow carries executable steps and is measured like any module.
const YAML_EXTENSIONS = new Set(['.yml', '.yaml']);
const WORKFLOWS_FOLDER = '.github/workflows';
// A binary file is recognised by a NUL byte in its first kilobytes, whatever its name. An
// image, binary or `.svg`, is an asset a folder holds beside its modules and counts toward
// neither limit: a figures folder of thirty plots is not thirty modules.
const BINARY_PROBE_BYTES = 8 * 1024;
const IMAGE_EXTENSIONS = new Set(['.svg']);
// A manuscript's folder holds the document, its bibliography and the venue's style files
// side by side; the venue template decides that layout, so LaTeX-family files
// count toward neither limit.
const LATEX_EXTENSIONS = new Set(['.tex', '.bib', '.sty', '.bst', '.cls']);
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
const { maxFileLines, maxFolderFiles } = statedLimits(args.limits);
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
  const extension = path.extname(basename).toLowerCase();
  const head = Buffer.alloc(BINARY_PROBE_BYTES);
  const descriptor = openSync(absolute, 'r');
  const headLength = readSync(descriptor, head, 0, BINARY_PROBE_BYTES, 0);
  closeSync(descriptor);
  if (IMAGE_EXTENSIONS.has(extension) || head.subarray(0, headLength).includes(0)) continue;
  if (LATEX_EXTENSIONS.has(extension)) continue;
  folderCounts.set(folder, folderCounts.has(folder) ? folderCounts.get(folder) + 1 : 1);
  if (LINE_LIMIT_EXEMPT_EXTENSIONS.has(extension)) continue;
  if (LINE_LIMIT_EXEMPT_BASENAMES.has(basename) || LICENCE_BASENAME_RE.test(basename)) continue;
  if (YAML_EXTENSIONS.has(extension) && folder !== WORKFLOWS_FOLDER) continue;
  const text = readFileSync(absolute);
  const source = text.toString('utf8');
  if (isGeneratedSource(source.split(/\r?\n/))) continue;
  const lineCount = countLines(source);
  if (lineCount > maxFileLines) {
    violations.push({
      file,
      line: maxFileLines + 1,
      rule: 'file-lines',
      detail: `${lineCount} lines; the limit is ${maxFileLines}`
    });
  }
}

for (const [folder, count] of [...folderCounts.entries()].sort()) {
  if (FOLDER_LIMIT_EXEMPT_FOLDERS.has(folder)) continue;
  if (count > maxFolderFiles) {
    violations.push({
      file: folder,
      line: NO_LINE,
      rule: 'folder-files',
      detail: `${count} files; the limit is ${maxFolderFiles}`
    });
  }
}

violations.sort(byFileThenRule);

// The report is set as the exit code rather than through process.exit(): on macOS a pipe is
// written asynchronously, and exiting right after console.log truncated reports at the pipe buffer.
if (args.json) {
  console.log(JSON.stringify({ schemaVersion: REPORT_SCHEMA_VERSION, root: ROOT, mode: 'all', limits: { maxFileLines, maxFolderFiles, source: args.limits }, checkedFiles: files.length, sourceDigest: sourceDigest.digest('hex'), violations }));
  process.exitCode = violations.length > 0 ? EXIT.findings : EXIT.clean;
} else if (violations.length > 0) {
  console.error('File-limits guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}: ${violation.rule}: ${violation.detail}`);
  }
  console.error('');
  console.error(`Split a file over ${maxFileLines} lines into modules; move the files of a folder holding more than ${maxFolderFiles} into sub-folders.`);
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
  const parsed = { all: false, json: false, limits: null };
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index];
    if (arg === '--help' || arg === '-h') {
      // --help prints the usage to stdout and checks nothing (cli.md rule 11).
      console.log(USAGE);
      process.exit(EXIT.clean);
    }
    else if (arg === '--all') parsed.all = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--limits') {
      const value = raw[index + 1];
      if (!value || value.startsWith('--')) usage('--limits requires the path of a numeric-provenance.json');
      parsed.limits = path.resolve(value);
      index += 1;
    }
    else usage(`unknown argument: ${arg}`);
  }
  if (!parsed.all) usage('--all is required: the limits are properties of the whole tree, not of a change');
  if (!parsed.limits) usage('--limits is required: the limits are the operator\'s, stated in Tama\'s numeric-provenance.json');
  return parsed;
}

// One stated limit: a positive whole number under `<name>.value`, or a refusal naming the
// file and the entry, never a number chosen here.
function statedLimits(file) {
  let declared;
  try {
    declared = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    usage(`cannot read the stated limits in ${file}: ${error.message}`);
  }
  const stated = name => {
    const value = declared?.[name]?.value;
    if (!Number.isInteger(value) || value < 1) usage(`${file} states no positive whole number for ${name}`);
    return value;
  };
  return { maxFileLines: stated('max_file_lines'), maxFolderFiles: stated('max_folder_files') };
}

function usage(message) {
  console.error(message);
  console.error(USAGE);
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
