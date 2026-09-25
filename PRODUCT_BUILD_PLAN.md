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

**One line:** an agent that captures what each person means and acts on it
before they ask: it notices what they are dropping, writes the way they write,
honours what they have said, executes across their stack, and learns their
routines, earning autonomy one approval at a time.

**The objective, stated plainly (2026-09-22):** the final product captures
intent and proactively acts on it. Every input exists to reveal intent (what
the person is trying to get done, with whom, how they do it) and every output
is the agent acting on that intent with the least asking. Everything in this
plan is measured against that.

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

### The agent, and where the arithmetic sits

This is the final product, not a demo. It is a general agent for each person,
not a follow-up tool. The shape is fixed, and the loop is the product:

```
sources      →  one store per person   →  discovery      →  the agent         →  the ladder    →  actions
(connectors,    (facts: contacts,          (which routines    (judges, proposes    (approve each,   (drafts, CRM
 the product     threads, deals,            this person has,   with evidence,       then Always,     writes, sends,
 itself, later   meetings; events:          from what they     compiles a routine)  shadow runs,     anything a
 the device)     what they did, when)       actually did)                           receipts, undo)  capability does)
```

**Restated 2026-09-22, after the owner's correction.** The agent does not
automate a workflow someone names. It finds the routines each person already
does, proposes each one with the evidence, and runs it up the ladder. What
was built through 2026-09-22 (notice a dropped follow-up, draft it, keep the
CRM true) is **routine 1, found by hand**, built first so the store, the
intent memory and the ladder had something real to run on. It stays, as the
demo and as the first routine. It is not the product, and no more routines
are written by hand from here. New work adds a source, a capability, or
discovery. See "Routines are found, not configured" below.

- **Adding a source means adding a connector, never changing the agent.** Each
  connector feeds facts into the same per-person store through the same seam
  (`DealSource`, the thread projection, the calendar projection). The agent
  reads the store, not the connectors.
- **The agent decides what to write, how, and when**, from three kinds of
  context: what happened (the thread, the deal stage, the last meeting), how
  this person writes (their own sent mail, and every edit they make to a
  draft), and what they asked for ("always follow up two days after a demo").
- **The deterministic detector is the trigger and the fallback, not the
  product.** It decides that something happened worth looking at (a thread
  went quiet, a meeting passed with nothing sent), for free, over every
  thread, and puts a floor under trust: the agent can only act on things that
  actually happened, and every card can show the fact behind it. The agent
  decides whether it matters, what to say, and when. With the agent switched
  off (`AGENT_MODE=off`) the product is the ranked list of facts and nothing
  else, and that path stays tested in both modes for as long as it exists.
- **Every model output is untrusted data.** It passes a strict schema, it can
  narrow and annotate, it can never add an obligation, change a value, or
  touch a permission. A failed judgment leaves the arithmetic in charge of
  that item.

### Routines are found, not configured

A routine is a trigger, a sequence of steps on records, and a check that it
landed. Nobody types one in. The agent finds them, in this order of sources:

1. **Connector events, first.** Every fact a connector already syncs is also
   an event about what the person did: sent a reply, booked a meeting, moved
   a stage, logged a call, changed a field. The product's own clicks are
   events too (approved, dismissed, edited, promoted). These land in the same
   per-person store as `WorkflowEvent` rows (the canonical event contract in
   `packages/contracts`, which carries roles, hashes, categories and counts,
   never a body or a value). No device software is needed for this, so it
   is where discovery starts.
2. **The browser, second.** The Chrome extension for the surfaces with no API
   (LinkedIn, the long tail), same event contract.
3. **The device, third.** The macOS observer (accessibility API only, no
   network) and Teach Mode, same event contract, for everything else. This is
   the moat, and it widens what can be found; it does not change how.

Over that stream, `pattern-engine` does what it was built for: segment
episodes, cluster the repeats, score each candidate (how often, how many
distinct days, risk, feasibility, minutes saved), and explain the steps in
plain words. A candidate that passes the eligibility bars becomes a proposal
on the Inbox: "After a meeting with someone on an open deal, you log a call
and set the next step in Salesforce. Twelve times in the last month. Want me
to?" The evidence is the episodes themselves. Accepting it is a confirmed
intent entry (§ The intent store), never silent.

An accepted candidate is compiled deterministically into an `AgentSpec`
(`agent-runtime`: trigger, steps naming capabilities, inputs, verification)
and then climbs the same ladder every write already climbs: shadow runs
compared with what the person did, approval per run bound to the diff,
"Always" once earned, gated by org risk policy, receipts, undo. The model
names the routine and writes the plain-language plan; it never authors a
write step, and the spec has nowhere for it to change risk or permissions.

What this means for the code already here: `obligation-engine`, the judgment
prompt, the drafting job and the two CRM write kinds are routine 1's trigger,
judgment and capabilities. The ladder, the intent store, the connectors and
the store are general and carry over unchanged. Stage moves, sending mail,
Slack and HubSpot are capabilities and sources a found routine may need, so
they are added as adapters when a routine needs them, not as workflows.

### The intent store

Intent is what the agent acts on, so it has one home per person. Three kinds
of entries, all kept as sentences the person can read:

1. **Stated.** Typed or spoken, in their words: "Don't chase Acme, their
   procurement is slow." "Never follow up more than twice." "After a demo,
   send a recap the same day." Speech is text after transcription; it lands
   the same way.
2. **Shown by action.** Dismissing a follow-up ("not needed, they signed"),
   snoozing something twice, rewriting a draft, dropping the sentence the
   agent keeps adding. Each is intent, recorded with its origin (which thread,
   which action) instead of thrown away after the click.
