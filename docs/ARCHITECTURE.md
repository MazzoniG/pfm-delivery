# Architecture

The design decisions behind this codebase, each with its rationale.

---

## 1. Monorepo, monolith deployment

pnpm workspaces. One deployable API, one static SPA, one shared contracts
package.

**Why pnpm over yarn:** strict `node_modules` prevents phantom dependencies,
content-addressed store makes Docker layer caching genuinely fast,
`workspace:*` protocol is cleaner than yarn's. Yarn 4 + PnP creates friction
with Vite and Prisma's postinstall for no benefit at this size.

**No Turborepo.** Config surface that doesn't earn its keep at two apps.
Mentioned in the README scaling section instead.

---

## 2. Backend — Express 5, structured to survive

Dropping NestJS removes the free architecture, so the structure has to be
deliberate.

**Why Express 5 specifically:** it forwards rejected promises to error
middleware natively. No `asyncHandler` wrapper on every route. That is the
headline reason to be on 5 rather than 4.

### Layout — module-per-domain, not layer-per-type

```
apps/api/src/
  modules/
    accounts/       routes | controller | service | repository | mapper
    transactions/
    categories/
    projects/
    recurring/
    reporting/
    insights/       AI insights — port + adapter
  shared/
    errors/         AppError hierarchy → RFC 9457 problem+json
    middleware/     validate(schema) | requestContext | errorHandler
    db/             prisma client | UnitOfWork
    http/           typed route helper
  container.ts      composition root
  app.ts | server.ts
```

Never `controllers/ services/ models/`. Lifting one folder out into its own
service and changing the transport only works if the folders are drawn along
domain lines.

**Cross-module rule:** modules talk to each other through services only. No
module imports another module's repository.

### Dependency injection

Hand-written `container.ts` doing constructor injection. ~40 lines, fully
typed, zero magic. No awilix, no tsyringe — more magic than value here, and
manual wiring can be read top to bottom in one file, where a decorator library
spreads it across every class.

### Cross-cutting

- **Validation:** one generic `validate(schema)` middleware over Zod,
  populating a typed `req.validated`. Schemas imported from
  `packages/contracts` — the same objects the frontend uses in `zodResolver`.
- **Errors:** `AppError` subclasses → single error middleware → RFC 9457
  `problem+json`. Prisma errors mapped, never leaked.
- **OpenAPI:** a hand-written spec covering the routes. Generation from Zod is
  the intended approach and was cut (see §Scope); the README names it.
- **Logging:** pino + `AsyncLocalStorage` request context so a request id
  threads through every log line.
- **Ops:** `/health` and `/ready` split, graceful shutdown draining in-flight
  requests.

### ORM boundary

Prisma for CRUD. **Hand-written SQL for all reporting** — running balances,
monthly category rollups, budget projections want window functions and CTEs,
and forcing those through an ORM is how reporting code rots. Raw queries live
in `modules/reporting/*.sql.ts` with Zod-validated row shapes and their own
integration tests.

The boundary is deliberate: use the ORM where it removes bugs, drop to SQL
where it would add them.

**Why Prisma over Drizzle:** the app creates its database, migrates and seeds
on first cold start. `prisma migrate deploy` +
`prisma db seed` is the most boring, most reliable path that exists. Prisma 7
is Rust-free (~1.6MB, down from ~14MB), so the old Alpine/Docker binary pain
is gone. `schema.prisma` also holds the whole domain in one readable file.
Drizzle is at 0.45.x with 1.0 still in beta — not putting pre-1.0 API churn
under the data layer.

---

## 3. Frontend

**Server state is TanStack Query's. Client state is almost nothing.**
Zustand holds only ephemeral UI (open modal, sidebar collapse). Redux would be
over-engineering.

**Filters, date ranges and selected period live in URL search params**, not in
a store. Shareable, back-button correct, and query cache keys derive from the
URL.

**UI: Tailwind + shadcn/ui.** The design (`docs/mockups/`) is a custom design
system — indigo accent on neutral gray, rounded white cards,
dense data tables, multi-step modal wizards, donut/bar/line charts, icon rail
sidebar. MUI or Ant would mean fighting a default theme the whole way.
shadcn components live in the repo (we own them), Radix gives accessible
Dialog/Tabs/Select/Popover, and shadcn's `<Form>` is built on React Hook Form +
zodResolver — zero glue with our stack.

