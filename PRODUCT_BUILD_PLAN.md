# `<PRODUCT>` — Technical Architecture & Build Plan

A multi-user GTM agent platform: notices what a team is dropping, drafts in each
person's voice, executes across their whole stack, and learns routines by
watching — earning autonomy one approval at a time.

Written 2026-09-21. Every "port" names a file verified to exist in
`maman-agent`. Every unverified claim is marked.

> **Unnamed.** `<PRODUCT>` is a placeholder. (An earlier draft used "Instinct",
> which is a different product — that error also contaminated the pricing
> evidence; see §12.)

---

## 1. Product

**One line:** an agent that notices what you're dropping, drafts the way you
draft, executes across your stack, and learns your routines — earning autonomy
one approval at a time.

**Not** a prompt box (that's Claude), **not** a sequencer (that's Ergo), **not**
an autonomous BDR (that's Artisan), and above all **not configured** — the
moment there is a workflow builder you become the tool that goes stale after the
contract period. That is the customer's own stated reason tools die.

### Four layers

| Layer           | Does                                                           | Needs observation |
| --------------- | -------------------------------------------------------------- | ----------------- |
| **L1 Notices**  | Reads every connected system, surfaces dropped obligations     | No                |
| **L2 Drafts**   | Writes in the individual's voice from real context             | No                |
| **L3 Executes** | Acts across the stack — API first, browser where no API exists | No                |
| **L4 Learns**   | Watches a routine, offers to take it over                      | Yes               |

L1 is the wedge (his #1 cause of lost deals). L4 is the moat and the answer to
"how is this different from Artisan": **the input is not language, it is what you
already did.**

### The trust ladder

```
notices → suggests → drafts for approval → approve the workflow → runs alone
```

Never granted, only earned; always demotable. For a risk-averse buyer this ladder
IS the pitch, and it is the pricing ladder.

### Execution hierarchy — decided

```
1. API              always preferred where one exists
2. Deterministic    replay a watched routine; no model in the loop
   replay
3. Browser/CUA      surfaces with no API, and repair when replay breaks
```

Browser automation is the fallback, never the foundation: it cannot prove a
write landed, costs a model call per step forever, and breaks on layout change.

---

## 2. Trust boundaries

Everything else follows from these.

- **Model output is untrusted data.** Strict schemas, confidence floors, reject
  whole rather than salvage.
- **Connector responses are untrusted data.**
- **The browser page is untrusted** relative to the extension; the **extension is
  untrusted** relative to the backend.
- **One tenant may never observe another.** Cross-tenant reads return 404, never
  403 — a 403 confirms existence.
- **An admin is not authorized to read an individual's raw activity.** Aggregates
  only, with a minimum cohort.
- **Secrets never enter logs, prompts, analytics, or specs.**
- **A write is never served by demo data.** Reads may fall back to fixtures and
  must say so; writes refuse.
- **Raw pixels leave a device only inside an explicit, bounded capture session**,
  after on-device redaction. Never continuous.
- **Keystrokes are never captured.** No setting, no mode.

---

## 3. Processes

| Process                     | Stack                          | Role                                                                                                     |
| --------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Web**                     | Next.js App Router             | Team UI: obligations, drafts, approvals, receipts, admin                                                 |
| **API**                     | Fastify + Zod                  | Tenant-isolated HTTP. The only thing that touches the DB                                                 |
| **Worker**                  | Temporal                       | Durable runs: an approval may wait hours; a process restart must not lose it                             |
| **Scheduler**               | Temporal cron / durable timers | Obligation sweeps. **Load-bearing** — a forgotten follow-up is by definition a moment the user is absent |
| **Local agent** _(Phase 4)_ | Swift, macOS                   | AX observation. No network code, ever                                                                    |
| **Extension** _(Phase 3)_   | Chrome MV3                     | Browser observation + actuation on granted origins                                                       |

Temporal is justified here in a way it was not for a single-user tool: runs pause
on human approval, and team-scale execution needs durability and replay.

---

## 4. Packages

Monorepo (pnpm + Turborepo), because five processes share contracts — the same
reason Maman's exists.

```
packages/
  contracts          all cross-process Zod schemas + types
  db                 Drizzle schema, hand-written migrations, tenant-scoped repos
  config             product identity, env validation, model ids
  capability-catalog capability metadata: risk, reversibility, idempotency
  capability-router  API-over-browser routing + verification requirements
  connector-auth     OAuth registry, PKCE, signed state, envelope-encrypted vault
  connector-adapters gmail, calendar, salesforce, hubspot, slack, apollo, clay, http
  policy-engine      deterministic risk/approval/budget. NEVER calls a model
  agent-runtime      specs, run engine, lifecycle, shadow comparison
  obligation-engine  NEW — L1 detection. Deterministic
  voice-engine       NEW — L2 style retrieval + draft generation
  browser-actuator   closed-verb browser execution (the CUA edge)
  pattern-engine     observation → episodes → candidates        (Phase 4)
  teach-mode         bounded vision capture + redaction gate    (Phase 4)
  roi-engine         measured value, provenance-tagged
apps/
  web  api  worker
native/     macos-agent  (Phase 4)
extensions/ chrome       (Phase 3)
```

**Boundary rule, lint-enforced:** packages must never import from apps.
`policy-engine` must never import a model provider.

---

## 5. Data model, tenancy, and per-user adaptation

**"Team-wide" means every person gets their own adapted agent — not a shared
team workspace.** The org is a billing and policy boundary; the USER is the unit
of personalization and of isolation.

### Two levels, and the inner one is the strict one

| Level            | Owns                                                                                                                                                         | Enforced by                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| **Organization** | Billing, policy ceilings, which connectors are permitted, OAuth client credentials, aggregate reporting                                                      | RLS on `organization_id`           |
| **User**         | Their connections and tokens, their contacts/threads/deals, their obligations, their voice model, their learned routines, their position on the trust ladder | RLS on `owner_user_id` **as well** |

A rep must never read another rep's inbox, drafts, obligations or patterns —
**including their own manager.** Admins get aggregates with a minimum cohort,
never individual activity. This is a stronger guarantee than ordinary
multi-tenancy: the isolation runs _inside_ the tenant, and most B2B products get
it wrong by treating org-membership as read-permission.

Every repository call therefore carries BOTH ids. There is no ambient tenant and
no ambient user. Cross-boundary access returns **404**, never 403.

### What adapts per user

- **Connections** — each person authorizes their own Gmail/CRM. Tokens are
  envelope-encrypted per user, never shared, never visible to an admin.
- **Voice** — style exemplars retrieved from _their_ sent mail. Two reps on the
  same account get different drafts.
- **Obligations** — derived from their threads and their deals.
- **Routines** — learned from what they do. Not inherited from the team.
- **Autonomy** — each person grants it independently, per workflow. An admin may
  lower the ceiling; they cannot raise it on someone's behalf.

### What the org level does

Sets ceilings, not content: which connectors are allowed, what autonomy is
permitted at most, budget limits, retention. **An admin can restrict; an admin
cannot configure someone's workflows** — that would reintroduce the
configuration burden this product exists to remove.

### Cross-user learning — off by default

If five reps do the same routine, that is real signal. It is also the one place
this design could violate its own boundary. So: **opt-in, aggregate-only, minimum
cohort, and off unless the org and the individual both enable it.** Maman's
`allow_pattern_sharing` and `min_cohort_size` are the right shape; port them.

### Onboarding is per user and must be zero-config

Connect two accounts, see a ranked list. No admin setup step, no workflow
builder, nothing for IT to maintain. If a new rep needs anyone's help to get
value on day one, the product has failed its own thesis.

### Storage

**Postgres + row-level security, FORCE'd on every tenant table**, keyed on
`organization_id` AND `owner_user_id` for user-owned rows.

Core tables:

```
organizations, users, memberships          org-scoped
policies                                    org-scoped (ceilings only)

-- everything below is USER-owned: (organization_id, owner_user_id)
connections            per-user OAuth grants; tokens envelope-encrypted
contacts, threads, deals        synced projections from THEIR connectors
obligations            detected, ranked, with a reason
suggestions            what was surfaced, and the outcome
voice_exemplars        style samples from their own sent mail
agents, agent_versions immutable versions, owned by the person who taught them
runs, run_steps, approvals      (PERSISTED — see §10)
receipts               (append-only, provenance-tagged)
audit_events           (append-only, hash-chained)
policies               (immutable versions)
```

**Migrations are hand-written up/down SQL**, both directions tested. Port that
discipline from `packages/db/migrations/`.

**Connector tokens** live in an envelope-encrypted vault bound to org+provider,
never returned in any API response, never logged.

---

## 6. Connector coverage — "connect everywhere"

| Connector                | Lane        | Notes                                                                                    |
| ------------------------ | ----------- | ---------------------------------------------------------------------------------------- |
| Gmail                    | API         | read + `compose`. **Never request send scope** until L3 sending is a deliberate decision |
| Google Calendar          | API         | meetings as obligation context                                                           |
| Salesforce               | API         | port Maman's adapter — real HTTP, idempotent writes                                      |
| HubSpot                  | API         | provider already registered in `connector-auth`                                          |
| Slack                    | API         | registered; `chat:write.customize`                                                       |
| Apollo / Clay            | API         | enrichment                                                                               |
| **LinkedIn**             | **Browser** | no write API for messaging or connection requests. This is why the browser lane exists   |
| Vendor portals (gifting) | Browser     | long tail                                                                                |

`capability-router` picks the lane. It scores `api` 1.0 over `browser` 0.6 and —
critically — gives consequential steps **no automatic fallback**: a failed API
write stops and asks rather than silently becoming a screen write.

Every capability declares `risk`, `reversible`, `is_idempotent`, `retry_class`
in `capability-catalog`. The policy engine reads those; nothing infers them.

---

## 7. Execution model

**Spec.** An agent is an immutable versioned `AgentSpec`: ordered steps, each
naming a capability, with typed inputs and explicit bindings. Specs are compiled
deterministically — from a watched trace (L4) or from a template. A model may
name a spec; it may never author a write step.

**Required inputs are validated before step one.** `null`, `""` and `[]` count
as missing. Port `agent-runtime/src/agent-inputs.ts`.

**Approval is bound to a diff hash.** Execution re-proposes **fresh**, requires
the hash to match, and aborts `stale` otherwise. Two-pass, so a multi-write
routine can never land half.

**Verification is independent.** A consequential write is confirmed by a
**separate read through a different channel** — ideally the provider's API.
Never trust the writing call's own return value. This is the single most
important lesson from Maman (§10).

**Receipts are append-only and provenance-tagged** — `measured` / `inferred` /
`estimated`. Never report a number you did not measure.

**Autonomy** requires four independent conditions, all true: org policy allows
it, the capability is on the unattended allowlist, a human promoted this agent,
and the plan-shape hash still matches. None implies another.

---

## 8. Observation (Phase 4)

Three tiers, decided on economics:

```
AX / DOM        continuous, free, coarse       ← runs all day
Vision          bounded sessions, user-started ← "show me this once"
Vision sampled  only where the cheap signal is ambiguous
```

Measured from Maman's own cost model (2.5s cadence, 1400px cap): ~$98/day Sonnet,
~$33/day Haiku; at 30s cadence ~$60/month/user on Haiku. **Continuous vision is
not viable.** Frame size is the lever — at 1400px the image is ~80% of input
tokens.

**Unverified:** the vision call has never actually been made in Maman.
`pnpm teach:vision-probe` settles whether a real reply satisfies the schema for a
fraction of a cent. Do it before designing on it.

Capture constraints that survive into this product unchanged: user-started,
app-scoped, ≤900s self-terminating, fail-closed on every unknown, credential
regions masked **before** egress, whole-frame refusal rather than partial
redaction, frames never persisted or logged.

### Prior art — measured on a real device, 2026-09-21

Findings from running Maman's observer against a live macOS machine. These cost
real time to establish; Phase 4 should not rediscover them.

**The AX lane never emits a click.** Zero `element_activated` across 589 events
including two rounds of deliberate button-clicking. The Swift observer
subscribes to focus-changed, window-changed and value-changed only — there is no
click notification in it. A press is _inferred_ from focus landing on a button,
and a mouse click on a web button commonly does not move AX focus.
**Unresolved:** whether the clicked buttons received focus. `target_role` is
encrypted at rest and absent from the timeline projection, which is exactly why
`pressEvidence` exists. Run it first.

**Clicking is noisy, not silent.** Button-only clicking produced +52
`value_committed` and +42 `element_focused`. Most of those commits are pages
updating themselves — AX fires `AXValueChanged` on static text when content
re-renders. So the native lane's problem is **signal-to-noise, not blindness**,
and the bar most likely to reject candidates is `min_similarity_mean: 0.82`
(untunable) rather than feasibility.

**Feasibility was a false lead.** Both emitted work types are already mapped to
capabilities; feasibility lands around 0.89, well over the 0.6 floor. Filling
capability-table entries for `element_activated`, `navigation`, `record_opened`
or `table_read` changes nothing, because the observer never emits them.

**87% of events carry no semantic classification.** 171 of 196 had no
`domain_object` / `domain_action`. Pack templates need them, so the cold-start
path is unavailable for most work. Measured on AX-only data — the poorest
signal — so re-measure once DOM semantics are available before buying a
classifier to fix it.

**The canonical token has no host.** Every unrecognised site collapses into
`app_category: "browser"`, and clustering compares tokens only — so two
different SaaS apps are indistinguishable. Add the host to the token for the
`browser` category only, or detection breadth makes clustering worse rather
than better.

**The extension observes its own writes.** `content.ts` listens for `change` at
document capture with no `isTrusted` guard, and the DOM adapter dispatches
exactly that event. Under autonomy this is a closed loop that retrains the
detector on the agent's own output. Fix on port — §10.

**Browser writes cannot be proven to have committed.** The "independent"
read-back re-reads the same DOM in the same page state, immediately, with no
settle and no reload. It returns `verified: true` for a value that sits in the
DOM but was never saved, and for a save the server rejected. This is why §7
verifies through a different channel.

---

## 9. What to port from Maman

| From                  | Path                                                        | Why                                                                                                                         |
| --------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Capability router     | `packages/capability-router/`                               | The §6 lane decision, already written, 21 tests. Zero consumers in Maman — this is its first real home                      |
| Browser actuator      | `packages/browser-actuator/`                                | Closed 7-verb set, role+name targeting not selectors, ambiguity refused, `expect_current`, secure fields refused. 149 tests |
| Trust ladder          | `agent-runtime/src/mesh-lifecycle.ts`                       | `supervised → approved → autonomous`, human-gated; shadow agreement is "informative only, can never substitute approval"    |
| Shadow comparison     | `agent-runtime/src/shadow.ts`                               | N-success promotion evidence                                                                                                |
| Approval + run engine | `agent-runtime/src/run-engine.ts`                           | Diff hash, fresh re-propose, stale abort, two-pass                                                                          |
| Input validation      | `agent-runtime/src/agent-inputs.ts`                         | Required inputs before step one                                                                                             |
| Policy engine         | `packages/policy-engine/`                                   | Deterministic risk, approval requirement, budgets. Never calls a model                                                      |
| Capability catalog    | `packages/capability-catalog/`                              | Risk/reversibility/idempotency metadata                                                                                     |
| Connector auth        | `packages/connector-auth/`                                  | 6-provider registry, PKCE, signed single-use state, envelope vault                                                          |
| Salesforce adapter    | `connector-adapters/src/salesforce.ts`                      | Real HTTP, idempotency, token refresh                                                                                       |
| DB tenancy            | `packages/db/src/tenant.ts`, `repositories.ts`              | Explicit `TenantContext`, 404 not 403                                                                                       |
| Migrations discipline | `packages/db/migrations/`                                   | Hand-written up/down, both tested                                                                                           |
| Audit chain           | `packages/db/src/audit.ts`                                  | Hash-chained append-only                                                                                                    |
| Receipts              | `contracts/src/receipt.ts`                                  | Provenance-tagged metrics                                                                                                   |
| Redaction gate        | `teach-mode/src/redact.ts`                                  | Fail-closed, mask-before-egress, 100% branch coverage                                                                       |
| Secret guards         | `contracts/src/common.ts`, `model-provider/src/provider.ts` | `looksLikeSecret`, `promptSafeText`, parse-before-send                                                                      |
| Pattern engine        | `packages/pattern-engine/`                                  | Segmentation, similarity, scoring (Phase 4)                                                                                 |
| Eligibility verdict   | `pattern-engine/src/eligibility.ts`                         | Single source of truth, no short-circuit, `relative_shortfall`, `sole_blocker`                                              |
| Observation profile   | `pattern-engine/src/observation-profile.ts`                 | Diagnose the pipeline from its input, not its silence                                                                       |
| Observer shape        | `native/macos-observer/`                                    | AX-only, no `CGEventTap`, CI scan that fails on a networking or keystroke symbol                                            |
| Extension             | `extensions/chrome/`                                        | Pinned key, closed action set, per-origin grants                                                                            |

**Leave:** the pet and Tauri shell · `runs.ts` (named debt) · `workflow-graph`
(no use yet) · domain-pack YAML · the mesh DB tables.

---

## 10. Maman's mistakes — do not repeat

Each of these is real, found in this codebase, and cost something.

| Mistake                                                       | Consequence                                                      | Rule here                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Auth was a placeholder that rejects everything                | No one could authenticate in production                          | Real auth in Phase 1, or none — never a stub that looks wired             |
| Worker persisted runs via `console.warn`                      | `run_steps`, `approvals`, receipts never written; no run history | The worker writes to the DB, and an integration test asserts a row exists |
| `capability-router` built, tested, **never called**           | The API-over-browser rule existed only in comments               | Wire a package into a real path in the same change that builds it         |
| 7 mesh tables created, never read or written                  | Migration weight, RLS tests, zero value                          | Do not create a table until something writes it                           |
| Teach Mode vertical built, its UI later deleted               | A whole capability unreachable, tests still green                | A feature without a surface is not done                                   |
| Extension observed its own writes                             | Agent output would retrain the detector                          | Suppress self-observation: `isTrusted` + an in-progress flag, tested      |
| "Independent" verification re-read the same DOM, same tick    | Reported `verified: true` for writes that never committed        | Verify through a **different channel**, after a settle                    |
| Eligibility logic existed in three places                     | Explanation could drift from behaviour                           | One source of truth; derive the others                                    |
| Four scripts failed silently and exited 0                     | Tests "passed" by never running                                  | No silent failure; a script says why it did nothing                       |
| A drift-guard test passed against a reintroduced `>` for `>=` | A guard that guarded nothing                                     | Drill every test, with boundary cases                                     |
| CI ran unit tests only                                        | A production defect reached `main`                               | Integration tests run in CI                                               |

---

## 11. Phases

### Progress

| Item                                                            | State                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `obligation-engine` (L1 detection)                              | ✅ 24 tests, 3 drilled                                                                                                      |
| Two-level tenancy (migration 0008)                              | ✅ `user_connections`, `contacts`, `threads`, `obligations`; org+user RLS, FORCE'd                                          |
| `withUser` transaction helper                                   | ✅ separate from `withTenant` by design                                                                                     |
| User-isolation integration tests                                | ✅ 10 tests, two users in ONE org                                                                                           |
| Gmail sync (metadata-only, per-user credentials)                | ✅ `gmail-project.ts` pure + `gmail.ts` HTTP; 55 tests in the package, 7 drilled                                            |
| **L1 vertical slice** — mailbox → rows → detector → ranked list | ✅ `runGmailSyncJob`; proven on a real DB under real RLS (5 integration tests); 3 drills                                    |
| Per-user vault (`user_connections`)                             | ✅ envelope AAD now binds `user_id`; stolen-ciphertext refusal tested end to end                                            |
| **`/v1/me/*` — the demo path over HTTP**                        | ✅ connect Gmail → sync → ranked list → act; 11 integration tests, two users in one org; 2 drills                           |
| `@maman/sync` package                                           | ✅ sync job + per-user vault, consumed by api now and worker in Phase 2                                                     |
| CRM connector                                                   | ☐ next — find out which CRM first                                                                                           |
| Web UI — Inbox + Connections                                    | ✅ `apps/web` is the product; server components + server actions, identity never in the browser; admin moved under `/admin` |
| Draft creation (`gmail.compose`, never send)                    | ✅ `gmail-draft.ts` + `voice-engine` deterministic composer + `POST /v1/me/obligations/:id/draft`; failure branch tested    |

**Landed defect, worth keeping:** the first RLS policy spelled the guard as
`current_setting('app.user_id', true)::uuid`. That returns NULL only while a
custom GUC has NEVER been set in the session; once any transaction has set it, a
transaction-local set reverts to the EMPTY STRING, and `''::uuid` raises
`invalid input syntax for type uuid`. So an org-scoped read of these tables
**threw instead of returning nothing** — still safe, but an exception rather
than a clean empty result. `NULLIF(..., '')` maps both cases to NULL. Caught by
the test asserting the documented fail-closed behaviour, which is the entire
reason that test exists.

**Gmail, two design facts worth keeping:**

- **The scope enforces the design.** The connector holds `gmail.metadata`,
  which grants headers and NOT bodies, and every thread fetch asks for
  `format=metadata` with an explicit `From`/`To`/`Subject` allowlist. So a
  content-free `threads` table is not a convention anyone has to respect — it
  is the only data we are permitted to read. Pinned by tests that assert on the
  REQUESTS (every call is a GET; the allowlist is exactly those three headers),
  because the privacy property lives in what is asked for, not in what comes
  back. L2 drafting will need bodies for context, and that is a deliberate
  scope escalation the user re-consents to — never requested early.
- **Credentials are per-user, by type.** The existing `CredentialProvider` is
  keyed `{organization_id, provider}` — correct for an org-installed Salesforce,
  wrong for a mailbox. A new `UserCredentialProvider` keyed on `user_id` as well
  makes it impossible to pass the org one and hand every rep the same inbox.
  This is §5's two-level tenancy surfacing in the credential layer.

Direction — whose turn it is — hinges on recognising the user's own address, so
`isSelf` folds case, plus-addressing, and Gmail's dot-insensitivity (only on
gmail.com/googlemail.com; folding dots on a corporate domain would merge two
real mailboxes). The counterparty is taken across ALL messages, not the last
one: on an outbound thread the last sender is the user and the other party only
appears in `To`.

**The slice, and three things wiring it surfaced** (each a §10-class lesson —
a part is not done until it runs in a real path):

- **Deal state is tri-state.** Migration 0008 said `has_open_deal NOT NULL
DEFAULT false`; the detector suppresses closed relationships; so a Gmail-only
  user — every user on day one — saw nothing. 0009 makes it nullable, NULL =
  "no CRM has said". Unknown passes and ranks 5 below known-open at equal
  lateness: within a kind band, never across one. The CRM's answer promotes, it
  does not unlock.
- **Envelope encryption was org-bound.** `envelopeEncrypt`'s AAD was
  `org:provider`, so a rep's encrypted Gmail token copied into a colleague's row
  in the same org would still decrypt. `EnvelopeAad` gains a positional
  `user_id` segment; org-bound and user-bound can never collide; org-installed
  connectors are unchanged. The slice test copies Alice's ciphertext into Bob's
  row and asserts: refused, zero Gmail calls, failure recorded on HIS row.
- **Reads had no ORDER BY.** Two reads of one workspace could disagree.
  Ordered now.

A sync failure is written to the connection row (`last_error`, status) rather
than swallowed — a list that quietly stops updating reads as "it stopped
working". And a sweep rewrites only PENDING obligations, so a snoozed or
dismissed thread is never re-surfaced: a reminder, not a nag.

Gate at this point: lint 24/24 · typecheck 24/24 · unit 22/22 tasks ·
integration **103** (db 63, worker 12, api 28) · build 5/5.

**The API surface (`apps/api/src/workspace.ts`).** No `/v1/me/*` route takes a
user id as a parameter: there is no legitimate reason for one person's request
to name another's data, RLS would return nothing anyway, and not offering the
parameter means the API cannot even express the question. Only `gmail` is
personally connectable; org-installed connectors stay on `/v1/connectors`.

A foreign or missing obligation answers **404, never 403** — a 403 confirms the
row exists, which is exactly the fact RLS withholds. `/v1/me/sync` answers 409
with a reason when the workspace cannot sync (no connection, expired grant),
so the UI can offer "connect" or "reconnect" instead of a generic error.

The mailbox address is learned on the first sync — Google's token response does
not carry it without an identity scope we do not request — so one label per
provider until then, which means one connection per provider per person.

Gate at this point: lint 25/25 · typecheck 25/25 · unit 23/23 · integration
**114** (sync 5, worker 7, db 63, api 39) · build 5/5.

**Drafts and the inbox.** The first write is a Gmail DRAFT: reversible and
human-reviewed by construction, so it needs none of the verification a CRM
write does, and the scope cannot send even if the code tried (tests pin that no
request ever targets a send endpoint). The RFC 2822 builder strips CR/LF from
every header — `Subject: x\r\nBcc: attacker` would be a send hiding inside a
draft — pinned by asserting the exact header names. The obligation is marked
`drafted` only AFTER Gmail confirms; the failure branch is tested (Gmail 500 →
the item stays pending).

`voice-engine` is deterministic for now, behind a `DraftComposer` interface the
model version implements later. Its one rule, model or not: **never invent a
fact.** With `gmail.metadata` we know subject, who, and how long — not what was
said — so the draft names the gap and stops. It never guesses a first name from
an address ("Hi sarah," reads as a bot).

The web app renders the reason sentence from the detector's FACTS, so copy can
never disagree with arithmetic. Dev identity is `MAMAN_DEV_ORG_ID` /
`MAMAN_DEV_USER_ID`, refused by the API outside `AUTH_MODE=dev`; real auth
replaces one function.

**Phase 1 remaining:** CRM connector (which one?), real auth, scheduled sweeps.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**117** (sync 5, worker 7, db 63, api 42) · build 5/5.

**Phase 1 — foundations + first value (2–3 weeks).**
Monorepo, contracts, DB with RLS, real auth, Gmail + one CRM connected per user.
`obligation-engine` (deterministic, unit-tested). Web UI: ranked obligations with
a reason. Gmail **draft** creation — no send scope.
_Exit:_ a team member logs in, connects two systems, and sees a real ranked list
with zero configuration.

**Phase 2 — voice + breadth (3–4 weeks).**
`voice-engine`: retrieve style exemplars from sent mail, generate drafts, record
every edit as signal. Add Calendar, Slack, HubSpot/Salesforce, Apollo/Clay.
Durable obligation sweeps on a schedule.
_Exit:_ users prefer the generated draft to their own first attempt more than
half the time, measured.

**Phase 3 — execution + the ladder (4–5 weeks).**
Wire `capability-router`. CRM writes verified by independent API read. Approval
bound to diff hash. Port `mesh-lifecycle` + `shadow.ts` so rungs are real.
Chrome extension for LinkedIn and the long tail — **with self-observation
suppression from the first commit**. Admin: aggregates only, minimum cohort.
_Exit:_ an approved workflow runs again without asking, with a receipt and a
one-click undo.

**Phase 4 — observation, the moat (5–6 weeks).**
macOS agent (AX only, no-network CI scan). Trace capture → spec compiler.
`pattern-engine` + the eligibility/profile diagnostics from day one. Teach Mode
with its UI built in the same change.
_Exit:_ a user does a routine once, is offered it, approves it, and it runs.

**Phase 5 — earned autonomy.** Unattended allowlist, plan-shape binding,
org-policy gate, value-priced ops workflows (the $70–80K gifting anchor).

**A demo can be cut from Phase 1 in ~1 week** by narrowing to one user, Gmail +
one CRM, drafts only, sandbox account. That is a slice of the real build, not a
throwaway.

---

## 12. Evidence quality

The product definition rests on **one customer conversation**.

| Claim                                              | Confidence                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Forgetting follow-ups loses deals                  | **High** — stated as the main cause                                                                                  |
| Reps won't configure; breakage strands them        | **High** — explains "tools go stale"                                                                                 |
| CRM integration mandatory, omnichannel is the goal | **High**                                                                                                             |
| Warm > cold for revenue                            | Medium                                                                                                               |
| Gifting worth $70–80K/yr                           | Medium — a hiring estimate, not a budget                                                                             |
| "Some of the 15-person team could be laid off"     | Low — enthusiasm, and an adoption risk: the users may be the displaced                                               |
| ~~$20/month~~                                      | **Does not apply** — that figure was about a different product. There is **no** individual price signal in the notes |

**Resolve with him:** what Boardy is (a stated disqualifier you cannot design
around) · champion vs. user · whether "observation, not language" lands · what
he would actually pay · whether the team skeptic's CUA reservation extends to
screen observation.

---

## 13. Agent instructions — how I work on this repo

**Before writing**

1. Read the target file. Never patch from memory.
2. If a claim is checkable in code, check it. In building Maman I twice
   diagnosed from inference and was wrong — a Temporal version "drift" that did
   not exist, and a capability-table gap for events the observer never emits.
3. State any unavoidable assumption, and mark it in the artifact.

**While writing**

4. Match the file's idiom, comment density and naming.
5. Comment **why**, not what — especially a constraint a future reader would
   otherwise delete.
6. One source of truth per rule; derive, never duplicate.
7. Diagnostic detail never rides on a wire contract. Carry it beside.
8. Wire a package into a real path in the same change that creates it.

**Testing**

9. **Drill every test**: break the code, confirm a useful failure, restore.
10. Boundary cases for every threshold, plus one either side.
11. Assert the consequence — "no row was created" beats "returned 400".

**Every change**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Green before moving on. If something is red for reasons outside the change, say
so explicitly rather than working around it.

**Reporting**

12. Separate "tests pass" from "works against the real system".
13. Report scope growth immediately.
14. Never claim something is built when only its tests are.

**Never**

15. Never weaken an authorization, approval, redaction or audit check to make a
    test pass.
16. Never add a workflow builder or configuration screen. Its absence is the
    product.
17. Never send, delete, or write to a system of record without an approval bound
    to the exact diff.
18. Never report a number without its provenance.