3. **Confirmed.** What the agent infers from actions ("you wait a week before
   chasing Acme") is held as a proposal until the person sees it and keeps it.
   Nothing inferred becomes permanent silently.

Each entry carries its source, its time and its scope: this contact, this
account, this kind of situation, or everything. Entries are encrypted to the
person like their mail, bounded and secret-checked like everything that
reaches a model, never shared across a team, never visible to an admin.

**How it is used.** Retrieved by relevance at the moment of judgment or
drafting: this contact first, then the account, then the situation, then the
general entries. Where an entry is enforceable by rule ("never more than
twice", "not Acme") it is enforced by rule in detection, so it holds with the
agent off. Where it is about judgment or voice ("recap same day", "sign off as
Cheers, A") it goes to the model as the person's own instructions, marked as
theirs, and grounding still applies. No entry can change a permission, a deal
value, or what the detector counts as fact. Contradictions resolve to the
newest stated entry, and the agent says when it did that.

**How it is surfaced.** The card and the draft name the entry that applied:
"Skipped: you said not to chase Acme." "Drafted the recap you asked for after
demos." The store is a page the person can read, correct and delete from. A
memory that cannot be seen is a bug waiting to be trusted.

**How what is already built serves this.** The connectors and the store are
intent's evidence: whom the person talks to, what was asked, what they
promised in meetings, what is at stake in the CRM. The detector is the
trigger that says something needs intent applied now. The judgment is the
agent reading the evidence for what is actually owed. The voice is intent
about how this person writes, learned from their own mail. The draft record
and the edit ratio are intent shown by action, captured. The trust ladder is
intent about how much the person wants done without asking. Each of these
feeds the store or is fed by it; none is a feature on its own.

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

### Mail content is an input

The agent reads whole conversations, not headers. Decided 2026-09-21 for the
final product: message bodies are synced and stored per person so the agent
has the full thread, the relationship so far (every other thread with that
contact), and the person's own writing as voice, without asking Gmail again
each time.

The conditions that make this acceptable, and they are enforced in code, not
policy: bodies are stored only as ciphertext under the person-bound envelope
key (the AAD names the organization, the user and the provider), so a row
copied to a colleague's account fails to open and a breach of the table
yields ciphertext. Rows are under the same row-level security as everything
the person owns. Only that person's agent decrypts them: never an admin,
never a log, never analytics, never a client response. The model gets a
bounded slice (last eight messages, four thousand characters each). Full
text search over the store is impossible by construction; the agent
retrieves by contact and thread.

Cost is controlled by Gmail's per-thread history id: a listed thread whose
id has not moved is not fetched again, so a full-content sync every fifteen
minutes costs one list call plus one fetch per changed thread.

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
messages               mail content, ENCRYPTED to the person (see below)
drafts                 what the agent wrote, matched later to what was sent
meetings               calendar events, agenda ENCRYPTED to the person; last/next stamped on contacts
intents                the intent store: stated, shown by action, confirmed; ENCRYPTED to the person
thread_assessments     the agent's judgment per thread state
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

| Item                                                               | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `obligation-engine` (L1 detection)                                 | ✅ 24 tests, 3 drilled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Two-level tenancy (migration 0008)                                 | ✅ `user_connections`, `contacts`, `threads`, `obligations`; org+user RLS, FORCE'd                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `withUser` transaction helper                                      | ✅ separate from `withTenant` by design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| User-isolation integration tests                                   | ✅ 10 tests, two users in ONE org                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Gmail sync (metadata-only, per-user credentials)                   | ✅ `gmail-project.ts` pure + `gmail.ts` HTTP; 55 tests in the package, 7 drilled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **L1 vertical slice** — mailbox → rows → detector → ranked list    | ✅ `runGmailSyncJob`; proven on a real DB under real RLS (5 integration tests); 3 drills                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Per-user vault (`user_connections`)                                | ✅ envelope AAD now binds `user_id`; stolen-ciphertext refusal tested end to end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **`/v1/me/*` — the demo path over HTTP**                           | ✅ connect Gmail → sync → ranked list → act; 11 integration tests, two users in one org; 2 drills                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@maman/sync` package                                              | ✅ sync job + per-user vault, consumed by api now and worker in Phase 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CRM connector — Salesforce                                         | ✅ adapter + resolver + sweep/API wiring + **Connections page**: Connect/Disconnect Salesforce for the team, logos, status, OAuth landing banner; 12 + 5 unit, 5 + 3 integration, 3 drilled. HubSpot ☐ (Phase 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The agent pass (AGENT_MODE=assist)                                 | ✅ reads candidate threads in full, model judges owed/ask/urgency behind a strict schema, stored per thread state; deterministic list unchanged with the switch off; 29 + 6 unit, 4 + 6 + 2 integration, 3 drilled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Mail content as input                                              | ✅ full threads synced and stored encrypted to the person (`messages`, 0011), unchanged threads skipped by history id, the agent reads the store plus the relationship so far; Gmail is the fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Voice: the agent writes the draft                                  | ✅ model composer behind the switch, voice retrieved from the person's own mail (to this contact, past follow-ups, recent), grounding enforced in code, template fallback with reason; drafts recorded and matched to what was sent (edit ratio); 12 + 3 + 1 unit, 3 + 2 + 1 integration, 3 drilled                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Google Calendar as input                                           | ✅ one Google consent (mail + calendar), meetings stored per person with the agenda encrypted, incremental sync by token, last/next meeting stamped on contacts, a booked call cancels a chase, meetings reach judgment, draft (grounded) and card; 7 + 5 + 3 unit, 3 + 3 integration, 3 drilled                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The intent store                                                   | ✅ stated and observed entries, encrypted to the person, scoped to contact/account/situation; rules (don't chase X, no more than N) enforced in detection with the agent off; guidance to the model as the person's instructions; set-aside items shown with the sentence that did it; a box to tell the agent, a list to forget from; 14 + 1 unit, 3 + 3 + 3 integration, 3 drilled                                                                                                                                                                                                                                                                                                                                            |
| Pre-drafting, and the measure shown                                | ✅ the sweep drafts what the agent judged owed (top 3 per sweep, one unsent draft per thread, never when the person said not to), through the same job a click uses; the card says "Draft ready" and opens it in Gmail; "This week: N drafts, M sent, K as written" on the Inbox; 1 + 1 unit, 2 + 3 + 2 integration, 3 drilled                                                                                                                                                                                                                                                                                                                                                                                                  |
| Phase 3, first write: Salesforce activity log                      | ✅ propose the exact diff from witnessed facts, approval bound to its hash, applied exactly once by marker, verified by an independent read, receipt row, audit event, undo with read-back, promotion ("Always") as a stated intent bound to the write's shape and gated by org policy; a Salesforce section on the Inbox; 4 + 2 + 1 unit, 9 + 3 integration, 3 drilled                                                                                                                                                                                                                                                                                                                                                         |
| Phase 3, second write: next step and close date on the opportunity | ✅ read from the thread with the sentence for each field, grounded in code (the quote must be in the thread, the date must be what the quote says), proposed only where the record differs, never over a hand edit (stale, both values shown), written field by field, verified by read-back, undo restores the previous values, medium risk so "Always" only where the organization lists it; "Update Salesforce" on a card with an open deal and in the sweep; 8 + 2 unit, 6 + 1 integration, 4 drilled                                                                                                                                                                                                                       |
| Routines found, not configured (the spine, restated 2026-09-22)    | ⬜ the follow-up lane above is routine 1, found by hand; Phase 3 from here is discovery on connector events, the proposal card, compile to a spec, the ladder for found routines; no more hand-written routines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Phase 3, step 1: the event stream                                  | ✅ every synced fact and every click derived into the person's store as canonical `WorkflowEvent` rows (migration 0017): source, app, event type, role, semantic type, object type, a salted one-way hash of the record, counts, time; never a body, address, subject or raw id; ids a function of the fact so a re-derivation is the same set; backfill then only what moved; refused whole when one event breaks the contract or names another person; `EVENT_STREAM=off` derives nothing; `GET /v1/me/events`; 7 unit, 4 + 4 + 2 integration, 4 drilled                                                                                                                                                                      |
| Phase 3, step 2: discovery                                         | ✅ the pattern engine over each person's stream in the sweep, segmented by case (the contact) and days of quiet through a new `segmentByCase` and an engine `segment` option; connector tokens mapped to real capabilities (draft, read); candidates stored per person by signature (migration 0018) with the engine's word beside the person's (not now with a cooldown, never, accepted); `GET /v1/me/routines` in plain words with every bar it misses; `DISCOVERY=off`; 5 + 1 + 1 unit, 3 + 4 + 1 integration, 5 drilled                                                                                                                                                                                                    |
| Phase 3, step 3: the proposal card                                 | ✅ a Routines section on the Inbox: each eligible routine in plain words with its steps, what a helper could do for each, and the evidence (how often, on how many days, around whom by name); Accept, Not now, Never; "not now" on the row with the cooldown, "accepted" and "never" as entries in the intent store bound to the routine's signature, so forgetting the entry is the undo; a forming routine cannot be accepted; forming routines listed with what they still need; 2 + 2 unit, 3 + 4 + 1 integration, 5 drilled                                                                                                                                                                                               |
| Phase 3, step 4: compile and run                                   | ✅ an accepted routine compiled deterministically into an immutable AgentSpec (trigger from its first step, every later step on the catalog's capability, never in write mode) and stored as an agent in shadow; one run per trigger event after acceptance; shadow runs record which steps the routine would take, wait for the episode to close, then compare with which steps the person took, with the gap named; three that agree make it ready; Start moves it to supervised, where a trigger produces a draft and a CRM proposal through the existing jobs, each still for approval; `routine_runs` (migration 0019); a decision on a card now lifts when the thread moves; 4 + 1 unit, 3 + 4 + 1 integration, 5 drilled |
| The demo world (CONNECTOR_MODE=demo)                               | ✅ a scripted Gmail, Calendar and Salesforce in memory that answers the real adapters' requests with the real shapes, so every path runs unchanged on a machine with no credentials: eight threads, six meetings, eight deals, a routine repeated four times; writes land in it and are read back from it; "Connect Google" and "Connect Salesforce" land on our own callback with a demo code and the same exchange and storage run; the deterministic next-step reader now prefers the plainest sentence; routine steps in plain words; 4 + 1 unit, 2 integration                                                                                                                                                             |
| The web app, redesigned, and the words on it                       | ✅ one stylesheet with a token set; a top bar with the page marked; a summary strip that jumps to each section; cards with the person, a colour edge by reason, the age, tags, the sentence, the facts in one line, one primary action and a quiet "Not needed" panel; Salesforce proposals as field-by-field changes with the sentences under them; routines as a sentence, the evidence, and the steps as a flow saying what the agent would do; "Checked N minutes ago"; phone layout; every line of copy rewritten to say what happens in plain words; the judgment's sentence no longer carries a day count that goes stale; 4 unit, 1 integration                                                                         |
| Intent inferred from what the person did, held until kept          | ✅ the third kind of intent: after each sweep, the person's decisions (what they set aside and how old it was) are read for patterns; two dismissals of one person, three across an account, or three young follow-ups set aside become proposals in the person's words with the evidence beside them; a new rule, "wait N days before chasing", enforced in detection once kept; nothing applies until kept; a declined proposal is never made again; "Your agent thinks" on the page with Keep and Not true; 6 + 2 unit, 2 + 2 + 1 integration, 3 drilled                                                                                                                                                                     |
| Web UI — Inbox + Connections                                       | ✅ `apps/web` is the product; server components + server actions, identity never in the browser; admin moved under `/admin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Draft creation (`gmail.compose`, never send)                       | ✅ `gmail-draft.ts` + `voice-engine` deterministic composer + `POST /v1/me/obligations/:id/draft`; failure branch tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Real auth (WorkOS AuthKit)                                         | ✅ `apps/api/src/workos.ts` JWKS verifier + JIT-provisioning resolver; web sign-in/out via `authkit-nextjs`; 12 unit + 12 integration, 3 drilled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Scheduled sweeps (worker)                                          | ✅ `workspaceSweepWorkflow` + `listSweepTargets` inside RLS + Temporal Schedule (SKIP overlap); 5 + 4 integration, 3 drilled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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

**Real auth.** WorkOS AuthKit, because the schema (`workos_user_id`,
`workos_organization_id`), the env contract and the adapter interface were
already shaped for it, and because AuthKit is Google sign-in for a Gmail team
today and SSO for an enterprise later without a code change. The split that
matters: the WEB app signs people in and holds a sealed session cookie; the
API trusts none of that — it verifies each bearer's signature against WorkOS's
published keys (`/sso/jwks/{client_id}`) itself, then maps the identity to
our rows. The web app cannot mint a principal.

First sight of a person provisions their user, their organization and an
active membership (after WorkOS confirms the membership is active), with
insert-if-absent so three racing first requests end with one row — a test
that HOLDS all three callers at a gate until each has read "no row yet",
because the un-gated version passed even without the guard. After that, our
rows are the truth: a membership an admin suspends here stays suspended
whatever WorkOS says. The initial role maps `admin → org_admin`, everything
else `member`, and is never rewritten by a sign-in. A token with no `org_id`
is refused: nothing in this system lives outside an organization, and the
web app explains "you are not in a team yet" instead.

The "never a stub that looks wired" rule (§10) is now enforced, not stated:
`AUTH_MODE=workos` without both WorkOS credentials fails env validation in
EVERY environment, and `createAuthenticator` throws without a database. The
old `UnconfiguredWorkosVerifier` — which rejected every token while looking
configured — is gone. Resolved principals are cached 60s per process, so an
authenticated request costs one signature check; the documented consequence
is that a suspension takes up to a minute to bite.

Dev mode is unchanged in kind and better in practice: with nothing set, the
web app resolves the seeded demo member (`user_demo_alex`) through the
dev-only routes, so `pnpm demo` opens a working inbox with zero
configuration. `AUTH_MODE` is read by BOTH processes, so they cannot disagree
about how a person is identified.

Not exercised here: a live round-trip against WorkOS (no credentials on this
machine). The verifier is tested with a locally generated RSA key set and the
directory client against a scripted fetch that pins the paths and the bearer;
what remains is dashboard configuration (redirect URI `${WEB_BASE_URL}/callback`,
logout redirect `/signed-out`), documented in `.env.example`.

**Phase 1 remaining:** CRM connector (which one?), scheduled sweeps.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**129** (sync 5, worker 7, db 63, api 54) · build 5/5.

**Scheduled sweeps.** The inbox is now current without anyone pressing
"sync": a Temporal Schedule (`workspace-sweep`, every 15 minutes by default,
`WORKSPACE_SWEEP_INTERVAL_MINUTES` to change it, bounded 1..1440) starts
`workspaceSweepWorkflow`, which runs THE SAME sync job the API runs on demand
(`@maman/sync`), once per connected mailbox. Two shapes worth keeping:

- **Finding whom to sweep does not bypass RLS.** The only cross-tenant read
  is the list of active organization ids; memberships are read under each
  organization's scope and connections under each person's. A person is a
  target only if their membership is active AND their mailbox connection is
  active — a suspended member's mailbox is not swept whatever their row
  says, and a mailbox that errored drops out of the next sweep until the
  person reconnects. Two organizations, six people in six states, one test
  per exclusion.
- **A bad mailbox is an outcome, not an exception.** The job records the
  failure on the person's connection (where the UI asks them to reconnect)
  and answers with a reason; the workflow counts it and moves on to the
  next person. Only infrastructure failures retry (3×), and even those are
  caught per person so one mailbox can never stop the people after it.
  Sequential by design: a team is tens of people, and Gmail's per-user
  quotas prefer a queue to a burst.

The schedule is created on worker startup and brought up to date if it
exists, so the interval in configuration is the interval that runs.
`overlap: SKIP` — a tick arriving mid-sweep is dropped, not queued; two
sweeps of the same rows would only race each other. `catchupWindow: 1m` — a
worker down for an hour runs one sweep on return, not four. Tested against a
real Temporal dev server (`TestWorkflowEnvironment.createLocal`), not only
the time-skipping one, because schedules exist only on a real server.

One worker, one workflow entry module: `@maman/sync/workflows` re-exports
the agent-run workflow and the sweep, since Temporal bundles exactly one.

**Phase 1 remaining:** CRM connector (which one?). Then Phase 1's exit —
"a team member logs in, connects two systems, and sees a real ranked list
with zero configuration" — is reachable end to end.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**138** (sync 10, worker 11, db 63, api 54) · build 5/5.

**The CRM seam.** Everything the product needs from a CRM is one question —
is there an open deal with this person, and how big — so that is the whole
contract (`DealSource` in `connector-adapters/src/deals.ts`). Salesforce and
HubSpot will implement it against Opportunity / Deal; the sync job, the
repository and the detector never learn which one answered. The step runs
between the mailbox write and detection, asks about THIS person's contacts
only (the CRM connection is the organization's; the question is scoped to
what one person can hold), and a CRM that is down does not take the mailbox
down — the sync completes on the last known deal state and the result says
the CRM was not heard.

The mistake caught before it shipped: my first version mapped "asked, and
the CRM returned nothing" to `false`. The detector suppresses `false` as a
finished relationship — so every prospect a rep had not entered in the CRM
yet would have vanished from the list, which is most of them on most days.
Tri-state, precisely: `true` open; `false` ONLY "deals exist and all are
closed"; not returned → back to unknown (null), which also means a deal the
CRM stops reporting stops promoting. A CRM signal for an address that was
not asked is ignored — a CRM cannot introduce a contact — and an account
name from the CRM fills a blank but never overwrites one already held.

**Phase 1 remaining:** the provider adapter behind `DealSource` — Salesforce
(SOQL on Opportunity via OpportunityContactRole; org connection already
plumbed: Connected App env, `/v1/connectors`, org vault) or HubSpot (Deals
API with contact associations; provider registered, no adapter yet). One
file plus its scripted-HTTP tests, once the customer's CRM is known.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**146** (sync 13, worker 11, db 68, api 54) · build 5/5.

**Salesforce, the first CRM.** The customer said Salesforce. The adapter
(`connector-adapters/src/salesforce-deals.ts`) is READ-ONLY: one SOQL query
per 200 addresses over `OpportunityContactRole` — deals this person is on,
not deals at their company — following pagination, refreshing the token once
on 401 and never looping, escaping every address into its SOQL literal. The
credentials are the organization's connected Salesforce, so the org-level
vault provider moved from the worker into `@maman/sync`
(`createOrgVaultCredentialProvider`) where the API can share it; the worker
re-exports it under its old name. `resolveDealSource` picks the org's
connected CRM from `connector_accounts` — revoked or degraded connectors are
not consulted, and a connector we have no deal adapter for is not a source.

Proven over HTTP on a real database: the org connects Salesforce, Alice's
`/v1/me/sync` asks about HER contacts with the ORG token (a GET on the org's
instance; her Gmail token appears nowhere), Bob's contact lands as
`true / 40000.00 / Client Co` and Sarah, unknown to the CRM, stays `null` and
stays listed. Bob's own sync in the same org never asks the CRM about anyone.
Three drilled: closed opportunities counted as open, rows for strangers
accepted, resolver ignoring connector status — each fails its test.

**Phase 1 is complete.** Its exit — a team member logs in (WorkOS), connects
two systems (Gmail per person, Salesforce per org), and sees a real ranked
list with zero configuration, kept current by the sweep — is now reachable
end to end. What is NOT exercised: a live round-trip against a real Salesforce
org or a real WorkOS environment; both need credentials this machine does not
hold. The dashboard steps are in `.env.example`.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**153** (sync 18, worker 11, db 68, api 56) · build 5/5.

**The Connections page, and where a browser lands.** The demo has to be
clickable end to end, so the page now carries both kinds of connection with
their difference stated where the choice is made: **Yours** (Gmail —
connected by you, readable only by you) and **Your team's** (Salesforce —
connected once for the organization, used only to ask which of your contacts
have an open deal). Each row: provider mark (inline SVG, no external assets),
name, a status chip driven by the API's own states (`describeGmail` /
`describeCrm`, unit-tested so the words cannot drift from the states), a
one-line "what this reads", and the single right action — Connect,
Reconnect, Check now, or Disconnect. Works at phone width without a
horizontal scroll.

Two API changes fell out of making it clickable. (1) Both OAuth callbacks
used to answer JSON, which meant the browser — arriving from Google's or
Salesforce's consent screen — landed on a JSON page at the API. They now
303 to `${WEB_BASE_URL}/connections?provider=…&connected=1` or
`…&error=exchange_failed`, and the page shows a banner. The URL carries the
provider and the outcome, never a token or an id. (2) A replayed PKCE state
was tolerated — the old test accepted 200, 400 or 502 — because the
exchange simply ran without a verifier. It is now refused (`state_reused`)
before any exchange, at both callbacks, and the test asserts the refusal
and that nothing was stored.

Still true: none of this has touched a real Google, Salesforce or WorkOS;
the three sets of credentials are the next step and need no more code.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**154** (sync 18, worker 11, db 68, api 57) · build 5/5.

**The agent pass.** The direction, decided with the owner: the connectors
feed facts into one place per person, and an agent reads those facts and
decides what to write. The deterministic detector is kept, on purpose, as
the trigger and the fallback. It still runs first and finds the candidates;
the agent looks only at those.

What changed. The Gmail scope is now read-only mail rather than metadata.
Detection still reads headers only, and the database still holds no message
text. The body of a candidate thread is read at judgment time, through a
separate reader, bounded (last 8 messages, 4000 characters each, quoted
history and signatures cut), handed to the model, and dropped. What is
stored is the judgment: owed or not, the ask in a few words, one sentence
for the card, urgency, confidence. The ask is an excerpt, so the honest
wording on the Connections page is "message text is never stored", not
"never read".

The contract (`assessmentInputSchema` / `assessmentOutputSchema`) bounds
every field and refuses secret-shaped text before it can reach a model.
The output cannot add an obligation, change a deal value, or touch a
permission: it narrows (owed false hides the item while the agent is on)
and annotates. Two providers implement it. The deterministic one uses rules
(a question in the last message is the ask; "thanks, all set" or an
out-of-office means nothing is owed) so the whole path runs with no key and
sets the floor the model has to beat. The Anthropic one sends the thread
inside untrusted tags at temperature 0 and validates the JSON on the way
back.

The switch. `AGENT_MODE=off` (default) is the list exactly as before this
work; `assist` turns the pass on in both places a sync runs. A judgment is
stored per thread state, reused while the thread is unchanged, stale the
moment it moves, and never made for more than 20 candidates per sweep. A
judgment that fails, for any reason, leaves the arithmetic in charge of
that item, and the pass never throws. Reverting is the variable.

Tests. 29 unit for the contract and the rules (secret refusal, bounds, the
ask, closed loops, automated replies, a thanks with a question still owed);
6 for body extraction and the content read (plain over html, quoted history
cut, oldest first, direction from the user's own addresses, bounded; exact
GET, refresh once on 401). db: judgments stored per state, agent mode hides
not-owed and reorders by urgency within a band never across one, staleness,
isolation. sync: the pass reads each candidate once, the facts and the text
reach the model, the body is in no table afterwards, unchanged threads are
not judged again, a moved thread is judged again and only that one, model
down keeps the arithmetic list, bounded. api: assist over HTTP reads the
candidates in full and the list leads with the judgment; off is the
deterministic list and says so. Three drilled: agent mode not hiding
not-owed, re-judging unchanged threads, treating a stale judgment as fresh.

Next in this direction: the model writes the draft with the thread and the
person's own sent mail as voice, then Calendar, then pre-drafting in the
sweep.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**166** (sync 24, worker 11, db 72, api 59) · build 5/5.

**Mail content as the input.** Decided with the owner for the final product
and described in §5 ("Mail content is an input"): whole threads are synced
and stored, encrypted to the person, and the agent reads the store plus the
relationship so far. Gmail is asked directly only for a thread the store
does not hold. Unchanged threads are skipped by history id, so the full
content sync stays affordable every fifteen minutes. The Connections page
says what is true: mail is read so the agent has the full conversation,
stored encrypted to the account, visible only to the owner.

Tests. Adapters: full fetch only for changed threads, a thread with no
history id is always fetched, projected messages carry text, direction and
order. Content: round trip, refused for a colleague and for another key.
Sync: bodies stored and the plaintext in no table, opens only for the owner,
a second sync of an unchanged mailbox fetches nothing, the agent reads the
store and Gmail is not asked, the relationship reaches the model. db: store
beside the thread, replace on re-sync, history ids, relationship excludes
the current thread, voice sample is outbound and substantial, colleague
reads nothing, cascade on thread delete. Three drilled: unchanged threads
fetched anyway, the content AAD without the user, the pass ignoring the
store.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**170** (sync 25, worker 11, db 75, api 59) · build 5/5.

**Voice.** The agent writes the draft. Style comes from everything the
person has written, retrieved from the store in three shelves, most
specific first: their messages to this contact, their past follow-ups (an
outbound message whose predecessor in the thread was also theirs, which is
what a chase looks like), and a sample of their recent writing. Facts come
only from the thread and the facts we hold, and that is enforced, not
requested: `groundDraft` checks every number, sum of money, URL and
committing word (meeting, contract, discount, a weekday) against the thread,
the subject, the ask and the deal value. The person's own exemplars are
deliberately not a source, so a number from another deal cannot leak into
this one. A draft that fails grounding, or a model that fails, gives way to
the template composer and the response says why (`fallback_reason`).

Every draft is recorded (body encrypted to the person). On the next sync,
the first outbound message on that thread after the draft was made is what
the person actually sent, and the edit ratio (1 = sent as written) is
recorded. That is the product's own measure of its voice
(`draftOutcomes`), and the sent message itself becomes an exemplar for the
next draft, so the voice converges without any setting. The record of a
draft outlives the obligation row: the sweep rewrites pending obligations,
and a measurement must not vanish with them (learned the hard way; the
foreign key is SET NULL, not CASCADE).

With the agent off, the template composer writes, grounded by construction,
and signs off the way the person does.

Tests. Grounding: passes a draft whose every number, sum, day and claim is
in the thread; refuses an invented number, sum, URL, discount, meeting and
day; exemplars cannot vouch for a fact. The composer: uses the model's draft
with provenance, falls back on failure and names it, falls back on an
invented fact and names the violation. db: voice retrieval per contact and
follow-ups by predecessor, drafts recorded encrypted, matched, measured,
colleague sees nothing. sync: voice from the store, a lightly edited sent
message matched at above 0.85. api: with the agent on, the draft answers the
actual ask, is filed on the thread, recorded encrypted, and nothing is sent.
Three drilled: trusting the model without grounding, a sent message from
before the draft counting, any outbound message counting as a follow-up.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**176** (sync 27, worker 11, db 78, api 60) · build 5/5.

**Google Calendar.** Meeting context is an input everywhere, not a stamp on
one field. One Google consent now covers mail and calendar; a grant made
before the scope existed reports `no_calendar_scope` until the person
reconnects once. Meetings are synced on the same grant, read only, stored
per person with the agenda encrypted like mail, and kept current with
Google's incremental sync token (a stale token is a full window again, not
an error). Every contact carries two stamps the sync recomputes in one
statement: the last meeting with them and the next, counting a meeting only
when it is not cancelled and the person did not decline.

Where it lands. Detection: "met them, sent nothing" is counted from a real
meeting, and a meeting already booked with the person cancels a chase (a
chase on Tuesday about a call on Wednesday is noise). A reply they are
waiting on is still owed; a booked call does not answer an email. The
judgment: the last meeting (title, when, the agenda) and the next one are in
the input, and the rules say "you are meeting them Thursday; no chase
needed". The draft: a meeting is a fact, so its title and its day may be
named and an invented day is refused; the template names the meeting it
follows up. The card: "You met 2 days ago for 'Pricing review' and nothing
has gone out since", and "Meeting Thursday: Kickoff" on the fact line.

Tests. Projection (7): the other people lower-cased with names and
responses, times in UTC, what is not a meeting dropped, all-day kept, an
outside organizer counted, declines and cancellations recorded. Sync (5): a
bounded window and a token on the first sync, the token and no window after,
pages, cancellations, 410 is a full window again, refresh once on 401.
Detector (3): a booked meeting cancels a chase up to the moment it starts
and not after, a reply owed stays owed, the meeting a follow-up is counted
from is carried. Judgment and draft rules with meetings. db (3): store,
cancel, stamps with declines excluded and idempotent, listing, token,
colleague sees nothing. sync (3): stored encrypted, stamped, token kept and
sent, stale token handled, mailbox survives a calendar failure, the meeting
reaches the agent. api: the step runs on every sync. Three drilled: a
booked meeting no longer cancelling a chase, declined meetings stamping the
contact, the token never kept.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**189** (sync 30, worker 11, db 81, api 60) · build 5/5.

**The intent store, first cut.** What the person means now has a home. Two
of the three kinds of entry are live: stated (typed, in their words) and
observed (a dismissal with its reason; a draft rewritten below half). Each
is encrypted to the person, scoped by resolving names, addresses and
accounts against their own contacts (a first name counts when it names
exactly one contact; a bare address answers to its local part), and kept
with its enforceable form beside it when the sentence is a rule.

Two rules are recognised deterministically and enforced in detection, so
they hold with the agent off: "don't chase X" (in its everyday forms) and
"no more than N" (words or digits, bounded), the latter counting the
person's trailing unanswered messages on the thread (`chase_count`, kept by
the sync). A rule can only set an obligation aside; it never touches a reply
the person owes, because what they asked about was chasing. What is set
aside is stored as `skipped` with the rule that did it, rewritten by every
sweep, so forgetting the rule brings the item back on the next sync. The
Inbox shows "Set aside by what you said" with the sentence.

Everything that is not a rule is guidance: retrieved for the model most
specific first (this contact, the account, the situation, then general),
bounded, and passed as the person's own standing instructions to both the
judgment and the draft. Grounding still applies to the draft; a preference
cannot make a fact.

Not yet: inferred entries ("you wait a week before chasing Acme") held as
proposals for the person to confirm, and speech.

Tests. Engine: scope resolution (name, address, account, longest match,
unique first name, no false match inside a word), the two rules in their
forms and bounds, guidance not mistaken for a rule, rules set aside chases
in scope and never a reply owed, "no more than N" at the boundary, no rules
no change. db: entries kept as ciphertext with scope and rule, retired;
skipped stored with the rule and rewritten; a colleague sees none and
cannot retire one. sync: a stated rule sets a chase aside and says why in
the person's words, a reply owed untouched, forgetting brings it back;
"never more than twice" counts chases; guidance reaches the model most
specific first and only what bears on the contact. api: kept in the
person's words, ciphertext at rest, visible only to them, retire is 404 for
a colleague; a dismissal with a reason is written down; empty and
oversized statements refused. Three drilled.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**202** (sync 33, worker 11, db 84, api 63) · build 5/5.

**Pre-drafting, and the measure shown.** The product now does the work
before being asked. After the agent pass, the sweep writes drafts for the
top items the agent judged owed: three per person per sweep by default
(`PREDRAFT_PER_SWEEP`, 0 disables), one unsent draft per thread, never for
a person or account the owner said not to draft for ("don't write drafts
for me", a rule like the others), and after judgment, never instead of it.
A click and the sweep go through one job (`sync/draft-job.ts`), so a draft
written before being asked is built from exactly the same context as one
written on request. Still never sent.

A draft now stays attached to its pending item instead of closing it: the
card says "Draft ready" (or "Drafted", when a click made it) and opens the
draft in Gmail, and the item leaves the list when the person sends it, or
snoozes it, or says it is not needed. The earlier behaviour, where a manual
draft marked the item drafted and removed it, is gone; a draft that nobody
has sent is not a finished obligation. A Gmail refusal during the sweep is
counted and retried next sweep, never raised.

The measure is visible: "This week: N drafts, M sent, K as written" on the
Inbox, from the edit ratio the sync records. Phase 2's exit is now a number
the person and the owner both see.

One thing surfaced and left as is: the sweep rewrites pending rows, so an
obligation's id changes every sweep. The thread is the stable key. Actions
taken on a stale id answer 404 and the page re-renders. Noted for a later
pass; not a demo blocker.

Tests. Engine: "don't draft for me" in its forms, scoped, never setting a
detection aside. db: a draft rides on the list until matched, the newest
unsent wins; the week's numbers are a window. sync: drafts only what was
judged owed, once per thread, attached to the item, the next sweep writes
nothing new; the rule holds the sweep back and a cap of 0 disables it; a
Gmail refusal is counted, not raised. api: a click keeps the item pending
with the draft attached across a sync, the week's numbers count it; with
the agent on, the sync pre-drafts what it judged owed. Three drilled.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**212** (sync 37, worker 11, db 85, api 66) · build 5/5.

**Phase 3 begins: the first write to a system of record.** An email the
person sent is logged to Salesforce as a completed activity on the contact
and, when there is one, their open opportunity. The CRM hygiene reps skip,
and the safest write with real value: the agent witnessed the email, there
is nothing to judge, and it can be undone.

The safeguards from §7, each checkable on its own (`sync/src/actions.ts`):

- **Propose.** The exact write as a diff (who, subject, date; never the
  body, the CRM is shared) with its canonical hash, from evidence the agent
  witnessed (the message id and time). One live proposal per message.
- **Approve, bound to the hash.** An approval whose hash does not match the
  diff marks it stale and writes nothing. A click and a promotion both go
  through this.
- **Apply, exactly once.** Re-proposed from current facts and compared with
  what was approved (stale if different). Before creating, the ledger's
  marker (`[maman:<action id>]`, carried in the task description) is
  searched for, so a retry after an unknown result finds the task instead of
  making a second.
- **Verify, independently.** The task is read back through a separate GET
  and compared field by field; only then is the action verified. A read-back
  that disagrees is a failure, whatever the create call answered.
- **Receipt and audit.** The row in `actions` (migration 0016) is the
  receipt; an event goes on the organization's hash-chained audit log for
  every transition that touched the provider.
- **Undo.** Deletes the task and reads back that it is gone.
- **Promotion.** "Always" writes a stated intent entry in the person's words
  whose rule binds the action kind and the write's shape (kind + field
  names), so it covers this write and no other. The sweep then approves and
  applies without asking, under four independent conditions: the
  organization's policy allows the kind unattended (`orgActionPolicy`; a
  low-risk reversible kind by default, and `disabled_capabilities` forbids
  it), the person promoted it, the shape matches, and the scope matches.

Where it runs: "Log to Salesforce" on a card the person wrote last on, and
the sweep for every draft matched to a sent message. The Inbox's Salesforce
section shows proposals (Approve, Always, Not now) and outcomes ("Logged,
verified", "Not written", "Undone") with Undo.

Tests. Adapter (4): the SOQL for the contact and the open opportunity,
escaped; the task created with no field the file does not name; read back
by a separate GET, found by marker, deleted; refresh once, 5xx transient,
4xx permanent, no connector refused. Hashes (2): canonical diff, shape by
kind and field names. Rule (1): a promotion covers one kind and one shape
in scope. Flow (9, real database, scripted Salesforce): proposed with the
exact diff, never twice for one message, the body absent; a wrong hash is
stale and writes nothing; approve, apply once, verified, receipt, audit
chain valid; a retry after an unknown result finds the task by marker; a
read-back that disagrees fails; undo; a contact Salesforce does not know
fails with a reason; a promotion applied by the sweep, and the org
forbidding it; the sweep proposes for a sent draft and a colleague sees
none. API (3). Three drilled: approval no longer bound to the diff, the
create call's answer trusted without read-back, no marker lookup before a
retry. Each fails the test written for it.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 24/24 · integration
**208** (sync 46, worker 11, db 85, api 66) · build 5/5.

**Phase 3, second write: next step and close date on the opportunity
(2026-09-22).** The first write the thread has to be _read_ for. The activity
log is made of facts the sync witnessed (who, when, subject). The next step and
the close date are claims in the text, so the reading is the model's and the
checks are in code.

The reading (`model-provider/src/opportunity.ts`). The contract asks for each
field as a value plus the sentence it came from, or null when the thread says
nothing new. Grounding refuses a field whose sentence is not in the thread
verbatim, a next step that is not an excerpt of its sentence, and a close date
that differs from what the code itself reads out of the sentence ("end of
quarter" written on 2026-09-16 is 2026-09-30; a model that says 2026-11-15 for
that sentence is dropped). The deterministic reader handles the plain forms
("Next step: …", "I'll send …", "can you confirm …", "by end of quarter",
"close by Friday") so the pass works with the model off. Refused fields are
dropped one at a time; the other field still goes through.

The write (`sync/src/actions.ts`, `connector-adapters/src/salesforce-opportunity.ts`).
A second action kind, `salesforce.update_opportunity`, through the same
propose, approve-by-hash, apply, verify, receipt, undo, promote path, with what
differs:

- **Only what differs.** The record is read first; a field already holding
  what the thread says is not proposed. A closed opportunity is never touched.
- **Never over a hand edit.** At apply time the record is read again. A field
  whose current value is not the value the proposal was made against goes
  stale, writes nothing, and the action shows both values. This is the rule
  that keeps a CRM someone maintains by hand safe from an agent that read an
  old thread.
- **Field by field.** The PATCH names only the fields in the diff. The
  read-back compares each named field; a 204 from Salesforce with the field
  unchanged (a validation rule, a flow that resets it) is a failure.
- **Undo is a write of the same shape** with the previous values, read back
  the same way.
- **Medium risk.** `orgActionPolicy` allows it, but not unattended unless the
  organization lists the kind in `unattended_medium_capabilities`. "Always"
  is offered on the card only when it is; a promotion made anyway is refused.

Where it runs: "Update Salesforce" on a card whose contact has an open deal,
and the sweep after judgment, over the whole detected list rather than the
owed-only view. A deal moves in threads that owe no reply ("Thanks, next step
is the MSA, signing by end of quarter" owes nothing and says two things the
record should hold), so the candidates are the detected obligations with an
open deal, bounded per sweep, one proposal per thread state.

Tests. Reading (8): dates in each form; grounding refuses a paraphrased
quote, a non-excerpt next step, a date the sentence does not say; the
deterministic reader. Adapter (2): GET with the named fields, PATCH with only
the fields asked, nothing sent for nothing, 404 as null, 4xx permanent. Flow
(6, real database, scripted Salesforce): proposed with the two sentences and
only the changed fields, not proposed twice, no "Always" by default; a hand
edit makes the action stale and the field is untouched; approve, one PATCH
with exactly the diff, GET before and after, verified, undo restores both
values, audit chain valid; the organization allowing it unattended plus a
promotion applies without asking with `approved_by = promotion`; a record
that already holds the thread's values proposes nothing; a model that
invents a date is refused and the date never reaches the record; a write
Salesforce accepted but did not keep fails on read-back. API (1). Four
drilled: the hand-edit check removed, the read-back ignored, the grounding
violation no longer clearing the field, the adapter sending a field that was
not asked for. Each fails the test written for it.

Not exercised: a live Salesforce. The scripted one answers the same GET,
PATCH and SOQL shapes the adapter sends; field-level security and validation
rules on a real org are what the read-back and the permanent-error branch are
for.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 25/25 · integration
**215** (sync 52, worker 11, db 85, api 67) · build 5/5.

**Phase 3, step 1: the event stream (2026-09-22).** The first piece of the
general loop. Discovery needs to see what each person did, across every
source, in one shape. That shape already existed: the `WorkflowEvent`
contract the on-device observer was designed around, strict, carrying roles,
categories, hashes and counts and refusing bodies, values and raw ids by
construction. The stream reuses it unchanged, plus one new source value,
`product`, for what the person does inside the Inbox.

Derived, not observed. Every fact the sweep already stores becomes an event
in the sweep's last step (`sync/src/events.ts`), so this needs no device
software, no new consent, and can be rebuilt from nothing:

- A message is the move it was: `sent_new`, `sent_reply`, `sent_chase`, or
  the other side's `received_new`, `received_reply`, `received_more`, told
  apart by position in the thread and the direction before it.
- A meeting counts once it happened and the person was in it. Declined,
  cancelled and future meetings are not things they did.
- A write is three events: the click that approved it (only when a person
  clicked, never a promotion), the write that landed with its field names,
  and the undo. A proposal is nothing yet.
- A decision on a card (dismissed, snoozed, drafted, resolved) and a
  sentence given to the agent are product events on the item, not their
  content. The sentence stays in the intent store.

What an event carries about the record is a one-way hash salted with the
organization, so the same thread in two organizations is two different
hashes and nothing joins across them. Event ids are a function of the fact,
so deriving twice, or on two machines, yields the same event and events in
the same second keep one order. The dedupe key names the fact and the insert
does nothing on conflict: the first run is a backfill over the window (90
days), later runs derive only what moved since the last write, with an hour
of overlap.

Two layers refuse a bad event before SQL, each sufficient alone: the strict
contract parse, and the forbidden-field scan the observer already uses. One
bad event refuses the whole batch. An event naming another person is refused
in code, and RLS would refuse it again. The stream is per person; a colleague
reads none of it.

Finding for step 2, recorded in a test rather than hidden: the pattern
engine's segmentation was tuned for a screen. Episodes close after ten quiet
minutes and need three events, so most connector events, hours or days
apart, fall between episodes with the defaults. With day-wide boundaries the
same events group. Discovery over connector events will segment by record
(everything that happened around this thread, this deal, this meeting) and
by day, not by minutes of screen activity. Every event does project to a
valid feature without loss.

Tests. Derivation (7, pure): every event passes the contract and the scan;
the six message moves; meetings held versus declined, cancelled, future; the
click, the write with field names, the undo, and a promotion that is not a
click; decisions and sentences as product events; no raw id, address or
subject anywhere and a different hash per organization; the same set with
the same ids on a second derivation. Repository (4, real database): once per
fact; the whole batch refused for a contract break, a forbidden field, or
another person; facts read with thread position and previous direction and
nothing else; a colleague reads none and cannot write in. Sweep (4): off
derives nothing, on backfills everything stored including this sweep's own
writes and clicks with no address or subject in it; a second run writes
nothing until something moves, then exactly that; the stream projects to the
engine and the segmentation finding above; a colleague's stream is empty.
HTTP (2): a sync derives, the person reads their own, a colleague reads none;
`EVENT_STREAM=off` derives nothing. Four drilled: the exactly-once insert
made an upsert, the hash replaced by the raw id, the other-person check
removed, and both refusal layers removed together. Removing either refusal
layer alone does not fail the test, because the other holds; that is the
point of two.

Not exercised: a stream fed from an observer or the browser; those arrive in
Phase 4 through the same table and the same contract. Not built yet: a page
that shows the person their own stream. It comes with the proposal card,
where the events are the evidence.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 25/25 · integration
**225** (sync 56, worker 11, db 89, api 69) · build 5/5. Two integration runs
made while unit tests and a build ran alongside failed at file level (a
Postgres test container did not come up in time); the suites passed twice
when run alone, and a container leaked by the interrupted run was removed.

**Phase 3, step 2: discovery (2026-09-22).** The pattern engine, which
existed for the on-device observer, now runs over each person's event stream
in the sweep and finds the routines they have. No model anywhere in it.

What had to change for a mailbox. The engine cut episodes by minutes of
quiet on a screen and needed three events inside ten minutes. Around a
contact, a routine is hours or days long: their reply arrives in the
morning, the person answers after lunch, the deal is updated the next day.
So segmentation is now a strategy the caller chooses (`segment` on the
engine options), and `segmentByCase` groups events by the case they belong
to and closes an episode after three days of quiet on that case. The case is
the contact, carried as a salted one-way hash from the event's target into a
new `case_ref` on the feature; only a 32-hex hash may ride there, so a raw id
cannot. Events with no case are left to the time segmenter. The engine's
floors (three events, ten seconds active) are unchanged, and everything after
segmentation, clustering, scoring, the bars, the verdict, is the engine as it
was.

Two more things stood between a connector routine and eligibility, both
fixed at the source rather than by loosening a bar. The catalog knew no
capability for a mail event, so every reply scored as an unmapped UI write;
it now maps a reply the person wrote to a draft (never a send) and a reply
that arrived, or a meeting that happened, to a read. And a quarter of the
engine's ranking score is projected time, estimated from seconds of screen
activity that a connector stream does not have; discovery uses the same
ranking bar with that quarter removed (`CONNECTOR_OPPORTUNITY_THRESHOLD`,
0.40). The safety bars, similarity, feasibility and risk, are not tunable and
were not touched. The person's clicks on the agent's own proposals are left
out of the features: they are the ladder, not steps of their routine.

What is stored (`routine_candidates`, migration 0018): one row per routine
shape per person, keyed by its signature, rewritten every sweep with fresh
counts, scores and the verdict, with the person's decision on it kept
through the rewrite. "Not now" holds the shape back for the engine's
cooldown (14 days) and the row says "you said not now"; "never" holds it for
good. `GET /v1/me/routines` gives each routine in plain words: the steps as
observed, which app, what a helper could do for each, how many times on how
many days, the capabilities it would need, and every bar it misses, nearest
first. The card that offers it is step 3.

Tests. Engine (5): grouping by case across hours where the time segmenter
would have split, days of quiet as the boundary, the floors kept, the same
episodes in the same order run to run, the engine finding the routine
through the case segmenter and not through the time one, the projection
carrying only a hash. Catalog (1): the mail and meeting mappings. Stream
(1): the case is the same hash across a thread, a write and a decision about
one contact, a meeting joins each contact who was in it, never the address.
Repository (3): a routine seen again is the same row and the decision
survives; dismissed inside the cooldown and never for good; a colleague
reads none and cannot decide. Sweep (4): a routine repeated around three
contacts on different days is found, named, eligible, its steps all
automatable through real capabilities, no address in what is shown, no
click among its steps; "not now" holds it with the reason, lapses after the
cooldown, "never" holds it for good; runs in the sweep after the stream and
not with discovery off; a colleague has none. HTTP (1). Five drilled: the
decisions not passed to the engine, the case segmenter removed, the clicks
fed to the engine, the ranking bar left at the screen default, the upsert
overwriting the decision. Each fails the test written for it.

Not built: the card. Not exercised: a stream from an observer or the
browser, where the time segmenter applies.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 25/25 · integration
**233** (sync 60, worker 11, db 92, api 70) · build 5/5.

**Phase 3, step 3: the proposal card (2026-09-22).** The first time a found
routine reaches the person. A Routines section on the Inbox, one card per
routine that cleared every bar: the title, the steps as observed and in which
app, what a helper could do for each step (with approval, context only, or
stays with you), and the evidence in one line: "Seen 4 times on 4 days,
around Bob Ray, Sarah Chen and Dan Li." The names are the person's own
contacts, joined back from the case hash with the same salted function the
stream uses; nothing else about a run is shown. Routines still forming are
listed underneath with what they still need ("not seen often enough yet").

Three words, and where each lives. "Not now" is kept on the row with its
date so the engine's 14-day cooldown can count, and it stops being a decision
when the cooldown lapses. "Accepted" and "never" are entries in the intent
store, in the person's words ("Do this for me when it comes up: …", "Never
offer to take this over: …"), each carrying a rule bound to the routine's
signature (`routine_accepted`, `routine_never`). That is where the person
already reads and forgets what they told the agent, so forgetting the entry
is the undo, and nothing is kept in two places. Discovery reads "never" from
the store on every sweep. The two rules never set a chase aside or cover a
write; they are about routines and nothing else.

Accepting is the confirmed entry the plan asks for: what the agent inferred
from the person's actions becomes permanent at the moment they keep it, and
not before. A routine still forming cannot be accepted, however the request
arrives; the API answers 409.

Tests. Rules (2): the two rule shapes, never parsed from a sentence; neither
sets a chase aside nor covers a write. Lines (2): the evidence line by name
only, the forming line. Repository (3): a routine seen again keeps "not now"
and the agent link through the rewrite; "not now" counts inside the cooldown
and lapses; a colleague reads none and cannot decide. Sweep (4): the
evidence names each run's contact; "not now" holds with its reason then is
offered again; "never" is an entry in the store, forgetting it offers the
routine again; "accept" is a confirmed entry in the person's words bound to
the routine, and a forming one is refused. HTTP (1). Five drilled: "never"
entries not consulted, accept allowed on a forming routine, "not now" never
lapsing, the evidence joined with a different salt, routine rules setting
chases aside. Each fails the test written for it. One drill variant (the
old type-unsafe branch restored) passed by accident, because a missing
`max` compares false; the test guards the outcome, not that line.

Not built: what accepting leads to. That is step 4.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 25/25 · integration
**236** (sync 63, worker 11, db 92, api 70) · build 5/5.

**Phase 3, step 4: compile and run (2026-09-22).** What accepting leads to.

Compile (`sync/src/routine-spec.ts`). An accepted routine becomes an
`AgentSpec`, the contract the runtime already had, deterministically and with
no model: the routine's first step is the trigger (something arrived, a
meeting ended); every later step becomes a spec step on the capability the
catalog names for it, a reply the person wrote as a draft, a CRM change as a
proposal, a thing that arrived as a read. No step is ever compiled in
`write` mode. A write happens only through the action ladder the proposal
enters, with its own approval, read-back and receipt, or not at all. The
agent id is a function of the person and the routine, the version id of the
spec's content, so compiling twice is the same agent and the same version.
Stored through the existing `agents` and `agent_versions` tables in state
`shadow`, linked from the routine. A routine with a step no capability can do
is refused, and the card says so.

Run (`sync/src/routine-runs.ts`). After acceptance, each time the trigger
happens in the person's stream there is one run, keyed by the trigger event
(`routine_runs`, migration 0019), so a sweep never runs one twice. What a
run does depends on the agent's state:

- **Shadow.** Nothing is produced. The run records which steps the routine
  would take on that case, by capability, waits for the episode to close
  (three days of quiet, or every expected step seen), then records which
  steps the person took and compares. Agreement is over which steps
  happened, not the words or values; the routine does not know them and the
  run does not store them. A gap is named in plain words ("I proposed
  changing … but you didn't"). Three comparisons at 0.9 or better make the
  routine ready to start; the card says "Ran alongside you 4 times, agreed 3
  times. Ready to start."
- **Supervised.** Start (a click, refused until ready) moves the agent to
  supervised. A trigger then runs the steps through the jobs that already
  exist for them, on the thread the trigger named: a draft in Gmail through
  the draft job, never sent; a proposal in the Salesforce section through
  the opportunity pass, never applied without approval or a promotion the
  person made. The run records what it produced. A step with no job yet is
  recorded as not run, never faked.

Found on the way and fixed: a decision on a card ("not needed", "later")
held the thread for good, even after the other side wrote again, because
the row blocked any new detection on that thread. It now holds only while
the thread stands still; once the thread moves, the detector looks again.

What "runs alone" means from here: the proposals a supervised routine makes
carry the same "Always" the CRM writes already have, gated by the
organization's risk policy. Active state, where the routine's own writes
apply under a promotion, is that promotion; nothing new is needed for it
beyond what step 5 adds as capabilities.

Tests. Compiler (3): trigger and steps, never write mode, deterministic ids,
refusals. Comparison (1): what a shadow run proposes and what it counts as
done, on the case and inside the window only. Line (1): the runs line.
Repository (3): one run per trigger, complete only from watching once, a
colleague reads none; plus (1) the lifted decision. Sweep (4): accepting
compiled it, with a plan, and start is refused; one shadow run per trigger,
never two, compared when closed, a partial run named, three that agree make
it ready; start moves it to supervised and a sweep then produces a draft
and a CRM proposal through the existing jobs without writing anything, and
the same trigger does not run twice; a colleague cannot start it. HTTP (1).
Five drilled: a step compiled in write mode, start without readiness, the
actual events not filtered to the case, runs no longer deduped, a decision
no longer lifting. Each fails the test written for it.

Not exercised: an active routine applying its own writes; that is the
existing promotion path, exercised for the two write kinds. Not built: the
person's clicks inside the product as triggers.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 25/25 · integration
**244** (sync 67, worker 11, db 96, api 70) · build 5/5.

**The demo world (2026-09-22).** The owner asked to see the product and saw
the empty state, because no mailbox was connected and there is no Google
client on this machine to connect one. `CONNECTOR_MODE=demo` already existed
as the switch for that case; it now has something behind it for the whole
product, not only the old Salesforce fixtures.

`connector-adapters/src/demo-world.ts` is a scripted Gmail, Google Calendar
and Salesforce, in memory, that answers the same requests the real adapters
send, with the same shapes: the profile, the thread list with history ids,
full threads with bodies, drafts, events with a sync token, SOQL for deals,
contacts, opportunity roles and tasks, task create, read and delete,
opportunity read and patch. Writes land in it and are read back from it, so
the read-back checks mean something even here. The story: eight threads
(a reply owed on a deal with the next step in it, a renewal gone quiet, a
fresh intro, a discovery call with nothing sent since, and a routine
repeated four times around four contacts), six meetings held and one booked,
eight deals. Dates are relative to the first request, so it is the same age
whenever it runs. Nothing in the product is demo-only: this is the demo
implementation of the connectors, as the deterministic provider is of the
model.

In demo mode "Connect Google" and "Connect Salesforce" return our own
callback URL with a demo code, so the browser lands on the same callback
and the same exchange, envelope encryption, storage and redirect run as they
would after a real consent. The token transport answers any exchange or
refresh with demo tokens. The worker uses the same world for its sweeps.

Two things the first look showed and fixed. The deterministic next-step
reader took the first sentence that matched anything ("Can you confirm the
price holds…") over the plain "Next step: send over the MSA for legal" that
came after it; it now prefers the plainest pattern anywhere in the message.
And routine steps from the stream were phrased for a screen ("you update a
record in Gmail"); they now read as the person would say them ("they reply",
"you reply", "you meet") and the title is the sentence of them, and each step
says whether the agent would notice it or would do it with approval.

Tests. World (4): the mailbox through the real Gmail sync, the calendar
through the real calendar sync with a token on the second read, Salesforce
through the real deal source, activity writer and opportunity writer with a
task written, found by marker, read back and deleted, and a field updated in
place; a draft landing, never sent; the token exchange. Reader (1): the
explicit next step beats the earlier question. HTTP (2): demo mode connects
both providers through our own callback and one sync fills the Inbox with
judged items, drafts, a Salesforce proposal and an eligible routine; real
mode still sends the browser to the provider. The other API tests now run
against real-mode routes with their scripted transports, which is what they
always were.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 25/25 · integration
**246** (sync 67, worker 11, db 96, api 72) · build 5/5.

**The web app, redesigned, and the words on it (2026-09-23).** The owner
saw the product and said it was ugly and read as machine-written. Both were
fair. The page had a column of five equal buttons on every card, the
person's name set as a small grey label, section names in tiny capitals,
and copy that explained the mechanism instead of saying what would happen.

What changed. One stylesheet with a small token set, and every page built
from a short list of parts. A top bar with a mark and the current page
marked. A summary strip under the title (replies owed, drafts ready,
Salesforce changes to approve, routines found), each jumping to its
section, with "Checked N minutes ago" beside the button. A card is one
person and one next move: initials, the name as the title, the age on the
right, a colour edge by reason, tags, the agent's sentence, the facts in one
quiet line, one primary button and the rest light, with "Not needed" opening
a small panel for the reason instead of a permanent input on every card. A
Salesforce proposal shows the deal by name and each field before and after,
with the sentences it rests on underneath. A routine is its sentence, the
evidence line, and the steps as a flow, each step saying what the agent
would do ("your agent drafts it, you send", "your agent notices this in
Gmail"). Phone width works without horizontal scroll. The admin pages keep
their classes.

The words. Every line was rewritten to say what happens, in the words the
person would use: "They're waiting on you", "Met, nothing sent", "No reply
yet"; "Changes your agent wants to make. Nothing changes until you approve
it."; "Patterns your agent has noticed in how you work"; "Done, checked";
"Skipped, it changed since you looked". The page is called Follow-ups.

One real fix underneath: the deterministic judgment's sentence carried a
day count ("3 days ago") that went stale, because a judgment is kept until
the thread moves while the card's own clock keeps counting. The sentence no
longer carries a count; the card does.

Tests: initials, long dates, "checked … ago", the step line (web); the
structured changes on a proposal (API). Gate: lint 26/26, typecheck 26/26,
unit 25/25, integration as at the last increment plus the one assertion,
build 5/5.

**Intent inferred from what the person did, held until kept (2026-09-24).**
The plan's third kind of intent, "confirmed": what the agent infers from
actions, held as a proposal until the person sees it and keeps it. Until
now the store had stated and observed entries only.

The inference (`obligation-engine/src/infer.ts`) is deterministic and reads
the person's decisions from the last 90 days: what they set aside, snoozed,
drafted or resolved, and how old each item was when they did. Three
patterns, each named with its evidence:

- Two follow-ups set aside with one person: "Don't chase Bob Ray." ("You
  set aside 2 follow-ups with Bob Ray.")
- Three across an account from at least two people there: "Don't chase
  Client Co."
- Three threads gone quiet set aside while younger than N days, and none
  acted on that young: "Wait N days before chasing." This is a new rule,
  `chase_after_days`, enforced in detection like the others once kept: a
  thread gone quiet for fewer days than the wait is set aside, with the
  entry named, while a reply owed is never touched.

The thresholds are small on purpose. The person confirms, so a wrong guess
costs one click, and no guess costs a rule they had to type.

The lifecycle. A proposal is an intent entry with source `inferred` and
status `proposed`. It is not a rule and not guidance until kept: the rules
and the retrieval read active entries only. "Keep" moves it to active;
"Not true" retires it, and a retired rule of the same kind and scope is
never proposed again, so a declined guess stays declined. The sweep runs
the inference after judgment and drafting, before the event stream, so the
new entry is an event too. On the page, "Your agent thinks" sits above the
box where the person tells it things, each guess with its evidence and the
two buttons; a kept one joins the list below tagged "You kept this".

Tests. Engine (6): each pattern and its threshold, a reply owed never a
chase, acting on a young one cancels the waiting rule, a declined rule
never re-proposed, the waiting rule applied and scoped. Repository (2):
proposed is not active, kept once, declined retired; decisions with age and
person. Sweep (2, a fresh person): two dismissals become a proposal with the
evidence and not a rule, proposed once; kept, it is enforced on the next
detection, and a declined waiting rule is never proposed again. HTTP (1).
Three drilled: the dedupe of declined rules removed, the waiting rule not
enforced, an inference stored active instead of proposed. Each fails the
test written for it.

Gate at this point: lint 26/26 · typecheck 26/26 · unit 25/25 · integration
**251** (sync 69, worker 11, db 98, api 73) · build 5/5.

**Phase 1: foundations and first value. Done (2026-09-21).**
Monorepo, contracts, DB with RLS, real auth (WorkOS), Gmail per person and
Salesforce per organization, the deterministic detector, the ranked list with a
reason on every card, Gmail drafts (never send), the scheduled sweep, the
Connections page.
_Exit met:_ a team member logs in, connects two systems, and sees a real ranked
list with zero configuration, kept current without a button.
_Not yet done against real services:_ a live round trip with Google, Salesforce
and WorkOS. Needs the three sets of credentials; needs no more code.

**Phase 2: the agent (in progress).** The layer that makes it an agent rather
than a reminder system. Each step ships behind the switch with the arithmetic
as fallback, and each is tested in both modes.

1. _Judgment._ ✅ Reads each candidate thread, decides owed / ask / urgency
   behind a strict schema, stored per thread state. Deterministic rules with
   no key; the model when configured.
2. _Voice._ ✅ The model writes the draft from the stored thread and the
   person's own writing (to this contact, past follow-ups, recent), behind
   the switch, with the template composer as fallback. Grounding is enforced
   in code. What the person then sends is matched to the draft and the edit
   ratio recorded.
3. _Calendar._ ✅ Google Calendar, read only, same sign-in, one more scope.
   Meetings are stored and stamped on contacts, so "met them, sent nothing"
   comes from a real meeting and a booked call cancels a chase; the agent
   and the draft know what you met about.
4. _The intent store._ ✅ Storage per person; capture from stated text, from
   dismissals (with the reason), and from heavy rewrites of a draft;
   retrieval by scope; enforcement by rule where a sentence is a rule; the
   rest to the model as the person's own instructions; what was set aside
   shown with the sentence that did it; a box to tell the agent and a list to
   forget from. Inferred entries held for confirmation are built (see the
   note of 2026-09-24). Still to come: speech as a transcription step in
   front of the same box.
5. _Pre-drafting._ ✅ The sweep drafts the top items the agent judged owed,
   honouring the store, so the person opens the app and the drafts are there.
   Still never sent.
6. _Measurement._ ✅ Draft acceptance and edit distance, per person, on the
   Inbox: "This week: N drafts, M sent, K as written."

_Exit:_ the agent's draft is accepted or lightly edited more than half the
time, measured; the deterministic list still passes every test with the agent
off.

**Phase 3: routines are found, proposed and run (next).** The general
loop, on connector events first, so it needs no device software. Each step
ships behind a switch with the current product as the fallback.

1. _The event stream._ ✅ Every synced fact and every click in the product
   becomes a `WorkflowEvent` in the person's store: source, app, event type,
   record category, hashed identifiers, time. No body, no value. Backfilled
   from what is already stored, then appended by every sweep. See the note.
2. _Discovery._ ✅ `pattern-engine` over the stream per person: episodes,
   clusters, candidates, scores, eligibility bars, plain-word steps. Runs in
   the sweep. Deterministic; the model only names. Segmentation by case (the
   contact) and days of quiet, not by minutes on a screen. See the note.
3. _The proposal._ ✅ A card with the routine in plain words, the count, the
   days, and the episodes as evidence. Accept, Not now, Never. Accepting
   writes a confirmed intent entry; "Never" writes a stated one. See the note.
4. _Compile and run._ ✅ The accepted candidate compiled to an `AgentSpec`,
   shadow-run against the next real episodes and compared, then started into
   supervised runs whose drafts and proposals go through the existing action
   ladder, then "Always" where the org policy allows the risk. Receipts and
   undo as today. See the note.
5. _Capabilities as routines need them._ Stage move, send (behind a
   per-person promotion and per-message approval until promoted), Slack,
   HubSpot. Each is an adapter through the catalog with its risk and
   reversibility, never a workflow.
6. _Routine 1 through the same path._ The hand-found follow-up routine
   expressed as a spec and run by the same runtime, so there is one path.
   Its detector stays as the free trigger over every thread.

_Exit:_ a person who never configured anything is offered a routine the
agent found in their own connector events, accepts it, sees it shadow-run
against what they did, approves it, and then it runs alone with a receipt
and a one-click undo. The follow-up routine still passes every test with
discovery off.

**Phase 4: observation widens the stream.** The Chrome extension for
LinkedIn and the long tail, then the macOS agent (accessibility API only, no
network, CI-scanned), then Teach Mode with its UI in the same change, all
emitting the same event contract into the same discovery. Self-observation
suppression from the first commit. Admin: aggregates only, minimum cohort.
_Exit:_ a person does a routine once in an app with no API, is offered it,
approves it, and it runs.

**Phase 5: earned autonomy.** Unattended allowlist, plan-shape binding, org
policy gate, value-priced operational routines (the gifting anchor).

**The demo is a slice of the final build, never a separate build.** Nothing is
written for the demo that the final product would not keep. Where a piece is
not ready, the switch is off and the fallback is what ships; there are no
demo-only branches.

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

**Standing rules from the owner (2026-09-21)**

19. This is the final product. No demo-only shortcuts; anything not ready sits
    behind a switch with a tested fallback.
20. Every piece of the agent ships beside the deterministic path, and the
    deterministic path stays tested with the agent off, so reverting is a
    variable, never a rewrite.
21. Plain language everywhere a person reads it: product copy, commit
    messages, this plan. Short sentences. No em dashes.
22. Do not commit. Report the files and what changed; the owner commits.
23. **No more hand-written routines (2026-09-22).** The product finds the
    routines each person has and runs them up the ladder. New work adds a
    source, a capability, or discovery. The follow-up lane is routine 1 and
    the demo; it is not the shape of what comes next.
