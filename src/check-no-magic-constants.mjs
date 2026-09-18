#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EXIT, REPORT_SCHEMA_VERSION } from './lib/constants.mjs';
import {
  candidateFiles, isGuardSource, parseArgs, repositoryRoot, resolveMode, selectedLineNumbers, usageOf
} from './lib/change-selection.mjs';
import { documentationLineNumbers, isCommentOnlyLine, codeWithoutInlineComment } from './lib/source-lines.mjs';
import {
  QUOTED_NUMBER_RE, isAllowedLiteralContext, isLikelyDocumentationLine, isLiteralSensitiveContext,
  literalViolations, withParseContinuation
} from './magic-numbers/literals.mjs';

const ROOT = repositoryRoot();
const SOURCE_EXTENSIONS = new Set([
  '.swift',
  '.mjs',
  '.js',
  '.ts',
  '.tsx',
  '.py',
  '.rs'
]);
// A directory of tests or third-party code is skipped wherever it sits in the tree.
const EXCLUDED_DIRECTORIES = new Set([
  '.build',
  '.git',
  '.swiftpm',
  '.work',
  'Tests',
  'test',
  'tests',
  '__tests__',
  'target',
  'node_modules',
  'vendor',
  '_catalog',
  'profiles'
]);
const EXCLUDED_BASENAME_RE = /(?:^config\.py|^test_.*\.py|_test\.py|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|Tests\.swift|\.min\.[cm]?js)$/;
// A finding quotes its line only up to this many characters, so a minified line stays one finding, not a report.
const SOURCE_EXCERPT_LIMIT = 160;
const ELLIPSIS = '...';
// A file whose head says it is generated is the generator's output; the generator's source is what gets read.
const GENERATED_HEADER_LINES = 5;
const GENERATED_HEADER_RE = /generated\b[\s\S]*do not edit/i;

const usage = usageOf('check-no-magic-constants.mjs', ' [--numbers-only] [--json]');
const args = parseArgs(process.argv.slice(2), usage, { '--json': 'json', '--numbers-only': 'numbersOnly' });
const mode = resolveMode(args, usage);
const files = candidateFiles(mode, isScannedFile);
const violations = [];
const sourceDigest = createHash('sha256');

for (const file of files) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;

  const text = readFileSync(absolute, 'utf8');
  sourceDigest.update(file).update('\0').update(text).update('\0');
  const lines = text.split(/\r?\n/);
  if (GENERATED_HEADER_RE.test(lines.slice(0, GENERATED_HEADER_LINES).join('\n'))) continue;
  const documentationLines = documentationLineNumbers(lines);
  const changedLines = selectedLineNumbers(mode, file, lines, ROOT);
  if (changedLines.size === 0) continue;

  for (const lineNumber of changedLines) {
    const line = withParseContinuation(lines, lineNumber - 1);
    if (documentationLines.has(lineNumber)) continue;
    // A number wearing quotes for a parser is code however the line starts: a quote, a `*` or a bare call.
    const disguised = codeWithoutInlineComment(line).search(QUOTED_NUMBER_RE) !== -1;
    if (isCommentOnlyLine(line) && !(disguised && line.trim().startsWith('*'))) continue;
    if (!disguised) {
      if (isLikelyDocumentationLine(line)) continue;
      if (isAllowedLiteralContext(line)) continue;
      if (!isLiteralSensitiveContext(line)) continue;
    }

    for (const violation of literalViolations(line, args.numbersOnly)) {
      violations.push({
        file,
        line: lineNumber,
        ...violation,
        source: abbreviate(line.trim(), SOURCE_EXCERPT_LIMIT)
      });
    }
  }
}

// The report is set as the exit code rather than through process.exit(): on macOS a pipe is
// written asynchronously, and exiting right after console.log truncated reports at the pipe buffer.
if (args.json) {
  console.log(JSON.stringify({ schemaVersion: REPORT_SCHEMA_VERSION, root: ROOT, mode: mode.kind, checkedFiles: files.length, sourceDigest: sourceDigest.digest('hex'), violations }));
  process.exitCode = violations.length > 0 ? EXIT.findings : EXIT.clean;
} else if (violations.length > 0) {
  console.error('No-magic-constants guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`);
    if (violation.source) console.error(`  ${violation.source}`);
  }
  console.error('');
  console.error('Name the value, load it from configuration, or derive it from typed metadata instead of embedding it in logic.');
  process.exitCode = EXIT.findings;
} else {
  console.log(`No-magic-constants guard passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);
}

function abbreviate(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`;
}

function isScannedFile(file) {
  if (isGuardSource(ROOT, file)) return false;
  const segments = file.split('/');
  const basename = segments.pop();
  if (segments.some(segment => EXCLUDED_DIRECTORIES.has(segment))) return false;
  if (EXCLUDED_BASENAME_RE.test(basename)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(basename));
}
