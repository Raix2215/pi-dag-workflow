# Releasing pi-dag-workflow

Maintainer checklist for a public release. Run checks on Node.js 22 and 24. This checklist is not publication authorization.

## 1. Freeze the candidate and permissions

- Obtain explicit approval for the version, repository, branch, tag, GitHub Release, and npm publication as applicable. GitHub and npm are separate channels; approval for one does not authorize the other. Approve the npm dist-tag separately from a prerelease/stable choice.
- Review non-code changes through the applicable maintainer approval process before committing them. Use Conventional Commits.
- Use an approved, clean release checkout. When development history contains private material, prepare a clean candidate on published history; do not push the private development branch or erase published history to make a scan pass. Compare the candidate's source, tests, and package metadata with the validated tree.
- Record the exact candidate commit/tree and validation evidence. Recheck the remote main branch and tag before writing: stop if main moved unexpectedly or the version/tag already exists. Verify an existing publication instead of attempting it again.
- Require complete candidate history before `--history`; a shallow checkout cannot establish full-history hygiene. Do not assume the default CI checkout provides it.

## 2. Prepare metadata

- Set the approved release version in both `package.json` and `package-lock.json`, using `npm version <version> --no-git-tag-version`. Keep `license: MIT`.
- Add a dated `CHANGELOG.md` section matching that version, and update both READMEs for behavior and configuration changes.
- Keep repository URLs in the manifest and README install examples consistent.
- Keep distributed files limited to `src`, both READMEs, `LICENSE`, `CHANGELOG.md`, and the explicitly approved documents in `docs`. Update the release check's document allowlist when adding a public document. Tests, fixtures, scripts, development dependencies, `.github`, and local artifacts must not ship.

## 3. Verify

```bash
npm ci --ignore-scripts
npm run check:all                     # typecheck, offline behavior tests, pack and release hygiene
node scripts/check-release.mjs --history
npm run test:performance
```

`npm run check` runs type checking, offline behavior tests with bounded concurrency (`--test-concurrency=4`), and pack inspection. `npm run check:all` adds `check:release`; neither starts a terminal UI or requires tmux. Running it does not substitute for cross-platform CI, full Git history hygiene, or interaction acceptance.

Terminal changes use one opt-in entry point, `tools/smoke-pty.mjs`: run `npm run smoke -- --require --team` for Team/history changes, or omit `--team` to visit all seven panels. It uses its own `tmux -L` server and must not touch user sessions. `--require` makes missing tmux fail rather than silently skip. Set `SMOKE_FRAMES` to an artifact directory for paired plain/ANSI captures. Check the changed operation and its return path, not a screenshot count; do not run the same scenario twice through different gates.

`check:release` verifies metadata, package contents, and machine-trace hygiene. It rejects personal home paths, private model literals, personal emails, real credential formats, `.env` files, session records, or a tracked `AGENTS.md`. Findings show only the file and rule, never the matched secret. The `--history` flag extends this check to the entire available Git commit history; use complete candidate history without waivers, exemptions, or ignored private history. These checks are bounded safeguards, not proof that every possible secret or packaging defect is detectable. Inspect the actual archive and verify every path in `package.json` → `pi.extensions` is present.

The default test suite requires no credentials or network model. Development dependencies are pinned to Pi 1.3.0; RPC fixtures select `PI_DAG_TEST_CLI` first, then the managed Pi installation, then the repository CLI. Record the actual host versions rather than assuming every check uses the development dependency. The suite executes and reloads module combinations derived across all six modules (`Todos`, `Plan`, `Agents`, `Goal`, `Retry`, `Team`): the registration matrix derives all 64 module combinations, while behavioral tests exercise a bounded 32-selection matrix. Team has its own test suites and real TUI smoke coverage in `tools/smoke-pty.mjs`. Tests also cover scripted failures, native and user-enabled retry coexistence, ordered model replacement, late model-selection cancellation, continuous Goal control, progress updates on paused goals, read-only status, ordinary prerequisite briefs, explicit profile skill files, single-shot child configuration, and secure session file location. Menu and command-view regressions cover paging, search, cancellation, protected reads, stale task/Plan dialogs, and bare-root versus argument-command output. Resource-loader tests cover both working-tree loading and an actual `npm pack --ignore-scripts` archive: the pinned Pi SDK loads all six manifest entries from the unpacked root and checks their registrations, missing entries, and a real conflict error. The packed test uses POSIX `tar` and is skipped on Windows; it is not CLI, model, or cross-platform acceptance. Other hosts can be checked through the explicit override; run `PI_DAG_TEST_CLI="<host dist/bundle/cli.js>" npm test` and record that host version separately. Record any separately performed packed-install acceptance as its own check.

With a caller-selected registered model, also run the bounded opt-in acceptance scripts:

```bash
# Set PI_DAG_TEST_MODEL=provider/model outside repository files.
npm run test:goal-flash
npm run test:continue-flash
npm run test:joint-flash
```

These exercise Goal startup and verification, two separately budgeted automatic rounds, and parallel children with a dependency join. `test:continue-flash` also accepts `PI_DAG_TEST_EXTENSIONS`, a JSON array of explicitly trusted extension paths, to verify coexistence. Disable unrelated memory workers for a bounded lifecycle test; do not confuse that check with a full memory-worker accuracy test. Native compaction tests require no compression extension and run in default CI.

