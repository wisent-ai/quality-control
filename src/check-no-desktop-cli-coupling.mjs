#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT } from './lib/constants.mjs';
import {
  candidateFiles, isGuardSource, parseArgs, repositoryRoot, resolveMode, selectedLineNumbers, usageOf
} from './lib/change-selection.mjs';
import { SWIFT_COMMENT_MARKERS, isCommentOnlyLine } from './lib/source-lines.mjs';

const ROOT = repositoryRoot();
const SOURCE_EXTENSIONS = new Set([
  '.swift'
]);
const EXCLUDED_PREFIXES = [
  '.build/',
  '.git/',
  '.swiftpm/',
  '.work/',
  'Tests/',
  'node_modules/'
];

const PROCESS_LAUNCH_RE = /\bProcess\s*\(\s*\)|\bexecutableURL\b|\bNSTask\b/;
const BACKEND_LAUNCHER_FILE_RE = /(?:BackendProcess|Runtime)[^/]*\.swift$/;
const PANEL_COMMAND_RE = /\bcommand\s*:/;
const STRING_LITERAL_RE = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
const COMMAND_STRING_RE = /`[a-z-]+ [a-z-]+`|curl |export [A-Z_]+=|npm install|brew install/;

if (!isDesktopRepository()) {
  console.log(`No-desktop-cli-coupling guard skipped (${repositoryName()} is not a desktop repository).`);
  process.exit(EXIT.clean);
}

const usage = usageOf('check-no-desktop-cli-coupling.mjs');
const args = parseArgs(process.argv.slice(2), usage);
const mode = resolveMode(args, usage);
const files = candidateFiles(mode, isScannedFile);
const violations = [];

for (const file of files) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;

  const text = readFileSync(absolute, 'utf8');
  const lines = text.split(/\r?\n/);
  const changedLines = selectedLineNumbers(mode, file, lines, ROOT);
  if (changedLines.size === 0) continue;

  for (const lineNumber of changedLines) {
    const line = lineNumber <= lines.length ? lines[lineNumber - 1] : '';
    if (isCommentOnlyLine(line, SWIFT_COMMENT_MARKERS)) continue;

    if (PROCESS_LAUNCH_RE.test(line) && !BACKEND_LAUNCHER_FILE_RE.test(file)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'process-launch',
        detail: 'desktop code must not launch processes outside the allowlisted backend-launcher file (BackendProcess/Runtime)',
        source: line.trim()
      });
      continue;
    }

    if (PANEL_COMMAND_RE.test(line)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'panel-command-argument',
        detail: 'UI panels must not receive command arguments; state the fact in plain prose instead',
        source: line.trim()
      });
      continue;
    }

    if (hasCommandString(line)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'ui-command-string',
        detail: 'user-visible strings must not contain shell commands, install instructions, or environment assignments',
        source: line.trim()
      });
    }
  }
}

if (violations.length > 0) {
  console.error('No-desktop-cli-coupling guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`);
    if (violation.source) console.error(`  ${violation.source}`);
  }
  console.error('');
  console.error('A desktop application reaches its product over loopback HTTP/JSON, local state files, or a linked library.');
  console.error('Do not build argv for the product CLI or render command strings in the interface.');
  process.exit(EXIT.findings);
}

console.log(`No-desktop-cli-coupling guard passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);

function isDesktopRepository() {
  return repositoryName().endsWith('-desktop');
}

function repositoryName() {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (result.status === EXIT.clean) {
    const base = result.stdout.trim().split('/').pop().replace(/\.git$/, '');
    if (base) return base;
  }
  return path.basename(ROOT);
}

function isScannedFile(file) {
  if (isGuardSource(ROOT, file)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) return false;
  const extension = path.extname(file);
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  if (file.includes('/node_modules/')) return false;
  return true;
}

function hasCommandString(line) {
  for (const match of line.matchAll(STRING_LITERAL_RE)) {
    if (COMMAND_STRING_RE.test(match[1] === undefined ? '' : match[1])) return true;
  }
  return false;
}
