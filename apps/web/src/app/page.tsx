import Link from "next/link";
import {
  checkedLine,
  draftsLine,
  explain,
  formingLine,
  gmailDraftUrl,
  initials,
  longDate,
  me,
  nextMeetingLine,
  routineEvidenceLine,
  routineRunsLine,
  stepLine,
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
  keepIntentAction,
  proposeSendAction,
} from "@/lib/actions";

export const dynamic = "force-dynamic";

const KIND_LABEL = {
  awaiting_you: "They're waiting on you",
  unsent_followup: "Met, nothing sent",
  awaiting_them: "No reply yet",
} as const;

const FIELD_LABEL = {
  next_step: "Next step",
  close_date: "Close date",
  subject: "Subject",
  date: "Date",
  to: "To",
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
        <h3>Connect your Google account to start</h3>
        <p>
          Your agent reads your mail and calendar, finds the people waiting on you, and writes the
          first draft. There is nothing to set up.
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
  const allIntents = intents.ok ? intents.data.intents : [];
  const known = allIntents.filter((k) => k.status === "active");
  const guesses = allIntents.filter((k) => k.status === "proposed");
  const week = draftsLine(obligations.data.drafts_this_week);
  const crm = actions.ok ? actions.data.actions : [];
  const outgoing = crm.filter((a) => a.kind === "gmail.send" && a.status === "proposed");
  const proposals = crm.filter((a) => a.kind !== "gmail.send" && a.status === "proposed");
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
      ? "Nobody is waiting on you right now."
      : items.length === 1
        ? "One person is waiting on you."
        : `${items.length} people are waiting on you. Most urgent first.`;
  const checked = checkedLine(connections.data.connections);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Follow-ups</h1>
          <p className="lede">{lede}</p>
        </div>
        <div className="aside">
          <form action={syncAction}>
            <button className="btn ghost" type="submit">
              Check now
            </button>
          </form>
          {checked ? <span className="fine">{checked}</span> : null}
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
                <span className="avatar" aria-hidden="true">
                  {initials(o.contact_display_name)}
                </span>
                <div className="item-title">
                  <h3>{why.headline}</h3>
                  <span className="when">{daysWord(o.reason.days_elapsed)}</span>
                </div>
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
                  <span className="label">They asked</span>
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
                  <span>no deal on record</span>
                ) : null}
                {meeting ? <span>{meeting}</span> : null}
              </div>
              <div className="actions">
                {o.draft ? (
                  <>
                    <a
                      className="btn"
                      href={gmailDraftUrl(o.draft)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open draft in Gmail
                    </a>
                    <form action={proposeSendAction.bind(null, o.id)}>
                      <button className="btn secondary" type="submit">
                        Send
                      </button>
                    </form>
                  </>
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
                    <p>Say why if you like. Your agent remembers it.</p>
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
          Drafts go to your Gmail Drafts folder. Nothing is sent until you press Send, here or in
          Gmail.
        </p>
      ) : null}

      {outgoing.length > 0 ? (
        <section className="section" id="outgoing">
          <div className="section-head">
            <div>
              <h2>Ready to send</h2>
              <p>
                Exactly what would go out, from your Gmail, as you. Nothing is sent until you press
                Send here. A sent email cannot be taken back, so there is no undo.
              </p>
            </div>
            <span className="count">
              {outgoing.length} {outgoing.length === 1 ? "message" : "messages"}
            </span>
          </div>
          <div className="stack">
            {outgoing.map((a) => (
              <div key={a.id} className="card proposal">
                <span className="title">{a.summary}</span>
                <span className="detail">{a.detail}</span>
                <dl className="diff">
                  {a.changes.map((c) => (
                    <div key={c.field} className="diff-row">
                      <dt>{FIELD_LABEL[c.field]}</dt>
                      <dd>
                        <span className="to">{c.to}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
                {a.message ? <pre className="message">{a.message}</pre> : null}
                <div className="actions">
                  <form action={approveActionAction.bind(null, a.id, a.diff_sha256)}>
                    <button className="btn" type="submit">
                      Send now
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
          </div>
        </section>
      ) : null}

      {proposals.length > 0 ? (
        <section className="section" id="salesforce">
          <div className="section-head">
            <div>
              <h2>Salesforce</h2>
              <p>
                Changes your agent wants to make. Nothing changes until you approve it. Every change
                is checked after it is made, and you can undo it.
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
                <span className="title">
                  {a.kind === "salesforce.update_opportunity"
                    ? `Update the deal "${a.record}"`
                    : `Log an email to ${a.contact_display_name}'s record`}
                </span>
                <span className="detail">
                  {a.kind === "salesforce.update_opportunity"
                    ? `From what ${a.contact_display_name} wrote.`
                    : "From an email you sent."}
                </span>
                <dl className="diff">
                  {a.changes.map((c) => (
                    <div key={c.field} className="diff-row">
                      <dt>{FIELD_LABEL[c.field]}</dt>
                      <dd>
                        {c.from ? <s>{longDate(c.from)}</s> : null}
                        <span className="to">{longDate(c.to)}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
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
          </div>
        </section>
      ) : null}

      {done.length > 0 ? (
        <section className="section" id="done">
          <div className="section-head">
            <div>
              <h2>Done</h2>
              <p>
                What your agent did and how it went. Each write was checked afterwards. A Salesforce
                change can be undone; a sent email cannot.
              </p>
            </div>
          </div>
          <ul className="rows">
            {done.map((a) => (
              <li key={a.id}>
                <span
                  className={`status ${a.status === "verified" ? "ok" : a.status === "reverted" ? "none" : a.status === "failed" || a.status === "stale" ? "bad" : "warn"}`}
                >
                  {a.status === "verified"
                    ? a.kind === "gmail.send"
                      ? "Sent, confirmed"
                      : "Done, checked"
                    : a.status === "reverted"
                      ? "Undone"
                      : a.status === "failed"
                        ? a.kind === "gmail.send"
                          ? "Not sent"
                          : "Not written"
                        : a.status === "stale"
                          ? "Skipped, it changed since you looked"
                          : a.status}
                </span>
                <span>{a.summary}</span>
                {a.error ? <span className="fine">{a.error}</span> : null}
                {a.kind === "gmail.send" && a.status === "verified" ? (
                  <span className="fine">No undo for a sent email.</span>
                ) : null}
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
        </section>
      ) : null}

      {offered.length > 0 || forming.length > 0 ? (
        <section className="section" id="routines">
          <div className="section-head">
            <div>
              <h2>Routines</h2>
              <p>
                Patterns your agent has noticed in how you work. Accept one and it watches a few
                more times, showing you what it would have done. It does nothing on its own until
                you tell it to start.
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
                          <span className="how">{stepLine(s)}</span>
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
                  <span className="state quiet">
                    You said not now. It will come back in two weeks.
                  </span>
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
              <h2>Set aside</h2>
              <p>
                Skipped because of something you told your agent. Forget the note to bring one back.
              </p>
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
              always followed. Everything else shapes how it writes.
            </p>
          </div>
        </div>
        {guesses.length > 0 ? (
          <div className="card guesses">
            <div className="guesses-head">
              <span className="title">Your agent thinks</span>
              <span className="fine">From what you did. Nothing applies until you keep it.</span>
            </div>
            <ul className="rows plain">
              {guesses.map((g) => (
                <li key={g.id}>
                  <span>
                    <b>{g.text}</b>
                    {g.evidence ? <span className="fine"> {g.evidence}</span> : null}
                  </span>
                  <span className="push actions" style={{ marginTop: 0 }}>
                    <form action={keepIntentAction.bind(null, g.id)}>
                      <button className="btn small" type="submit">
                        Keep
                      </button>
                    </form>
                    <form action={forgetIntentAction.bind(null, g.id)}>
                      <button className="btn small ghost" type="submit">
                        Not true
                      </button>
                    </form>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <form action={stateIntentAction} className="tell">
          <input
            className="input"
            name="text"
            type="text"
            placeholder="Something your agent should know about how you work"
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
                  {k.source === "stated"
                    ? k.is_rule
                      ? "Rule"
                      : "Guidance"
                    : k.source === "inferred"
                      ? "You kept this"
                      : "Noticed"}
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
          <p className="footnote">Nothing yet. What you write here is only ever seen by you.</p>
        )}
      </section>
    </>
  );
}
