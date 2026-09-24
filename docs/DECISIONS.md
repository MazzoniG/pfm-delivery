# Decision log (ADRs)

One short ADR per significant choice **made during implementation**.

Decisions carried over from the planning session — the unified chart of
accounts (OD-1), line-level project dimension (OD-2), dropping savings goals
(OD-4), line-level exclusion (OD-5), and everything in §1–§8 — already have
their rationale in `docs/ARCHITECTURE.md` and are **not** duplicated here.
This file records trade-offs discovered while building: the moments where the
code pushed back on the design.

Append only. Never rewrite an accepted ADR — supersede it with a new one and
mark the old one `Superseded by ADR-00N`.

---

## Template

```
## ADR-00N — <decision in five words or fewer>
**Date:** YYYY-MM-DD · **Status:** Accepted | Superseded by ADR-00N · **Story:** US-n | Phase 0
**Context:** The forces in tension. One or two sentences. Not a history lesson.
**Decision:** What we do, in the active voice.
**Rejected:** The strongest alternative, and the specific reason it lost.
**Consequence:** What this costs us, and — if we deferred something — the scaling path we did not build.
```

A good ADR is five lines and survives being read aloud. If it needs a diagram,
it belongs in `docs/ARCHITECTURE.md` instead.

---

<!-- ADRs start here. Newest at the bottom. -->

## ADR-001 — OD-3 resolved: every pin held
**Date:** 2026-09-20 · **Status:** Accepted · **Story:** Phase 0
**Context:** `CLAUDE.md`'s stack table was correct on 2026-09-19 but eight entries were never independently verified, and the Vite 8 / TS 6 / Tailwind 4.3 / React 19.3 cluster was flagged as a peer-range risk.
**Decision:** Every pinned version exists on the registry and is kept as written. **No version moved.** The eight unverified packages resolved to: zustand 5.0.15, pnpm 12.5.1, @testing-library/react 16.3.3, msw 2.15.0, @tanstack/react-table 8.21.3, recharts 3.10.1, testcontainers 12.1.0, @anthropic-ai/sdk 0.127.0.
**Rejected:** Nothing to reject — the cluster resolves. `vitest@4.1.11` peers `vite@^6 || ^7 || ^8` and `@tailwindcss/vite@4.3.3` peers `vite@^5.2 || ^6 || ^7 || ^8`, so Vite 8 is admitted by both. No overrides, resolutions or `--force` were needed, and none are present.
**Consequence:** The lockfile is the source of truth from here. Three registry facts worth knowing, none of which changed a pin: `typescript`'s `latest` tag is now 7.0.2 (we pin 6.0.3 deliberately); `prisma`'s `latest` tag points at an **8.0.0-rc** prerelease, so a bare `pnpm add prisma` would install an RC — we pin 7.10.0 stable; and `@tanstack/react-table` has shipped v9 while `CLAUDE.md` pins v8, which we honour rather than drift.

## ADR-002 — Node pinned twice, by offer and by refusal
**Date:** 2026-09-20 · **Status:** Accepted · **Story:** Phase 0
**Context:** A stale Node 18 on `PATH` shadowed an installed Node 24 during planning. Under Node 18 the stack fails in ways that read as peer-range conflicts — the exact failure Phase 0 exists to diagnose, arriving disguised as a different problem.
**Decision:** `.nvmrc` contains `24`, and the root `package.json` sets `engines.node` with `engine-strict=true` in `.npmrc`.
**Rejected:** `.nvmrc` alone — it is an offer a developer has to accept, and it is silent when ignored.
**Consequence:** `engines` turns a wrong-runtime install into an immediate, named failure instead of a confusing downstream one. Cost is one more file and an install that hard-fails rather than warns, which is the intent.

## ADR-003 — Prisma 7 connects through a driver adapter
**Date:** 2026-09-20 · **Status:** Accepted · **Story:** Phase 0
**Context:** Prisma 7 removed `url` from the `datasource` block. The schema still declares the provider, but the connection string no longer lives there.
**Decision:** The CLI reads `DATABASE_URL` from `prisma.config.ts`; the runtime client receives it through `@prisma/adapter-pg`. Adapter and client are pinned to the same exact version.
**Rejected:** Pinning Prisma 6 to keep `url` in the schema — that gives up the Rust-free client that was the reason for choosing Prisma, to avoid one config file.
**Consequence:** Two consumers of the connection string instead of one, and one more dependency that must move in lockstep with `@prisma/client`.

## ADR-004 — `projects` ships in the ledger baseline
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US1
**Context:** `projects` belongs to US5, but `entry_lines.project_id` is an FK into it and ships with the ledger.
**Decision:** Create `projects` in the US1 baseline migration, empty, and build the entity and its rollups in US5.
**Rejected:** A later additive migration adding both the table and the column — that ships a released window in which `project_id` either does not exist or has no referent, and a nullable FK to nothing is not a schema, it is a plan.
**Consequence:** One table exists before the story that uses it. Nothing queries it until US5, and the baseline is one migration rather than two.

