# Personal Finance Manager

Bank and credit-card accounts, their transactions, balances at any date,
monthly expense reports, scheduled bills and income with a balance projection,
per-project expense tracking, and a grouped spending report that can optionally
use an LLM. The structural fact behind the rest of this document: it is a
double-entry ledger whose invariants are enforced by the database, not the
application. Every transaction is a set of lines summing to zero, a reconciled
transaction is frozen, and every change to either is recorded — as Postgres
triggers. Deleting the API and writing to the database by hand would not get
past them.

## Declared focus

Backend and platform: the ledger model, the reporting SQL, the database
invariants, and the container story. The frontend exercises all of it.

## Tech stack

| | |
|---|---|
| Runtime | Node 24, TypeScript 6.0 (`strict`, `noUncheckedIndexedAccess`) |
| Package manager | pnpm 12 workspaces |
| Backend | Express 5.2, Zod 4.4 validation, Prisma 7.10 (CRUD only) |
| Database | PostgreSQL 18.6, hand-written SQL for reporting, `pg` + `@prisma/adapter-pg` |
| Frontend | React 19.3, Vite 8, React Router 7, Tailwind 4.3, Radix primitives |
| Server / client state | TanStack Query 5.102, TanStack Table 8.21, Recharts 3.10, URL search params for filters |
| Forms | React Hook Form 7.76 + `@hookform/resolvers` + Zod |
| Testing | Vitest 4.1, React Testing Library, MSW, Supertest, Testcontainers |
| AI | `@anthropic-ai/sdk` 0.128, model configurable via `INSIGHTS_MODEL` |
| Container | Docker, docker compose |

Every version above is what is pinned in the workspace's `package.json` files,
not a target. `packages/contracts` and `packages/config` share schemas and
tooling config across both applications.

## Run it

Requires Docker. Nothing else — no Node, no pnpm, no database, no API key.
Ports 8080, 3000 and 5432 must be free: the database publishes 5432, so a local
Postgres on its default port stops the stack from starting.

```
docker compose up
```

That is the whole procedure from a clean clone. The API applies migrations and
seeds on start; the web container waits for it to report healthy.

| | |
|---|---|
| Web | http://localhost:8080 |
| API | http://localhost:3000/api/v1 |
| Liveness / readiness | http://localhost:3000/health, `/ready` |

The seed is deterministic and idempotent. It writes a demo tenant — 25 ledger
accounts, 129 entries over 261 lines, 2 projects, 5 recurring series, with 23
entries in one filed month reconciled and therefore locked — and a second
tenant of 4 accounts, 5 entries, 1 project and 1 series, so cross-tenant
isolation is something the tests demonstrate rather than assert. Dates anchor to
the current UTC date when you seed, so the six months of history end today in
UTC — east or west of it near midnight, the newest entries can fall on your
tomorrow or yesterday. Starting again on an existing volume applies no
migrations and re-seeds nothing.

`ANTHROPIC_API_KEY` is optional: without one the spending report still returns
its deterministic grouping, with `fallback: "no-key"` explaining why the
semantic half was not produced. To try that half:

1. Copy `.env.example` to `.env` and set the key. A key exported in your shell
   takes precedence over `.env`.
2. Run `docker compose up -d` again so the API container is recreated with it.
3. On **Insights**, turn on consent — nothing is sent to the model before that.

For the tests you need Node 24, pnpm 12, and Docker running (the API suite
starts PostgreSQL through Testcontainers). The contracts package is consumed
from its build output, so build it before testing:

```
pnpm install
pnpm --filter @pfm/contracts build
pnpm -r test
```

## What it does

Six things, one screen each.

- **Accounts and transactions** — open, rename and archive accounts and post,
  edit, split and delete their transactions, on **Transactions**.
- **Balances** — each account's balance and your net worth as at any date you
  pick, in the sidebar on **Transactions**.
- **Monthly expense report** — spending by category per month, with a
  drill-down to the transactions behind any figure, on **Reports**.
- **Future bills and income** — scheduled items, a projection of net worth to a
  horizon you choose, and a mark-paid action, on **Bills**.
- **Projects** — expenses assigned to a renovation or a trip, with net cost and
  categories, on **Projects**; a split can put part of itself on one.
- **Grouped spending report** — a button on **Insights** that groups similar
  merchants and marks the largest. The grouping is SQL; an LLM can optionally
  regroup those merchants by meaning, and never sees or computes an amount.

"Real-time" here means computed on read, at request time, from the ledger. No
push, no WebSocket, no cache to go stale: a balance is a query over entry lines,
and asking twice runs it twice.

## Architecture

A pnpm workspace, two applications and two packages.

```
apps/
  api/     Express 5, module-per-domain
    src/modules/   accounts  categories  transactions  reporting
                   projects  recurring   insights      health
    src/shared/    auth  config  db  errors  ledger  logging  middleware
    prisma/        schema, migrations, deterministic seed
  web/     React 19 + Vite, feature-per-domain
    src/features/  accounts  transactions  reporting
                   projects  bills  insights  health
packages/
  contracts/   Zod schemas, inferred types, route constants
  config/      shared tsconfig / eslint / prettier bases
```

