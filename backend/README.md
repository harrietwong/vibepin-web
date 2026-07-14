# backend/

Cloud/worker-side Python code (crawling, product harvesting, trend pipeline,
scheduler). See the sibling `*.md` files in this directory for deploy and
scheduling docs (`CLOUD_WORKER.md`, `SCHEDULING.md`, `DEPLOY_MANUAL_STEPS.md`,
etc.). This file only documents how to run the test suite.

## Running `pytest backend/tests`

As of 2026-07-14, `pytest backend/tests` **cannot currently run** in this
repo/environment — `pytest` itself is not installed:

```
$ py -3 -m pytest backend/tests -q
...python.exe: No module named pytest
```

There is no `requirements.txt`, `pytest.ini`, `pyproject.toml`, or
`conftest.py` in `backend/` that installs or configures pytest today. The
only dependency manifest present is `backend/requirements-cloud.txt`, which
lists runtime deps for the cloud worker (`httpx`, `python-dotenv`,
`curl_cffi`, `cryptography`, `playwright`, `psutil`) and does not include
`pytest`.

To actually run the suite locally you need, at minimum:

1. **Install pytest** (not installed globally by this doc — do this in your
   own venv): `pip install pytest`
2. **Install the runtime deps the tests import through**, since test modules
   import backend modules directly (e.g. `import cloud_smoke`,
   `import run_worker`) which in turn import third-party packages:
   `pip install -r backend/requirements-cloud.txt`
3. **Run pytest from the `backend/` directory** (not the repo root), or
   otherwise ensure `backend/` is on `PYTHONPATH`. The test modules do
   `import <module>` for modules that live directly in `backend/`
   (`cloud_smoke.py`, `run_worker.py`, etc.), and there is no
   `conftest.py`/`pyproject.toml` `pythonpath` setting to add `backend/` to
   `sys.path` automatically — running from the repo root
   (`pytest backend/tests`) may raise `ModuleNotFoundError` for those
   imports even once pytest is installed:
   ```
   cd backend
   pytest tests -q
   ```

None of the above has been installed or verified end-to-end by this change —
this section only documents the requirement, it does not confirm the suite
passes once the dependencies are present.
