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

const STRING_LITERAL_RE = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
const NUMBER_LITERAL_RE = /(?<![A-Za-z0-9_$])[-+]?(?:\d+\.\d+|\d+)(?:e[-+]?\d+)?(?![A-Za-z0-9_$])/gi;
const NAMED_CONSTANT_RE = /^\s*(?:(?:export\s+)?(?:const|let|var|static\s+let|static\s+var)\s+)?[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=/;
const IMPORT_RE = /^\s*(?:import|export)\b.*\bfrom\b|^\s*(?:import|require)\s*\(/;
const LOCAL_LITERAL_ASSIGN_RE = /^\s*(?:const|let|var)?\s*[a-z_][A-Za-z0-9_]*\s*(?::[^=]+)?=\s*(?:["'`]|[-+]?(?:\d+\.\d+|\d+)(?:e[-+]?\d+)?\b)/i;
const LOGIC_LITERAL_RE = /^\s*(?:if|elif|while|for|return|assert)\b|(?:[=!<>]=|[<>])|[-+*/%]=|\b(?:range|sleep|timeout|limit|max|min)\s*\(/;
const ALLOWED_NUMBER_LITERALS = new Set(['-1', '0', '1', '2']);

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
    if (isLikelyDocumentationLine(line)) continue;
    if (isAllowedLiteralContext(line)) continue;
    if (!isLiteralSensitiveContext(line)) continue;

    for (const violation of literalViolations(line)) {
      violations.push({
        file,
        line: lineNumber,
        ...violation,
        source: line.trim()
      });
    }
  }
}

if (violations.length > 0) {
  console.error('No-magic-constants guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`);
    if (violation.source) console.error(`  ${violation.source}`);
  }
  console.error('');
  console.error('Name the value, load it from configuration, or derive it from typed metadata instead of embedding it in logic.');
  process.exit(1);
}

console.log(`No-magic-constants guard passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);

function literalViolations(line) {
  const code = codeWithoutInlineComment(line);
  const withoutStrings = code.replace(STRING_LITERAL_RE, '""');
  const found = [];

  for (const match of code.matchAll(STRING_LITERAL_RE)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!isSignificantString(value)) continue;
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

  return found;
}

function isSignificantString(value) {
  if (value.length < 3) return false;
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
  return LOCAL_LITERAL_ASSIGN_RE.test(code) || LOGIC_LITERAL_RE.test(code);
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
  return String(Number(value));
}

function abbreviate(value) {
  if (value.length <= 32) return value;
  return `${value.slice(0, 29)}...`;
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
  console.error('usage: node check-no-magic-constants.mjs [--all | --staged | --worktree | --base <sha> | --range <before>..<after>]');
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
  if (file.includes('/_catalog/')) return false;
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
