import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HttpRequest, HttpResponse, HttpTransport } from "./http.js";

/**
 * THE DEMO WORLD. A scripted Gmail, Google Calendar and Salesforce, in
 * memory, for a machine with no credentials: CONNECTOR_MODE=demo.
 *
 * It answers the same requests the real adapters send, with the same shapes,
 * so every path the product runs is the real one: the sync, the detector,
 * the judgment, drafts, CRM writes with read-back, the event stream,
 * discovery, routines. Only the wire is scripted. Writes land here and are
 * read back from here (a draft, a task, an opportunity field), which is what
 * makes the read-back checks meaningful even in the demo.
 *
 * Nothing in the product is demo-only. This is the demo implementation of
 * the connectors, as the deterministic provider is of the model.
 *
 * Two processes run the product (the API and the worker), and both must see
 * the same world: a draft the worker's sweep made is what the person sends
 * from the API. So what the product writes here (drafts, sent messages,
 * tasks, opportunity fields) is kept in a store the processes share, read
 * before every request and written after every write. The scripted story
 * itself is never stored; it is rebuilt from the clock each time.
 */

/** Where the world keeps what the product wrote. Fictional data only. */
export type DemoWorldStore = {
  load: () => string | null;
  save: (text: string) => void;
};

/** A store on disk, so the API and the worker share one world. */
export function fileStore(path: string): DemoWorldStore {
  return {
    load: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    save: (text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
    },
  };
}

/** The default place for the shared file when none is configured. */
export const defaultDemoWorldStateFile = (): string => join(tmpdir(), "maman-demo-world.json");

type Snapshot = {
  schema_version: 1;
  drafts: Array<{ id: string; thread_id: string | null; raw: string; sent_message_id?: string }>;
  sent: Array<{ thread_id: string; message: Msg }>;
  tasks: Array<Record<string, unknown>>;
  opportunities: Array<Record<string, unknown>>;
};

