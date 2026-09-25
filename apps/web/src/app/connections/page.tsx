import type { ReactNode } from "react";
import { me } from "@/lib/me";
import { connectAction, connectOrgAction, disconnectOrgAction, syncAction } from "@/lib/actions";
import { describeCrm, describeGmail, noticeFrom, type Presentation } from "@/lib/connections-view";
import { GmailMark, SalesforceMark } from "@/components/logos";

export const dynamic = "force-dynamic";

type Search = { provider?: string; connected?: string; error?: string };

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const [personal, org, params] = await Promise.all([
    me.connections(),
    me.connectors(),
    searchParams,
  ]);
  const gmail = (personal.ok ? personal.data.connections : []).find((c) => c.provider === "gmail");
  const salesforce = (org.ok ? org.data.connected : []).find((c) => c.provider === "salesforce");
  const notice = noticeFrom(params);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <p className="lede">What your agent can read, and who connected it.</p>
        </div>
      </div>

      {notice ? (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.text}
        </div>
      ) : null}

      <Section
        title="Yours"
        blurb="Connected by you. Only you can see what comes through it, admins included."
      >
        <Integration
          mark={<GmailMark size={26} />}
          name="Google"
          description="Gmail and Calendar. Your agent reads your mail and meetings and writes drafts. It sends only what you approve, or what you told it to always send."
          presentation={describeGmail(gmail)}
          action={
            gmail && gmail.status === "active" ? (
              <form action={syncAction}>
                <button className="btn ghost" type="submit">
                  Check now
                </button>
              </form>
            ) : (
              <form action={connectAction.bind(null, "gmail")}>
                <button className="btn" type="submit">
                  {gmail ? "Reconnect Google" : "Connect Google"}
                </button>
              </form>
            )
          }
        />
      </Section>

      <Section
        title="Your team's"
        blurb="Connected once for the whole team. Used to see which of your contacts have an open deal, and to log emails and update deals when you approve it."
      >
        <Integration
          mark={<SalesforceMark size={28} />}
          name="Salesforce"
          description="Reads the deals your contacts are on. Writes only what you approve, and checks every write afterwards."
          presentation={describeCrm(salesforce)}
          action={
            salesforce && salesforce.status === "connected" ? (
              <form action={disconnectOrgAction.bind(null, "salesforce")}>
                <button className="btn ghost" type="submit">
                  Disconnect
                </button>
              </form>
            ) : (
              <form action={connectOrgAction.bind(null, "salesforce")}>
                <button className="btn" type="submit">
                  {salesforce ? "Reconnect Salesforce" : "Connect Salesforce"}
                </button>
              </form>
            )
          }
        />
      </Section>
    </>
  );
}

function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          <p>{blurb}</p>
        </div>
      </div>
      <div className="stack">{children}</div>
    </section>
  );
}

function Integration({
  mark,
  name,
  description,
  presentation,
  action,
}: {
  mark: ReactNode;
  name: string;
  description: string;
  presentation: Presentation;
  action: ReactNode;
}) {
  return (
    <div className="card integration">
      <div className="logo" aria-hidden="true">
        {mark}
      </div>
      <div className="integration-main">
        <div className="integration-title">
          <span className="name">{name}</span>
          <span className={`status ${presentation.tone}`}>{presentation.label}</span>
        </div>
        <p className="muted">{description}</p>
        <p className="fine">{presentation.detail}</p>
      </div>
      <div className="integration-action">{action}</div>
    </div>
  );
}
