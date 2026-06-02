import * as dotenv from "dotenv";
dotenv.config();

import { Octokit } from "octokit";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import semver from "semver";

// -------------------- Types --------------------
interface CliArgs {
  org?: string;
  in?: string;
  out?: string;
  "include-forks"?: boolean | string;
  "include-archived"?: boolean | string;
  concurrency?: string | number;
  [key: string]: boolean | string | number | undefined;
}

interface ParsedEntry {
  name: string;
  version: string;
}

interface ExternalRef {
  referenceType?: string;
  referenceLocator?: string;
}

interface SpdxPackage {
  name?: unknown;
  versionInfo?: unknown;
  externalRefs?: ExternalRef[];
}

interface SbomData {
  packages?: SpdxPackage[];
}

interface Match {
  package: string;
  version: string;
  repositories: string[];
}

interface OutputReport {
  org: string;
  generated_at: string;
  input_entries: number;
  repos_scanned: number;
  matches: Match[];
  host: string;
}

// -------------------- CLI args --------------------
const args: CliArgs = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);

const ORG = (args.org as string | undefined) || process.env.ORG;
const IN = (args.in as string | undefined) || "affected.txt";
const OUT = (args.out as string | undefined) || "matches.json";
const INCLUDE_FORKS = Boolean(args["include-forks"]);
const INCLUDE_ARCHIVED = Boolean(args["include-archived"]);
const CONCURRENCY = Number(args.concurrency ?? 6);

if (!ORG) {
  console.error("Missing --org or environment ORG");
  process.exit(1);
}
if (!process.env.GITHUB_TOKEN) {
  console.error("Missing GITHUB_TOKEN env");
  process.exit(1);
}

// -------------------- Helpers --------------------
function parsePkgNameVersionFromSpdx(p: SpdxPackage): ParsedEntry | null {
  const n = String(p.name ?? "");
  const v = String(p.versionInfo ?? "");
  if (n && semver.valid(v)) return { name: n, version: v };

  const ext = Array.isArray(p.externalRefs) ? p.externalRefs : [];
  const purl = ext.find((e) => e?.referenceType === "purl")?.referenceLocator;
  if (typeof purl === "string" && purl.startsWith("pkg:npm/")) {
    const m = purl.match(/^pkg:npm\/(.+)@(.+)$/);
    if (m) {
      const pathPart = decodeURIComponent(m[1]);
      const version = m[2];
      if (semver.valid(version)) return { name: pathPart, version };
    }
  }
  return null;
}

function parseLine(line: string): ParsedEntry | null {
  const s = line.trim();
  if (!s || s.startsWith("#")) return null;
  const at = s.lastIndexOf("@");
  if (at <= 0) return null;
  const name = s.slice(0, at).trim();
  const version = s.slice(at + 1).trim();
  if (!name || !version) return null;
  return { name, version };
}

