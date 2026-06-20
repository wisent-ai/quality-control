#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = git(['rev-parse', '--show-toplevel']).trim();
const ZERO_SHA = /^0+$/;
const SOURCE_EXTENSIONS = new Set([
  '.swift',
  '.mjs',
  '.js',
  '.ts',
  '.tsx',
  '.py',
  '.sh',
  '.yml',
  '.yaml',
  '.json'
]);
const EXCLUDED_FILES = new Set([
  '.github/workflows/no-fallbacks.yml',
  '.github/workflows/no-keyword-logic.yml',
  'scripts/check-no-fallbacks.mjs',
  'scripts/check-no-keyword-logic.mjs'
]);
const EXCLUDED_PREFIXES = [
  '.build/',
  '.git/',
  '.swiftpm/',
  '.work/',
  'Tests/',
  'node_modules/'
];

const KEYWORD_IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*(?:keyword|keywords)[A-Za-z0-9_]*\b/i;
const SUSPICIOUS_LIST_NAME_RE = /\b(?:signals?|fragments?|phrases?|prefixes?|suffixes?|triggers?|words?|terms?|markers?|patterns?)\b/i;
const DECLARES_LIST_RE = /\b(?:let|var|const|static\s+let|static\s+var)\s+[A-Za-z_][A-Za-z0-9_]*\s*(?::[^=]+)?=\s*(?:\[|Set\s*\(|new\s+Set\s*\()/;
const STRING_LITERAL_RE = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
const LEXICAL_GATE_RE = /\.(?:contains|hasPrefix|hasSuffix|localizedCaseInsensitiveContains|range|includes|startsWith|endsWith|some|every|test|match)\b|\b(?:contains|hasPrefix|startswith|endswith|includes|re\.search|RegExp|NSRegularExpression|localizedLowercase|lowercased|toLowerCase|lower)\b/;
const DIRECT_LITERAL_GATE_RE = /\.(?:contains|hasPrefix|hasSuffix|localizedCaseInsensitiveContains|includes|startsWith|endsWith|test|match)\s*\(\s*(["'`])([^"'`]{3,})\1/;
const REGEX_ALTERNATION_RE = /\/[^/\n]*(?:[A-Za-z][A-Za-z0-9_-]{2,}\|){2,}[A-Za-z][A-Za-z0-9_-]{2,}[^/\n]*\/|#["'][^"'\n]*(?:[A-Za-z][A-Za-z0-9_-]{2,}\|){2,}[A-Za-z][A-Za-z0-9_-]{2,}[^"'\n]*["']/;

const args = parseArgs(process.argv.slice(2));
const mode = resolveMode(args);
const files = candidateFiles(mode);
const violations = [];

for (const file of files) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
  if (!isScannedFile(file)) continue;

  const text = readFileSync(absolute, 'utf8');
  const lines = text.split(/\r?\n/);
  const changedLines = mode.all || (mode.kind === 'worktree' && !isTrackedFile(file))
    ? allLineNumbers(lines)
    : changedLineNumbers(mode, file);
  if (changedLines.size === 0) continue;

  for (const lineNumber of changedLines) {
    const line = lines[lineNumber - 1] ?? '';
    if (isCommentOnlyLine(line)) continue;

    if (KEYWORD_IDENTIFIER_RE.test(line)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'keyword-identifier',
        detail: 'identifier names cannot introduce keyword-based logic',
        source: line.trim()
      });
      continue;
    }

    if (REGEX_ALTERNATION_RE.test(line)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'regex-keyword-gate',
        detail: 'regex alternation over words is keyword-based logic',
        source: line.trim()
      });
      continue;
    }

    if (DIRECT_LITERAL_GATE_RE.test(line) && directGateHasNaturalLanguageLiteral(line)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'literal-keyword-gate',
        detail: 'natural-language literals cannot drive contains/prefix/match logic',
        source: line.trim()
      });
      continue;
    }

    if (!isPotentialStringListGateLine(line)) continue;

    const window = sourceWindow(lines, lineNumber, 12);
    if (isStringListGate(window.text)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'string-list-keyword-gate',
        detail: 'string lists cannot drive lexical contains/prefix/match decisions',
        source: line.trim()
      });
    }
  }
}

if (violations.length > 0) {
  console.error('No-keyword-logic guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`);
    if (violation.source) console.error(`  ${violation.source}`);
  }
  console.error('');
  console.error('Use structured state, typed metadata, parser output, or model/classifier output.');
  console.error('Do not make behavior depend on word lists, phrase lists, prefix lists, or contains checks.');
  process.exit(1);
}

console.log(`No-keyword-logic guard passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);

function parseArgs(raw) {
  const parsed = { all: false, staged: false, worktree: false, base: '', range: '' };
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === '--all') parsed.all = true;
    else if (arg === '--staged') parsed.staged = true;
    else if (arg === '--worktree') parsed.worktree = true;
    else if (arg === '--base') parsed.base = raw[++i] ?? '';
    else if (arg === '--range') parsed.range = raw[++i] ?? '';
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
  console.error('usage: node check-no-keyword-logic.mjs [--all | --staged | --worktree | --base <sha> | --range <before>..<after>]');
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
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) return false;
  const extension = path.extname(file);
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  if (file.includes('/node_modules/')) return false;
  return true;
}

function isCommentOnlyLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//')
    || trimmed.startsWith('///')
    || trimmed.startsWith('#')
    || trimmed.startsWith('*')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('<!--');
}

function sourceWindow(lines, lineNumber, radius) {
  const start = Math.max(1, lineNumber - radius);
  const end = Math.min(lines.length, lineNumber + radius);
  return {
    start,
    end,
    text: lines.slice(start - 1, end).join('\n')
  };
}

function isStringListGate(text) {
  const literalCount = naturalLanguageLiterals(text).length;
  if (literalCount < 3) return false;
  if (!LEXICAL_GATE_RE.test(text)) return false;
  if (SUSPICIOUS_LIST_NAME_RE.test(text)) return true;
  return false;
}

function isPotentialStringListGateLine(line) {
  const code = codeWithoutStrings(line);
  if (SUSPICIOUS_LIST_NAME_RE.test(code)) return true;
  if (DECLARES_LIST_RE.test(code)) return true;
  return LEXICAL_GATE_RE.test(code) && naturalLanguageLiterals(line).length > 0;
}

function directGateHasNaturalLanguageLiteral(line) {
  return naturalLanguageLiterals(line)
    .some(value => !/^[A-Za-z0-9_.-]+:$/.test(value));
}

function naturalLanguageLiterals(text) {
  const literals = [];
  for (const match of text.matchAll(STRING_LITERAL_RE)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (isNaturalLanguageToken(value)) literals.push(value);
  }
  return literals;
}

function isNaturalLanguageToken(value) {
  if (value.length < 3) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  if (/^[A-Z0-9_./:-]+$/.test(value)) return false;
  if (/^https?:\/\//.test(value)) return false;
  if (/^[./~]/.test(value)) return false;
  return true;
}

function codeWithoutStrings(text) {
  return text.replace(STRING_LITERAL_RE, '""');
}

function isTrackedFile(file) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return result.status === 0;
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    const command = `git ${args.join(' ')}`;
    const detail = (result.stderr || result.stdout || '').trim();
    console.error(`${command} failed${detail ? `: ${detail}` : ''}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}
