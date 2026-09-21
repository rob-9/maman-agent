# PROACTIVE_AGENT_PLAN

Implementation plan: from the current build to a Chrome agent that detects repeated
work, proposes an automation proactively when its trigger fires, and — once the
person approves that automation — performs it on every subsequent firing without
asking again.

Written 2026-09-21. Every claim below is either measured on this machine's live
store or cited to a file in this repository. Where something is unverified it
says so.

---

## 1. The objective, stated precisely

> Across **any** site in Chrome: detect repeated workflows → propose the
> automation proactively when the trigger fires → on the person's approval,
> perform it **on every subsequent firing** without re-asking.

Decomposed into properties the system must have:

| #   | Property                                         | Status today                                                                |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| P1  | Observes work across all Chrome sites            | **Yes** (native AX lane)                                                    |
| P2  | Detects repeated workflows from that observation | Partially — see §3                                                          |
| P3  | Proposes proactively when a trigger fires        | Yes, but trigger is too coarse (§3.4)                                       |
| P4  | A human approves the automation once             | Mechanism exists (`approved_runs`, mesh lifecycle) but is unwired           |
| P5  | Subsequent firings execute without re-asking     | **No** — blocked in three places (§3.5)                                     |
| P6  | The write actually lands and is provably correct | **No** — cannot prove a commit (§3.6)                                       |
| P7  | Useful before weeks of data accumulate           | Partially — pack templates exist, but 87% of events are unclassified (§3.3) |

---

## 2. Measured baseline

Taken from `~/Library/Application Support/com.maman.desktop/maman-local.sqlite`
on 2026-09-21, after ~20 minutes of ordinary use.

| Signal                 | Value                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Events                 | 196                                                                                                 |
| Source                 | **100% `macos_ax`** (native lane; no extension installed)                                           |
| Work event types       | `value_committed` 118, `element_focused` 71                                                         |
| Context event types    | `app_activated` 5                                                                                   |
| **Never observed**     | `element_activated`, `navigation`, `record_opened`, `table_read`, `copy_semantic`, `paste_semantic` |
| App categories         | `browser` 138, `spreadsheet` 53, `other` 3                                                          |
| L1 pack classification | **171/196 unclassified (87%)**; 25 → `finops/gl_entry`                                              |
| Episodes               | 0                                                                                                   |
| Pattern candidates     | 0                                                                                                   |
| Action traces          | 3                                                                                                   |
| Encryption             | Verified — `salesforce`, `google`, `http`, `Phone`, `gmail` all absent from the raw file            |
| Learning eligibility   | 196/196 (`internal`, not excluded, not quarantined)                                                 |

Zero episodes and candidates is expected at this volume: `MIN_EPISODE_EVENTS` /
`MIN_EPISODE_ACTIVE_MS` gate episodes, and `DEFAULT_ELIGIBILITY` in
`packages/pattern-engine/src/scoring.ts` requires `min_occurrences: 3` **and**
`min_distinct_days: 2`.

### Eligibility bars (`scoring.ts`)

| Bar                            | Value | Tunable?        |
| ------------------------------ | ----- | --------------- |
| `min_occurrences`              | 3     | yes             |
| `min_distinct_days`            | 2     | yes             |
| `min_projected_minutes_weekly` | 20    | yes             |
| `min_similarity_mean`          | 0.82  | **no — safety** |
| `min_feasibility`              | 0.6   | **no — safety** |
| `max_risk`                     | 0.7   | **no — safety** |

---

## 3. Gap analysis

### 3.1 The native lane cannot observe clicks — CRITICAL

Zero `element_activated` events in 196. The Swift observer subscribes only to
focus-changed, window-changed, and value-changed notifications
(`native/macos-observer/Sources/MamanObserver/main.swift`). **No click
notification exists anywhere in it.**

