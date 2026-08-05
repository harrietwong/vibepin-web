<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Testing — read this before running any E2E

**All E2E and manual QA must follow [`tests/e2e/TESTING.md`](tests/e2e/TESTING.md).**
That is the single source of truth for: the shared test account, database
isolation, environment variables, and how to run each suite.

Non-negotiable rules (details in TESTING.md):

- **Never point tests at the production database.** `npm run dev` connects to
  PROD (`.env.local` → `auth.vibepin.co`). For any login / purchase-intent E2E,
  start the server with **`npm run dev:testdb`** — it injects the TEST project
  (`snulmwprsahzqvdbyenc`) credentials and forces the auth guard on, without
  editing `.env.local`.
- **One shared test account**, in the test DB only:
  `e2e-purchase-intent@vibepin.test`. Don't mint random accounts.
- **Paid-checkout cases are gated on `CREEM_MODE`.** They auto-skip (correctly)
  when billing is off. Run `CREEM_MODE=test npm run dev:testdb` for full coverage.
- Any script that WRITES to a DB (seed / create user / destructive) must print
  the target project ref and assert it is the test ref, never `jaxteelkecvlozdrdoog`.