## ADR-005 — the audit log takes no owner and no foreign key
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US1
**Context:** `entry_audit_log` is written by an AFTER trigger, so its DELETE row describes an entry that no longer exists.
**Decision:** No `owner_id`, and no FK on `entry_id`. Owner-scoped audit queries join through `entries`. The migration says so at the point of contact, because a missing FK is otherwise indistinguishable from a forgotten one.
**Rejected:** `ON DELETE CASCADE`, which destroys the evidence at the moment it becomes interesting, and `ON DELETE RESTRICT`, which lets the log veto the deletions it exists to observe.
**Consequence:** Rows whose entry is gone are reachable only by direct id, and this is the one table an owner-scoping check must not flag — not an unscoped query, an unscoped table.

## ADR-006 — the lock is enforced on lines too, with no exemptions
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US1
**Context:** A `BEFORE UPDATE OR DELETE` trigger on `entries` alone is bypassed by editing that entry's lines, which is where the money is. A first draft then had to carve out `status` and `reconciled_at` so that reconciling and correcting could still write — and an invariant with a list of exceptions is a convention again.
**Decision:** Two guards, `entries` and `entry_lines`, both refusing every write while `locked_at` is set. The exceptions are designed out instead: reconciling writes `reconciled_at` on the lines first and `locked_at` on the entry last, and a correction writes only new entries (see ADR-008).
**Rejected:** The carve-outs, and a session GUC to disable the guard for trusted code paths — a bypass switch turns a database invariant back into an application convention, which is what the trigger was for.
**Consequence:** Two lock triggers rather than one, and a reconcile that must be written in that order — a comment in the migration says so. Un-reconciling is impossible by construction; if it is ever wanted, it is a new migration and a deliberate one.

## ADR-007 — a correction links both ways, through two self-FKs
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US1
**Context:** A correction posts a reversal and a replacement. `reverses_entry_id` links the reversal to the original; nothing linked the replacement to anything, so the register could not render the approved mock-up's correction badge or its link back.
**Decision:** `entries` carries two nullable self-FKs: `reverses_entry_id` on the reversal and `replaces_entry_id` on the replacement, both pointing at the original. The original's own badge is derived by looking for the entry that reverses it, not by a third column.
**Rejected:** Pointing `reverses_entry_id` from the original at its reversal, which would make the column name false, and would leave the replacement unlinked anyway.
**Consequence:** One column beyond the model in `docs/ARCHITECTURE.md` §4, and the three correction badges all fall out of two FKs read in the two directions.

## ADR-008 — reversal is derived, not stored
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US1
**Context:** `entries.status ∈ {posted, reversed}` duplicated a fact the correction already states through `reverses_entry_id`, and keeping it in step meant writing to the reconciled entry — the one row the lock exists to freeze.
**Decision:** Drop the column and the enum. An entry is reversed when another entry's `reverses_entry_id` points at it, read as a join or as `EXISTS`.
**Rejected:** Keeping `status` and exempting it from the lock, which is where ADR-006 started: one exemption, and the lock stops being a rule the database enforces.
**Consequence:** Every register row costs one more join, and "is this reversed" can never disagree with the reversal itself. Un-reversal has nothing to flip: withdrawing a correction means deleting the reversal entry, which is itself an audited, visible act.

## ADR-009 — the audit log records lines, tagged by source table
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US1
**Context:** The log watched `entries` only. Amounts live on `entry_lines`, so a changed figure produced no audit row at all, and the claim that every change to an entry is recorded was false in the only case anyone would audit.
**Decision:** The same `AFTER` trigger function runs on both tables — it reads its row through `to_jsonb`, so it does not care which — and `source_table` records where each row came from. Both are keyed by `entry_id`, so one query returns a transaction's whole history.
**Rejected:** Reconstructing line changes from entry-level snapshots, which would mean storing the lines inside the entry's `after` payload and writing a trigger that reads other rows to describe one.
**Consequence:** Roughly three times the log volume — a two-line entry writes three rows per change — and a `source_table` filter on any query that wants only headers. Cheap, until the log is large enough to want partitioning by `changed_at`.

## ADR-010 — account names are unique only while live
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US1
**Context:** Accounts are archived, never deleted. A plain `UNIQUE (owner_id, name)` therefore lets a closed account hold its name against its own replacement for ever.
**Decision:** A partial unique index, `WHERE archived_at IS NULL`. Live names are unique per owner; archived rows keep the name they had in history.
**Rejected:** Renaming on archive (`Everyday Checking (closed)`) — rewriting a name a user chose, in rows that historical reports render, to work around an index.
**Consequence:** Prisma cannot express a filtered unique index, so it is declared in the migration and `schema.prisma` carries a note where the `@@unique` would sit. `migrate diff` confirms this reads as no drift, but the uniqueness rule is now one a reader finds in SQL rather than in the model.