Presses are _inferred_ when a button receives AX focus ("record a focused
button/link as the press it was"). A mouse click on a web button commonly does
**not** move AX focus.

**Consequence:** a trace records the field edits but not the Save click, so a
compiled agent fills the form and never submits — and reports success on the
fields it did write. Fatal for P5, and silent.

**Not fixable inside the invariants.** The only reliable AX-free mechanism is a
`CGEventTap`, which `scripts/scan-observer-no-network.sh` explicitly greps for
and fails the build on. That ban is correct and stays.

**This supersedes the earlier assumption** that the fix was filling
`browser/element_activated → browser.press_control` in the capability table.
That event type is never produced on this lane, so the mapping would change
nothing.

### 3.2 Feasibility is NOT the blocker (revised)

Both emitted work types are already mapped in
`packages/capability-catalog/src/metadata.ts`:

| Token                         | Capability                                                  |
| ----------------------------- | ----------------------------------------------------------- |
| `browser/element_focused`     | `browser.extract_structured_fields`                         |
| `browser/value_committed`     | `browser.propose_form_fill`, `browser.supervised_form_fill` |
| `spreadsheet/element_focused` | `google_sheets.read_range`                                  |
| `spreadsheet/value_committed` | `local.transform_columns`                                   |

Only `app_activated` is unmapped, and deliberately so (context, not work). At
the observed ratio, feasibility lands around **0.89** — comfortably over the 0.6
bar. Filling more table entries is not the priority it appeared to be from
reading code alone.

`browser/table_read → browser.extract_table` remains mapped-but-**unregistered**
(`packages/agent-runtime/src/browser-adapters.ts`, with a documented rationale
about unbounded page reads). Irrelevant while `table_read` is never emitted.

### 3.3 87% of events carry no semantic classification

L2 pack templates — the cold-start path, and the only route to P7 — require
domain-typed steps (`domain_object` / `domain_action`). 171 of 196 events have
none.

Two caveats before acting on this number:

- It was measured on **AX-only data**, the poorest available signal:
  `app_category` is always `browser`, labels are AX titles, no DOM structure.
- The 25 that _did_ classify became `finops/gl_entry`. If the work was not
  finance, that is a false positive from loose `label_patterns` — its own
  problem, since a wrong category files a demonstration under the wrong domain.

Only two packs ship (`domain/packs/revops.yaml`, `finops.yaml`), six workflows
each, with `min_reps_with_template` of 2–3.

### 3.4 Every unrecognised site collapses into one bucket

`canonicalToken` (`packages/pattern-engine/src/segmentation.ts:51`) is:

```
source : app_category : event_type : target_role : semantic_type : object_type
```

No host. `clusterEpisodes` compares only these token strings. `DOMAIN_CATEGORIES`
(`apps/desktop/src-tauri/src/store.rs:1656`) contains **9 hosts**; every other
site falls to `browser`. Two different SaaS apps are indistinguishable to the
clusterer — visible in the baseline as 138 undifferentiated `browser` events.

### 3.5 The trigger is far too coarse for unattended execution

`agentTriggerSchema.context` (`packages/contracts/src/agent-spec.ts:53`):

```
{ app_category, object_type?, origin?, cooldown_seconds }
```

Matching (`packages/agent-runtime/src/local-runtime.ts:246-273`): exact host if
`origin` is present, else `app_category`; plus optional `object_type`; plus
cooldown (default 300s).

That means **"the user is on this site again"**, not "this workflow's situation
has recurred". Under supervised runs a false fire costs a declined card. Under
P5, **every false fire is a write**.

The raw material exists but is not promoted: `preconditions`
(`packages/contracts/src/action-trace.ts:142`) already carries `origin`,
`path_template` (`"/leads/:id"` — shape, never the identifier),
`focused_window_title_hash`, `expect_current_ref`, `requires_foreground`,
`requires_user_presence`. And `expectedEffect.readback` already specifies how to
confirm independently.

Constraint on any fix: `workflowContextSchema` is deliberately minimal —
_"subscribing to context can never become a side-channel to content."_ Any new
precondition must be expressible in redacted form (path shape, label hash).

### 3.6 Writes cannot be proven to have committed

Two verification layers, unequal:

**Layer A — `packages/browser-actuator/src/verify.ts`.** For `set_value` it
compares `action.value` against `result.observed.value_after`, which comes from
`readValue(element)` called **synchronously inside `applyAction`, same tick,
immediately after `setNativeValue`**. It reads back the property it just
assigned. It cannot see a revert. (For `click_control` it correctly refuses to
self-certify and returns `requires_independent_read`.)

**Layer B — `packages/agent-runtime/src/browser-adapters.ts:492`.** A fresh
`read_field` dispatch per changed field — genuinely independent _of the
executor_. But it runs immediately after `write` returns
(`run-engine.ts:132-137`, no settle) and re-reads **the same live DOM in the
same page state**. It never reloads and never consults another channel.

| Failure mode                         | Caught?                     |
| ------------------------------------ | --------------------------- |
| Control in native shadow DOM         | ✅ refused up front (safe)  |
| Framework reverts **synchronously**  | ✅ Layer B                  |
| Framework reverts **asynchronously** | ⚠️ race, usually missed     |
| Value in DOM, Save never clicked     | ❌ reports `verified: true` |
| Save clicked, server rejects         | ❌ reports `verified: true` |
| Never persisted, gone on reload      | ❌ nothing reloads          |

"Independent read-back" means independent **of the executor**, not **of the
page**. A DOM value is not a commit.

Related: `collectControls` (`extensions/chrome/src/lib/dom-adapter.ts:276`) is a
single flat `doc.querySelectorAll` — no shadow-root recursion, no iframe
descent. And dispatched events default to `composed: false`.

### 3.7 The extension observes its own writes — feedback loop

`extensions/chrome/src/content.ts:136-143` listens for `change` at document
level, capture phase. `dom-adapter.ts` `setNativeValue` dispatches exactly that,
and `click_control` calls `element.click()`. **No `isTrusted` check, no
suppression flag.**

Agent writes → content script records `value_committed` → ingested → feeds the
pattern engine _and_ trigger evaluation.

The Swift lane already solved this (`BrowserActor` suppresses self-observation
while acting). The extension lane never got the equivalent. Bounded under
supervised runs; a runaway under P5, and it silently corrupts the pattern data
driving the suggestions.

### 3.8 Autonomy is blocked in three independent places

1. `browser.press_control` and `browser.supervised_form_fill` are `risk: "high"`,
   `reversible: false` (`capability-catalog/src/metadata.ts:158-170`), so
   `approvalRequirement` (`policy-engine/src/risk.ts:105`) returns `"always"`
   with the comment _"may NEVER become unattended in v1"_.
2. `authorizeIssue` (`browser-actuator/src/authorize.ts:82-86`) requires
   `approvalGranted` for **every** browser write in **every** mode, `active`
   included. There is no autonomous branch.
3. The extension independently refuses `user_absent` for writes.

Plus: `draft_autonomy` — the product's existing autonomy knob — grants an
automatic **shadow** run, never a write (`agentService.ts:324`). The UI says
_"Material writes still require your approval, always."_

**The architecture already models what is wanted.** `mesh-lifecycle.ts:24-88`
has `supervised → approved → autonomous`, human-gated, requiring
`org_policy_allows_autonomy`, with `shadow_agreement` marked _"informative only;
can never substitute approval"_. And `approvalRequirement` returns `"none"` for
capabilities listed in `unattended_medium_capabilities` (already in `OrgPolicy`,
default `[]`). This is a **wiring** problem, not a policy fight.

### 3.9 Approval is bound to a diff hash, which cannot persist across runs

`runApproved` re-proposes fresh and requires the hash to match, else
`aborted_stale`. Correct for supervised runs, and unusable for P5 — every
autonomous run writes different values to different records, so there is no
stable hash.

### 3.10 Orphaned infrastructure that this plan needs

| Component                             | Location                              | Consumers             |
| ------------------------------------- | ------------------------------------- | --------------------- |
| `@maman/capability-router` (21 tests) | `packages/capability-router/`         | **zero**              |
| `@maman/workflow-graph` (13 tests)    | `packages/workflow-graph/`            | **zero**              |
| mesh lifecycle                        | `agent-runtime/src/mesh-lifecycle.ts` | **zero**              |
| shadow comparison engine              | `agent-runtime/src/shadow.ts`         | **zero**              |
| 7 mesh tables (migration 0005)        | `packages/db/migrations/`             | **zero reads/writes** |

`capability-router` already emits `verification: "independent_read"` for
consequential writes (`router.ts:151`) — the exact mechanism §3.6 needs.
`shadow.ts` already implements N-successful-comparisons-before-promotion — the
exact gate §3.8 needs.

### 3.11 UI describes a filter that is not applied

`bundlesForDomains` (`apps/desktop/src/state/settings.ts:223`) ignores _which_
domains were picked:

```js
if (domains.length === 0) return [...new Set(existing)];
return [...new Set([...existing, ...BROWSER_BUNDLE_IDS])];
```

Picking one site and picking all eight are identical. The Swift observer parses
`allowlist_domains` and never reads it; the Rust `gate_event` domain check is
wrapped in `source == "chrome"`, which only matches extension-relayed events.

Onboarding asks the user to choose sites and Privacy reports "N apps allowed",
while on the default lane the choice narrows nothing. Not a leak — hard-deny,
private apps, incognito and secure fields all hold — but CLAUDE.md requires
user-facing copy to match behaviour.

---

## 4. Decisions taken

### D1 — The Chrome extension is the execution lane. Native AX stays for observation.

The native lane has **two** defects and extending the observer addresses at most
one: it cannot see clicks (§3.1) **and** its `set_value` bypasses page JS
handlers so framework fields silently revert (open item #8). Solving observation
by inference would still leave the write broken.

The extension solves both, and additionally sees richer DOM semantics (helping
§3.3) and can narrow `app_category` beyond `browser`.

```
Native AX  = observation breadth (all apps, zero install, works day one)
Extension  = the Chrome execution lane (clicks, reliable writes, richer semantics)
```

Chrome-only is not a limitation — the objective is Chrome-specific. Distribution
is largely built: stable pinned extension id, desktop writes the native-messaging
manifest itself, pairing UI exists in Privacy & access. Missing: a Web Store
listing.

### D2 — Jev (or any classifier) goes at L1, after the extension lands.

`classifyEvent` returns a `Classification`; the store already has a
`classifier_confidence REAL` column; there is precedent for confidence floors
(`DATE_CONFIDENCE_FLOOR`, `VISION_CONFIDENCE_FLOOR`). A typed-output-with-
probability model is a drop-in at this seam.

But the 87% was measured on AX-only data. Land the extension, **re-measure**,
then decide. Do not pay a model to compensate for a signal problem already being
fixed.

When it lands: **batch per episode, not per event** (~5,000 events/workday would
otherwise put a network call in the observation hot path, which today has none),
and constrain the output **by shape** — fields for `domain_object`,
`domain_action`, `confidence` and _nowhere to put_ eligibility, risk, permissions
or value, mirroring `visionActionSchema`. Own `eventSource` for provenance.

### D3 — Keep the presence gate under autonomy.

A context trigger fires because the user just acted on that page, so
`userPresent` is naturally true. Keeping it costs nothing and preserves a real
safety property. Only _scheduled_ autonomy would need it relaxed — out of scope.

### D4 — Add a narrow reversible capability rather than reclassifying.

`browser.supervised_form_fill` and `browser.press_control` genuinely are
irreversible. Introduce `browser.set_field_bounded` (`reversible: true`, scoped
to approved origin+field pairs) and put _that_ on
`unattended_medium_capabilities`. Do not make the catalog assert something false.

---

## 5. The plan

### Phase 0 — Unblock the gate (½ day)

| #   | Task                                                                                                                                          | Why                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1 | Pin the Temporal test server to 1.25.2 in `agent-run.test.ts`, `chaos-restart.test.ts`, `real-connector.test.ts`, api `agent-run-e2e.test.ts` | 8 integration tests fail today. `package.json` declares `^1.11.5`, lockfile resolved 1.20.3, and `TestWorkflowEnvironment` downloads the _latest_ server (currently 1.32.0). Time-dependent, not code-dependent.                                                                           |
| 0.2 | Install Node 24 + add `.node-version`                                                                                                         | CI pins 24; local is 26. `ssh2`'s native binding already fails to build on 26.                                                                                                                                                                                                             |
| 0.3 | Fix `docker-compose.yml` MinIO image                                                                                                          | `minio/minio:latest` is no longer pullable; `pnpm demo` and `pnpm infra:up` are broken. Use a pinned tag on the live mirror.                                                                                                                                                               |
| 0.4 | Fix three silently-failing scripts                                                                                                            | `test-rust.sh:15` (`source` of missing file aborts under bash 3.2 despite `\|\| true`); `build-observer.sh` (`set -e -o pipefail` makes its own fallback unreachable); `dev-codesign.sh` (Homebrew OpenSSL 3 writes PKCS12 macOS cannot import — pin `/usr/bin/openssl` or add `-legacy`). |

**Exit:** `pnpm lint / typecheck / test / build` and both native suites green.

---

### Phase 1 — Prove the loop can close (3–5 days)

**1.1 — The click experiment.** Snapshot the event count; in Chrome, type into a
field (known to work), then **click a button with the mouse** (not tab+Enter);
diff the count and type mix.

- If clicks produce nothing → §3.1 confirmed → the extension becomes mandatory
  for P5, exactly as D1 assumes.
- If a press _is_ inferred → record how reliably; it may still be too lossy.

**1.2 — Install and pair the extension.** Load unpacked, pair via Privacy &
access, enable the target domains. Confirm `source: "chrome"` events appear
alongside `macos_ax`.

**1.3 — Suppress self-observation in the extension.** Actuation-in-progress flag
in the content script, plus ignore `!event.isTrusted`. Sequence-number
correlation so a late echo is still attributable.
_Test:_ run an agent 50× against a test page; assert **zero** new events
attributable to its own actions.

**1.4 — Ineligibility report.** For every rejected candidate: which bar, and by
how much. Surface through the existing `verification_report` /
`observation_stats` commands.
_Rationale:_ 0 candidates exist today. This is what turns day-3 data into a
decision instead of another guess — and the earlier failure it prevents is
recorded in the codebase (_438 episodes, 58 candidates, zero eligible, with no
surface anywhere saying why_).

**1.5 — Host in the token** for `app_category === "browser"` only. Preserves
cross-app merging for known categories; stops §3.4 compounding as data grows.

**Exit:** a trace containing a Save press; an agent run producing zero
self-observations; a report that explains every rejection.

---

### Phase 2 — Fire on real work (1 week, data-gated)

**2.1** Accumulate 3–5 days of ordinary use with `observe_all_apps` on.
`min_distinct_days: 2` is a hard floor.

**2.2** Read the report. Fix whichever bar actually dominates. **Do not
pre-commit** — that is the entire purpose of 1.4.

**2.3** Re-measure the unclassified rate now that the extension supplies DOM
semantics. Decide on D2 with a real number.

**2.4** If classification is still the binding constraint: write more packs
(~160 lines of YAML each, with `packs:check` / `packs:conformance` already
built), and/or land the L1 classifier per D2.

**2.5** Consider `min_reps_with_template: 1` for read-only / propose-only pack
workflows. Keep 2–3 for write-heavy ones.

**Exit:** candidates appear from real work; suggestions render on Home with
honest evidence.

---

### Phase 3 — Make the write trustworthy (1 week; needs a live org)

**3.1** Un-orphan `capability-router`; route consequential browser writes through
its `verification: "independent_read"` decision.

**3.2** Verification hierarchy:
(a) API read (`salesforce.get_record`) where a connector is linked;
(b) else `expectedEffect.readback` with a bounded settle + re-read;
(c) else report **unverified** — never `verified: true` by default.

**3.3** Shadow-DOM recursion in `collectControls`; `composed: true` on dispatched
events.

**3.4** Settle/retry between `write` and `verify` in `run-engine.ts`.

**3.5** **One real write, end to end, surviving a page reload.** There is
currently zero evidence of this in the repo on either lane.

**Exit:** a deliberately-failed write (validation error) reports
`verified: false`.

---

### Phase 4 — Precise triggers (1 week)

**4.1** Extend `agentTriggerSchema.context` with `preconditions` mirroring the
trace's: `path_template`, `object_state` (e.g. _target field empty_),
`expect_current_ref`, `requires_foreground`.

**4.2** Extend `workflowContextSchema` correspondingly — **redacted forms only**
(§3.5).

**4.3** Compile preconditions from the representative trace (already captured).

**4.4** Evaluate in **both** evaluators — TS `handleContext` and Rust
`trigger_service.rs`. They must agree; divergence is how the "impossible
category equality" bug happened.

**4.5** A failed precondition means **no fire**, not fire-then-refuse.

**Exit:** visiting the origin with no matching record fires nothing; visiting a
record already in the target state fires nothing.

---

### Phase 5 — Standing approval (1–2 weeks)

**5.1 — Plan-shape hash** replaces the diff hash for autonomous runs: hash spec
version + step sequence + resolved control identities (origin, role+name per
target). Drift in _what is touched_ aborts; variation in _values written_ does
not.

**5.2 — Refuse `source: "user"` inputs in autonomous runs, structurally.** The
codebase already made this call for answers: _"An answer given once is not a
standing instruction to write that value every time."_ Autonomous values must
come from `from_step` / discovered bindings, derived fresh each run.

**5.3 — Approval envelope** persisted alongside `browser_actuation_origins`:
origin + field set + max records/run + plan-shape hash.

**5.4** Keep `expect_current` per field.

**Exit:** a run that would touch a field outside the envelope aborts before any
write.

---

### Phase 6 — The autonomy gate (3–5 days)

**6.1** Add `browser.set_field_bounded` per D4.

**6.2** Put it on `unattended_medium_capabilities`; `approvalRequirement` then
returns `"none"` with no change to that function.

**6.3** Add a **fourth branch** to `authorizeIssue` — not a bypass:
`mode === "active"` **and** envelope grant **and** capability unattended-listed
**and** plan-shape hash matches. Keep `userPresent` (D3).

**6.4** Wire `evaluateMeshTransition` — `approved → autonomous`, human-gated,
org-policy-gated, using the existing `autonomy_min_approved_runs` meter
(default 5) and `shadow.ts`'s N-success comparison as the recommendation signal.

**6.5** Receipt + one-click revert (`revertBrowserRun`) on every autonomous run,
with a visible notification. The human review that used to catch errors is gone.

**6.6** Amend CLAUDE.md **in the same change**, naming what the invariant used to
say and why it changed — following the Teach Mode precedent already in that file.

**Exit:** autonomy cannot be reached by any system actor; revoking it stops the
next run.

---

## 6. Situation matrix

| Situation                                            | Required behaviour                                    | Phase              |
| ---------------------------------------------------- | ----------------------------------------------------- | ------------------ |
| Multiple tabs on the granted origin                  | Frontmost only; never opens a tab                     | ✅ exists          |
| Right origin, **wrong record**                       | `path_template` + object_state → no fire              | 4                  |
| Record already in target state                       | No fire (not fire-then-no-op)                         | 4                  |
| Page still loading                                   | Settle, else `could_not_look`                         | 3.4                |
| User typing in the target field                      | `requires_foreground` + `expect_current` abort        | 4, 5.4             |
| Two agents match one context                         | Deterministic order; one run at a time per origin     | **new**            |
| Firing while a run is in flight                      | Queue or drop — never concurrent writes to one origin | **new**            |
| **Agent's own write re-triggers it**                 | Suppression                                           | **1.3**            |
| Incognito on granted origin                          | Refuse                                                | ✅ exists          |
| Origin revoked after approval                        | Registry rebuild bites next run                       | ✅ exists          |
| Site redesign → control missing                      | `no_match` → refuse                                   | ✅ exists          |
| **Site redesign → control renamed, another matches** | Plan-shape hash mismatch → abort                      | **5.1**            |
| Ambiguous control names                              | Refuse, never first-hit                               | ✅ exists          |
| Secure field where a normal one was                  | Refuse whole action                                   | ✅ exists          |
| Value already correct                                | No-op; receipt says so                                | **new**            |
| Save validation error                                | `verified: false` + notify                            | **3**              |
| Async server rejection                               | Verified via API read                                 | **3.2a**           |
| Network / browser close / sleep mid-run              | Fail closed, no partial                               | ✅ two-pass exists |
| Extension unpaired mid-run                           | Refuse, surface                                       | ✅ exists          |
| Autonomy revoked with a run staged                   | Staged run re-gated                                   | **6.4**            |
| Different org/tenant, same SaaS                      | Exact origin → no fire                                | ✅ exists          |
| Cooldown expired mid-workflow                        | Preconditions gate it                                 | **4**              |

Six genuinely new items; the rest already hold.

---

## 7. Sequencing and effort

```
Phase 0  ½ day      unblock the gate
Phase 1  3–5 days   prove the loop can close        ← click test is the fork
Phase 2  1 week     fire on real work               ← data-gated, runs in parallel
Phase 3  1 week     trustworthy writes              ← needs a live Salesforce org
Phase 4  1 week     precise triggers
Phase 5  1–2 weeks  standing approval
Phase 6  3–5 days   the autonomy gate
```

**Roughly 5–6 weeks** with real testing.

**Phases 1–3 are prerequisites, not preamble.** Doing 4–6 first yields an agent
that autonomously writes on a coarse trigger, cannot prove the write landed, and
retrains itself on its own output — the worst available version.

Phase 2 is wall-clock-bound, so start observing now and let it run while
Phases 0–1 proceed.

---

## 8. Risks and open questions

| Risk                                          | Impact                                         | Mitigation                                                 |
| --------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| Clicks unobservable on **both** lanes         | P5 impossible without a redesign               | Phase 1.1 settles it in minutes                            |
| Extension adoption friction                   | Users never reach the execution lane           | Pairing UI exists; Web Store listing is the remaining work |
| 87% unclassified persists after the extension | Cold start (P7) stays weak                     | D2 — re-measure, then a classifier at L1                   |
| Framework fields revert despite the extension | Writes silently no-op                          | Phase 3.5 proves it on a real org                          |
| Salesforce native shadow DOM                  | Controls invisible to the adapter              | Phase 3.3; failure mode is a safe refusal                  |
| Plan-shape hash too strict                    | Agents break on trivial UI churn               | Tune what enters the hash; start strict                    |
| Plan-shape hash too loose                     | An autonomous write lands on the wrong control | Keep `confirm_name` + `expect_current` underneath          |

**Unverified claims in this document:**

- Whether a mouse click is ever inferred as a press on the native lane (Phase 1.1).
- Whether Salesforce Lightning controls are reachable via light-DOM
  `querySelectorAll` on the target org (synthetic vs native shadow varies by
  component and release).
- Whether a real write commits and survives a reload — **no evidence of this
  exists anywhere in the repo on either lane**.

---

## 9. Out of scope

Deliberately excluded; none is required for the objective.

- WorkOS authentication (`UnconfiguredWorkosVerifier` rejects everything; there
  is no login anywhere).
- Worker persistence (`PersistenceSink` is four `console.warn` calls; `run_steps`
  and `approvals` are never written).
- The admin console (read-only counters against a hardcoded seeded org).
- Gmail / Calendar / Slack / HubSpot adapters (OAuth registered, no
  implementations).
- Teach Mode UI (the vertical is built; its screen was removed in the
  three-surface simplification and `useTeach` has no consumer outside tests).
- Scheduled triggers (carried in the schema; nothing ticks them).
- Notarisation and code signing for distribution.

---

## 10. Verification commands

```bash
# Gate
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build
bash scripts/test-swift.sh && bash scripts/test-rust.sh
bash scripts/scan-observer-no-network.sh

# Integration (needs Docker; DOCKER_HOST passthrough is in turbo.json)
docker compose up -d --wait postgres redis temporal temporal-ui mailpit
pnpm db:migrate && pnpm test:integration

# Live observation state
cd ~/Library/Application\ Support/com.maman.desktop
sqlite3 maman-local.sqlite \
  "select app_category, event_type, count(*) from workflow_events group by 1,2 order by 3 desc;"
sqlite3 maman-local.sqlite \
  "select coalesce(pack_domain,'(none)'), count(*) from workflow_events group by 1;"
sqlite3 maman-local.sqlite \
  "select (select count(*) from workflow_episodes), (select count(*) from pattern_candidates);"
```
