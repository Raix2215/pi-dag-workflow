# Contributing

Thanks for taking a look at pi-dag-workflow. Keep changes small, focused on the plugin, and easy to review.

## Checks

Run the same checks CI runs, on Node.js 22 or 24:

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` runs the type checker, the test suite, and a package dry run. The default checks do not call paid models. Real-model acceptance scripts are opt-in and separate; do not add them to the default check command. They require a registered model through `PI_DAG_TEST_MODEL=provider/model`; `PI_DAG_TEST_THINKING` optionally selects a supported thinking level.

## Guidelines

- Keep the default checks offline. Tests should not require network access or model credentials.
- If you add or change user-facing text, update both the English and Simplified Chinese copy so the interface stays consistent.
- Localize plugin-authored labels, help, notifications, and workflow messages. Keep user-authored content, Todo subjects, command names, and structured tool fields unchanged.
- Do not log secrets, API keys, tokens, full child conversations, or personal file paths. Test with fixtures and temporary directories instead.
- Do not commit personal configuration or machine-specific files. Keep `pi-dag-workflow-config.json` and `pi-dag-workflow-profile.json` out of the repository.
- Keep dependency and tool-permission changes minimal, and explain any new permission a change requires.

## Pull requests

Describe what changed, why, and how you verified it. Note any boundary the change touches, such as module selection, persistence, or the continuation budget.
