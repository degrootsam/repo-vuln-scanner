# NPM Vulnerability Scanner for Repositories

Scans an organisation's repositories via GitHub's SBOM API (Dependency Graph)
and reports which repos contain any package@version listed in an input file.

## Installation

1. Clone this repo:

   ```bash
   git clone https://github.com/degrootsam/shai-hulud-detector.git
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

## Workflow

### 1. Get affected packages

Download threat intelligence CSVs from [SafeDep](https://safedep.io) and place them in the `import/` directory.

### 2. Parse the CSV

Convert downloaded CSVs into `package@version` lists:

```bash
npm run parse-csv
```

For each CSV in `import/`, this writes a corresponding `.txt` to `affected/` and moves the parsed CSV to `import/parsed/`.

### 3. Scan repositories

1. Rename `env.example` to `.env` and insert your GitHub PAT token.
2. Run the scanner against your org, pointing it at the generated affected file:

```bash
# Simple
npm run sbom-scan -- --org=<ORG>

# Advanced
npm run sbom-scan -- --org=<ORG> --in=affected/<file>.txt [--out=matches.json] [--include-forks] [--include-archived] [--concurrency=6]
```

> [!NOTE]
> The token needs access to your organisation's repos (scope: repo). Make sure the owner of the PAT is set to the target org.