**Structure:** feature folders mirroring the API modules. Shared primitives in
`components/ui` (shadcn), composed components in `components/`.

---

## 4. Domain model — double-entry ledger

```
users            id, display_name, created_at
ledger_accounts  id, owner_id, name, kind, currency, is_system, archived_at,
                 created_at
                 kind ∈ {asset, liability, equity, income, expense}
entries          id, owner_id, occurred_on DATE, description, payee, memo,
                 locked_at TIMESTAMPTZ NULL,        -- null = freely editable
                 reverses_entry_id UUID NULL,       -- on the reversal
                 replaces_entry_id UUID NULL,       -- on the replacement
                 recorded_at TIMESTAMPTZ            -- when we learned it
entry_lines      id, entry_id, ledger_account_id, amount_minor BIGINT signed,
                 project_id?, excluded_from_reporting BOOLEAN,
                 reconciled_at TIMESTAMPTZ NULL
projects         id, owner_id, name, created_at
recurring_series id, owner_id, ...
entry_audit_log  id, entry_id,                      -- no FK, deliberately
                 source_table ∈ {entries, entry_lines},
                 changed_at, actor_id, action, before JSONB,
                 after JSONB
```

`entry_lines` has no `owner_id` — it inherits scope from its entry, and a
redundant copy would be a consistency risk for no gain.

**There is no `status` column, and no `created_by`.** An entry is *reversed*
when another entry's `reverses_entry_id` points at it, and *replaced* when
another's `replaces_entry_id` does — both are facts about the correction that
already exists, so a stored copy could only ever fall out of step with them.
Deriving them also means posting a correction never writes to the reconciled
entry, which is what lets the lock refuse every write with no exemptions.
`created_by` is dropped in favour of `entry_audit_log.actor_id`: identity is a
stub, and one nullable column recording who changed what beats one on every
entry recording who typed it.

### The audit log is not a scoped table

`entry_audit_log` has **no `owner_id`**, and its `entry_id` carries **no foreign
key constraint**. Both absences are deliberate.

The log is populated by `AFTER INSERT OR UPDATE OR DELETE` triggers on **both
`entries` and `entry_lines`**, tagged with `source_table`. A log that watched
only `entries` would record that a transaction was touched and not that its
money changed, since the amounts live on the lines — and "every change to an
entry is recorded" would be false in the one case that matters. Both are keyed
by `entry_id`, so the log reads as one history per transaction.

Because the triggers are `AFTER`, an `AFTER DELETE` row can outlive the entry
it describes. An FK would force a
choice between `ON DELETE CASCADE` — which destroys exactly the evidence the log
exists to preserve, at exactly the moment it becomes interesting — and
`ON DELETE RESTRICT`, which makes the log veto deletions it is supposed to be
silently observing. A log of record does not get a referential dependency on the
thing it is recording.

Entries are archived rather than deleted in the normal path, so this is mostly
theoretical. *Mostly theoretical* is not a standard an audit trail should be
held to.

**Consequence, accepted:** an owner-scoped audit query joins through `entries`
to reach `owner_id`. Log rows whose entry no longer exists are therefore not
reachable by that join at all — only by direct id. That is the correct trade for
a log of record: the orphaned row is the one most worth keeping, and keeping it
costs a join for the ordinary case rather than a column on every row.

This also means the audit log is the one table an owner-scoping check must
**not** flag. It is not an unscoped query; it is an unscoped table.

### Unified chart of accounts (RESOLVED — see OD-1)

One table holds both "accounts" and "categories". They are the same thing: the
two sides of an entry. `ledger_accounts` is deliberately **not** named
`accounts`, so the UI word "account" never means two things.

| Layer | Asset/liability side | Income/expense side |
|---|---|---|
| Table | `ledger_accounts` `kind IN (asset, liability, equity)` | `ledger_accounts` `kind IN (income, expense)` |
| API | `GET /accounts` | `GET /categories` |
| UI | "Accounts" sidebar, Add Account modal | "Category" column, Spending/Income tabs |

