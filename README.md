# Repo Vulnerability scanner

Scans an organisation'srepositories via GitHub's SBOM API (Dependency Graph)
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

## Usage

1. Rename `env.example` to `.env`.
2. Insert your GitHub PAT token.
3. Edit the `affected.txt` to contain your targeted packages.
4. Start the scanner:

```bash
# Simple
node sbom-scan.mjs --org=<ORG>

#Advanced
node sbom-scan.mjs --org=<ORG> [--in=affected.txt] [--out=matches.json] [--include-forks] [--include-archived] [--concurrency=6]
```

> [!NOTE]
> The token needs access to your organisation's repos (scope: repo). Make sure the owner of the PAT is set to the target org.
