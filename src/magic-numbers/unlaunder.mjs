#!/usr/bin/env node
// wisent-unlaunder-numbers: write back, as plain literals, the numbers a
// JavaScript or TypeScript source dressed up to slip past the magic-number
// guards: `Number('8')`, `Number(true)`, `parseInt('77', 8)`, `'xxxx'.length`,
// `const radix = 'node-radix'.length`, unary `+''`. The value is computed the
// way the runtime computes it, so the rewrite changes spelling, not behaviour.
//
// Only tracked files with no uncommitted change are read, so a file somebody
// else is editing is reported and left alone. Without --write it lists what
// it would rewrite; with --write it rewrites and lists what it did.
//
//   wisent-unlaunder-numbers --repository <path> [--write] [--json]
//   wisent-unlaunder-numbers --workspace <dir> [--skip <name>]... [--write] [--json]
//
// --workspace reads every Git repository directly inside <dir>, in name
// order, and prints one summary line per repository that has any.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, MAX_OUTPUT_BYTES } from '../lib/constants.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
// A decimal JavaScript writes without change: no leading zero that strict mode
// would read as octal.
const DECIMAL = '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?';
const RADIX_PREFIX = new Map([[2, '0b'], [8, '0o'], [16, '0x']]);
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*)/;

// Each rule finds one disguise and answers the literal it stands for, or
// null when the value would not be written back exactly.
const RULES = [
  {
    form: 'Number(quoted decimal)',
    pattern: new RegExp(`\\bNumber\\s*\\(\\s*(['"])(${DECIMAL})\\1\\s*\\)`, 'g'),
    literal: (match) => match[2],
  },
  {
    form: 'parseInt(quoted decimal)',
    pattern: new RegExp(`(?<![\\w$.])(?:Number\\.)?parseInt\\s*\\(\\s*(['"])(${DECIMAL})\\1\\s*\\)`, 'g'),
    literal: (match) => String(Number.parseInt(match[2], 10)),
  },
  {
    form: 'parseFloat(quoted decimal)',
    pattern: new RegExp(`(?<![\\w$.])(?:Number\\.)?parseFloat\\s*\\(\\s*(['"])(${DECIMAL})\\1\\s*\\)`, 'g'),
    literal: (match) => String(Number.parseFloat(match[2])),
  },
  {
    form: 'parseInt(quoted text, radix)',
    pattern: /(?<![\w$.])(?:Number\.)?parseInt\s*\(\s*(['"])([0-9A-Za-z]+)\1\s*,\s*(['"]?)(\d+)\3\s*\)/g,
    literal: (match) => {
      const radix = Number.parseInt(match[4], 10);
      const value = Number.parseInt(match[2], radix);
      if (!Number.isSafeInteger(value) || value.toString(radix) !== match[2].toLowerCase().replace(/^0+(?=.)/, '')) return null;
      return RADIX_PREFIX.has(radix) ? `${RADIX_PREFIX.get(radix)}${match[2].toLowerCase()}` : String(value);
    },
  },
  {
    form: 'Number(true)',
    pattern: /\bNumber\s*\(\s*true\s*\)/g,
    literal: () => '1',
  },
  {
    form: 'Number(false)',
    pattern: /\bNumber\s*\(\s*false\s*\)/g,
    literal: () => '0',
  },
  {
    form: 'filler string length',
    pattern: /(['"])(x*|0*)\1\s*\.\s*length\b/g,
    literal: (match) => String(match[2].length),
  },
  {
    form: 'name bound to a string literal length',
    pattern: /(?<=\b[A-Za-z_$][\w$]*\s*=\s*)(['"])([^'"\n\\]*)\1\s*\.\s*length(?=\s*;?\s*$)/gm,
    literal: (match) => String(match[2].length),
  },
  {
    form: "unary +''",
    pattern: /(?<=(?:^|[=(,:?])\s*)\+\s*(['"])\1/gm,
    literal: () => '0',
  },
];

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error) throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== EXIT.clean) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout;
}

function parseArgs(argv) {
  const options = { repository: null, workspace: null, skip: new Set(), write: false, json: false, commit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repository') {
      options.repository = argv[index + 1];
      index += 1;
    } else if (argument === '--workspace') {
      options.workspace = argv[index + 1];
      index += 1;
    } else if (argument === '--skip') {
      options.skip.add(argv[index + 1]);
      index += 1;
    } else if (argument === '--write') {
      options.write = true;
    } else if (argument === '--commit') {
      options.commit = argv[index + 1];
      options.write = true;
      index += 1;
    } else if (argument === '--json') {
      options.json = true;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (Boolean(options.repository) === Boolean(options.workspace)) {
    throw new Error('exactly one of --repository and --workspace is required');
  }
  if (options.commit !== null && !options.commit.trim()) throw new Error('--commit needs a message');
  return options;
}

// A literal that starts with a minus sign right after another sign would
// become `--` or `+-`; it goes in parentheses there.
function placed(text, index, literal) {
  const before = text.slice(0, index).trimEnd().at(-1);
  return literal.startsWith('-') && (before === '-' || before === '+') ? `(${literal})` : literal;
}

// Whether `index` falls inside a quoted string or template text on this
// line, read from the quotes before it. A disguise spelled inside a string is
// text, such as an error message or this file's own rule names, not a number
// in code; inside a template's `${…}` it is code again.
function insideString(line, index) {
  const QUOTES = "'\"`";
  const open = [];
  for (let position = 0; position < index; position += 1) {
    const character = line[position];
    const top = open.at(-1);
    if (top !== undefined && QUOTES.includes(top)) {
      if (character === '\\') {
        position += 1;
      } else if (top === '`' && character === '$' && line[position + 1] === '{') {
        open.push('{');
        position += 1;
      } else if (character === top) {
        open.pop();
      }
    } else if (QUOTES.includes(character)) {
      open.push(character);
    } else if (character === '{' && top === '{') {
      open.push('{');
    } else if (character === '}' && top === '{') {
      open.pop();
    }
  }
  const top = open.at(-1);
  return top !== undefined && QUOTES.includes(top);
}

/** Rewrite one file's text; answers the new text and every change made. */
export function unlaunder(text) {
  const changes = [];
  const lines = text.split('\n');
  const rewritten = lines.map((line, lineIndex) => {
    if (COMMENT_LINE_RE.test(line)) return line;
    let current = line;
    for (const rule of RULES) {
      current = current.replace(rule.pattern, (...args) => {
        const groups = args.slice(0, -2);
        const offset = args.at(-2);
        const literal = insideString(current, offset) ? null : rule.literal(groups);
        if (literal === null) return groups[0];
        const written = placed(current, offset, literal);
        changes.push({ line: lineIndex + 1, form: rule.form, from: groups[0], to: written });
        return written;
      });
    }
    return current;
  });
  return { text: rewritten.join('\n'), changes };
}

function repositoryReport(repository, write) {
  const root = realpathSync(repository);
  const tracked = git(['ls-files', '-z'], root).split('\0').filter(Boolean);
  const dirty = new Set(git(['status', '--porcelain', '-z', '--untracked-files=no'], root)
    .split('\0').filter(Boolean).map((entry) => entry.slice(3)));
  const files = [];
  const skipped = [];
  for (const relative of tracked) {
    if (!SOURCE_EXTENSIONS.has(path.extname(relative))) continue;
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) continue;
    const original = readFileSync(absolute, 'utf8');
    const { text, changes } = unlaunder(original);
    if (!changes.length) continue;
    if (dirty.has(relative)) {
      skipped.push({ file: relative, reason: 'uncommitted changes', changes: changes.length });
      continue;
    }
    if (write) writeFileSync(absolute, text);
    files.push({ file: relative, changes });
  }
  return { repository: root, written: write, files, skipped };
}

// Commit exactly the files this run rewrote, by path, so nothing else
// staged or modified in the repository rides along.
function commitRewritten(report, message) {
  if (!report.files.length) return null;
  git(['commit', '-q', '-m', message, '--', ...report.files.map((file) => file.file)], report.repository);
  return git(['rev-parse', '--short', 'HEAD'], report.repository).trim();
}

function printRepository(report) {
  for (const file of report.files) {
    for (const change of file.changes) {
      process.stdout.write(`${file.file}:${change.line}: ${change.from} -> ${change.to} (${change.form})\n`);
    }
  }
  for (const entry of report.skipped) {
    process.stdout.write(`skipped ${entry.file}: ${entry.reason} (${entry.changes} disguised numbers)\n`);
  }
  const count = report.files.reduce((sum, file) => sum + file.changes.length, 0);
  process.stdout.write(`${report.written ? 'rewrote' : 'would rewrite'} ${count} disguised numbers in ${report.files.length} files${report.commit ? `; committed ${report.commit}` : ''}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.repository) {
    const report = repositoryReport(options.repository, options.write);
    if (options.commit) report.commit = commitRewritten(report, options.commit);
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printRepository(report);
    return;
  }
  const workspace = realpathSync(options.workspace);
  const reports = readdirSync(workspace, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !options.skip.has(entry.name) && existsSync(path.join(workspace, entry.name, '.git')))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, ...repositoryReport(path.join(workspace, name), options.write) }))
    .map((report) => (options.commit ? { ...report, commit: commitRewritten(report, options.commit) } : report))
    .filter((report) => report.files.length || report.skipped.length);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ workspace, written: options.write, repositories: reports }, null, 2)}\n`);
    return;
  }
  for (const report of reports) {
    const count = report.files.reduce((sum, file) => sum + file.changes.length, 0);
    const held = report.skipped.reduce((sum, entry) => sum + entry.changes, 0);
    process.stdout.write(`${report.name}: ${options.write ? 'rewrote' : 'would rewrite'} ${count} in ${report.files.length} files; ${held} left in ${report.skipped.length} files with uncommitted changes${report.commit ? `; committed ${report.commit}` : ''}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`wisent-unlaunder-numbers: ${error.message}\n`);
    process.exitCode = EXIT.error;
  }
}