function keyNameVersion(name: string, version: string): string {
  return `${name.toLowerCase()}@${version}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  const active = new Set<Promise<void>>();

  async function runOne(idx: number): Promise<void> {
    const p: Promise<void> = (async () => {
      const r = await worker(items[idx], idx);
      results[idx] = r;
    })();
    active.add(p);
    try {
      await p;
    } finally {
      active.delete(p);
    }
  }

  while (i < items.length) {
    while (active.size < limit && i < items.length) {
      void runOne(i++);
    }
    if (active.size) await Promise.race(active);
  }
  while (active.size) await Promise.race(active);
  return results;
}
// -------------------- Scan SBOMs --------------------

const scan = async () => {
  // -------------------- Input & lookups --------------------
  const lines = readFileSync(IN, "utf8").split(/\r?\n/);
  const entries = lines
    .map(parseLine)
    .filter((e): e is ParsedEntry => e !== null);

  const wantedMaxVersion = new Map<string, string>();
  for (const { name, version } of entries) {
    if (!semver.valid(version)) continue;
    const key = name.toLowerCase();
    const prev = wantedMaxVersion.get(key);
    if (!prev || semver.gt(version, prev)) {
      wantedMaxVersion.set(key, version);
    }
  }

  // -------------------- Octokit --------------------
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
    defaults: {
      headers: { "X-GitHub-Api-Version": "2022-11-28" },
    },
  });

  // -------------------- Repo list --------------------
  const repos = await octokit.paginate("GET /orgs/{org}/repos", {
    org: ORG,
    per_page: 100,
    type: "all",
  });

  const reposToScan = repos.filter((r) => {
    if (!INCLUDE_FORKS && r.fork) return false;
    if (!INCLUDE_ARCHIVED && r.archived) return false;
    return true;
  });

  // -------------------- SBOM async fetch --------------------
  async function fetchSbom(owner: string, repoName: string): Promise<SbomData> {
    const genRes = await octokit.request(
      "GET /repos/{owner}/{repo}/dependency-graph/sbom/generate-report",
      { owner, repo: repoName },
    );
    const reportUrl = (genRes.data as { sbom_url?: string })?.sbom_url ?? "";
    const m = reportUrl.match(/fetch-report\/([^/?#\s]+)/);
    if (!m)
      throw new Error(
        `Unexpected generate-report response: ${JSON.stringify(genRes.data)}`,
      );
    const uuid = m[1];

    while (true) {
      const res = await octokit.request(
        "GET /repos/{owner}/{repo}/dependency-graph/sbom/fetch-report/{sbom-uuid}",
        { owner, repo: repoName, "sbom-uuid": uuid },
      );
      if (res.status === 201) {
        await sleep(3000);
        continue;
      }
      return (res.data as { sbom?: SbomData })?.sbom ?? {};
    }
  }

  const affectedMap = new Map<string, Set<string>>();

  await pool(reposToScan, CONCURRENCY, async (repo) => {
    const full = repo.full_name ?? `${ORG}/${repo.name}`;
    console.log(`Scanning ${full}`);
    try {
      const sbom = await fetchSbom(ORG, repo.name);
      const pkgs: SpdxPackage[] = Array.isArray(sbom?.packages)
        ? sbom.packages
        : [];
      console.log(
        `Found ${pkgs.length} packages in repository. Checking for matches with affected packages`,
      );

      const foundPairs = new Set<string>();

      for (const p of pkgs) {
        const nv = parsePkgNameVersionFromSpdx(p);
        if (!nv) continue;
        const nameLower = nv.name.toLowerCase();
        const maxAllowed = wantedMaxVersion.get(nameLower);
        if (!maxAllowed) continue;
        if (semver.lte(nv.version, maxAllowed)) {
          console.log(
            `Package ${String(p.name)}@${String(p.versionInfo)} matched with an affected version`,
          );
          foundPairs.add(keyNameVersion(nv.name, nv.version));
        }
      }

      for (const pair of foundPairs) {
        if (!affectedMap.has(pair)) affectedMap.set(pair, new Set());
        affectedMap.get(pair)!.add(full);
      }

      if (foundPairs.size === 0) console.log("No affected packages found!");
    } catch (e) {
      const err = e as {
        status?: number;
        message?: string;
        response?: { headers?: Record<string, string> };
      };
      const msg = err?.status ? `${err.status}` : (err?.message ?? "error");
      console.error(`SBOM fetch failed for ${full}: ${msg}`);
      if (err?.status === 429 || err?.response?.headers?.["retry-after"]) {
        await sleep(1000);
      }
    }
  });

  // -------------------- Build output --------------------
  const matches: Match[] = [];
  for (const [pair, setRepos] of affectedMap.entries()) {
    const at = pair.lastIndexOf("@");
    const pkg = pair.slice(0, at);
    const ver = pair.slice(at + 1);
    matches.push({
      package: pkg,
      version: ver,
      repositories: Array.from(setRepos).sort(),
    });
  }
  matches.sort((a, b) =>
    a.package === b.package
      ? a.version.localeCompare(b.version)
      : a.package.localeCompare(b.package),
  );

  const out: OutputReport = {
    org: ORG,
    generated_at: new Date().toISOString(),
    input_entries: entries.length,
    repos_scanned: reposToScan.length,
    matches,
    host: os.hostname(),
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log(
    `Wrote ${OUT} with ${matches.length} distinct package@version matches across ${reposToScan.length} repos.`,
  );
};

scan();
