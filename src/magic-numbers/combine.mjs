#!/usr/bin/env node
// One table over several fleet audits: for every repository, how many findings each
// guard reported, so a clean-up can be ordered by total work instead of one rule.
//
//   node src/magic-numbers/combine.mjs [--json] <audit output directory>...
//
// Prints a tab-separated table, or with --json the same rows as one JSON object.
// Exit 0: the table was printed. Exit 2: wrong invocation, an unreadable report, or
// an audit that could not read a repository.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT, RESULT } from '../lib/constants.mjs';

const USAGE = 'usage: node src/magic-numbers/combine.mjs [--json] <audit output directory>...';

function refuse(message) {
  console.error(`combine: ${message}`);
  console.error(USAGE);
  process.exit(EXIT.error);
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(USAGE);
  process.exit(EXIT.clean);
}
const json = args.includes('--json');
const reports = args.filter(argument => argument !== '--json');
const unknown = reports.find(argument => argument.startsWith('--'));
if (unknown) refuse(`unknown argument ${unknown}`);
if (reports.length === 0) refuse('name at least one audit output directory');

function readReport(directory) {
  const file = path.join(directory, 'report.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return refuse(`${file}: ${error.message}`);
  }
}

const columns = [];
const totals = new Map();
for (const directory of reports) {
  const report = readReport(directory);
  columns.push(report.checker.name);
  for (const record of report.repositories) {
    if (!totals.has(record.name)) totals.set(record.name, {});
    const row = totals.get(record.name);
    if (record.result === RESULT.error) refuse(`${report.checker.name} could not audit ${record.name}: ${record.error}`);
    row[report.checker.name] = record.violations.length;
  }
}

const rows = [...totals.entries()]
  .map(([name, counts]) => ({ name, counts, total: columns.reduce((sum, column) => sum + counts[column], 0) }))
  .filter(row => row.total > 0)
  .sort((left, right) => {
    if (right.total !== left.total) return left.total - right.total;
    return left.name.localeCompare(right.name);
  });

if (json) {
  console.log(JSON.stringify({ checkers: columns, repositories: rows }, null, 2));
} else {
  console.log(['total', ...columns, 'repository'].join('\t'));
  for (const row of rows) {
    console.log([row.total, ...columns.map(column => row.counts[column]), row.name].join('\t'));
  }
}
