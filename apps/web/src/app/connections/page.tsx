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
        <h1>Connections</h1>
        <p className="muted">
          What Maman can read, and on whose behalf. Tokens are encrypted and never shown here.
        </p>
      </div>

      {notice ? (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.text}
        </div>
      ) : null}

      <Section
        title="Yours"
        blurb="Connected by you and visible only to you. No one else in your organization can see what it syncs, including admins."
      >
        <Integration
          mark={<GmailMark size={26} />}
          name="Gmail"
          description="Reads your mail so your agent has the full conversation. Stored encrypted to your account and visible only to you. Creates drafts but cannot send."
          presentation={describeGmail(gmail)}
          action={
            gmail && gmail.status === "active" ? (
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
            )
          }
        />
      </Section>

      <Section
        title="Your team's"
        blurb="Connected once for the whole organization. Used only to check which of your contacts have an open deal, so the list can rank by what is at stake."
      >
        <Integration
          mark={<SalesforceMark size={28} />}
          name="Salesforce"
          description="Reads the open opportunities your contacts are on. Read only. Nothing in Salesforce is changed."
          presentation={describeCrm(salesforce)}
          action={
            salesforce && salesforce.status === "connected" ? (
              <form action={disconnectOrgAction.bind(null, "salesforce")}>
                <button className="button quiet" type="submit">
                  Disconnect
                </button>
              </form>
            ) : (
              <form action={connectOrgAction.bind(null, "salesforce")}>
                <button className="button" type="submit">
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
        <h2>{title}</h2>
        <p className="muted">{blurb}</p>
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
