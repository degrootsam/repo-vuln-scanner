import { parse } from 'csv/sync';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync } from 'fs';
import { join, basename } from 'path';

interface CsvRow {
  item_type: string;
  category: string;
  identifier: string;
  detail: string;
  href: string;
}

const CSV_DIR = './import';
const PARSED_DIR = './import/parsed';
const OUTPUT_DIR = './affected';

mkdirSync(PARSED_DIR, { recursive: true });

const csvFiles = readdirSync(CSV_DIR).filter(f => f.endsWith('.csv'));

if (csvFiles.length === 0) {
  console.log('No CSV files found in', CSV_DIR);
  process.exit(0);
}

for (const file of csvFiles) {
  const srcPath = join(CSV_DIR, file);
  const content = readFileSync(srcPath, 'utf8');

  const records = parse(content, { columns: true, skip_empty_lines: true }) as CsvRow[];

  const packages: string[] = [];

  for (const row of records) {
    if (row.item_type !== 'package') continue;

    const name = row.identifier;
    const detail = row.detail ?? '';
    const versionsMatch = detail.match(/versions:\s*([^|]+)/);
    if (!versionsMatch) continue;

    const versions = versionsMatch[1].split(',').map(v => v.trim()).filter(Boolean);
    for (const version of versions) {
      packages.push(`${name}@${version}`);
    }
  }

  const stem = basename(file, '.csv');
  const outPath = join(OUTPUT_DIR, `${stem}.txt`);
  writeFileSync(outPath, packages.join('\n') + '\n');
  console.log(`Wrote ${packages.length} entries to ${outPath}`);

  renameSync(srcPath, join(PARSED_DIR, file));
  console.log(`Moved ${file} to ${PARSED_DIR}`);
}
