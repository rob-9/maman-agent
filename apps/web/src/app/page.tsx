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

function daysWord(n: number): string {
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  return `${n} days ago`;
}

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
      <div className="card empty">
        <h3>Not connected to the API</h3>
        <p>
          The API is not reachable (
          {!connections.ok ? connections.status : obligations.ok ? "" : obligations.status}). Start
          it with <code>pnpm --filter @maman/api dev</code>.
        </p>
      </div>
    );
  }

  if (connections.data.connections.length === 0) {
    return (
      <div className="card empty">
        <h3>Nothing to read yet</h3>
        <p>
          Connect your Google account and your agent will read your mail and calendar, find the
          people you are about to drop, and write the first draft. Nothing to set up.
        </p>
        <Link className="btn" href="/connections">
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
  const owed = items.filter((o) => o.kind === "awaiting_you").length;
  const found = routines.ok ? routines.data.routines : [];
  const offered = found.filter((r) => r.status === "eligible" && r.decision !== "never");
  const forming = found.filter(
    (r) => r.status === "candidate" && r.decision === null && r.why_not.length > 0,
  );

  const lede =
    items.length === 0
      ? "Nothing pending. You're caught up."
      : `${items.length} ${items.length === 1 ? "person" : "people"} to get back to, most urgent first.`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Who you&apos;re about to drop</h1>
          <p className="lede">{lede}</p>
        </div>
        <div className="aside">
          <form action={syncAction}>
            <button className="btn ghost" type="submit">
              Check now
            </button>
          </form>
        </div>
      </div>

      {items.length > 0 || proposals.length > 0 || offered.length > 0 ? (
        <div className="summary" aria-label="At a glance">
          {owed > 0 ? (
            <span>
              <i className="dot owed" aria-hidden="true" /> <b>{owed}</b>{" "}
              {owed === 1 ? "reply owed" : "replies owed"}
            </span>
          ) : null}
          {ready > 0 ? (
            <span>
              <i className="dot ready" aria-hidden="true" /> <b>{ready}</b>{" "}
              {ready === 1 ? "draft ready" : "drafts ready"}
            </span>
          ) : null}
          {proposals.length > 0 ? (
            <a href="#salesforce">
              <i className="dot crm" aria-hidden="true" /> <b>{proposals.length}</b> Salesforce{" "}
              {proposals.length === 1 ? "change to approve" : "changes to approve"}
            </a>
          ) : null}
          {offered.length > 0 ? (
            <a href="#routines">
              <i className="dot found" aria-hidden="true" /> <b>{offered.length}</b>{" "}
              {offered.length === 1 ? "routine found" : "routines found"}
            </a>
          ) : null}
          {week ? <span className="muted">{week}</span> : null}
        </div>
      ) : null}

      <div className="stack">
        {items.map((o) => {
          const why = explain(o, agentMode);
          const meeting = nextMeetingLine(o);
          return (
            <article className={`card item k-${o.kind}`} key={o.id}>
              <div className="item-head">
                <h3>{why.headline}</h3>
                <span className="when">{daysWord(o.reason.days_elapsed)}</span>
              </div>
              <div className="tags">
                <span className={`tag ${o.kind}`}>{KIND_LABEL[o.kind]}</span>
                {why.source === "agent" && o.assessment?.urgency === "high" ? (
                  <span className="tag urgent">Urgent</span>
                ) : null}
                {o.draft ? (
                  <span className="tag ready">
                    {o.draft.mode === "auto" ? "Draft ready" : "Drafted"}
                  </span>
                ) : null}
              </div>
              <p className="body">{why.detail}</p>
              {why.ask && !why.detail.includes(why.ask) ? (
                <div className="ask">
                  <span className="label">Waiting on</span>
                  <span className="text">{why.ask}</span>
                </div>
              ) : null}
              <div className="facts">
                {o.contact_account_name ? <span>{o.contact_account_name}</span> : null}
                <span>&ldquo;{o.subject}&rdquo;</span>
                <span>
                  {o.reason.message_count} {o.reason.message_count === 1 ? "message" : "messages"}
                </span>
                {o.reason.open_deal_value !== undefined ? (
                  <span className="money">${o.reason.open_deal_value.toLocaleString()} open</span>
                ) : o.reason.has_open_deal === null ? (
                  <span>deal unknown</span>
                ) : null}
                {meeting ? <span>{meeting}</span> : null}
              </div>
              <div className="actions">
                {o.draft ? (
                  <a className="btn" href={gmailDraftUrl(o.draft)} target="_blank" rel="noreferrer">
                    Open draft in Gmail
                  </a>
                ) : (
                  <form action={draftAction.bind(null, o.id)}>
                    <button className="btn" type="submit">
                      Draft a reply
                    </button>
                  </form>
                )}
                {o.reason.has_open_deal === true ? (
                  <form action={proposeCrmUpdateAction.bind(null, o.id)}>
                    <button className="btn ghost" type="submit">
                      Update Salesforce
                    </button>
                  </form>
                ) : null}
                {o.reason.last_direction === "outbound" ? (
                  <form action={proposeLogAction.bind(null, o.id)}>
                    <button className="btn ghost" type="submit">
                      Log to Salesforce
                    </button>
                  </form>
                ) : null}
                <form action={snoozeAction.bind(null, o.id)} className="push">
                  <button className="btn ghost" type="submit">
                    Snooze 3 days
                  </button>
                </form>
                <details className="dismiss">
                  <summary>
                    <span className="btn ghost">Not needed</span>
                  </summary>
                  <form action={dismissAction.bind(null, o.id)} className="panel">
                    <p>Say why, if you like. Your agent keeps it as something you told it.</p>
                    <input
                      className="input"
                      name="note"
                      type="text"
                      placeholder="They signed, no reply needed"
                      aria-label="Why is this not needed?"
                      maxLength={300}
                    />
                    <button className="btn small" type="submit">
                      Set aside
                    </button>
                  </form>
                </details>
              </div>
            </article>
          );
        })}
      </div>

      {items.length > 0 ? (
        <p className="footnote">
          A draft lands in your Gmail Drafts folder. Nothing is sent until you open it and press
          Send.
        </p>
      ) : null}

      {proposals.length > 0 || done.length > 0 ? (
        <section className="section" id="salesforce">
          <div className="section-head">
            <div>
              <h2>Salesforce</h2>
              <p>
                What your agent would record for the team. Nothing is written until you approve it,
                and every write is read back before it counts. You can undo any one.
              </p>
            </div>
            {proposals.length > 0 ? (
              <span className="count">
                {proposals.length} {proposals.length === 1 ? "proposal" : "proposals"}
              </span>
            ) : null}
          </div>
          <div className="stack">
            {proposals.map((a) => (
              <div key={a.id} className="card proposal">
                <span className="title">{a.summary}</span>
                <span className="detail">{a.detail}</span>
                {a.quotes.length > 0 ? (
                  <div className="quotes">
                    {a.quotes.map((q) => (
                      <span key={q} className="quote">
                        &ldquo;{q}&rdquo;
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="actions">
                  <form action={approveActionAction.bind(null, a.id, a.diff_sha256)}>
                    <button className="btn" type="submit">
                      Approve
                    </button>
                  </form>
                  {a.can_promote ? (
                    <form action={alwaysActionAction.bind(null, a.id)}>
                      <button className="btn secondary" type="submit">
                        Always
                      </button>
                    </form>
                  ) : null}
                  <form action={declineActionAction.bind(null, a.id)}>
                    <button className="btn ghost" type="submit">
                      Not now
                    </button>
                  </form>
                </div>
              </div>
            ))}
            {done.length > 0 ? (
              <ul className="rows">
                {done.map((a) => (
                  <li key={a.id}>
                    <span
                      className={`status ${a.status === "verified" ? "ok" : a.status === "reverted" ? "none" : a.status === "failed" || a.status === "stale" ? "bad" : "warn"}`}
                    >
                      {a.status === "verified"
                        ? "Written, verified"
                        : a.status === "reverted"
                          ? "Undone"
                          : a.status === "failed"
                            ? "Not written"
                            : a.status === "stale"
                              ? "Changed since you saw it"
                              : a.status}
                    </span>
                    <span>{a.summary}</span>
                    {a.error ? <span className="fine">{a.error}</span> : null}
                    {a.can_revert && a.status !== "reverted" ? (
                      <form action={revertActionAction.bind(null, a.id)} className="push">
                        <button type="submit" className="link">
                          Undo
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}

      {offered.length > 0 || forming.length > 0 ? (
        <section className="section" id="routines">
          <div className="section-head">
            <div>
              <h2>Routines</h2>
              <p>
                Things you do the same way, again and again, that your agent noticed in your own
                mail, calendar and Salesforce. Accept one and it first runs alongside you, showing
                what it would have done, before it does anything.
              </p>
            </div>
          </div>
          <div className="stack">
            {offered.map((r) => (
              <article key={r.id} className="card routine">
                <div>
                  <div className="title">{r.title}</div>
                  <div className="evidence">{routineEvidenceLine(r)}</div>
                </div>
                <ol className="flow" aria-label="Steps">
                  {r.steps.map((s) => {
                    const does = s.automation === "automated" && s.mode !== "read";
                    return (
                      <li key={s.order}>
                        <span className={`step ${does ? "does" : ""}`}>
                          <span className="what">
                            {s.observed}
                            {s.repeats > 1 ? ` (×${s.repeats})` : ""}
                          </span>
                          <span className="how">
                            {s.automation === "automated" && s.mode === "read"
                              ? `noticed in ${s.app}`
                              : s.automation === "automated"
                                ? `agent does this, you approve`
                                : s.automation === "context"
                                  ? "context"
                                  : "stays with you"}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                {r.decision === "accepted" ? (
                  <span className="state">
                    {r.runs ? routineRunsLine(r.runs) : "Accepted."}
                    {r.compile_problem ? ` Not compiled: ${r.compile_problem}.` : ""}
                  </span>
                ) : r.decision === "dismissed" ? (
                  <span className="state quiet">You said not now. It will ask again later.</span>
                ) : null}
                {r.decision === null ? (
                  <div className="actions">
                    <form action={decideRoutineAction.bind(null, r.id, "accepted")}>
                      <button className="btn" type="submit">
                        Accept
                      </button>
                    </form>
                    <form action={decideRoutineAction.bind(null, r.id, "dismissed")}>
                      <button className="btn ghost" type="submit">
                        Not now
                      </button>
                    </form>
                    <form action={decideRoutineAction.bind(null, r.id, "never")} className="push">
                      <button className="btn ghost" type="submit">
                        Never
                      </button>
                    </form>
                  </div>
                ) : r.intent_id ? (
                  <div className="actions">
                    {r.runs?.ready_to_start ? (
                      <form action={startRoutineAction.bind(null, r.id)}>
                        <button className="btn" type="submit">
                          Start
                        </button>
                      </form>
                    ) : null}
                    <form action={forgetIntentAction.bind(null, r.intent_id)} className="push">
                      <button className="link" type="submit">
                        Undo
                      </button>
                    </form>
                  </div>
                ) : null}
              </article>
            ))}
            {forming.length > 0 ? (
              <ul className="rows">
                {forming.map((r) => (
                  <li key={r.id}>
                    <span className="status none">Forming</span>
                    <span>{r.title}</span>
                    <span className="fine">{formingLine(r)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}

      {skipped.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <div>
              <h2>Set aside by what you said</h2>
              <p>These matched something you told your agent. Forget the note to bring one back.</p>
            </div>
          </div>
          <ul className="rows">
            {skipped.map((s) => (
              <li key={s.id}>
                <span>
                  <b>{s.contact_display_name}</b> <span className="muted">· {s.subject}</span>
                </span>
                {s.intent_text ? <span className="fine">&ldquo;{s.intent_text}&rdquo;</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section" id="tell">
        <div className="section-head">
          <div>
            <h2>Tell your agent</h2>
            <p>
              In your own words. &ldquo;Don&apos;t chase Acme.&rdquo; &ldquo;Never follow up more
              than twice.&rdquo; &ldquo;After a demo, send a recap the same day.&rdquo; Rules are
              enforced; the rest guides the writing.
            </p>
          </div>
        </div>
        <form action={stateIntentAction} className="tell">
          <input
            className="input"
            name="text"
            type="text"
            placeholder="Something your agent should know"
            aria-label="Tell your agent"
            maxLength={300}
            required
          />
          <button className="btn" type="submit">
            Save
          </button>
        </form>
        {known.length > 0 ? (
          <ul className="rows" style={{ marginTop: 12 }}>
            {known.map((k) => (
              <li key={k.id}>
                <span className={`tag ${k.is_rule ? "rule" : ""}`}>
                  {k.source === "stated" ? (k.is_rule ? "Rule" : "Guidance") : "Noticed"}
                </span>
                <span>{k.text}</span>
                <form action={forgetIntentAction.bind(null, k.id)} className="push">
                  <button type="submit" className="link">
                    Forget
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="footnote">
            Nothing yet. Whatever you write here stays with your account only.
          </p>
        )}
      </section>
    </>
  );
}
