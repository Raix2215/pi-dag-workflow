# Contributing

Thanks for taking a look at pi-dag-workflow. Keep changes small, focused on the plugin, and easy to review.

## Checks

Run the local loop on Node.js 22 or 24:

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` runs the type checker, the offline behavior tests (with bounded concurrency `--test-concurrency=4`), and the package dry run. `npm run check:all` adds release hygiene. Neither default command starts tmux or a TUI screenshot run.

The offline test suite derives all 64 module registration combinations across the six modules (`Todos`, `Plan`, `Agents`, `Goal`, `Retry`, `Team`), while behavioral tests exercise a bounded 32-selection matrix.

For terminal interaction changes, run one focused opt-in check: `npm run smoke -- --require --team` covers Team navigation and history Enter/body/Esc; omit `--team` to visit all seven panels. `tools/smoke-pty.mjs` uses a private tmux server and fails on missing tmux when `--require` is supplied. Set `SMOKE_FRAMES` to an artifact directory for paired plain/ANSI captures. This is not part of default CI and is not proof that unexercised workflows work. Running `check:all` also does not substitute for full Git history hygiene or cross-platform CI.

The default checks run offline against scripted providers and do not call paid models. Real-model acceptance scripts are opt-in and separate; do not add them to the default check command. They require a registered model through `PI_DAG_TEST_MODEL=provider/model`; `PI_DAG_TEST_THINKING` optionally selects a supported thinking level.

## Guidelines

- Keep the default checks offline. Tests should not require network access or model credentials.
- Prefer a small existing test that drives the reported operation and checks its outcome. A title, screenshot count, source-code spelling, or passing mutation count is not an interaction acceptance criterion. Use type checking and review for syntax and structure; use targeted behavior checks for state changes, safety and UI transitions. Mutation checks are occasional checks of assertion sensitivity, not a default gate.
- If you add or change user-facing text, update both the English and Simplified Chinese copy so the interface stays consistent.
- Localize plugin-authored UI labels, help, notifications and error feedback. Keep plugin-authored system/model instructions in English regardless of UI locale. Preserve user-authored content, Todo subjects, names, command names and structured tool fields.
- Do not log secrets, API keys, tokens, full child conversations, or personal file paths. Test with fixtures and temporary directories instead.
- Do not commit personal configuration or machine-specific files. Keep `pi-dag-workflow-config.json` and `pi-dag-workflow-profile.json` out of the repository.
- Keep dependency and tool-permission changes minimal, and explain any new permission a change requires.
- Keep README examples aligned with the current tools and commands. Write installation, usage, and boundaries for users; use the changelog for release notes.
- Keep model-context measurements separate from stored result details and provider billing. Name the tokenizer and test scope for performance claims.

## Pull requests

Describe what changed, why, and how you verified it. Note any boundary the change touches, such as module selection, persistence, or the continuation budget.

New commits and pull request titles use Conventional Commits: `type(scope): description`, for example `fix(goal): allow progress notes while paused` or `docs(release): align user guidance`. Apply the convention to new work; do not rewrite existing commits just to rename them.
