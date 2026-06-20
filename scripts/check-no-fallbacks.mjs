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
  '.py'
]);
const EXCLUDED_FILES = new Set([
  'scripts/check-no-fallbacks.mjs',
  'scripts/check-no-keyword-logic.mjs',
  'scripts/check-no-magic-constants.mjs'
]);
const EXCLUDED_PREFIXES = [
  '.build/',
  '.git/',
  '.swiftpm/',
  '.work/',
  'Tests/',
  'test/',
  'node_modules/'
];

const FALLBACK_IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*fallback[A-Za-z0-9_]*\b/i;
const NULLISH_DEFAULT_RE = /\?\?/;
const LOGICAL_DEFAULT_RE = /(?:=|return|\(|:|,)\s*[^;\n]+(?:\|\|)\s*(?:["'`\[{(]|\d|true\b|false\b|null\b|undefined\b|[A-Za-z_$][A-Za-z0-9_$]*)/;
const OPTIONAL_TRY_RE = /\btry\?/;
const PY_GET_DEFAULT_RE = /\.get\(\s*[^=,\n]+,\s*[^)\n]+\)/;
const PROMISE_CATCH_DEFAULT_RE = /\.catch\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*(?:["'`\[{(]|\d|true\b|false\b|null\b|undefined\b)/;
const CATCH_RETURN_DEFAULT_RE = /\bcatch\b[^{]*{\s*return\s+(?:["'`\[{(]|\d|true\b|false\b|null\b|undefined\b)/;
const EMPTY_CATCH_RE = /\bcatch\b[^{]*{\s*}/;

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
  const documentationLines = documentationLineNumbers(lines);
  const changedLines = mode.all || (mode.kind === 'worktree' && !isTrackedFile(file))
    ? allLineNumbers(lines)
    : changedLineNumbers(mode, file);
  if (changedLines.size === 0) continue;

  for (const lineNumber of changedLines) {
    const line = lines[lineNumber - 1] ?? '';
    if (documentationLines.has(lineNumber)) continue;
    if (isCommentOnlyLine(line)) continue;
    const code = codeWithoutInlineComment(line);

    const rule = fallbackRule(code);
    if (!rule) continue;

    violations.push({
      file,
      line: lineNumber,
      rule: rule.name,
      detail: rule.detail,
      source: line.trim()
    });
  }
}

if (violations.length > 0) {
  console.error('No-fallbacks guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`);
    if (violation.source) console.error(`  ${violation.source}`);
  }
  console.error('');
  console.error('Fail explicitly, validate upstream data, or require configuration instead of adding fallback behavior.');
  process.exit(1);
}

console.log(`No-fallbacks guard passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);

function fallbackRule(code) {
  if (isAllowedFallbackContext(code)) {
    return null;
  }
  if (FALLBACK_IDENTIFIER_RE.test(code)) {
    return {
      name: 'fallback-identifier',
      detail: 'fallback identifiers introduce hidden alternate behavior'
    };
  }
  if (NULLISH_DEFAULT_RE.test(code)) {
    return {
      name: 'nullish-default',
      detail: 'nullish coalescing hides missing data behind a substitute value'
    };
  }
  if (LOGICAL_DEFAULT_RE.test(code) && !isBooleanExpression(code)) {
    return {
      name: 'logical-default',
      detail: 'logical-or defaulting hides missing data behind a substitute value'
    };
  }
  if (OPTIONAL_TRY_RE.test(code)) {
    return {
      name: 'optional-try',
      detail: 'optional try converts errors into missing values'
    };
  }
  if (PY_GET_DEFAULT_RE.test(code)) {
    return {
      name: 'dictionary-default',
      detail: 'dictionary defaults hide missing keys'
    };
  }
  if (PROMISE_CATCH_DEFAULT_RE.test(code)) {
    return {
      name: 'promise-catch-default',
      detail: 'promise catch returns a substitute value'
    };
  }
  if (CATCH_RETURN_DEFAULT_RE.test(code)) {
    return {
      name: 'catch-return-default',
      detail: 'catch block returns a substitute value'
    };
  }
  if (EMPTY_CATCH_RE.test(code)) {
    return {
      name: 'empty-catch',
      detail: 'empty catch block swallows errors'
    };
  }
  return null;
}

function isAllowedFallbackContext(code) {
  const trimmed = code.trim();
  if (/\b_os\.environ\.get\(|\bos\.environ\.get\(/.test(trimmed)) return true;
  if (/\.get\(/.test(trimmed) && (
    trimmed.startsWith('click.echo')
    || trimmed.startsWith('print(')
    || trimmed.startsWith('logger.')
    || trimmed.startsWith('_log(')
    || trimmed.startsWith('f"')
    || trimmed.startsWith("f'")
  )) return true;
  if (/\[[^\]]+\]\s*=\s*[^=\n]+\.get\([^,\n]+,\s*(?:0|0\.0|\[\]|\{\})\)\s*(?:\+|\|)/.test(trimmed)) {
    return true;
  }
  return false;
}

function isBooleanExpression(code) {
  return /^\s*(?:if|while|for)\s*\(/.test(code)
    || /\b(?:true|false)\b\s*(?:\|\|)\s*\b(?:true|false)\b/.test(code)
    || /(?:&&|\|\|)\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:&&|\|\|)/.test(code);
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
  console.error('usage: node check-no-fallbacks.mjs [--all | --staged | --worktree | --base <sha> | --range <before>..<after>]');
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
  if (file.endsWith('/config.py') || file === 'config.py') return false;
  if (file.includes('/profiles/')) return false;
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
