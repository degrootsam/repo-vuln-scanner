import { parse } from "csv/sync";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
} from "fs";
import { createPrompter } from "./utils/prompter";
import { join, basename } from "path";

interface CsvRow {
  item_type: string;
  category: string;
  identifier: string;
  detail: string;
  href: string;
  [key: string]: any;
}

const CSV_DIR = "./import";
const PARSED_DIR = "./import/parsed";
const OUTPUT_DIR = "./affected";

mkdirSync(PARSED_DIR, { recursive: true });

const csvFiles = readdirSync(CSV_DIR).filter((f) => f.endsWith(".csv"));

if (csvFiles.length === 0) {
  console.log("No CSV files found in", CSV_DIR);
  process.exit(0);
}

const prompter = createPrompter();

const main = async () => {
  for (const file of csvFiles) {
    const srcPath = join(CSV_DIR, file);
    const content = readFileSync(srcPath, "utf8");

    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
    }) as Record<keyof CsvRow, any>[];

    const packages: string[] = [];
    const name: string = await prompter.input(
      `Please enter the key of the column containing the package identifier/name (${file})`,
      true,
    );

    const version: string = await prompter.input(
      `Please enter the key of the column containing the package version (${file})`,
      true,
    );

    for (const row of records) {
      const packageName = row[name];
      const packageVersion = row[version] ?? "";
      const versions = packageVersion
        .split(",")
        .map((v: string) => v.trim())
        .filter(Boolean);
      console.log({ packageName, packageVersion, versions });

      for (const version of versions) {
        packages.push(`${packageName}@${version}`);
      }
    }

    const stem = basename(file, ".csv");
    const outPath = join(OUTPUT_DIR, `${stem}.txt`);
    writeFileSync(outPath, packages.join("\n") + "\n");
    console.log(`Wrote ${packages.length} entries to ${outPath}`);

    renameSync(srcPath, join(PARSED_DIR, file));
    console.log(`Moved ${file} to ${PARSED_DIR}`);
  }
};

main();
