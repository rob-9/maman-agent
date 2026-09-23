import Link from "next/link";
import {
  draftsLine,
  explain,
  formingLine,
  gmailDraftUrl,
  me,
  nextMeetingLine,
  routineEvidenceLine,
  routineRunsLine,
} from "@/lib/me";
import {
  alwaysActionAction,
  approveActionAction,
  declineActionAction,
  dismissAction,
  draftAction,
  forgetIntentAction,
  proposeCrmUpdateAction,
  proposeLogAction,
  revertActionAction,
  snoozeAction,
  stateIntentAction,
  syncAction,
  decideRoutineAction,
  startRoutineAction,
} from "@/lib/actions";

export const dynamic = "force-dynamic";

const KIND_LABEL = {
  awaiting_you: "Owed a reply",
  unsent_followup: "No follow-up",
  awaiting_them: "Gone quiet",
} as const;

export default async function InboxPage() {
  const [obligations, connections, intents, actions, routines] = await Promise.all([
    me.obligations(),
    me.connections(),
    me.intents(),
    me.actions(),
    me.routines(),
  ]);

  if (!connections.ok || !obligations.ok) {
    return (
      <div className="card">
        <h3>Not connected to the API</h3>
        <p className="muted">
          The API is not reachable (
          {!connections.ok ? connections.status : obligations.ok ? "" : obligations.status}). Start
          it with <code>pnpm --filter @maman/api dev</code>.
        </p>
      </div>
    );
  }

  if (connections.data.connections.length === 0) {
    return (
      <div className="card">
        <h3>Nothing to read yet</h3>
        <p className="muted">
          Connect your mailbox to see the people you are about to drop, ranked, with the reason on
          every card. Nothing to set up.
        </p>
        <Link className="button" href="/connections">
          Connect Google
        </Link>
      </div>
    );
  }

  const items = obligations.data.obligations;
  const skipped = obligations.data.skipped;
  const agentMode = obligations.data.agent_mode;
  const known = intents.ok ? intents.data.intents : [];
  const week = draftsLine(obligations.data.drafts_this_week);
  const crm = actions.ok ? actions.data.actions : [];
  const proposals = crm.filter((a) => a.status === "proposed");
  const done = crm.filter((a) => a.status !== "proposed" && a.status !== "declined").slice(0, 8);
  const ready = items.filter((o) => o.draft !== null).length;
  const found = routines.ok ? routines.data.routines : [];
  const offered = found.filter((r) => r.status === "eligible" && r.decision !== "never");
  const forming = found.filter(
    (r) => r.status === "candidate" && r.decision === null && r.why_not.length > 0,
  );
  return (
    <>
      <div className="row">
        <div>
          <h1>Who you&apos;re about to drop</h1>
          <p className="muted">
            {items.length === 0
              ? "Nothing pending. You're caught up."
              : `${items.length} ${items.length === 1 ? "thread" : "threads"}, most urgent first.` +
                (ready > 0 ? ` ${ready} ${ready === 1 ? "draft" : "drafts"} ready in Gmail.` : "")}
          </p>
          {week ? <p className="fine">{week}</p> : null}
        </div>
        <form action={syncAction}>
          <button className="button secondary" type="submit">
            Check now
          </button>
        </form>
      </div>

      <div className="stack">
        {items.map((o) => {
          const why = explain(o, agentMode);
          return (
            <div className="card item" key={o.id}>
              <div className="item-main">
                <span className={`pill ${o.kind}`}>{KIND_LABEL[o.kind]}</span>
                {why.source === "agent" && o.assessment?.urgency === "high" ? (
                  <span className="pill urgent">Urgent</span>
                ) : null}
                {o.draft ? (
                  <span className="pill ready">
                    {o.draft.mode === "auto" ? "Draft ready" : "Drafted"}
                  </span>
                ) : null}
                <h3>{why.headline}</h3>
                <p className="muted">{why.detail}</p>
                {why.ask ? (
                  <p className="ask">
                    They are waiting on: <span>{why.ask}</span>
                  </p>
                ) : null}
                <p className="fine">
                  {o.contact_account_name ? `${o.contact_account_name} · ` : ""}
                  {o.reason.message_count} {o.reason.message_count === 1 ? "message" : "messages"}
                  {o.reason.has_open_deal === null
                    ? " · deal state unknown (no CRM connected)"
                    : ""}
                  {o.reason.open_deal_value !== undefined
                    ? ` · $${o.reason.open_deal_value.toLocaleString()} open`
                    : ""}
                  {nextMeetingLine(o) ? ` · ${nextMeetingLine(o)}` : ""}
                </p>
              </div>
              <div className="item-actions">
                {o.draft ? (
                  <a
                    className="button"
                    href={gmailDraftUrl(o.draft)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open draft in Gmail
                  </a>
                ) : (
                  <form action={draftAction.bind(null, o.id)}>
                    <button className="button" type="submit">
                      Draft follow-up
                    </button>
                  </form>
                )}
                {o.reason.last_direction === "outbound" ? (
                  <form action={proposeLogAction.bind(null, o.id)}>
                    <button className="button secondary" type="submit">
                      Log to Salesforce
                    </button>
                  </form>
                ) : null}
                {o.reason.has_open_deal === true ? (
                  <form action={proposeCrmUpdateAction.bind(null, o.id)}>
                    <button className="button secondary" type="submit">
                      Update Salesforce
                    </button>
                  </form>
                ) : null}
                <form action={snoozeAction.bind(null, o.id)}>
                  <button className="button secondary" type="submit">
                    Snooze 3 days
                  </button>
                </form>
                <form action={dismissAction.bind(null, o.id)} className="dismiss">
                  <input
                    name="note"
                    type="text"
                    placeholder="Why? (optional)"
                    aria-label="Why is this not needed?"
                    maxLength={300}
                  />
                  <button className="button quiet" type="submit">
                    Not needed
                  </button>
                </form>
              </div>
            </div>
          );
        })}
      </div>

      <p className="fine" style={{ marginTop: 24 }}>
        &ldquo;Draft follow-up&rdquo; saves a draft in your Gmail Drafts folder. Nothing is sent
        until you open it and press Send.
      </p>

      {proposals.length > 0 || done.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2>Salesforce</h2>
            <p className="muted">
              What your agent would record for the team. Nothing is written until you approve it,
              and every write is read back before it counts. &ldquo;Always&rdquo; lets it log your
              sent emails without asking; you can undo any one.
            </p>
          </div>
          <ul className="quiet-list">
            {proposals.map((a) => (
              <li key={a.id} className="proposal">
                <div className="proposal-main">
                  <span className="name">{a.summary}</span>
                  <span className="fine">{a.detail}</span>
                  {a.quotes.map((q) => (
                    <span key={q} className="quote">
                      &ldquo;{q}&rdquo;
                    </span>
                  ))}
                </div>
                <div className="proposal-actions">
                  <form action={approveActionAction.bind(null, a.id, a.diff_sha256)}>
                    <button className="button" type="submit">
                      Approve
                    </button>
                  </form>
                  {a.can_promote ? (
                    <form action={alwaysActionAction.bind(null, a.id)}>
                      <button className="button secondary" type="submit">
                        Always
                      </button>
                    </form>
                  ) : null}
                  <form action={declineActionAction.bind(null, a.id)}>
                    <button className="button quiet" type="submit">
                      Not now
                    </button>
                  </form>
                </div>
              </li>
            ))}
            {done.map((a) => (
              <li key={a.id}>
                <span
                  className={`status ${a.status === "verified" ? "ok" : a.status === "reverted" ? "none" : a.status === "failed" || a.status === "stale" ? "bad" : "warn"}`}
                >
                  {a.status === "verified"
                    ? a.approved_by === "promotion"
                      ? "Logged, verified"
                      : "Logged, verified"
                    : a.status === "reverted"
                      ? "Undone"
                      : a.status === "failed"
                        ? "Not written"
                        : a.status === "stale"
                          ? "Changed since you saw it"
                          : a.status}
                </span>
                <span> {a.summary}</span>
                {a.error ? <span className="fine"> {a.error}</span> : null}
                {a.can_revert && a.status !== "reverted" ? (
                  <form action={revertActionAction.bind(null, a.id)}>
                    <button type="submit" className="link">
                      Undo
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {offered.length > 0 || forming.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2>Routines</h2>
            <p className="muted">
              Things you do the same way, again and again, that your agent noticed in your own mail,
              calendar and Salesforce. Accept one and it will first run alongside you, showing what
              it would have done, before it does anything.
            </p>
          </div>
          <ul className="quiet-list">
            {offered.map((r) => (
              <li key={r.id} className="proposal">
                <div className="proposal-main">
                  <span className="name">{r.title}</span>
                  <span className="fine">{routineEvidenceLine(r)}</span>
                  <ol className="steps">
                    {r.steps.map((s) => (
                      <li key={s.order}>
                        {s.observed} in {s.app}
                        {s.repeats > 1 ? ` (${s.repeats} times)` : ""}
                        <span className="fine">
                          {s.automation === "automated" && s.mode === "read"
                            ? " · the agent would notice this"
                            : s.automation === "automated"
                              ? " · the agent would do this, with your approval"
                              : s.automation === "context"
                                ? " · context"
                                : " · stays with you"}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {r.decision === "accepted" ? (
                    <span className="pill ready">
                      {r.runs ? routineRunsLine(r.runs) : "Accepted."}
                      {r.compile_problem ? ` Not compiled: ${r.compile_problem}.` : ""}
                    </span>
                  ) : r.decision === "dismissed" ? (
                    <span className="pill">You said not now.</span>
                  ) : null}
                </div>
                {r.decision === null ? (
                  <div className="proposal-actions">
                    <form action={decideRoutineAction.bind(null, r.id, "accepted")}>
                      <button className="button" type="submit">
                        Accept
                      </button>
                    </form>
                    <form action={decideRoutineAction.bind(null, r.id, "dismissed")}>
                      <button className="button secondary" type="submit">
                        Not now
                      </button>
                    </form>
                    <form action={decideRoutineAction.bind(null, r.id, "never")}>
                      <button className="button quiet" type="submit">
                        Never
                      </button>
                    </form>
                  </div>
                ) : r.intent_id ? (
                  <div className="proposal-actions">
                    {r.runs?.ready_to_start ? (
                      <form action={startRoutineAction.bind(null, r.id)}>
                        <button className="button" type="submit">
                          Start
                        </button>
                      </form>
                    ) : null}
                    <form action={forgetIntentAction.bind(null, r.intent_id)}>
                      <button className="link" type="submit">
                        Undo
                      </button>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
            {forming.map((r) => (
              <li key={r.id}>
                <span className="status none">Forming</span>
                <span> {r.title}</span>
                <span className="fine"> {formingLine(r)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {skipped.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2>Set aside by what you said</h2>
            <p className="muted">
              These matched something you told your agent. Forget the note below to bring one back.
            </p>
          </div>
          <ul className="quiet-list">
            {skipped.map((s) => (
              <li key={s.id}>
                <span className="name">{s.contact_display_name}</span>
                <span className="muted"> &middot; {s.subject}</span>
                {s.intent_text ? (
                  <span className="fine"> &ldquo;{s.intent_text}&rdquo;</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>Tell your agent</h2>
          <p className="muted">
            In your own words. &ldquo;Don&apos;t chase Acme.&rdquo; &ldquo;Never follow up more than
            twice.&rdquo; &ldquo;After a demo, send a recap the same day.&rdquo; Rules are enforced;
            the rest guides the writing.
          </p>
        </div>
        <form action={stateIntentAction} className="tell">
          <input
            name="text"
            type="text"
            placeholder="Something your agent should know"
            aria-label="Tell your agent"
            maxLength={300}
            required
          />
          <button className="button" type="submit">
            Save
          </button>
        </form>
        {known.length > 0 ? (
          <ul className="quiet-list">
            {known.map((k) => (
              <li key={k.id}>
                <span className={`pill ${k.is_rule ? "rule" : ""}`}>
                  {k.source === "stated" ? (k.is_rule ? "Rule" : "Guidance") : "Noticed"}
                </span>
                <span> {k.text}</span>
                <form action={forgetIntentAction.bind(null, k.id)}>
                  <button type="submit" className="link">
                    Forget
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fine">Nothing yet. Whatever you write here stays with your account only.</p>
        )}
      </section>
    </>
  );
}