`GET /accounts` must **always** filter by kind. The Add Account modal is
hardcoded to `asset | liability` and never shows income/expense rows.

**Evidence this matches how consumer finance apps already behave:**

- Their category lists commonly *include accounts*, which function as transfer
  categories: assigning an account as a transaction's category makes it a
  transfer. The category field accepts either — it is literally "the other
  line of the entry."
- A typical Add Account type tree is Banking / Credit / Investments / Asset /
  Liability — already five kinds of real-world thing, mapping exactly onto
  asset and liability. We add two more kinds, not a new concept.
- Opening balances are categorized **"Balance Adjustment"** in the register.
  That is `Equity:Opening Balances` with a friendlier name. Under this model it
  needs no special case; under a split model it needs a magic system row.
- A transactions view's All / Spending / Income tabs are exactly
  `kind IN (expense)` and `kind IN (income)`.

Caveat: those apps are not *strictly* double-entry — a linked transfer is the
closest they get. This model is stricter, which is why it needs the uniformity
more than they do.

**System accounts** (`is_system = true`, not user-deletable): at minimum
`Equity:Opening Balances`, surfaced in the UI as "Balance Adjustment".

**Invariant:** `SUM(amount_minor) = 0` per entry, enforced by a **deferrable**
constraint trigger — deferrable so both legs insert inside one transaction
before the check fires. ~12 lines of PL/pgSQL.

### Sign convention (debit/credit)

Double-entry is represented with **signed amounts, not separate debit/credit
columns**. `debit = positive`, `credit = negative`. This keeps the invariant a
single `SUM() = 0` and every balance a single `SUM(amount_minor)` with no
branching on direction. Beancount and hledger use the same representation —
it is the same model, fewer footguns than a `direction` enum.

| Example | Lines (signed minor units) |
|---|---|
| Opening balance $5,000 | BAC `+500000` / `Equity:Opening Balances` `−500000` |
| Groceries $50 on debit card | Groceries `+5000` / BAC `−5000` |
| Salary $3,000 | BAC `+300000` / Salary `−300000` |
| Groceries $50 on credit card | Groceries `+5000` / Visa `−5000` |
| Pay off card $800 | Visa `+80000` / BAC `−80000` |
| Transfer BAC→Chase $200 | Chase `+20000` / BAC `−20000` |

Paying a credit card touches **no expense account** — the charges were already
expensed. This is the classic double-counting trap in personal-finance tools,
and the model makes it structurally impossible.

### Normal balances — the #1 bug source

Assets and expenses are naturally **positive** in storage. Liabilities, equity
and income are naturally **negative**. A $3,000 salary is stored `−300000`;
$800 owed on a card is stored `−80000`.

Flip the sign **once, at the mapper/DTO boundary**:

```
displaySign(kind) = kind IN (asset, expense) ? +1 : -1
```

Never scatter `Math.abs()` through services or SQL. The domain and every query
stay in raw signed values — that is what keeps the zero-sum invariant
checkable. Only the response DTO flips. Cover this with explicit tests for an
income account and a liability account, not just a checking account.

**What this buys us, for free:**

| Feature | Falls out as |
|---|---|
| Transfer between accounts | An ordinary entry. No `transfer_group_id` hack. |
| Opening balance | Entry against `Equity:Opening Balances`. |
| Balance at any point in time | `SUM(amount_minor) WHERE occurred_on <= T`, identical query for every account. |
| Ledger integrity | Structurally impossible to go out of balance. |

### Tenancy without authentication

*Authentication* — proving who you are — is out of scope. *Tenancy* — scoping
data to an owner — is not. These are different concerns, and the app has to
scale to many users: a schema that already scopes by owner makes that a tested
property of the code rather than a promise in the README.

- `owner_id NOT NULL` on `ledger_accounts`, `entries`, `projects`,
  `recurring_series`
- **Every repository query is scoped by owner. No exceptions.** An unscoped
  query is a bug in the same class as an unfiltered `ledger_accounts` query.
- `currentUser` middleware returns a constant seeded user id, with a one-line
  comment marking it as the authentication seam. Adding JWT later swaps the
  stub — nothing else moves.