Review every result; opt-in scripts never run in default CI. Their generated artifacts must remain outside the release package. For terminal changes, select a bounded real TUI scenario that exercises the changed flow, including its return path. Keep scripted-provider checks separate from any explicitly approved caller-selected model check. Record the enabled plugins, theme, thinking level, and known untested cases. An isolated fixture run, an isolated real TUI session, and a full configured extension environment are separate checks; an isolated real TUI run does not stand in for the configured environment. Preserve personal configuration and Profile/preset files, and keep private model names, paths, captures, and test records out of Git and the package.

## 4. Authenticate without disclosing credentials

- Load credentials only from the maintainer-approved private source, outside repository files. Keep that source's location in private operational records, not this public guide.
- An approved loader supplies `GH_TOKEN` for GitHub and `NPM_TOKEN` for npm to the intended child process only. Environment names are not token values. Do not print them, pass their values in command arguments or URLs, enable shell tracing, dump the environment, or paste raw authentication errors into reports.
- Do not use `gh auth login`, `npm login`, or persistent Git credential/URL changes as an incidental release step. Do not copy private environment files into a checkout or archive.
- npm does not automatically turn `NPM_TOKEN` into registry authentication. Use a dedicated userconfig template outside the checkout whose entire auth entry is the literal line below; the token value is substituted in memory by npm. Do not write the expanded value or modify the user's existing `.npmrc`.

```ini
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

`AUTH_TEMPLATE` below names that external template, not a credential value. Disable npm debug-log retention for authenticated commands, capture only sanitized results, and remove temporary templates in cleanup. If an authentication response could include a secret, report only the operation, HTTP/error code, and outcome. Never forward an authorization header across origins.

## 5. Publish only the approved channels

### GitHub

Run the following only in the approved release checkout, after approved changes are committed and the candidate/remote checks above pass:

```bash
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')
TAG="v${VERSION}"
COMMIT=$(git rev-parse HEAD)
git status --short                     # must be clean
node scripts/check-release.mjs --history
git tag "$TAG" "$COMMIT"
git push origin HEAD:main
git push origin "refs/tags/${TAG}"
```

Use the approved remote without credentials in its URL. Do not force-push or move an existing tag. Resolve annotated tags to their commit when comparing the remote main/tag with `COMMIT`. Wait for the exact main and tag commit's Node 22/24 CI jobs to succeed; a local pass or an unrelated green run is not sufficient.

Create the approved non-prerelease GitHub Release using the matching CHANGELOG section, explicit repository, and an already-existing verified tag. If using `gh release create`, require `--verify-tag`; do not let the CLI create a missing tag. Verify the public URL, resolved commit, tag, body, draft/prerelease status, and intended latest status. If attaching an archive, inspect and hash the exact file, then verify the downloaded asset against it.

### npm

1. Confirm npm publication and the intended dist-tag are explicitly approved. Query the registry for the exact package/version and current dist-tags. An authentication/network failure does not mean the version is absent. If it already exists, stop publication and verify its archive; do not try to overwrite or silently unpublish it.
2. Run `npm pack --ignore-scripts --pack-destination "$ARTIFACT_DIR"` from the verified release checkout, with `ARTIFACT_DIR` outside that checkout. Inspect the actual archive, compare every declared extension entry, record its SHA-256, and select that exact file as `APPROVED_TARBALL`. Do not repack an unreviewed working tree during publication.
3. With the approved credential loader, external auth template, and selected archive/dist-tag, publish only that archive:

```bash
NPM_CONFIG_USERCONFIG="$AUTH_TEMPLATE" \
  npm publish "$APPROVED_TARBALL" --registry=https://registry.npmjs.org \
    --ignore-scripts --access public --tag "$APPROVED_DIST_TAG" \
    --loglevel=error --logs-max=0
```

4. Query the public registry again. Verify the exact version, publication time, intended dist-tag, and `dist.integrity`; download the registry archive from the approved HTTPS registry origin, check its integrity, and compare its SHA-256 with `APPROVED_TARBALL`. A successful CLI exit alone is not acceptance.
5. A 401/403 or 2FA-related failure is an authentication blocker, not a reason to bypass 2FA or retry indefinitely. Stop, retain only the sanitized error code, and obtain an approved token with the required package scope and 2FA policy. Recheck whether publication succeeded before any retry. Never change account security settings or revoke/replace credentials without approval.

## 6. Record results and handle partial completion

Keep one timestamped receipt per version/channel, linked to the exact candidate commit/tree and archive checksum. Record GitHub/tag/CI and npm/dist-tag/integrity independently, including not-requested, failed, and unverified states. Do not keep conflicting duplicate publication booleans or let an earlier GitHub-only snapshot masquerade as the final npm status. Private evidence and authentication diagnostics do not belong in Git or the package.

If a later step fails after a push, tag, Release, or npm publication succeeded, stop and report what actually happened. Do not repeat completed writes, delete/repoint tags, unpublish a version, or change dist-tags as an automatic rollback. Any corrective external mutation requires its own approval.

## 7. Confirm installation separately

Update only the approved package/source, then compare its installed manifest version and commit/tree with the release. A publication check does not authorize changing the user's Git/npm installation source. Back up and verify a clean installation first; preserve session history, configuration, Profile/preset files, and unrelated packages.

Running sessions need `/reload` or a restart; do not perform either automatically. Reload pauses restored Goals, including autoresearch, while `/retry` keeps its saved enabled state and interval settings and only cancels a pending recovery. Re-enable a Goal explicitly, and verify the saved candidate order, Goal controls, and retry settings were preserved.

Keep private vulnerability reporting enabled as described in `SECURITY.md`.