## ADR-011 — the seed generates its own ids, and anchors on today
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US1
**Context:** Two requirements pull apart: the data must be byte-identical every run, and it must be six months of history *ending today*. Meanwhile the id columns default to `uuidv7()`, which is time-ordered and therefore different on every run by construction.
**Decision:** The seed mints its own ids — UUIDv5 over stable names like `entry:2026-08-salary` — and sets `created_at` / `recorded_at` explicitly rather than letting `now()` supply them. Dates are derived from today's UTC date, so the dataset is deterministic *given the day it is seeded*.
**Rejected:** A fixed calendar window, which is deterministic outright but ages: a demo whose "recent" transactions are months old undercuts a balance-as-of feature. And a random-uuid seed, which makes an identical-output check impossible to state.
**Consequence:** Two cold seeds on the same day are byte-identical in every domain table; the audit log matches too, except `changed_at`, which is wall-clock because it records when the change happened. Seeds on different days differ by exactly the date shift, which is the intent.

## ADR-012 — ownership is a WHERE clause, so writes go through updateMany
**Date:** 2026-09-21 · **Story:** US1 · **Status:** Accepted
**Context:** Prisma's `update` and `delete` accept only a unique `where`, so the natural spelling is "fetch by id, check the owner in TypeScript, then write" — which is a check a future edit can forget, and which leaks existence by answering 403.
**Decision:** Every write is an `updateMany` whose `where` carries `owner_id` **and** `kind`, with a re-fetch for the response. A zero row count is indistinguishable from a missing row, and both surface as 404.
**Rejected:** `findUnique` + an ownership guard in the service. It reads better and fails open: delete the guard and the tests still pass unless one is written specifically against a foreign id.
**Consequence:** Two round trips on `PATCH` instead of one, and an `archive` that cannot report *why* it matched nothing. `DELETE` on an already-archived account is therefore a 204 — the state the caller asked for holds — while a row this owner cannot see stays a 404.

## ADR-013 — one raw query, for the keyset predicate
**Date:** 2026-09-21 · **Story:** US1 · **Status:** Accepted
**Context:** Keyset paging needs `(occurred_on, id) < (cursor)`. Prisma can only express that as `OR (occurred_on < d, occurred_on = d AND id < i)`, and `EXPLAIN` shows Postgres demoting it to a `Filter` — correct rows, but it walks and discards everything above the cursor, so page 500 costs five hundred times page 1.
**Decision:** `GET /entries` selects its page of entry ids with a hand-written row-value comparison, then hydrates those ids through Prisma. `EXPLAIN` on the raw form gives `Index Cond: (owner_id = … AND ROW(occurred_on, id) < ROW(…))` with nothing removed by filter.
**Rejected:** Keeping the `OR` form. It is correct, and it quietly gives up the one property keyset pagination is for — which would have made the README's scaling claim untrue.
**Consequence:** One query in `modules/transactions` is raw SQL rather than reporting SQL, and it owes the reader the comment it carries. Owner scoping is stated twice, once in each half. Payee search is still a sequential scan; a trigram index is the next step when it matters.

## ADR-014 — the display flip belongs to the projection, not to the entry
**Date:** 2026-09-21 · **Story:** US1 · **Status:** Accepted
**Context:** The transactions mapper applied `displaySign(kind)` to every line it mapped, including the lines of a whole `Entry`. A $50 card charge came back as `groceries +5000 / visa +5000`: the entry's own lines no longer summed to zero, and handing them back to `PATCH` was rejected by the request schema's zero-sum refine. Found by the independent US1 suite.
**Decision:** `Entry.lines[].amountMinor` is raw, as posted. `TransactionRowView.amountMinor` keeps the flip — it is a projection, and its contract already said so. The mapper now has two named helpers, `asPosted` and `asDisplayed`, rather than one shared one.
**Rejected:** Declaring `Entry.lines` display-signed in the contract, which would have meant dropping `sumsToZero` from `UpdateEntryRequest` — a request schema that no longer checks the only rule it exists to check, so that a response could satisfy it.
**Consequence:** Two schemas now carry different sign conventions on purpose, and each states which. It also fixed two unreported bugs in the register UI, where the edit and correction dialogs read direction off the entry's account line and would have turned a card charge into a payment.

## ADR-015 — the transactions repository reads two other modules' tables
**Date:** 2026-09-21 · **Story:** US1 · **Status:** Accepted
**Context:** Before writing an entry, the service must prove every `ledgerAccountId` and `projectId` in the payload belongs to the current owner. Those rows live in the accounts and projects modules.
**Decision:** `transactions/repository.ts` queries `ledger_accounts` and `projects` directly, through two narrow owner-scoped reads (`ownedAccounts`, `ownedProjectIds`) that return ids and kinds and nothing else. It imports no other module's repository, so the module boundary in ARCHITECTURE §2 holds by the letter; this ADR exists so it does not hold only by silence.
**Rejected:** Going through the accounts service, which constrains `kind` to `asset | liability` — an entry line may name any kind, so the call would have to widen the very filter that makes `/accounts` safe. Also rejected: a shared "chart of accounts" reader, which is one more indirection than two `findMany`s deserve.
**Consequence:** Two tables are read from a module that does not own them. If a third module needs the same check, that is the signal to extract the reader rather than copy the query again.

