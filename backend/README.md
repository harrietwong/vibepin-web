# backend/

Cloud/worker-side Python code (crawling, product harvesting, trend pipeline,
scheduler). See the sibling `*.md` files in this directory for deploy and
scheduling docs (`CLOUD_WORKER.md`, `SCHEDULING.md`, `DEPLOY_MANUAL_STEPS.md`,
etc.). This file documents how to run the test suite.

## Running `pytest backend/tests`

As of 2026-07-14 the suite is installed, configured, and passing:

```
$ cd backend && py -3 -m pytest tests -q -s
............................................................. [376 passed]
```

### 1. Install dependencies

```
py -3 -m pip install -r backend/requirements-cloud.txt   # runtime deps the tests import through
py -3 -m pip install -r backend/requirements-test.txt    # pytest itself
```

(`requirements-cloud.txt` already carries `httpx`, `python-dotenv`,
`curl_cffi`, `cryptography`, `playwright`, `psutil` — the third-party
packages backend modules import. `requirements-test.txt` adds `pytest`.)

On Windows, `python` may not be on `PATH` — use the `py -3` launcher as shown
above, not `python`.

### 2. Run it

From the `backend/` directory:

```
cd backend
py -3 -m pytest tests -q -s
```

...or from the repo root (also works — see "Import path" below):

```
py -3 -m pytest backend/tests -q -s
```

...or via the repo-root npm entry point:

```
npm run test:backend
```

**The `-s` flag is required on Windows.** Without it, this pytest/Python
combination hits a console-capture teardown bug on Windows terminals
(`ValueError: I/O operation on closed file` during
`_pytest.capture.stop_global_capturing`) that fires *after* the suite has
already finished running, corrupting the printed summary in some shells.
`-s` disables pytest's output capturing and avoids the bug entirely; it does
not change what the suite tests. `--capture=fd` / `--capture=sys` both hit
the same crash on this Windows/Python 3.14/pytest 9.1 combination — stick
with `-s` here. Use a `--junitxml=<path>` report if you need a
machine-parseable pass/fail summary.

### Import path

Test modules do bare `import <module>` for files that live directly in
`backend/` (e.g. `import cloud_smoke`, `import run_worker`,
`import db as db_mod`). `backend/pytest.ini` sets `pythonpath = .`, which
puts `backend/` on `sys.path` regardless of the invoking working directory —
so both `cd backend && pytest tests` and `pytest backend/tests` (from the
repo root) resolve these imports correctly.

## What's covered, what isn't

The suite is 376 tests, all plain `unittest.TestCase` (stdlib
`unittest.mock` for fakes — no `pytest-mock`/`requests-mock` needed). It is
fully offline/self-contained: env-var and network-failure paths (e.g.
`cloud_smoke`'s Supabase checks, `scraper_v2`'s timeout handling) are
exercised via `unittest.mock` fakes, not real network calls or a real
database — the full run takes ~17s. Nothing is marked `@pytest.mark.integration`
or excluded, because nothing in the suite currently needs live infra to run.
If a future test genuinely requires a live DB/network/API key, mark it
`@pytest.mark.integration` and exclude it from the default command with
`-m "not integration"` — document the exclusion here when you do.

## Unified command

From the repo root:

```
npm run test:backend
```

This is defined in the repo-root `package.json` (`web/` has its own,
separate `package.json` — this one only wires up cross-cutting commands like
this).
