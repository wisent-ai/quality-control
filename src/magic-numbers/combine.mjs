#!/usr/bin/env node
// One table over several fleet audits: for every repository, how many findings each
// guard reported, so a clean-up can be ordered by total work instead of one rule.
//
//   node src/magic-numbers/combine.mjs <audit output directory>...
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT, RESULT } from '../lib/constants.mjs';

const reports = process.argv.slice(2);
if (reports.length === 0) {
  console.error('usage: node src/magic-numbers/combine.mjs <audit output directory>...');
  process.exit(EXIT.error);
}

const columns = [];
const totals = new Map();
for (const directory of reports) {
  const report = JSON.parse(readFileSync(path.join(directory, 'report.json'), 'utf8'));
  columns.push(report.checker.name);
  for (const record of report.repositories) {
    if (!totals.has(record.name)) totals.set(record.name, {});
    const row = totals.get(record.name);
    if (record.result === RESULT.error) throw new Error(`${report.checker.name} could not audit ${record.name}: ${record.error}`);
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

console.log(['total', ...columns, 'repository'].join('\t'));
for (const row of rows) {
  console.log([row.total, ...columns.map(column => row.counts[column]), row.name].join('\t'));
}