## ADR-016 — the account list carries no balances
**Date:** 2026-09-21 · **Story:** US2 · **Status:** Accepted
**Context:** An earlier draft had balances surfaced on the account list. The balances mock-up (`docs/mockups/balances.html`) rules the other way: account names come from the account list and render immediately, balances are a separate request and shimmer in place, and a slow balance query never delays the list.
**Decision:** `GET /accounts` returns no money. Balances come only from `GET /accounts/balances` and `GET /accounts/:id/balance`. Two queries, two render phases; the client joins them on `ledgerAccountId`.
**Rejected:** Embedding `balanceMinor` in the list — one round trip, but it makes the list exactly as slow as the `ROLLUP` aggregate and forfeits the shimmer the mock-up specifies. Also rejected: an optional `?withBalances` flag, which is two response shapes for one route where the client only ever uses one.
**Consequence:** Balance rows deliberately carry no `name` or `currency`; the account list is the single source for presentation, so no field has two sources. A consumer wanting both makes both calls.

## ADR-017 — "today" is an absent URL param resolved on the client's clock
**Date:** 2026-09-21 · **Story:** US2 · **Status:** Accepted
**Context:** The balance date lives in the URL so the view is shareable and back-button correct. Two ways to say "today": write today's date into `asOf`, or leave the param out. They diverge the moment a link outlives the day it was shared.
**Decision:** No `asOf` in the URL means today, and "Back to today" (and picking today in the calendar) *deletes* the key rather than writing a date. The client then resolves today from `getFullYear/getMonth/getDate` and always sends it to the API explicitly, so the figure never depends on the server's timezone — `toISOString()` is deliberately not reused from the register's filters, where it is UTC by design for a range. A future or malformed `asOf` pasted into the URL falls back to today, because a balance after today is a projection and belongs to US4.
**Rejected:** Writing today's date on load, which freezes a shared link to the day it was made and churns the history entry on every visit. Also rejected: omitting `asOf` from the request and letting the service default it, which hands a user just after local midnight yesterday's balance.
**Consequence:** Two date conventions coexist in the web app, local for the balance date and UTC for the register's range; each states which and why. The query key is the resolved date, so a link opened tomorrow is a different cache entry with no special casing.

## ADR-018 — one balance query, filtered, rather than a second narrower one
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US2
**Context:** `GET /accounts/:id/balance` needs one account's figure. The batch query already computes every account, both kind subtotals and net worth in a single `ROLLUP`.
**Decision:** The single-account endpoint calls the same `selectBalances` and filters to the requested id in the service. One definition of "balance" in the codebase, expressed once in SQL.
**Rejected:** A second, narrower query for one account. It would be cheaper per call and would be a second place where the meaning of a balance is defined — the place a future predicate gets added to one and not the other.
**Consequence:** Answering for one account aggregates all of the owner's accounts. Harmless at this scale and wrong at a much larger one; the trade-off flips when an owner has enough accounts for the waste to show, and the fix is a narrower query plus a test that pins the two definitions together. An id that is absent from the owner's rows — another tenant's, or an income account the shape cannot represent — falls out as a 404 rather than a fabricated zero.

## ADR-019 — the report answers the whole period at once
**Date:** 2026-09-21 · **Status:** Accepted · **Story:** US3
**Context:** The report view selects one month out of a range, and `month` is a UI-only URL parameter. Either the API answers per selected month, or it answers the whole period and the client picks.
**Decision:** `GET /reports/categories` returns every month in `from`–`to`, each with its API-computed total and its category rows, from one `GROUPING SETS` query. Choosing a bar is a lookup, not a request. The period is capped at 24 months, and the drill-down, which is fetched per category-month, is returned unpaginated under the same cap.
**Rejected:** A `month` query parameter. It would make every bar click a round trip, and the chart still needs every month's total, so the per-month rows would be a second query over the same lines.
**Consequence:** The payload grows with months × categories. That is small at a 24-month cap and 20 categories, and it is why the cap exists. If category counts grow, the breakdown moves behind a `month` parameter and the series stays as it is. Keyset pagination on the drill-down becomes worth having only if a single category-month can hold hundreds of lines.

## ADR-020 — the split editor sums money, in BigInt
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US5
**Context:** Splitting $230 across projects means showing "allocated" and "remaining" while the user types — a sum and a difference that change on every keystroke, before anything is posted.
**Decision:** The split editor may add and subtract minor units as `bigint`, and only through helpers in `apps/web/src/lib/money.ts`. No other browser code does money arithmetic. The API's zero-sum check and the deferrable trigger remain the authority; these figures only gate the Save button.
**Rejected:** A round trip per keystroke to have the API compute the remainder — correct, and a chatty network dependency for a figure the database re-checks on write anyway.
**Consequence:** The browser's "no money arithmetic" rule has one named exception, listed in the sanctioned-exceptions table in `.claude/agents/reviewer.md`. A second site that wants to sum money is a finding, not a precedent.

