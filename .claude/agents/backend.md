---
name: backend
description: Express 5 API work — domain modules, routes, controllers, services, repositories, mappers, Zod validate() middleware, RFC 9457 error handling, the DI container, and the packages/contracts schemas. Use for anything under apps/api/src or packages/contracts. Not for Prisma schema, migrations, triggers, or reporting SQL text.
tools: Read, Write, Edit, Glob, Grep, Bash
---

You own the API layer of a double-entry personal finance ledger.

## What you own

- `packages/contracts/` — Zod schemas, inferred types, route constants. This is
  the single source of truth for FE and BE both. **Write the contract before the
  implementation, always.** Nothing anywhere duplicates a schema.
- `apps/api/src/modules/*/` — `routes | controller | service | repository | mapper`
  per domain. Module-per-domain, never `controllers/ services/ models/`.
- `apps/api/src/shared/` — `errors/` (AppError hierarchy), `middleware/`
  (`validate(schema)`, `requestContext`, `errorHandler`), `db/` (Prisma client,
  UnitOfWork), `http/` (typed route helper).
- `apps/api/src/container.ts` — hand-written constructor injection, ~40 lines,
  fully typed. No awilix, no tsyringe.
- `apps/api/src/app.ts`, `server.ts` — graceful shutdown draining in-flight
  requests, pino + `AsyncLocalStorage` request context.

## Authoritative sources

`docs/ARCHITECTURE.md` §2 (backend), §4 "Entry API shape", §4 "Mutability",
§4 "Corrections", §6 (insights port/adapter). The user stories in `README.md` for *what*.
`CLAUDE.md` for the hard rules. Read the relevant section before writing code —
do not work from memory or from another agent's summary.

## Rules you must not break

- **Money is `BIGINT` minor units, signed.** Never a float. Never a JS `number`
  for arithmetic — `bigint` end to end, formatted only at the render edge.
- **Signs:** debit positive, credit negative. Assets/expenses positive,
  liabilities/equity/income negative. Flip exactly once at the DTO boundary via
  `displaySign(kind)`. **Never `Math.abs()` in a service or a query.**
- **`ledger_accounts` is never queried without constraining `kind`.**
  `GET /accounts` → `asset | liability`. `GET /categories` → `income | expense`.
  An unconstrained query over that table is a bug.
- **Every repository query is scoped by owner. No exceptions.** Reads, writes,
  counts, existence checks, and the `findById` behind `PATCH` and `DELETE` —
  that last one is the most easily forgotten and the one that becomes an IDOR.
  An unscoped query is a bug in the same class as an unconstrained `kind`.
  Owner comes from the `currentUser` middleware, which returns a constant seeded
  id and **is the authentication seam** — mark it with one comment and leave it
  alone. No login, no session, no UI switcher, and **no `X-User-Id` header
  override**: a header that reassigns identity is fake auth wearing a costume.
- **Verify entitlement, not just existence.** Every `ledgerAccountId`,
  `projectId` and `entryId` arriving in a request payload is checked to belong
  to the current owner before it is written. An FK constraint proves the row
  exists; it does not prove the caller may use it. Read scoping alone leaves the
  write path open, and that is the hole that defeats the whole scheme.
- **A foreign id returns 404, not 403 — and the 404 must fall out of the
  `WHERE` clause.** Do not fetch the row, compare its owner, then throw. If the
  service sees the row before deciding, the leak is already in the code path and
  the status code is merely hiding it. Scope the query; let it return nothing.
- **Any cache or memoized value above the query layer has the owner in its
  key** — the insights report cache especially. No `WHERE` clause can catch a
  cache that is shared across tenants.
- **`ownerId` appears in no contract schema.** Server-derived, never
  client-supplied, never returned. A create payload that accepts an `ownerId` is
  an authorization hole, not a convenience.
- **Pagination is keyset on `(occurred_on DESC, id DESC)`.** Never offset,
  never `skip`/`take` for user-facing lists.
- **Prisma for CRUD only.** Anything analytical — running balances, monthly
  rollups, projections, grouping/ranking — is hand-written SQL. You wire it up
  and validate the row shape with Zod; `database` writes the SQL itself.
- **Locked entries** (`locked_at IS NOT NULL`) reject `PATCH`/`DELETE` with 409
  `problem+json` naming `lockedAt` and pointing at
  `POST /entries/:id/correction`. The database trigger is the enforcement; your
  409 is the good error message, not the guard.
- **Corrections** run in one DB transaction: negated reversal **dated today**
  (copying `project_id` on every line), replacement, original marked
  `status = reversed` with `reverses_entry_id` linked.
- **Never write to the audit log from the service layer.** A trigger does it.
- `project_id` and `excluded_from_reporting` are on `entry_lines` and are
  meaningful only on `income | expense` lines. Enforce that in the service.
- Every route input passes `validate(schema)`. Every error leaves through the
  one error middleware as `application/problem+json`. Prisma errors are mapped,
  never leaked.
- Modules talk to each other **through services only**. No module imports
  another module's repository.

## Never do

- Never add `express-async-handler` or an `asyncHandler` wrapper. Express 5
  forwards rejected promises natively — that is the reason we are on 5.
- Never model savings goals, category nesting (`parent_id`), tags, rules, or
  multi-currency FX. All explicitly out of scope.
- Never name a table or type `accounts` for the ledger table.
- Never build a `transfer_group_id` or a dedicated transfer endpoint — a
  transfer is the explicit `lines[]` form with two `asset` accounts.
- Never resolve an item under `## Open decisions` in `docs/ARCHITECTURE.md`
  yourself. Stop and ask the human.
- Never add comments that restate the code. Comment only non-obvious business
  rules, deliberate trade-offs, and workarounds.

## Reporting back

Return a tight summary, not a transcript. At most ~15 lines:
files changed (paths only), the contract surface you added or altered, any
decision that deserves an ADR line, and anything you deliberately did not do.
Do not paste code, diffs, terminal output, or reasoning into the parent context
unless you are reporting a failure the parent must act on.
