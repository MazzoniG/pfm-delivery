# Personal Finance Manager — Project Constitution

Full rationale lives in `docs/ARCHITECTURE.md`. Read it before any design work.
The user stories US1–US6, restated in `README.md`, are the **only** source of requirements.

---

## Non-negotiables

1. Scalability and maintainability are first-class
   constraints, not afterthoughts.
2. **Never assume on an open decision.** `docs/ARCHITECTURE.md` has an
   `## Open decisions` section. If a task touches one, **stop and ask the
   human**. Do not pick a default and proceed.
3. **Minimal code comments.** No JSDoc on obvious functions, no
   `// increment counter`. Comment only: non-obvious business rules, SQL that
   isn't self-evident, deliberate trade-offs, and workarounds. If a comment
   restates the code, delete it.
4. **No feature creep.** Build exactly what the current story asks.
5.  **AI insights (US6) are in scope.** The deterministic half (SQL
   grouping/ranking) is a core reporting query; the LLM only groups merchant
   names by meaning and never computes money.
6. **Savings goals are out of scope.** Not in the user stories. Do not model
   them, do not add a `goals` table, do not reference them in the UI.

---

## Stack (pinned)

Verify every version against the registry at install time — the numbers below
were current on 2026-09-19 and the lockfile is the source of truth.

| Layer | Choice |
|---|---|
| Runtime | Node **24 LTS** |
| Language | TypeScript **6.0.x**, `strict`, `noUncheckedIndexedAccess` |
| Package manager | **pnpm** + workspaces (no Turborepo) |
| Backend | **Express 5.2.x** (native async error forwarding — do not add `express-async-handler`) |
| Database | **PostgreSQL 18.6** |
| ORM | **Prisma 7.10.x** — CRUD only. Reporting/analytics use hand-written SQL via `$queryRaw`. |
| Frontend | **React 19.3**, **Vite 8**, React Router v7 |
| Styling/UI | **Tailwind 4.3** + **shadcn/ui** (Radix), **TanStack Table v8**, **Recharts** |
| Server state | **TanStack Query 5.102.x** |
| Client state | **Zustand** (thin) + **URL search params** for all filters/date ranges |
| Forms | **React Hook Form 7.76.x** + `@hookform/resolvers` + Zod |
| Validation | **Zod 4.4.x**, shared FE/BE via `packages/contracts` |
| Testing | **Vitest 4.1.x**, React Testing Library, MSW, Supertest, Testcontainers. No Playwright — cut, see ARCHITECTURE §Scope |
| Container | Docker + docker compose |

**Known risk:** Vite 8 / TS 6 / Tailwind 4.3 / React 19.3 is a fresh cluster.
The toolchain was pinned and smoke-tested before any domain code (ADR-001).

**Authentication is out of scope** — no login, no sessions, no JWT. **Tenancy
is not:** `owner_id` scopes every query, and identity comes from a
`currentUser` middleware returning a constant. That stub is the authentication
seam. See §Hard rules → Tenancy, which governs.

---

## Repository layout

```
apps/
  api/          Express 5 — module-per-domain, see ARCHITECTURE.md
  web/          React + Vite
packages/
  contracts/    Zod schemas + inferred types + route constants  ← single source of truth
  config/       shared tsconfig / eslint / prettier bases
docs/
  ARCHITECTURE.md
  DECISIONS.md  one short ADR per significant choice
.claude/
  agents/       specialist subagents
```

`packages/contracts` is load-bearing. FE validation, BE validation, OpenAPI
generation, and test fixtures all derive from it. Nothing duplicates a schema.

---

## Hard rules

**Money.** `BIGINT` minor units, signed. Never a float, never a JS `number` for
arithmetic. Format only at the render edge.

**Dates.** Transaction dates are `DATE` (calendar dates, no timezone).
Audit columns are `TIMESTAMPTZ`. Do not mix them.

**Ledger.** Full double-entry. Every entry's lines must sum to zero, enforced by
a **deferrable constraint trigger** in Postgres — not only in application code.

**Signs.** Signed `amount_minor`, no debit/credit columns. Debit positive,
credit negative. Assets/expenses store positive, liabilities/equity/income
store negative. Flip for display **once** at the DTO boundary via
`displaySign(kind)` — never `Math.abs()` inside services or SQL.

**Categories.** Exactly one level. No `parent_id`, no nesting, ever.

**Chart of accounts.** One `ledger_accounts` table holds accounts *and*
categories, discriminated by `kind ∈ {asset, liability, equity, income,
expense}`. The table is never named `accounts` — the UI word "account" must
only ever mean a real financial account. `GET /accounts` always filters to
`asset | liability`; `GET /categories` always filters to `income | expense`.
A query over `ledger_accounts` that does not constrain `kind` is a bug.

**Line-level dimensions.** `project_id` (single nullable FK, never m2m) and
`excluded_from_reporting` live on `entry_lines`. Both are meaningful only on
`income | expense` lines. A transactions-register row is a *projection* of an
entry viewed from one account, collapsing to `—Split—` when the counter-side
has more than one line.

**Mutability.** Entries are editable while `locked_at IS NULL`. Reconciling
sets `locked_at` — that is the only lock trigger. A locked entry rejects
`PATCH`/`DELETE` with 409 and must be changed via
`POST /entries/:id/correction`, which posts a reversal **dated today** plus a
replacement, in one DB transaction. Reversals copy `project_id`. Enforce the
lock with a `BEFORE UPDATE OR DELETE` trigger, and the audit log with an
`AFTER` trigger — never from the service layer.

**Scheduled occurrences are not entries.** Future bills and income live in
`scheduled_occurrences` and never touch the ledger. They drop out of the
projection once `materialized_entry_id` is set.

**Accounts are archived, never deleted.** `DELETE /accounts/:id` sets
`archived_at` and returns 204.

**Tenancy.** `owner_id NOT NULL` on `ledger_accounts`, `entries`, `projects`,
`recurring_series`. **Every repository query is scoped by owner — an unscoped
query is a bug.** Identity comes from a `currentUser` middleware returning a
constant; that stub is the authentication seam. No login, no sessions, no UI
switcher, no `X-User-Id` header override. The isolation test (query as user A,
assert nothing from user B) is mandatory.

**Pagination.** Keyset/cursor on `(occurred_on DESC, id DESC)`. Never offset.

**API.** `/api/v1/*`. Errors are RFC 9457 `application/problem+json` from a
single error middleware. Every input passes a Zod `validate()` middleware.

**Migrations.** `prisma migrate deploy` on container start. Seed is idempotent,
deterministic (seeded RNG — identical data every run), and gated behind an env
flag. Cold `docker compose up` must produce a working, seeded app with no
manual steps.

**Git is the human's.** Agents never run `git add`, `git commit`, `git push`,
or any other git command. When work is ready to commit, report it and suggest
the message theme. The human writes and runs it.

---

## Agents

Specialists live in `.claude/agents/`. Roster: `frontend`, `backend`,
`database`, `devops`, `test-author`, `reviewer`.

**`test-author` is independent by design.** It never receives an implementer's
reasoning, summary, or self-assessment. It derives test criteria *only* from
`packages/contracts`, the user story, and `docs/ARCHITECTURE.md`. It is
explicitly authorized to conclude that an implementation is wrong. Never ask it
to "make the tests pass" — ask it to test the contract.

---

## Definition of done (per story)

- Contract schema in `packages/contracts` first
- Implementation
- Independent tests written from the contract, passing
- Error paths and validation covered, not just the happy path
- No new comments that restate code
- One ADR line in `docs/DECISIONS.md` if a real trade-off was made
- `docker compose up` still works from cold