## ADR-021 — chart geometry may use a JS number
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US3, US5
**Context:** Recharts bar heights and the category table's share bars need a ratio, and a ratio of two `bigint`s cannot produce a fraction.
**Decision:** Chart and share-bar code may convert minor units to `Number` for scaling only. Every figure drawn next to a bar is the API's value through `formatMinorUnits`, never the converted number. Sites: `MonthlySpendingChart.tsx`, and `lib/share.ts`, which is the single `shareWidth` every share bar calls — the category table, the project report and the insights groups.
**Rejected:** Scaling in `bigint` (multiply by 10 000, then divide) — exact and pointless, since past 2^53 cents the precision loss is below a pixel.
**Consequence:** A converted number can never reach a label, a sum or a request; every `Number(` on an amount is checked against this ADR's scope. Formalises the two existing US3 sites rather than changing them.

## ADR-022 — the insights response is a discriminated union, not one shape with optional halves
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US6
**Context:** One report has two forms: groups matched by name, computed entirely in SQL, and groups the model proposed, which additionally carry a label, member payees and a record of what was sent. The semantic form degrades to the deterministic one on a missing key, withheld consent, a failed call or totals that do not reconcile.
**Decision:** `SpendingReport` is a Zod discriminated union on `grouping`. The `name` member has no label, no members and no sent payload, and carries a nullable `fallback` reason; the `meaning` member requires `sent`. Every figure in both is a SQL sum.
**Rejected:** A single object with `label`, `members` and `sent` optional. It types the degraded report and the semantic one identically, so "did this come from the model?" becomes a runtime guess at every render site, and a semantic report with no disclosure of what was sent stays representable.
**Consequence:** The view renders two group shapes rather than one, sharing a row component. In exchange, a report that cannot say what left the process does not typecheck, and the degraded path cannot silently inherit a model's label.

## ADR-023 — payee normalisation drops trailing tokens containing digits
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US6
**Context:** "Similar transactions" means one merchant written several ways: `THE BOOKSHOP`, `The Bookshop*1685`. Grouping needs a normalisation rule, and the rule decides what the feature claims to know.
**Decision:** Case-fold, collapse every run of punctuation and whitespace to one space, then drop *trailing* tokens that contain a digit — the store number or terminal reference a card network appends. The displayed spelling is the most frequent one, ties broken alphabetically. The seed writes the same merchant in variant spellings so the rule has something real to merge.
**Rejected:** Cutting at the first `*` or `#`, which collapses every `SQ *…` payment into one group named for the payment processor. Also rejected: trigram similarity, which merges merchants that only look alike and cannot be explained to a user in one sentence.
**Consequence:** `Shell 1120` and `Shell 4408` merge, which is the intended reading of a brand's two stations; `7-Eleven` and a leading network prefix survive intact. The rule is stated verbatim in the report's footnote, because a user who sees two spellings merged is owed the reason.

## ADR-024 — consent is a timestamp on the user, and the only gate on sending
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US6
**Context:** Semantic grouping sends merchant names to a third party. That has to be opt-in, revocable, and provable — "we asked first" should be a recorded fact, not a claim taken on trust.
**Decision:** `users.semantic_grouping_consented_at TIMESTAMPTZ NULL`. NULL means never, or withdrawn; revoking writes NULL rather than a second `revoked_at` column, because a withdrawn consent is not a consent with a date. The service reads it, and the provider's availability, *before* the query that produces the names, so there is no code path to the model that skips either check.
**Rejected:** A boolean. It cannot answer "when did I agree to this", which is the question asked after the fact. Also rejected: consent in the browser (localStorage or a URL parameter) — the check would then live on the side of the wire that does not do the sending.
**Consequence:** Consent is per owner, so it rides the same tenancy seam as everything else and needs no new concept when authentication arrives. The order of statements in `spendingReport` is load-bearing, which is why the reconciliation and consent checks are pinned by tests rather than left to review.

## ADR-025 — the model's answer is validated against what was sent, and rejected rather than repaired
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US6
**Context:** Payee names are text merchants wrote, so the prompt carries whatever they put there — including text shaped like an instruction. The response comes back naming those same strings, and every figure on screen is a SQL sum keyed by them.
**Decision:** The prompt states that the names are data, not instruction. The response is schema-validated by the SDK, then checked against the request: every name must be one that was sent, and each may appear at most once. A failure throws, and the report degrades to name matching with a visible notice. Names the model omitted fall into `Other`, which sorts last and is never marked largest. Labels render as plain text and are never interpreted.
**Rejected:** Repairing a near-miss — dropping the unknown name, or fuzzy-matching it back to a real one. A report that silently corrects a wrong answer cannot be told from one that was right, and the correction would be the only place in the feature where a merchant's total moved for a reason that was not in the ledger.
**Consequence:** A model that answers badly costs a user the grouping, never a wrong figure. The groups reconcile to the deterministic total by construction, and the service checks that anyway before rendering — the one place where "should be impossible" earns a runtime check, because the alternative is showing money that does not add up.

