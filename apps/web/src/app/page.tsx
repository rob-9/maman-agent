import Link from "next/link";
import { explain, me } from "@/lib/me";
import { dismissAction, draftAction, snoozeAction, syncAction } from "@/lib/actions";

export const dynamic = "force-dynamic";

const KIND_LABEL = {
  awaiting_you: "Owed a reply",
  unsent_followup: "No follow-up",
  awaiting_them: "Gone quiet",
} as const;

export default async function InboxPage() {
  const [obligations, connections] = await Promise.all([me.obligations(), me.connections()]);

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
          Connect Gmail
        </Link>
      </div>
    );
  }

  const items = obligations.data.obligations;
  const agentMode = obligations.data.agent_mode;
  return (
    <>
      <div className="row">
        <div>
          <h1>Who you&apos;re about to drop</h1>
          <p className="muted">
            {items.length === 0
              ? "Nothing pending. You're caught up."
              : `${items.length} ${items.length === 1 ? "thread" : "threads"}, most urgent first.`}
          </p>
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
                </p>
              </div>
              <div className="item-actions">
                <form action={draftAction.bind(null, o.id)}>
                  <button className="button" type="submit">
                    Draft follow-up
                  </button>
                </form>
                <form action={snoozeAction.bind(null, o.id)}>
                  <button className="button secondary" type="submit">
                    Snooze 3 days
                  </button>
                </form>
                <form action={dismissAction.bind(null, o.id)}>
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
    </>
  );
}
