# Shipped action regression tests

From the repository root, after the frozen-lockfile install, use Node 20:

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism
pnpm exec tsc --noEmit
pnpm build
node --test --test-concurrency=1 tests/action/review-outcomes.cjs tests/action/source-acquisition.cjs
```

The two Node suites exercise the committed `dist/index.js` through 18 provider,
license and score cases plus 40 source-acquisition cases. They use the existing
synthetic catalog in `tests/tasks/eventcatalog` and generate temporary extra
events and a service required by the locked EventCatalog SDK. No saved response
corpus or provider key is needed. Each child uses only synthetic action inputs,
loopback GitHub/license routes, an in-process provider capture and a socket guard.

`ACTION_BUNDLE` can select another built entrypoint. `ACTION_EVIDENCE_DIRECTORY`
optionally saves captures outside this test tree. Provider failures must fail
the action without a risk score; source failures must additionally make no
provider request for the failed file. The source timeout unit throws a real
`TimeoutError`; shipped source timeout cases use local HTTP 504, and network
cases close the local socket. These are offline contract tests, not installed
or live model-quality checks.