## ADR-026 — the semantic cache is keyed by the rows it grouped, not by the period
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US6
**Context:** The last semantic report is cached so that pressing Generate twice does not pay for the model twice. Keyed on owner and period, a report generated before a transaction was posted was served against rows queried after it: the total came from the fresh rows, the groups from the stale ones, and the figures on screen did not add up. Found by an independent test at 5.5, not by review.
**Decision:** The key is owner, period, and the payee totals the grouping was computed from. New data cannot hit an old entry, because it is a different key. The reconciliation check was moved to cover every return of a semantic report, cached or fresh, rather than sitting after an early return where the one path that could fail skipped it.
**Rejected:** Caching the rows alongside the groups and serving both. It keeps the report internally consistent and makes Generate show figures that are quietly out of date — a worse failure, because nothing on screen says so.
**Consequence:** A period whose spending changed costs a model call on the next report, which is correct: the grouping is of those merchants, and they are not the same merchants. `unreconciled` is now reachable, which is what makes it worth having as a `FallbackReason`.

## ADR-027 — deleting a paid bill's entry returns the occurrence to the projection
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US4
**Context:** `scheduled_occurrences.materialized_entry_id` is the only reference from a schedule into the ledger, and it is what removes a bill from the forecast. Its `ON DELETE` behaviour decides what happens when the transaction that paid a bill is deleted.
**Decision:** `ON DELETE SET NULL`. The payment was undone, so the money did not move, so the bill is due again and reappears in the projection — the same rule the projection already runs on, applied backwards. A partial unique index on the column keeps one entry from materialising two occurrences.
**Rejected:** `RESTRICT`, which lets a schedule veto a deletion in the ledger — the forecast is downstream of the ledger and does not get an opinion about it. Also rejected: `CASCADE`, which deletes the bill because its payment was reversed, losing a real obligation on the strength of an unrelated correction.
**Consequence:** Deleting a payment is self-healing and needs no service-layer cleanup. An occurrence can travel unpaid → paid → unpaid, so nothing may assume the link is monotonic — in particular the expansion watermark, which tracks dates and not payment state.

## ADR-028 — a scheduled amount is signed on the account side, and nothing in US4 flips it
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US4
**Context:** Every figure on the bills page is a movement, not a balance: a bill reads −1,650.00 whether it leaves a chequing account or lands on a credit card. `displaySign(liability)` is −1, so routing these through the usual display flip makes a card charge read positive, which is right for a register row and wrong here.
**Decision:** `recurring_series.amount_minor` and `scheduled_occurrences.amount_minor` hold the signed amount posted to the *account* side, which is that bill's effect on net worth. The category side is its exact negation at payment time, the same sugar as `CreateEntrySimple`. Group nets, the projected figure and the chart points are all in the same basis — `BalancesResponse.netWorthMinor`'s basis — so nothing in this phase calls `displaySign` at all.
**Rejected:** Storing on the category side, which is the reports' orientation (spending positive) and inverts every row the mock-up specifies. Also rejected: an unsigned amount plus a direction flag, which is `Math.abs` with extra steps and loses the refund case.
**Consequence:** One basis across the whole feature, and `displaySign` staying absent from it is a grep-checkable property rather than a convention. The cost is that a bill's amount has the opposite sign to the same purchase in a category report — correct in both, as the register and the drill-down already are.

## ADR-029 — the projection horizon is capped, and a request past it is refused rather than truncated
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US4
**Context:** Expansion writes real rows up to whatever horizon is asked for, so an open-ended series plus an unbounded `to` is an unbounded table. "Never store infinite future rows" needs a number, and something has to happen when a caller exceeds it.
**Decision:** `MAX_PROJECTION_MONTHS = 12`, checked in the service against the request-time date — a contract refinement would need a clock, and a date decided at module load is the trap `BalanceQuery` already documents. A `to` beyond it is a 400 naming the field, and writes nothing. A new series may also be anchored at most 31 days in the past, which bounds expansion in the other direction.
**Rejected:** Expanding to the cap and returning a partial projection. A forecast that silently stops short is the same failure as one that silently drops an unpaid bill — the thing this phase has an ADR and a README limitation about — and it would need a "truncated" flag on every figure to be honest.
**Consequence:** The bills page's furthest option is six months, so the cap is invisible in normal use and the table stays small. A user who wants two years gets a refusal that says so, and the number is one constant to raise if that ever becomes a real request.

