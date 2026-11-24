# Contributing

Thanks for taking a look. Issues and pull requests are welcome, and no separate permission is needed to use or change this project: it is [MIT licensed](LICENSE). By contributing, you agree your contribution is released under the same license.

## Before you open a pull request

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Run the tests. They need no AWS account or keys, and CI runs the same command on Ubuntu and Windows.

   ```
   npm install
   npm test
   ```

3. **Write the test first.** This project is built test-first: add the test, watch it fail for the right reason, then make it pass. A change without a test that would fail without it will usually be asked to add one.
4. Keep changes small and focused, and explain the why in the description.

## Hard rules

- **Never commit a secret.** That means API keys, GitHub tokens, AWS keys and `.env` files. If you think you leaked one, rotate it first, then tell us.
- Don't weaken a safety check (the request guard, redaction, or the push rules) to make a test or feature easier. If a check is in your way, open an issue and explain.
- Don't add real account IDs, ARNs or personal paths to code, tests or docs. Use placeholders such as `<account-id>`.

## Real-cloud tests

`npm run test:integration` starts a real AWS MicroVM and spends a few cents. It is skipped unless you set `RUN_INTEGRATION=1` and `MICROVM_IMAGE_ARN`. Please don't make it a required step for contributors.

## Good places to start

- Testing on macOS. CI covers Ubuntu and Windows only.
- Warm-start measurements. See [`docs/PHASE_4_PLAN.md`](docs/PHASE_4_PLAN.md).
- Making the model-comparison runner score any task, not only the demo task.