**Explicitly not built:** no login, no sessions, no JWT, no UI user switcher,
and **no `X-User-Id` header override** — a header that reassigns identity is
fake auth wearing a costume, and it is unnecessary because isolation is proven
at the repository layer rather than over HTTP.

**The isolation test is mandatory, not optional.** Seed two users, query as A,
assert nothing belonging to B is returned. Without that test the `owner_id`
column is unverified decoration; with it, isolation is a tested property. It is
in the never-drop list.

### Mutability — period locking (RESOLVED)

**Transactions are mutable until someone has relied on them.** Immutability is
about reliance, not about data.

- `locked_at IS NULL` → plain `UPDATE`. Fixing a typo thirty seconds after
  entry is one edit, one row.
- **Reconciling an entry sets `locked_at`.** That is the only trigger. No
  auto-locking by age. Manual period-close is the natural extension, and is
  not built; the README lists it.
- Locked entry → `PATCH`/`DELETE` return **409** with a
  `problem+json` naming `lockedAt` and pointing at
  `POST /entries/:id/correction`.

**Enforced by a `BEFORE UPDATE OR DELETE` trigger** raising when
`OLD.locked_at IS NOT NULL`. Same reasoning as the zero-sum trigger: a rule the
database enforces beats a rule the repository layer remembers. A second guard
on `entry_lines` refuses insert, update and delete while the parent entry is
locked — without it the first is bypassed by editing the lines, which is where
the money is.

**Neither guard has an exemption**, and reconciling is ordered so that none is
needed: it writes `reconciled_at` onto the lines first and sets `locked_at` on
the entry last, so every write happens while the entry is still open. Nothing
afterwards has cause to touch the row, because reversal and replacement are
derived from the correction's own entries rather than flagged on this one.

**Audit log is populated by `AFTER INSERT OR UPDATE OR DELETE` triggers on
`entries` and `entry_lines`** writing `to_jsonb(OLD)` / `to_jsonb(NEW)` — never
from the service layer. A raw SQL update, a migration, or a future developer
bypassing the repository still gets logged. Service-layer auditing is a
suggestion; trigger-based auditing is a guarantee.

### Corrections

`POST /entries/:id/correction` runs in one DB transaction:

1. Reversal entry — every line of the original negated, **including
   `project_id`** (omitting it leaves project totals overstated; needs its own
   test), carrying `reverses_entry_id` = the original
2. Replacement entry, carrying `replaces_entry_id` = the original

**Nothing is written to the original.** Both links live on the new entries and
point back at it, so "reversed" is a join rather than a flag, and a correction
against a reconciled entry needs no write to a locked row — which is why the
lock can refuse every write with no exemptions.

**The reversal is dated today, not the original's date.** Reaching back into a
reconciled period is exactly what locking prevents — a filed period stays
filed, and the correction lands in the open one.

The zero-sum trigger validates the reversal for free: a bad negation fails to
insert, so a broken reversal cannot ship.

Net effect of reversal + replacement on the *asset* line is zero when only the
categorization changed — the reconciled bank balance is untouched, which is
correct, because the statement was never wrong. This falls out of the model
rather than being coded.

*Different case:* if the **amount** was genuinely wrong, post an adjusting
entry for the difference rather than reversing. A reconciled amount being
wrong means the reconciliation was wrong.

### Known cost

A correction lands in a later month, so a monthly category report can show a
negative total (−$60 Groceries in October). Correct accounting, surprising to a
personal-finance user. Mitigations, all three taken: lock only on explicit
reconciliation so casual use never hits it; seed exactly **one** reconciled
month; render correction rows distinctly with a link to the original.

### Accounts are archived, never deleted

An account with entries cannot be deleted without destroying the ledger.
`DELETE /accounts/:id` sets `archived_at` and returns `204`. Archived accounts
are hidden from pickers and still present in historical reports.

### Entry API shape

`POST /entries` accepts a simple form (`accountId`, `categoryId`, `amountMinor`)
that the service desugars into two lines, or an explicit `lines[]` form for
splits, transfers and multi-project entries. **Sugar over the explicit path,
not a second code path.** Transfers need no dedicated endpoint — they are the
explicit form with two `asset` accounts.

