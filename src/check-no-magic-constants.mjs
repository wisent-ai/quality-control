#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MAX_OUTPUT_BYTES } from './constants.mjs';

const ROOT = git(['rev-parse', '--show-toplevel']).trim();
const ZERO_SHA = /^0+$/;
const SOURCE_EXTENSIONS = new Set([
  '.swift',
  '.mjs',
  '.js',
  '.ts',
  '.tsx',
  '.py',
  '.rs'
]);
const EXCLUDED_FILES = new Set([
  'src/check-no-desktop-cli-coupling.mjs',
  'src/check-no-fallbacks.mjs',
  'src/check-no-keyword-logic.mjs',
  'src/check-no-magic-constants.mjs'
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

const STRING_LITERAL_RE = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
// A JavaScript regular-expression literal after an operator, opening bracket or keyword; digits inside it are pattern text.
const REGEX_LITERAL_RE = /(?<=^|[=(,:[!&|?{};]|\breturn|\btest|\bmatch)\s*\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[\n])+\/[a-z]*/g;
// A tuple field such as `.0` or `.1` follows a closing bracket or an identifier, never an operator.
const NUMBER_LITERAL_SOURCE = '(?:0x[\\da-f_]+|0b[01_]+|0o[0-7_]+|(?:\\d[\\d_]*(?:\\.[\\d_]+)?|(?<![\\])])\\.\\d[\\d_]*)(?:e[-+]?[\\d_]+)?)(?:_?(?:[ui](?:8|16|32|64|128|size)|f(?:32|64)))?';
// A unit or percent sign after the digits makes the value a dimension, and a digit glued to a
// hyphenated word (utf-8, sha-256) is part of the word; the guard leaves both alone.
const NUMBER_LITERAL_RE = new RegExp(`(?<![A-Za-z0-9_$.]|[A-Za-z]-)[-+]?${NUMBER_LITERAL_SOURCE}(?![A-Za-z0-9_$%])`, 'gi');
const QUOTED_NUMBER_RE = new RegExp(`\\b(?:Number|parseInt|parseFloat|Int|UInt|Double|Float|CGFloat|int|float|Decimal)\\s*\\(\\s*["'](?<value>[-+]?${NUMBER_LITERAL_SOURCE})["']|["'](?<value2>[-+]?\\d[\\d_]*(?:\\.\\d+)?)["']\\s*\\.parse(?:::<[^>]+>)?\\(`, 'gi');
const NAMED_CONSTANT_RE = /^\s*(?:(?:pub(?:\([^)]*\))?|export|private|fileprivate|public|internal)\s+)*(?:(?:const|let|var|static(?:\s+(?:let|var))?)\s+)?_?[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=/;
const IMPORT_RE = /^\s*(?:import|export)\b.*\bfrom\b|^\s*(?:import|require)\s*\(/;
const LOCAL_LITERAL_ASSIGN_RE = new RegExp(`^\\s*(?:const|let|var)?\\s*[a-z_][A-Za-z0-9_]*\\s*(?::[^=]+)?=\\s*(?:["'\`]|[-+]?${NUMBER_LITERAL_SOURCE}(?![A-Za-z0-9_$]))`, 'i');
const LOGIC_LITERAL_RE = /^\s*(?:if|elif|while|for|return|assert)\b|(?:[=!<>]=|[<>])|[-+*/%]=|\b(?:range|sleep|timeout|limit|max|min)\s*\(/;
const ALLOWED_NUMBER_LITERALS = new Set(['-1', '0', '1', '2']);
const ELLIPSIS = '...';
// A finding quotes its line only up to this many characters, so a minified line stays one finding, not a report.
const SOURCE_EXCERPT_LIMIT = 160;
const DETAIL_EXCERPT_LIMIT = 32;

const args = parseArgs(process.argv.slice(2));
const mode = resolveMode(args);
const files = candidateFiles(mode);
const violations = [];
const sourceDigest = createHash('sha256');

for (const file of files) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
  if (!isScannedFile(file)) continue;

  const text = readFileSync(absolute, 'utf8');
  sourceDigest.update(file).update('\0').update(text).update('\0');
  const lines = text.split(/\r?\n/);
  const documentationLines = documentationLineNumbers(lines);
  const changedLines = mode.all || (mode.kind === 'worktree' && !isTrackedFile(file))
    ? allLineNumbers(lines)
    : changedLineNumbers(mode, file);
  if (changedLines.size === 0) continue;

  for (const lineNumber of changedLines) {
    const line = lines[lineNumber - 1] ?? '';
    if (documentationLines.has(lineNumber)) continue;
    if (isCommentOnlyLine(line)) continue;
    if (isLikelyDocumentationLine(line)) continue;
    if (isAllowedLiteralContext(line)) continue;
    if (!isLiteralSensitiveContext(line)) continue;

    for (const violation of literalViolations(line)) {
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
  console.log(JSON.stringify({ schemaVersion: 1, root: ROOT, mode: mode.kind, checkedFiles: files.length, sourceDigest: sourceDigest.digest('hex'), violations }));
  process.exitCode = violations.length > 0 ? 1 : 0;
} else if (violations.length > 0) {
  console.error('No-magic-constants guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`);
    if (violation.source) console.error(`  ${violation.source}`);
  }
  console.error('');
  console.error('Name the value, load it from configuration, or derive it from typed metadata instead of embedding it in logic.');
  process.exitCode = 1;
} else {
  console.log(`No-magic-constants guard passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);
}

function literalViolations(line) {
  const code = codeWithoutInlineComment(line);
  const withoutStrings = code.replace(STRING_LITERAL_RE, '""').replace(REGEX_LITERAL_RE, '/re/');
  const found = [];

  for (const match of code.matchAll(STRING_LITERAL_RE)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (args.numbersOnly || !isSignificantString(value)) continue;
    if (isSchemaKeyAccess(code, match.index ?? 0, match[0].length)) continue;
    found.push({
      rule: 'magic-string',
      detail: `string literal "${abbreviate(value)}" is embedded in logic`
    });
  }

  for (const match of withoutStrings.matchAll(NUMBER_LITERAL_RE)) {
    const value = normalizeNumberLiteral(match[0]);
    if (ALLOWED_NUMBER_LITERALS.has(value)) continue;
    found.push({
      rule: 'magic-number',
      detail: `number literal ${value} is embedded in logic`
    });
  }

  // Number('127'), Int("3") or "3".parse() is the same literal wearing quotes to slip past a guard.
  for (const match of code.matchAll(QUOTED_NUMBER_RE)) {
    const value = normalizeNumberLiteral(match.groups.value ?? match.groups.value2);
    if (ALLOWED_NUMBER_LITERALS.has(value)) continue;
    found.push({
      rule: 'magic-number',
      detail: `number literal ${value} is hidden in a string`
    });
  }

  return found;
}

function isSignificantString(value) {
  if (value.length < 3) return false;
  if (/[{}]/.test(value)) return false;
  if (value.startsWith('<')) return false;
  if (value.startsWith('--')) return false;
  if (/^[A-Z0-9_./:-]+$/.test(value)) return false;
  if (/^https?:\/\//.test(value)) return false;
  if (/^[./~]/.test(value)) return false;
  if (/^\$\{[^}]+\}$/.test(value)) return false;
  return /[A-Za-z]/.test(value);
}

function isAllowedLiteralContext(line) {
  const trimmed = line.trim();
  return NAMED_CONSTANT_RE.test(line)
    || IMPORT_RE.test(line)
    || trimmed === 'if __name__ == "__main__":'
    || trimmed.startsWith('@')
    || trimmed.startsWith('"')
    || trimmed.startsWith("'")
    || trimmed.startsWith('<')
    || trimmed.startsWith('help=')
    || trimmed.startsWith('default=')
    || trimmed.startsWith('case ')
    || trimmed.startsWith('throw new ')
    || trimmed.startsWith('throw ')
    || trimmed.startsWith('console.')
    || trimmed.startsWith('click.echo')
    || trimmed.includes('flags.append(')
    || trimmed.startsWith('logger.')
    || trimmed.startsWith('print(')
    || trimmed.startsWith('sys.stderr.write')
    || trimmed.startsWith('_log(')
    || trimmed.startsWith('f"')
    || trimmed.startsWith("f'");
}

function isLiteralSensitiveContext(line) {
  const code = codeWithoutInlineComment(line);
  return LOCAL_LITERAL_ASSIGN_RE.test(code) || LOGIC_LITERAL_RE.test(code) || code.search(QUOTED_NUMBER_RE) !== -1;
}

function isSchemaKeyAccess(code, start, length) {
  const before = code.slice(Math.max(0, start - 8), start);
  const beforeFull = code.slice(0, start).trimEnd();
  const after = code.slice(start + length, start + length + 4).trimStart();
  if (before.endsWith('[') && after.startsWith(']')) return true;
  if (before.endsWith('.get(') && (after.startsWith(',') || after.startsWith(')'))) return true;
  if (/getattr\([^,\n]+,\s*$/.test(beforeFull) && (after.startsWith(',') || after.startsWith(')'))) return true;
  if (/setattr\([^,\n]+,\s*$/.test(beforeFull) && (after.startsWith(',') || after.startsWith(')'))) return true;
  if (
    after.startsWith(':')
    && (beforeFull.endsWith('{') || beforeFull.endsWith(',') || beforeFull.endsWith('('))
  ) {
    return true;
  }
  return false;
}

function documentationLineNumbers(lines) {
  const docs = new Set();
  let activeToken = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let searchFrom = 0;
    let lineIsDocumentation = Boolean(activeToken);
    while (searchFrom < line.length) {
      const next = nextTripleQuote(line, searchFrom);
      if (!next) break;
      lineIsDocumentation = true;
      if (activeToken) {
        if (next.token === activeToken) activeToken = '';
      } else {
        activeToken = next.token;
      }
      searchFrom = next.index + next.token.length;
    }
    if (lineIsDocumentation) docs.add(index + 1);
  }
  return docs;
}

function nextTripleQuote(line, searchFrom) {
  const doubleIndex = line.indexOf('"""', searchFrom);
  const singleIndex = line.indexOf("'''", searchFrom);
  if (doubleIndex === -1 && singleIndex === -1) return null;
  if (singleIndex === -1 || (doubleIndex !== -1 && doubleIndex < singleIndex)) {
    return { index: doubleIndex, token: '"""' };
  }
  return { index: singleIndex, token: "'''" };
}

function isLikelyDocumentationLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) return true;
  if (trimmed.endsWith('"""') || trimmed.endsWith("'''")) return true;
  if (trimmed.includes('"""') || trimmed.includes("'''")) return true;
  if (/^[A-Za-z][A-Za-z0-9 ,.;:()/_<>`'"\-–—]+$/.test(trimmed) && !/[=({[;]/.test(trimmed)) return true;
  return false;
}

function normalizeNumberLiteral(value) {
  return String(Number(value.replace(/_?(?:[ui](?:8|16|32|64|128|size)|f(?:32|64))$/i, '').replaceAll('_', '')));
}

function abbreviate(value, limit = DETAIL_EXCERPT_LIMIT) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`;
}

function parseArgs(raw) {
  const parsed = { all: false, staged: false, worktree: false, base: '', range: '', json: false, numbersOnly: false };
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === '--all') parsed.all = true;
    else if (arg === '--staged') parsed.staged = true;
    else if (arg === '--worktree') parsed.worktree = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--numbers-only') parsed.numbersOnly = true;
    else if (arg === '--base' || arg === '--range') {
      const value = raw[++i];
      if (!value || value.startsWith('--')) usage(`${arg} requires a value`);
      parsed[arg.slice(2)] = value;
    }
    else usage(`unknown argument: ${arg}`);
  }
  return parsed;
}

function resolveMode(parsed) {
  const selected = [parsed.all, parsed.staged, parsed.worktree, Boolean(parsed.base), Boolean(parsed.range)]
    .filter(Boolean).length;
  if (selected > 1) usage('choose only one of --all, --staged, --worktree, --base, or --range');
  if (parsed.all) return { kind: 'all', all: true };
  if (parsed.staged) return { kind: 'staged', all: false };
  if (parsed.worktree) return { kind: 'worktree', all: false };
  if (parsed.base) return { kind: 'base', base: parsed.base, all: false };
  if (parsed.range) {
    const [before, after] = parsed.range.split('..');
    if (!before || !after) usage('--range must look like <before>..<after>');
    if (ZERO_SHA.test(before)) return { kind: 'all', all: true };
    return { kind: 'range', range: parsed.range, all: false };
  }
  return { kind: 'staged', all: false };
}

function usage(message) {
  console.error(message);
  console.error('usage: node check-no-magic-constants.mjs [--all | --staged | --worktree | --base <sha> | --range <before>..<after>] [--numbers-only] [--json]');
  process.exit(2);
}

function candidateFiles(mode) {
  let output = mode.all
    ? git(['ls-files'])
    : git(diffNameOnlyArgs(mode));
  if (mode.kind === 'worktree') {
    output = [output, git(['ls-files', '--others', '--exclude-standard'])].join('\n');
  }
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(isScannedFile);
}

function diffNameOnlyArgs(mode) {
  if (mode.kind === 'staged') {
    return ['diff', '--cached', '--name-only', '--diff-filter=ACMR'];
  }
  if (mode.kind === 'worktree') {
    return ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'];
  }
  if (mode.kind === 'base') {
    return ['diff', '--name-only', '--diff-filter=ACMR', `${mode.base}...HEAD`];
  }
  if (mode.kind === 'range') {
    return ['diff', '--name-only', '--diff-filter=ACMR', mode.range];
  }
  throw new Error(`unsupported mode: ${mode.kind}`);
}

function changedLineNumbers(mode, file) {
  const output = git(diffPatchArgs(mode, file));
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

function diffPatchArgs(mode, file) {
  if (mode.kind === 'staged') {
    return ['diff', '--cached', '--unified=0', '--diff-filter=ACMR', '--', file];
  }
  if (mode.kind === 'worktree') {
    return ['diff', '--unified=0', '--diff-filter=ACMR', 'HEAD', '--', file];
  }
  if (mode.kind === 'base') {
    return ['diff', '--unified=0', '--diff-filter=ACMR', `${mode.base}...HEAD`, '--', file];
  }
  if (mode.kind === 'range') {
    return ['diff', '--unified=0', '--diff-filter=ACMR', mode.range, '--', file];
  }
  throw new Error(`unsupported mode: ${mode.kind}`);
}

function allLineNumbers(lines) {
  const numbers = new Set();
  for (let i = 1; i <= lines.length; i += 1) numbers.add(i);
  return numbers;
}

function isScannedFile(file) {
  if (EXCLUDED_FILES.has(file)) return false;
  const segments = file.split('/');
  const basename = segments.pop();
  if (segments.some(segment => EXCLUDED_DIRECTORIES.has(segment))) return false;
  if (EXCLUDED_BASENAME_RE.test(basename)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(basename));
}

function isCommentOnlyLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//')
    || trimmed.startsWith('///')
    || trimmed.startsWith('#')
    || trimmed.startsWith('*')
    || trimmed.startsWith('/*');
}

function codeWithoutInlineComment(line) {
  return line.replace(/\s+\/\/.*$/, '').replace(/\s+#.*$/, '');
}

function isTrackedFile(file) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return result.status === 0;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error || result.status !== 0) {
    const command = `git ${args.join(' ')}`;
    const detail = result.error ? result.error.message : result.stderr.trim();
    console.error(`${command} failed: ${detail}`);
    process.exit(result.status === null ? 1 : result.status);
  }
  return result.stdout;
}