## ADR-030 — an overdue bill is outside the projected figure, and shown beside it
**Date:** 2026-09-22 · **Status:** Accepted · **Story:** US4
**Context:** `projection(T)` starts from today's balance. An occurrence due before today that was never materialised is money that has not moved, so it is not in that balance and not in the forward window either. Something has to happen to it, and both obvious answers are wrong.
**Decision:** Overdue occurrences are excluded from `projectedNetWorthMinor` and returned as their own group, with their own API-computed net, which the page shows above the forecast saying the forecast excludes them. Nothing dismisses an overdue occurrence: it stays listed until it is paid. No route deletes a series, so payment is the only way to clear one.
**Rejected:** Adding them to the projection, which claims a payment that did not happen and makes the forecast disagree with the bank. Also rejected: dropping them silently — a forecast that quietly loses an unpaid bill is worse than one that flags it, because the user cannot tell the difference between "nothing is owed" and "we forgot".
**Consequence:** The projected figure is exactly `ledger(T) + scheduled`, which is what makes paying a bill on time for its scheduled amount leave it unchanged. The cost is a list that only grows until someone acts on it — there is no dismiss, by design, and that is the README limitation this ADR pairs with.

## ADR-031 — `GET /projection` writes, so it cannot be served from a read replica
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US4
**Context:** Occurrences are expanded lazily, and the projection is what triggers the expansion — so the one endpoint that looks most like a report is the one reporting endpoint that issues `INSERT`s. The README's scaling section sends reporting traffic to a read replica, and this route is the exception to that sentence.
**Decision:** The projection materialises occurrences to the requested horizon before reading them, and must therefore be routed to the primary. Concurrency is safe rather than serialised: the `(series_id, due_on)` unique index makes a second insert of the same window a no-op, so two requests that both see an unadvanced watermark converge on one set of rows instead of one of them failing.
**Rejected:** Expanding on a schedule instead, which trades a write on a read path for a background job, a job runner and a window in which the projection is stale or empty. Also rejected: expanding inside the write path only — a series created while the horizon was already materialised would not appear until something else moved.
**Consequence:** The README's replica note names this route as the exception. If reporting is ever split off, the projection goes with the write side, or expansion moves behind an explicit `POST` and the read becomes replica-safe — that is the refactor, and it is one endpoint wide.

## ADR-032 — `scheduled_occurrences` carries no `owner_id`, and is the fifth scoped table
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US4
**Context:** `CLAUDE.md` names four tables that carry `owner_id`. US4 adds two: `recurring_series`, which carries it, and `scheduled_occurrences`, which does not. A new table with no owner column needs a stated reason, or the next reader has to decide whether it was a decision or an oversight.
**Decision:** An occurrence inherits scope from its series, exactly as `entry_lines` inherits scope from its entry, and every query over it joins through `recurring_series` to reach the owner. A second copy of the owner is a consistency risk for no gain, and the join is one hop.
**Rejected:** `owner_id` on the table. It would have to be kept in step with the series' own, and the failure mode is silent: a row whose two owners disagree is readable by one tenant and attributed to another. Also rejected: leaving it undocumented on the strength of the `entry_lines` precedent — a precedent a reader has to find is not a rule.
**Consequence:** The tenancy rule reads "five tables carry `owner_id`, and two inherit it": `ledger_accounts`, `entries`, `projects`, `recurring_series` and `users` carry it, while `entry_lines` and `scheduled_occurrences` inherit it through their parent. The isolation tests cover the inherited case directly: one tenant's expansion never writes rows under the other's series.

## ADR-033 — the first migration is a placeholder, and stays one
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US1
**Context:** `0000000000000_init` is a one-line `SELECT 1;`, written in Phase 0 so `prisma migrate deploy` had something to apply and the container entrypoint could be proved before any schema existed. US1 then had to put the ledger somewhere, and the obvious place was that empty file.
**Decision:** Leave it alone. The ledger ships as a **new** migration, `20260921120000_ledger_baseline`, and the placeholder keeps its one line for ever.
**Rejected:** Folding the ledger into `init` to get one clean migration. An applied migration's checksum is recorded in `_prisma_migrations`; editing the file makes `migrate deploy` refuse to start against any database that already ran it, which is every developer's and the cold-start volume's.
**Consequence:** The history opens with a migration that does nothing, which reads as noise until you know why — hence this ADR and the comment in the file. In exchange, no migration in this repo is ever edited after it is applied, which is the rule that makes `docker compose up` safe against a warm volume as well as a cold one.

## ADR-034 — `recorded_at` is stored and deliberately unqueried
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US1
**Context:** `entries.recorded_at` records when we *learned* of an entry, against `occurred_on`, which records when it happened. The pair is real audit value — it is what lets a filed period be reproduced as it was known on a date — and it is also the first half of a bitemporal model.
**Decision:** Store it, seed it, expose it on the `Entry` DTO, and read it from no endpoint. No `knownAsOf` parameter exists on any balance or report.
**Rejected:** Building the query layer to go with it. A `knownAsOf` variant on every balance, every rollup and the projection is a large surface with its own sign and date rules, carried for a question nobody has asked. Also rejected: dropping the column, which would make the fact unrecoverable later — the column is cheap, and the history it captures cannot be backfilled.
**Consequence:** A column that no `WHERE` clause mentions, which reads as dead weight unless this ADR is found first. The scaling path is that the data is already there: a bitemporal reporting layer is additive when it is wanted, and needs no migration of existing rows.