### What "real-time" means

Computed on read, at request time. Not WebSocket push. State this plainly in
the README; it is also where the `balance_snapshots` scaling note belongs.

Current balance counts `occurred_on <= today`. Future-dated entries exist but
belong to projection, not balance — that is the line between US2 and US4.

**Balance strategy:** compute on read, covering index on
`(account_id, occurred_on)`. Correct and fast at this scale. The README
documents the scaling path — nightly `balance_snapshots` rollup, query becomes
snapshot + delta — without building it. *Knowing when to add the cache is worth
more than adding it.*

**Recurring / projection:** the critical rule is that **scheduled occurrences
are not entries.** They have not happened; putting them in the ledger would
corrupt every balance and every report.

```
recurring_series       rule (frequency, interval, anchor day, end date),
                       amount, ledger_account_id, category_id
scheduled_occurrences  series_id, due_on, amount,
                       materialized_entry_id NULL
```

Occurrences expand lazily into a rolling horizon with a `materialized_through`
watermark — never store infinite future rows.

Projection at date T = `balance(today)` + unmaterialized occurrences due
between today and T + future-dated real entries. When a bill is actually paid,
the occurrence is linked to the entry via `materialized_entry_id` and drops out
of the projection — that link is what prevents double-counting.

The projected cash-flow chart follows directly: solid line to today from the
ledger, dashed line forward from occurrences.

### Line-level dimensions (RESOLVED — see OD-2, OD-5)

`project_id` and `excluded_from_reporting` live on **`entry_lines`**, not on
`entries`.

The rule: *a dimension lives at the level at which it can vary.* Home Depot
$230 = $200 house-remodel materials + $30 household lightbulb is one real
purchase and one bank debit. Putting `project_id` on the entry would force
splitting it into two entries, falsifying the ledger. Same for exclusion —
a $100 team lunch with $60 reimbursable needs $60 out of spending and $40 in.

**`project_id` is a single nullable FK, NOT a many-to-many.** An m2m without
amounts cannot say *how much* of a $230 expense belongs to each project, so
every project report would guess or double-count. Splitting the line forces
the apportionment to be stated. Multi-project = split the line, the same
gesture users already know from splitting categories.

**Register rows are a projection, not an entry.** A row in the transactions
table is *an entry viewed from one account*: it shows that account's line
amount and collapses the counter-side. One counter-line (the 99% case) →
show its category and exclusion inline. More than one → show `—Split—` and
open the split editor. The register's single Category/Exclusion cell is a
display collapse, not a storage constraint. Model this as an explicit
`TransactionRowView` type in `packages/contracts`; do not let the register
shape leak into the domain.

**Constraint:** both dimensions are meaningful only on `income | expense`
lines — "which project is the −$230 from BAC attributable to" is meaningless.
Enforce in the service layer with one repository test. A trigger would be
airtight, but the database triggers are kept to the ledger's own invariants
(zero-sum, lock, audit); this one is the documented hardening step, not built.

**Projects** (house remodel, trip to France): first-class entity, not a tag,
because the stories want per-project aggregation.

---

## 5. Currency

Currency is a property of the account. USD throughout. No FX rates, no
cross-currency reporting. The column exists so multi-currency is an additive
change, not a migration of every amount.

---

## 6. AI insights — shaped deliberately

US6 — grouping similar transactions and highlighting the most expensive — is
**one feature split across two layers**:

1. **Deterministic layer (SQL).** Grouping and ranking is a reporting query —
   group by normalized payee and by expense account, order by sum descending.
   Tested like any other reporting query.
2. **Semantic grouping layer (LLM), optional.** Receives **merchant names
   only** and returns groupings of those names — which is the one thing no
   string rule can derive, that a taxi company and a rideshare app are the same
   kind of spending. It receives no amounts, dates, accounts, balances or
   identity, and **no figure in the response originates from it**: every total
   is a SQL sum over the model's grouping. It is opt-in per user, and nothing
   is sent before consent.

Consequences: the button still works with no API key (degrade to grouping by
name), the numbers are always right, and the failure mode is coarser grouping
rather than wrong figures. Names the model leaves out fall into `Other`, which
sorts last; groups that do not sum to the deterministic total exactly fall back
to name matching rather than showing figures that do not reconcile.

