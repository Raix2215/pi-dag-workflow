# Releasing pi-dag-workflow

Maintainer checklist for a public release. Run every command from the repository root on Node.js 22 or 24.

## 1. Prepare metadata

- Keep `version` at the intended release (`0.1.0` for the first public preview) and `license: MIT`.
- Fill the real repository URL in `package.json` and update the clone/install links in `README.md` and `README.zh-CN.md`. The placeholder `<owner>` in the READMEs and an absent `repository` field are intentional until then; the checker only warns about the missing URL.
- Keep `files` limited to `src`, both READMEs, `LICENSE`, `CHANGELOG.md`, and `docs`. Tests, fixtures, scripts, `.github`, and local artifacts must never ship.
- Move the `0.1.0` section of `CHANGELOG.md` from `Unreleased` to the release date.

## 2. Run the checks

```bash
npm ci --ignore-scripts
npm run check          # typecheck + tests + pack dry run + release hygiene
npm run check:release  # metadata, package contents, and machine-trace scan
node scripts/check-release.mjs --history   # also scan commit metadata and historical content
```

`check:release` fails on a `0.0.0` version, a non-MIT license, a missing whitelisted file, a forbidden path in the tarball, a tracked `AGENTS.md`, or a detected home path, private model reference, personal email, or real credential format. It prints only the file and rule, never the matched value.

Never commit secrets, API keys, personal file paths, private provider names, `.env` files, or `artifacts/`. If a trace was committed earlier, sanitize the history before publishing.

## 3. Publish (only with explicit maintainer approval)

Tagging, pushing, and creating a GitHub Release require explicit maintainer approval. Use only the repository URL and remote approved for this project.

```bash
npm pack --dry-run   # inspect the tarball one last time
git tag v0.1.0
git push <remote> main
git push <remote> v0.1.0
```

Then create the GitHub Release for `v0.1.0`.

## 4. Repository settings

- Enable private vulnerability reporting (Security → Advisories) so `SECURITY.md` stays accurate.
- Keep the default checks credential-free. The live acceptance scripts require `PI_DAG_TEST_MODEL` and are never part of `npm run check`.
