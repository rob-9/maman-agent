import { me } from "@/lib/me";
import { connectAction, syncAction } from "@/lib/actions";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const res = await me.connections();
  const connections = res.ok ? res.data.connections : [];
  const gmail = connections.find((c) => c.provider === "gmail");

  return (
    <>
      <h1>Connections</h1>
      <p className="muted">
        Each connection is yours alone. Nobody else in your organization — including an admin — can
        read what it syncs. Tokens are encrypted to your account and never shown here.
      </p>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <div>
            <h3>Gmail</h3>
            <p className="muted">
              Reads who you&apos;re talking to and when — never the message text. Can create drafts;
              cannot send.
            </p>
            {gmail ? (
              <p className="fine">
                {gmail.status === "active" ? "Connected" : `Status: ${gmail.status}`}
                {gmail.last_synced_at
                  ? ` · last checked ${new Date(gmail.last_synced_at).toLocaleString()}`
                  : " · not checked yet"}
                {gmail.last_error ? ` · ${gmail.last_error}` : ""}
              </p>
            ) : null}
          </div>
          <div className="item-actions">
            {gmail && gmail.status === "active" ? (
              <form action={syncAction}>
                <button className="button secondary" type="submit">
                  Check now
                </button>
              </form>
            ) : (
              <form action={connectAction.bind(null, "gmail")}>
                <button className="button" type="submit">
                  {gmail ? "Reconnect Gmail" : "Connect Gmail"}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>CRM</h3>
        <p className="muted">
          Coming next. Until a CRM is connected, deal state is unknown — threads still surface, they
          just can&apos;t be ranked by deal value yet.
        </p>
      </div>
    </>
  );
}