export type TokenTransportLike = (
  tokenEndpoint: string,
  form: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

export type DemoWorld = {
  /** The person's own address, as Gmail's profile reports it. */
  self: string;
  /** Answers Gmail, Calendar and Salesforce requests. */
  transport: HttpTransport;
  /** Answers any token exchange or refresh with demo tokens. */
  token: TokenTransportLike;
  /** What the world holds now, for tests and for a curious reader. */
  state: () => {
    drafts: Array<{ id: string; thread_id: string | null; sent: boolean }>;
    tasks: Array<Record<string, unknown>>;
    opportunities: Array<Record<string, unknown>>;
  };
};

export const DEMO_SALESFORCE_INSTANCE = "https://demo-salesforce.invalid";

type Msg = { id: string; from: string; to: string; at: number; subject: string; text: string };
type Thread = { id: string; subject: string; messages: Msg[] };

const DAY = 86_400_000;
const HOUR = 3_600_000;

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** A person in the story: their address, their name, their company, their deal. */
type Party = {
  address: string;
  name: string;
  company: string;
  contact_id: string;
  account_id: string;
  opportunity?: {
    id: string;
    name: string;
    amount: number;
    stage: string;
    close_date: string;
    next_step: string | null;
  };
};

export function createDemoWorld(
  opts: { now?: () => Date; self?: string; store?: DemoWorldStore } = {},
): DemoWorld {
  const now = opts.now ?? (() => new Date());
  const self = opts.self ?? "alex@acme-sales.example";
  const selfName = "Alex";
  // Every date is relative to the first request, at ten in the morning, so the
  // story is the same age however long the process has been up.
  const t0 = new Date(now().getTime());
  t0.setUTCHours(10, 0, 0, 0);
  const day = (n: number, hours = 0) => t0.getTime() - n * DAY + hours * HOUR;

  const parties: Record<string, Party> = {
    sarah: {
      address: "sarah@northwind.example",
      name: "Sarah Chen",
      company: "Northwind",
      contact_id: "003NW01",
      account_id: "001NW",
      opportunity: {
        id: "006NW01",
        name: "Northwind 60 seats",
        amount: 48_000,
        stage: "Proposal",
        close_date: "2026-12-31",
        next_step: null,
      },
    },
    bob: {
      address: "bob@harbor.example",
      name: "Bob Ray",
      company: "Harbor Logistics",
      contact_id: "003HB01",
      account_id: "001HB",
      opportunity: {
        id: "006HB01",
        name: "Harbor renewal",
        amount: 40_000,
        stage: "Negotiation",
        close_date: "2026-11-15",
        next_step: "Send renewal proposal",
      },
    },
    dan: {
      address: "dan@fable.example",
      name: "Dan Li",
      company: "Fable",
      contact_id: "003FB01",
      account_id: "001FB",
    },
    priya: {
      address: "priya@meridian.example",
      name: "Priya Nair",
      company: "Meridian",
      contact_id: "003MR01",
      account_id: "001MR",
      opportunity: {
        id: "006MR01",
        name: "Meridian pilot",
        amount: 22_000,
        stage: "Discovery",
        close_date: "2027-01-31",
        next_step: null,
      },
    },
    maya: {
      address: "maya@bluepeak.example",
      name: "Maya Ortiz",
      company: "Bluepeak",
      contact_id: "003BP01",
      account_id: "001BP",
      opportunity: {
        id: "006BP01",
        name: "Bluepeak rollout",
        amount: 30_000,
        stage: "Qualification",
        close_date: "2027-02-28",
        next_step: null,
      },
    },
    omar: {
      address: "omar@kestrel.example",
      name: "Omar Haddad",
      company: "Kestrel",
      contact_id: "003KS01",
      account_id: "001KS",
      opportunity: {
        id: "006KS01",
        name: "Kestrel expansion",
        amount: 35_000,
        stage: "Qualification",
        close_date: "2027-01-15",
        next_step: null,
      },
    },
    lena: {
      address: "lena@solstice.example",
      name: "Lena Fischer",
      company: "Solstice",
      contact_id: "003SL01",
      account_id: "001SL",
      opportunity: {
        id: "006SL01",
        name: "Solstice pilot",
        amount: 27_000,
        stage: "Discovery",
        close_date: "2027-03-31",
        next_step: null,
      },
    },
    tom: {
      address: "tom@granite.example",
      name: "Tom Becker",
      company: "Granite",
      contact_id: "003GR01",
      account_id: "001GR",
      opportunity: {
        id: "006GR01",
        name: "Granite platform",
        amount: 52_000,
        stage: "Qualification",
        close_date: "2027-02-15",
        next_step: null,
      },
    },
  };
  const named = (p: Party) => `${p.name} <${p.address}>`;
  const me = `${selfName} <${self}>`;

  const threads: Thread[] = [];
  const meetings: Array<{
    id: string;
    summary: string;
    description: string;
    start: number;
    end: number;
    with: Party[];
  }> = [];
  let n = 0;
  const msg = (from: string, to: string, at: number, subject: string, text: string): Msg => ({
    id: `m${++n}`,
    from,
    to,
    at,
    subject,
    text,
  });

  // Sarah: a reply owed, on an open deal, with the next step and the close in it.
  threads.push({
    id: "t-northwind",
    subject: "Enterprise pricing",
    messages: [
      msg(
        me,
        named(parties.sarah!),
        day(6),
        "Enterprise pricing",
        "Hi Sarah,\n\nAttached is the enterprise pricing for 60 seats, with the volume discount we discussed. Happy to walk your team through it.\n\nBest,\nAlex",
      ),
      msg(
        named(parties.sarah!),
        me,
        day(4),
        "Re: Enterprise pricing",
        "Thanks Alex. Can you confirm the price holds for 60 seats if we start in November? Next step: send over the MSA for legal. We'd like to sign by end of quarter.\n\nSarah",
      ),
    ],
  });
  // Bob: waiting on him for nine days, on a renewal.
  threads.push({
    id: "t-harbor",
    subject: "Renewal proposal",
    messages: [
      msg(
        me,
        named(parties.bob!),
        day(9),
        "Renewal proposal",
        "Hi Bob,\n\nHere is the renewal proposal for next year, same terms with the two extra regions. Let me know if anything needs changing before I send the order form.\n\nAlex",
      ),
    ],
  });
  // Dan: a fresh intro, nothing owed yet.
  threads.push({
    id: "t-fable",
    subject: "Intro from Priya",
    messages: [
      msg(
        me,
        named(parties.dan!),
        day(1),
        "Intro from Priya",
        "Hi Dan,\n\nPriya suggested we talk. Would a short call next week suit?\n\nAlex",
      ),
    ],
  });
  // Priya: a discovery call two days ago, and nothing sent since.
  threads.push({
    id: "t-meridian",
    subject: "Discovery call",
    messages: [
      msg(
        named(parties.priya!),
        me,
        day(8),
        "Discovery call",
        "Hi Alex,\n\nLooking forward to Thursday's call. I'll bring our ops lead.\n\nPriya",
      ),
      msg(
        me,
        named(parties.priya!),
        day(7),
        "Re: Discovery call",
        "Great, see you both Thursday.\n\nAlex",
      ),
    ],
  });
  meetings.push({
    id: "ev-meridian",
    summary: "Discovery call with Meridian",
    description: "Agenda: current process, pilot scope, timeline.",
    start: day(2, 4),
    end: day(2, 4.5),
    with: [parties.priya!],
  });
  // The routine, four times over three weeks: a reply arrives, Alex answers the
  // same day, a meeting is held, they write back. Discovery should find it.
  for (const [key, ago] of [
    ["maya", 20],
    ["omar", 15],
    ["lena", 11],
    ["tom", 7],
  ] as const) {
    const p = parties[key]!;
    threads.push({
      id: `t-${key}`,
      subject: `${p.company} and Acme`,
      messages: [
        msg(
          me,
          named(p),
          day(ago),
          `${p.company} and Acme`,
          `Hi ${p.name.split(" ")[0]},\n\nQuick question: is ${p.company} still looking at replacing the current process this year? If so I'd love to compare notes.\n\nAlex`,
        ),
        msg(
          named(p),
          me,
          day(ago - 2),
          `Re: ${p.company} and Acme`,
          `Hi Alex, yes, happy to chat. Does Thursday afternoon work for a short call?`,
        ),
        msg(
          me,
          named(p),
          day(ago - 2, 3),
          `Re: ${p.company} and Acme`,
          `Thursday works. Sending an invite now.\n\nAlex`,
        ),
        msg(
          named(p),
          me,
          day(ago - 4),
          `Re: ${p.company} and Acme`,
          `Thanks for the call, Alex. We'll regroup internally and come back to you next month.`,
        ),
      ],
    });
    meetings.push({
      id: `ev-${key}`,
      summary: `Intro call with ${p.company}`,
      description: `Intro call with ${p.name}.`,
      start: day(ago - 3, 4),
      end: day(ago - 3, 4.5),
      with: [p],
    });
  }
  // A call already booked with Sarah next week.
  meetings.push({
    id: "ev-northwind-next",
    summary: "Contract review with Northwind",
    description: "MSA and pricing for 60 seats.",
    start: day(-5, 5),
    end: day(-5, 6),
    with: [parties.sarah!],
  });

  // ---- mutable state: what the product writes ----
  const drafts: Array<{
    id: string;
    thread_id: string | null;
    raw: string;
    sent_message_id?: string;
  }> = [];
  const sentMessages: Array<{ thread_id: string; message: Msg }> = [];
  const tasks = new Map<string, Record<string, unknown>>();
  const opportunities = new Map<string, Record<string, unknown>>();
  const seedOpportunities = () => {
    opportunities.clear();
    for (const p of Object.values(parties)) {
      if (!p.opportunity) continue;
      opportunities.set(p.opportunity.id, {
        Id: p.opportunity.id,
        Name: p.opportunity.name,
        StageName: p.opportunity.stage,
        NextStep: p.opportunity.next_step,
        CloseDate: p.opportunity.close_date,
        IsClosed: false,
        Amount: p.opportunity.amount,
      });
    }
  };
  seedOpportunities();
  // The story's own messages, so a restore can put the sent ones back on top.
  const baseMessages = new Map(threads.map((t) => [t.id, [...t.messages]]));

  /** Read what the product wrote, from the shared store, before answering. */
  const restore = () => {
    if (!opts.store) return;
    const text = opts.store.load();
    if (!text) return;
    const snap = JSON.parse(text) as Snapshot;
    if (snap.schema_version !== 1) return;
    drafts.splice(0, drafts.length, ...snap.drafts);
    sentMessages.splice(0, sentMessages.length, ...snap.sent);
    tasks.clear();
    for (const t of snap.tasks) tasks.set(String(t["Id"]), t);
    seedOpportunities();
    for (const o of snap.opportunities) opportunities.set(String(o["Id"]), o);
    for (const t of threads) {
      t.messages = [
        ...(baseMessages.get(t.id) ?? []),
        ...sentMessages.filter((x) => x.thread_id === t.id).map((x) => x.message),
      ];
    }
  };
  /** Write what the product wrote, after every write. */
  const persist = () => {
    if (!opts.store) return;
    const snap: Snapshot = {
      schema_version: 1,
      drafts,
      sent: sentMessages,
      tasks: [...tasks.values()],
      opportunities: [...opportunities.values()],
    };
    opts.store.save(JSON.stringify(snap));
  };

  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body });
  const historyOf = (t: Thread) => `h-${t.id}-${t.messages.length}`;
  const gmailThread = (t: Thread) => ({
    id: t.id,
    historyId: historyOf(t),
    messages: t.messages.map((m) => ({
      id: m.id,
      threadId: t.id,
      internalDate: String(m.at),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: m.from },
          { name: "To", value: m.to },
          { name: "Subject", value: m.subject },
          { name: "Date", value: new Date(m.at).toUTCString() },
        ],
        body: { data: b64url(m.text) },
      },
    })),
  });
  const calendarEvent = (e: (typeof meetings)[number]) => ({
    id: e.id,
    status: "confirmed",
    summary: e.summary,
    description: e.description,
    start: { dateTime: new Date(e.start).toISOString() },
    end: { dateTime: new Date(e.end).toISOString() },
    organizer: { email: self, self: true },
    attendees: [
      {
        email: self,
        displayName: selfName,
        responseStatus: "accepted",
        self: true,
        organizer: true,
      },
      ...e.with.map((p) => ({ email: p.address, displayName: p.name, responseStatus: "accepted" })),
    ],
  });
  const byAddress = (address: string) =>
    Object.values(parties).find((p) => p.address === address.toLowerCase());
  const byContactId = (id: string) => Object.values(parties).find((p) => p.contact_id === id);
  const quoted = (q: string) => [...q.matchAll(/'([^']*)'/g)].map((m) => m[1]!);

  const transport: HttpTransport = async (req: HttpRequest) => {
    restore();
    const url = new URL(req.url);
    const path = url.pathname;
    // ---- Google ----
    if (url.hostname.endsWith("googleapis.com")) {
      if (path.includes("/calendar/")) {
        if (url.searchParams.get("syncToken")) {
          return json(200, { items: [], nextSyncToken: "demo-cal-sync" });
        }
        return json(200, { items: meetings.map(calendarEvent), nextSyncToken: "demo-cal-sync" });
      }
      if (path.endsWith("/profile")) return json(200, { emailAddress: self });
      if (path.endsWith("/threads")) {
        return json(200, { threads: threads.map((t) => ({ id: t.id, historyId: historyOf(t) })) });
      }
      if (req.method === "POST" && path.endsWith("/drafts/send")) {
        const body = JSON.parse(req.body ?? "{}") as { id?: string };
        const d = drafts.find((x) => x.id === body.id);
        if (!d) return json(404, { error: { message: "draft not found" } });
        if (d.sent_message_id) return json(400, { error: { message: "already sent" } });
        // The draft becomes a message on its thread, as it would in Gmail.
        const raw = Buffer.from(d.raw, "base64url").toString("utf8");
        const sep = raw.indexOf("\r\n\r\n");
        const headers = sep >= 0 ? raw.slice(0, sep) : "";
        const text = sep >= 0 ? raw.slice(sep + 4) : raw;
        const to = /^To: (.*)$/m.exec(headers)?.[1] ?? "";
        const subject = /^Subject: (.*)$/m.exec(headers)?.[1] ?? "";
        const t = threads.find((x) => x.id === d.thread_id);
        const sentAt = now().getTime();
        // Named after the draft, not counted, so every process agrees on it.
        const message: Msg = { ...msg(me, to, sentAt, subject, text), id: `sent-${d.id}` };
        if (t) {
          t.messages.push(message);
          sentMessages.push({ thread_id: t.id, message });
        }
        d.sent_message_id = message.id;
        persist();
        return json(200, { id: message.id, threadId: d.thread_id, labelIds: ["SENT"] });
      }
      const sent = path.match(/\/messages\/([^/]+)$/);
      if (sent) {
        const id = decodeURIComponent(sent[1]!);
        const d = drafts.find((x) => x.sent_message_id === id);
        return d
          ? json(200, { id, threadId: d.thread_id, labelIds: ["SENT"] })
          : json(404, { error: { message: "not found" } });
      }
      if (req.method === "POST" && path.endsWith("/drafts")) {
        const body = JSON.parse(req.body ?? "{}") as {
          message?: { raw?: string; threadId?: string };
        };
        const id = `draft-${drafts.length + 1}`;
        drafts.push({
          id,
          thread_id: body.message?.threadId ?? null,
          raw: body.message?.raw ?? "",
        });
        persist();
        return json(200, { id, message: { id: `${id}-msg`, threadId: body.message?.threadId } });
      }
      const m = path.match(/\/threads\/([^/]+)$/);
      if (m) {
        const t = threads.find((x) => x.id === decodeURIComponent(m[1]!));
        return t ? json(200, gmailThread(t)) : json(404, { error: { message: "not found" } });
      }
      return json(404, { error: { message: `demo gmail: no route for ${path}` } });
    }
    // ---- Salesforce ----
    if (
      url.hostname === new URL(DEMO_SALESFORCE_INSTANCE).hostname ||
      path.includes("/services/data/")
    ) {
      const q = url.searchParams.get("q") ?? "";
      if (path.endsWith("/query")) {
        if (q.includes("FROM OpportunityContactRole WHERE Contact.Email IN")) {
          const records = quoted(q)
            .map((a) => byAddress(a))
            .filter((p): p is Party => !!p && !!p.opportunity)
            .map((p) => ({
              Contact: { Email: p.address, Account: { Name: p.company } },
              Opportunity: {
                Amount: opportunities.get(p.opportunity!.id)!["Amount"],
                IsClosed: opportunities.get(p.opportunity!.id)!["IsClosed"],
              },
            }));
          return json(200, { records, done: true });
        }
        if (q.includes("FROM Contact WHERE Email =")) {
          const p = byAddress(quoted(q)[0] ?? "");
          return json(200, { records: p ? [{ Id: p.contact_id, AccountId: p.account_id }] : [] });
        }
        if (q.includes("FROM OpportunityContactRole WHERE ContactId =")) {
          const p = byContactId(quoted(q)[0] ?? "");
          const open = p?.opportunity && opportunities.get(p.opportunity.id)!["IsClosed"] === false;
          return json(200, { records: open ? [{ OpportunityId: p!.opportunity!.id }] : [] });
        }
        if (q.includes("FROM Task WHERE Description LIKE")) {
          const marker = (q.match(/LIKE '%([^%]+)%'/) ?? [])[1] ?? "";
          const hit = [...tasks.values()].find((t) =>
            String(t["Description"] ?? "").includes(marker),
          );
          return json(200, { records: hit ? [hit] : [] });
        }
        return json(200, { records: [] });
      }
      if (req.method === "POST" && path.endsWith("/sobjects/Task")) {
        const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
        const id = `00T${String(tasks.size + 1).padStart(5, "0")}`;
        tasks.set(id, { Id: id, ...body });
        persist();
        return json(201, { id, success: true });
      }
      const task = path.match(/\/sobjects\/Task\/([^/]+)$/);
      if (task) {
        const id = decodeURIComponent(task[1]!);
        if (req.method === "GET")
          return tasks.has(id) ? json(200, tasks.get(id)) : json(404, [{ errorCode: "NOT_FOUND" }]);
        if (req.method === "DELETE") {
          const had = tasks.delete(id);
          persist();
          return had ? json(204, "") : json(404, [{ errorCode: "NOT_FOUND" }]);
        }
      }
      const opp = path.match(/\/sobjects\/Opportunity\/([^/]+)$/);
      if (opp) {
        const id = decodeURIComponent(opp[1]!);
        const row = opportunities.get(id);
        if (!row) return json(404, [{ errorCode: "NOT_FOUND" }]);
        if (req.method === "GET") return json(200, row);
        if (req.method === "PATCH") {
          const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
          for (const [k, v] of Object.entries(body)) row[k] = v;
          persist();
          return json(204, "");
        }
      }
      return json(404, [
        { errorCode: "NOT_FOUND", message: `demo salesforce: no route for ${path}` },
      ]);
    }
    return json(404, { error: { message: `demo world: unknown host ${url.hostname}` } });
  };

  const token: TokenTransportLike = async () => ({
    status: 200,
    body: {
      access_token: "demo-access-token",
      refresh_token: "demo-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
      instance_url: DEMO_SALESFORCE_INSTANCE,
    },
  });

  return {
    self,
    transport,
    token,
    state: () => ({
      ...(restore(), {}),
      drafts: drafts.map((d) => ({ id: d.id, thread_id: d.thread_id, sent: !!d.sent_message_id })),
      tasks: [...tasks.values()],
      opportunities: [...opportunities.values()],
    }),
  };
}