`packages/contracts` is the single source of truth for every request and
response shape — the API validates against it, the tests build fixtures from
it, and the web client parses responses with it — so no wire shape is written
twice. Two kinds of schema deliberately live elsewhere: the Zod row parsers for
raw SQL results, which are internal to the API, and the web forms' own schemas,
which describe what a user types (a decimal string, a date picker's value)
rather than what crosses the wire.

Three layers touch the database, chosen by what you are doing:

- **Prisma for CRUD**, where an ORM removes bugs.
- **Hand-written SQL for reporting.** Running balances, monthly rollups,
  merchant ranking and the projection want `GROUPING SETS`, `ROLLUP` and CTEs;
  they live in `modules/reporting/*.sql.ts` as parameterised queries with
  Zod-validated row shapes.
- **Triggers for invariants** — the rules that hold no matter who is writing.

In one sentence: **invariants live in the database, workflows live in the
application.** The reasoning and the rejected alternatives are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The ledger

- **Double-entry.** A transaction is an entry plus at least two lines summing
  to zero. One `ledger_accounts` table holds accounts and categories both,
  discriminated by kind, so a purchase is a movement between two of its rows
  rather than a record with a category attached.
- **Money is a signed `BIGINT` of minor units.** Never a float, never a
  JavaScript number; amounts cross the wire as strings and parse to `bigint`.
  The sign flips for display exactly once, where a row becomes a response.
- **Four trigger functions, six triggers.** A deferrable constraint trigger
  checks zero-sum at commit on both tables; two refuse any write to a locked
  entry or its lines; a fourth writes the audit log.
- **Reconciling locks, and corrections are how you edit afterwards.** `PATCH`
  and `DELETE` on a locked entry return 409 pointing at
  `POST /entries/:id/correction`, which posts a reversal and a replacement,
  both dated today, in one transaction. The original is never rewritten.

## Tenancy

Authentication is not built: no login, no session, no token, and no header or
parameter that changes whose data you see. Identity comes from a `currentUser`
middleware returning a constant.

Tenancy is built. `owner_id` is `NOT NULL` on `ledger_accounts`, `entries`,
`projects` and `recurring_series`; `entry_lines` and `scheduled_occurrences`
reach it through their parent. Every repository method and every reporting
query is scoped by owner, and another owner's id answers 404 rather than 403,
because a 403 confirms the row exists. Thirty-two tests in two dedicated suites
(`tenancy-isolation.test.ts`, `current-user.test.ts`) hold the seam in both
directions, including the case where a foreign key would otherwise let one
tenant's transaction reference another's account.

That middleware is where authentication attaches: replacing it with real
identity resolution changes one file, and nothing downstream moves, because
everything downstream already scopes by the owner it supplies.

## Testing

726 tests pass: **620 across 19 files** in the API, **106 across 9 files** in
the web application.

They were written from the contracts and the stories rather than the
implementation, by an author kept away from the implementer's reasoning and
free to conclude the implementation was wrong. Two entries in
[docs/DECISIONS.md](docs/DECISIONS.md) exist because it did.

The whole API suite runs against a real PostgreSQL 18.6 in a container,
migrated and seeded the way a cold start does it, because a mocked client
cannot prove a deferrable constraint trigger fires at commit. The web suite
runs in jsdom with React Testing Library and the API mocked at the network
boundary.

Not covered: there is no browser-driven end-to-end test, so the seam between
the two suites is checked by hand.

## Scaling

- **Pagination is keyset, never offset.** The register orders by
  `(occurred_on DESC, id DESC)` and pages on that tuple, so page 500 costs what
  page 1 costs. The cursor is re-validated on the way in.
- **Module boundaries are the seams.** Each domain owns its routes, service and
  repository and talks to others through services, so splitting reporting or
  insights into its own process is a deployment change, not a rewrite.
- **Balances are computed on read** — correct and fast at this size. When it
  stops being fast, the path is a nightly `balance_snapshots` rollup, after
  which a balance is the nearest snapshot plus a short delta. Documented, not
  built.
- **Reporting can move to a read replica, with one exception.**
  `GET /projection` materialises scheduled occurrences before reading them, so
  it writes and must go to the primary. If reporting is split off, that endpoint
  goes with the write side, or expansion moves behind an explicit `POST`.

## How AI was used

The grouped spending report on **Insights** is the one place this application
calls an LLM, and its design answers to two constraints.

**No sensitive data leaves the process.** The model receives merchant names
only — never an amount, an account or a category — and only after explicit,
revocable consent that gates every request, not just the first. The exact
payload sent is recorded and shown back on screen, so the claim is checked
rather than asserted.

**The deterministic load stays deterministic.** Every figure in the report —
totals, per-merchant sums, the ranking — is computed by SQL before the model is
called at all. The model's only job is to propose a semantic regrouping of the
names it was given; its answer is validated against what was sent and must
reconcile to the SQL total, or it is discarded rather than repaired, and the
report falls back to the name-matched grouping with a visible reason on screen.
The model can reorganize what is displayed. It cannot change what anything
cost.

## Where to look next

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the model, the module layout,
  and the arguments behind both.
- [docs/DECISIONS.md](docs/DECISIONS.md) — one short record per trade-off made
  while building, including those discovered rather than planned.
- [docs/openapi.yaml](docs/openapi.yaml) — hand-written OpenAPI 3.1 covering all
  28 endpoints, written against the routes as they are mounted.
- [docs/mockups/](docs/mockups/) — the screen designs the UI was built against.