## ADR-035 — the semantic cache lives in the process
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US6
**Context:** The last semantic grouping is cached so pressing Generate twice does not pay the model twice. Where it lives is a separate question from what keys it (ADR-026).
**Decision:** An in-process `Map`, 10-minute TTL, 50 entries, oldest evicted first. It is a cost guard, not a store: a restart loses it and that is correct behaviour, not data loss.
**Rejected:** Redis or a cache table now. Both are infrastructure for a saving that is one model call on a cold start, at a scale with one API container.
**Consequence:** Behind more than one instance this is a per-instance cache, so a miss costs one extra call and nothing else — there is no correctness dependency on a hit, because the key already includes the rows. The scaling path is Redis under the same key, and ADR-026's key is what makes that swap safe.

## ADR-036 — names are unique per owner, and case decides
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US1, US5
**Context:** Account and project names are unique per owner (ADR-010 for the partial index on accounts). The indexes compare the stored text, so `Everyday Checking` and `Everyday checking` are two different names and both are accepted.
**Decision:** Ship it. Uniqueness is case-sensitive, and this is recorded as a known limitation rather than fixed late.
**Rejected:** Adding `UNIQUE (owner_id, lower(name))` now. It is two new indexes, on two tables, and changing one without the other leaves the app inconsistent in exactly the way the rule exists to prevent — a change worth doing deliberately rather than in a delivery sweep. Also rejected: normalising case on write, which edits a name the user chose.
**Consequence:** A user can create two accounts whose names differ only in case, and the UI gives no warning. The fix is a pair of expression indexes plus a data check for existing collisions, and it belongs in the README's cut list so it is a decision on the record rather than a gap found by a reader.

## ADR-037 — an archived account keeps its money and loses its name
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US2
**Context:** `GET /accounts` serves live accounts only, while `/accounts/balances` returns every account including archived ones, because their money is still on the balance sheet. ADR-016 made the account list the single source of names, so the two together leave an archived account's balance row with no name available anywhere.
**Decision:** That is the mechanism, not a gap. The client joins balances to the live account list on `ledgerAccountId`; archived rows find no match and drop out of the visible list, while `subtotals` and `netWorthMinor` still count them. `archived` on the row is what makes the drop deliberate rather than accidental.
**Rejected:** Returning archived accounts from `GET /accounts` and filtering in the client, which puts closed accounts into every account picker and every register selector. Also rejected: carrying `name` on the balance row, which gives one field two sources — the thing ADR-016 decided against.
**Consequence:** An archived account's name is not retrievable from this API, and by construction nothing needs it. A future "closed accounts" view is a new endpoint or a flag on the list, not a change to this shape; the web test `keeps archived accounts out of the list while their money stays in the totals` is what pins the behaviour.

## ADR-038 — reconciling ships in the seed, not the API
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US1
**Context:** The lock, its two triggers and the correction path are built, and they deliberately depart from plain edit and delete: a locked entry refuses both. What sets `locked_at` is reconciling, and none of US1–US6 asks for reconciliation.
**Decision:** No reconcile endpoint and no reconcile screen. The seed reconciles one filed month in the order ADR-006 requires — lines first, entry last — so the 409 and the correction can be demonstrated from a cold start.
**Rejected:** `POST /entries/:id/reconcile`. It is a feature no story traces to, and it would arrive before the period-close design that ought to own it.
**Consequence:** A user cannot lock anything they post; only seeded entries are ever locked, and the triggers are proved by the seed and the tests rather than by a route. Manual period close, which `docs/ARCHITECTURE.md` names as the extension, is where reconciling would land.

## ADR-039 — the audit log's actor stays null until identity is real
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US1
**Context:** `entry_audit_log.actor_id` reads the `pfm.actor_id` session setting, so the authentication seam has somewhere to land. Nothing sets it, so every audit row today has a null actor.
**Decision:** Leave it unset. The `currentUser` stub returns a constant, and nobody authenticated as it; null is the honest answer to "who did this".
**Rejected:** `SET LOCAL pfm.actor_id` in every write transaction with the stub's id. The log would then attribute every change to a user who never proved who they were, and an audit log that asserts something false is worse than one that admits it does not know.
**Consequence:** The log records what changed and when, but not who. When authentication arrives, the write path sets the setting inside the transactions it already opens, and the trigger does not change.

## ADR-040 — an entry is reversed at most once
**Date:** 2026-09-23 · **Status:** Accepted · **Story:** US1
**Context:** A correction posts a reversal pointing at the original. Nothing stopped a second correction of the same original, which reversed it twice and double-counted it in the ledger.
**Decision:** A partial unique index on `entries(reverses_entry_id)` makes the database refuse a second reversal; the service checks first and answers 409 `entry-already-corrected`, and maps the index violation to the same 409 when two requests race.
**Rejected:** The service check alone, which two concurrent requests can both pass.
**Consequence:** A corrected entry is final. Further changes go to its replacement, which is unlocked and so edited directly; the 409 links the existing reversal so the client can find it.
