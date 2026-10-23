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
npm run check:all                     # typecheck, offline behavior tests, pack and release hygiene
node scripts/check-release.mjs --history
npm run test:performance
```

`npm run check` runs type checking, offline behavior tests with bounded concurrency (`--test-concurrency=4`), and pack inspection. `npm run check:all` adds `check:release`; neither starts a terminal UI or requires tmux. Running it does not substitute for cross-platform CI, full Git history hygiene, or interaction acceptance.

Terminal changes use one opt-in entry point, `tools/smoke-pty.mjs`: run `npm run smoke -- --require --team` for Team/history changes, or omit `--team` to visit all seven panels. It uses its own `tmux -L` server and must not touch user sessions. `--require` makes missing tmux fail rather than silently skip. Set `SMOKE_FRAMES` to an artifact directory for paired plain/ANSI captures. Check the changed operation and its return path, not a screenshot count; do not run the same scenario twice through different gates.

`check:release` verifies metadata, package contents, and machine-trace hygiene. It rejects personal home paths, private model literals, personal emails, real credential formats, `.env` files, session records, or a tracked `AGENTS.md`. Findings show only the file and rule, never the matched secret. The `--history` flag extends this check to the entire Git commit history; release hygiene enforces strict checks without adding waivers, exemptions, or ignoring history.

The default test suite requires no credentials or network model. Development dependencies are pinned to Pi 1.3.0; RPC fixtures select `PI_DAG_TEST_CLI` first, then the managed Pi installation, then the repository CLI. Record the actual host versions rather than assuming every check uses the development dependency. The suite executes and reloads module combinations derived across all six modules (`Todos`, `Plan`, `Agents`, `Goal`, `Retry`, `Team`): the registration matrix derives all 64 module combinations, while behavioral tests exercise a bounded 32-selection matrix. Team has its own test suites and real TUI smoke coverage in `tools/smoke-pty.mjs`. Tests also cover scripted failures, native and user-enabled retry coexistence, ordered model replacement, late model-selection cancellation, continuous Goal control, progress updates on paused goals, read-only status, ordinary prerequisite briefs, explicit profile skill files, single-shot child configuration, and secure session file location. Menu and command-view regressions cover paging, search, cancellation, protected reads, stale task/Plan dialogs, and bare-root versus argument-command output. The packed-install test loads all six feature entry points (Todos, Plan, Goal, Agents, Retry, Team) and launches a child using the host's Pi dependencies. Other hosts can be checked through the explicit override; run `PI_DAG_TEST_CLI="<host dist/bundle/cli.js>" npm test` and record that host version separately.

With a caller-selected registered model, also run the bounded opt-in acceptance scripts:

```bash
# Set PI_DAG_TEST_MODEL=provider/model outside repository files.
npm run test:goal-flash
npm run test:continue-flash
npm run test:joint-flash
```

These exercise Goal startup and verification, two separately budgeted automatic rounds, and parallel children with a dependency join. `test:continue-flash` also accepts `PI_DAG_TEST_EXTENSIONS`, a JSON array of explicitly trusted extension paths, to verify coexistence. Disable unrelated memory workers for a bounded lifecycle test; do not confuse that check with a full memory-worker accuracy test. Native compaction tests require no compression extension and run in default CI.

Review every result; opt-in scripts never run in default CI. Their generated artifacts must remain outside the release package.

For terminal changes, select a bounded real TUI scenario that exercises the changed flow, including its return path. Keep scripted-provider checks separate from any explicitly approved caller-selected model check. Record the enabled plugins, theme, thinking level, and known untested cases. An isolated fixture run, an isolated real TUI session, and a full configured extension environment are separate checks; an isolated real TUI run verifies only that boundary and does not stand in for the configured environment. Use a separate test session, preserve personal configuration and Profile/preset files, and keep private model names, paths, captures, and test records out of Git and the package.

## 3. Publish with maintainer approval

Pushing, tagging, and creating a GitHub Release require explicit approval. Use the approved repository and remote; never embed credentials in a URL, commit, file, or persistent Git configuration.

```bash
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')
npm pack --dry-run --ignore-scripts
git status --short                     # confirm only intended changes
git add <reviewed-files>
git commit -m "chore(release): v${VERSION}"
node scripts/check-release.mjs --history
git tag "v${VERSION}"
git push origin main
git push origin "v${VERSION}"
```

Create a non-prerelease GitHub Release for the tag using its CHANGELOG section. Confirm the tag resolves to the reviewed commit and the main/tag Node 22/24 CI jobs succeed. If attaching an npm package archive, run `npm pack --ignore-scripts` outside the source tree, inspect its contents, and record its SHA-256. Confirm the published asset matches that checksum. GitHub and npm publication are separate operations.

## 4. Confirm installation

Update only the approved package with `pi update <package-source>`, then compare its installed manifest version and commit with the release. Running sessions need `/reload` or a restart. Reload pauses restored Goals, including autoresearch, while `/retry` keeps its saved enabled state and interval settings and only cancels a pending recovery; re-enable a Goal explicitly, and verify the saved candidate order, Goal controls, and retry settings were preserved.

Keep private vulnerability reporting enabled as described in `SECURITY.md`. Preserve session history, user configuration, and unrelated packages during installation updates.
