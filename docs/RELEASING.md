# Releasing pi-dag-workflow

Maintainer checklist for a public release. Run checks on Node.js 22 and 24.

## 1. Prepare metadata

- Set the approved release version in both `package.json` and `package-lock.json`, using `npm version <version> --no-git-tag-version`. Keep `license: MIT`.
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

The default test suite requires no credentials or network model. Its integration tests launch isolated Pi processes with scripted providers, including transient failures and native/Goal retry coexistence. The packed-install test loads all five entry points and launches a child using the host's Pi dependencies. To validate another installed host, run `PI_DAG_TEST_CLI="<host dist/bundle/cli.js>" npm test` and record that host version separately.

With a caller-selected registered model, also run the bounded opt-in acceptance scripts:

```bash
# Set PI_DAG_TEST_MODEL=provider/model outside repository files.
npm run test:goal-flash
npm run test:continue-flash
npm run test:joint-flash
```

These exercise Goal startup and verification, two separately budgeted automatic rounds, and parallel children with a dependency join. `test:continue-flash` also accepts `PI_DAG_TEST_EXTENSIONS`, a JSON array of explicitly trusted extension paths, to verify coexistence. Disable unrelated memory workers for a bounded lifecycle test; do not confuse that check with a full memory-worker accuracy test. Native compaction tests require no compression extension and run in default CI.

Review every result; opt-in scripts never run in default CI. Their generated artifacts must remain outside the release package.

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

Create a non-prerelease GitHub Release for the tag using its CHANGELOG section. Confirm the tag resolves to the reviewed commit and the main/tag Node 22/24 CI jobs succeed. If attaching an npm package archive, run `npm pack --ignore-scripts` outside the source tree, inspect its contents, and record its SHA-256. Confirm the published asset matches that checksum. GitHub and npm publication are separate operations.

## 4. Confirm installation

Update only the approved package with `pi update <package-source>`, then compare its installed manifest version and commit with the release. Running sessions need `/reload` or a restart. Reload pauses restored Goals; use `/goal enable` explicitly when ready to resume.

Keep private vulnerability reporting enabled as described in `SECURITY.md`. Preserve session history, user configuration, and unrelated packages during installation updates.