`modules/insights/` defines an `LlmProvider` port with one adapter
(`@anthropic-ai/sdk`), returning a **Zod-validated structured response**, not
free text. Required around it: request timeout, one retry, a cost ceiling,
the last report cached, and the prompt in a versioned file — not a template
literal. Those details are the integration; the API call itself is the easy
part.

Streaming over SSE is not built.

---

## 7. Seed data

**Deterministic, seeded RNG — the same data every run.** A dataset that
changes between runs cannot be relied on to show the same thing twice.

Roughly six months of history, ending today, for the **primary user**,
covering:

- 2–3 `asset`/`liability` ledger accounts (a checking, a savings, one credit
  card — the credit card exercises the liability sign convention)
- 15–20 `expense` accounts and 2–3 `income` accounts, one level, no nesting
- Salary as a recurring income entry, so the projection has an upward slope
- 2 projects with spend concentrated in different months
- A handful of transfers between accounts — proves the model with no special case
- At least two split entries, one of them splitting across projects — proves
  line-level dimensions and the `—Split—` register projection
- At least one excluded line — proves exclusion affects spending but not balance
- Opening balances via `Equity:Opening Balances`
- **Exactly one reconciled month**, with one corrected entry in it — enough to
  demo locking and the reversal flow without littering every report with
  correction rows

Plus a **second user, deliberately thin**: three accounts and a handful of
entries. It exists to back the isolation test, not to be browsed. Two users is
enough; three buys nothing.

Seeding must be **idempotent** and gated behind an env flag. Volume matters:
the monthly category report needs several months to show a trend, the
projection chart needs a history line before the dashed forecast, and the
semantic grouping has nothing to group without real spread.

---

## 8. Delivery

Commit messages explain *why*, not what.

**README declares a backend/platform focus.** The depth is in the ledger model,
the deferrable trigger and the reporting SQL; the frontend is deliberately
thinner.

README must also contain: install/run instructions (cold `docker compose up`,
no manual steps), the architecture summary, the scaling section (keyset
pagination, module boundaries, the `balance_snapshots` rollup path, read
replicas for reporting), **the explicit cut list with reasons**, and a section
on where and how AI was used.

---

## Scope

**In scope — core (US1–US5).** Ledger accounts + transactions CRUD, balance at
any point in time, monthly category report, projects, future bills/income +
balance projection.

**In scope — AI insights (US6).** What matters is the integration, not the
model's accuracy. See §6 — the deterministic grouping is SQL, and the LLM only
groups names by meaning, never computes money.

**Explicitly cut, each listed with its reason in the README:** savings goals,
multi-currency/FX, investments and assets
beyond a `kind` value, tags, rules, attachments, auth, receipt imports,
**Playwright E2E**, and **generated OpenAPI** (hand-write a small stub
instead). The last two were cut deliberately to pay for period locking and
corrections — for a ledger, holding up under audit is worth more than an E2E
test and a generated spec.

**Recurrence is limited** to monthly-on-day-N, biweekly, weekly, and one-off.
No RRULE library, no timezone-aware recurrence.

**Never drop:** the zero-sum trigger, the lock trigger, the audit-log trigger,
the reporting SQL tests, the money type, reversals copying `project_id`, and
the **tenancy isolation test**.

---

## Design decisions resolved during the build

All five are closed. Each is recorded here in short, and in `docs/DECISIONS.md`
in full.

- **Chart of accounts** — one `ledger_accounts` table holding both accounts and
  categories, discriminated by `kind`. See §4.
- **Project dimension** — line-level, a single nullable FK, never many-to-many.
  See §4 "Line-level dimensions".
- **Package versions** — every pinned version verified against the registry; no
  pin moved. ADR-001 records the eight that were checked and three registry
  facts that did not change a pin.
- **Savings goals** — dropped. Not in the user stories, and not modelled: no
  table, no endpoint, no screen.
- **Exclusion granularity** — line-level, honoured by the spending and category
  reports and ignored by balance and projection, because an excluded
  transaction still moved real money.
