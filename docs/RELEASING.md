# Releasing pi-dag-workflow

Maintainer checklist for a public release. Run checks on Node.js 22 and 24.

## 1. Prepare metadata

- Set the intended version in both `package.json` and `package-lock.json`, for example with `npm version 0.2.0 --no-git-tag-version`. Keep `license: MIT`.
- Add a dated `CHANGELOG.md` section matching that version, and update both READMEs for behavior and configuration changes.
- Keep repository URLs in the manifest and README install examples consistent.
- Keep distributed files limited to `src`, both READMEs, `LICENSE`, `CHANGELOG.md`, and the explicitly approved documents in `docs`. Update the release check's document allowlist when adding a public document. Tests, fixtures, scripts, development dependencies, `.github`, and local artifacts must not ship.

## 2. Verify

```bash
npm ci --ignore-scripts
npm run check                         # typecheck, offline tests, pack inspection, hygiene
node scripts/check-release.mjs --history
npm run test:performance
```

`check:release` verifies metadata, package contents, and machine-trace hygiene. It rejects personal home paths, private model literals, personal emails, real credential formats, `.env` files, session records, or a tracked `AGENTS.md`. Findings show only the file and rule, never the matched secret.

The default test suite requires no credentials or network model. Its integration tests launch isolated Pi processes with scripted providers, including transient failures and native/Goal retry coexistence. The packed-install test loads all five entry points and launches a child without bundled Pi dependencies.

With a caller-selected registered model, also run the bounded opt-in acceptance scripts:

```bash
# Set PI_DAG_TEST_MODEL=provider/model outside repository files.
npm run test:goal-flash
npm run test:continue-flash
npm run test:joint-flash
```

These exercise Goal startup and verification, two separately budgeted automatic rounds, and parallel children with a dependency join. Review every result; opt-in scripts never run in default CI. Their generated artifacts must remain outside the release package.

## 3. Publish with maintainer approval

Pushing, tagging, and creating a GitHub Release require explicit approval. Use the approved repository and remote; never embed credentials in a URL, commit, file, or persistent Git configuration.

```bash
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')
npm pack --dry-run --ignore-scripts
git status --short                     # confirm only intended changes
git add <reviewed-files>
git commit -m "Release v${VERSION}"
node scripts/check-release.mjs --history
git tag "v${VERSION}"
git push origin main
git push origin "v${VERSION}"
```

Create the GitHub Release for the tag using its CHANGELOG section. Confirm the tag resolves to the reviewed commit and the Node 22/24 CI jobs succeed. These steps publish to GitHub; npm publication is a separate approval and operation.

## 4. Confirm installation

Update only the approved package with `pi update <package-source>`, then compare its installed manifest version and commit with the release. Running sessions need `/reload` or a restart. Reload pauses restored Goals; use `/goal enable` explicitly when ready to resume.

Keep private vulnerability reporting enabled as described in `SECURITY.md`. Preserve session history, user configuration, and unrelated packages during installation updates.
