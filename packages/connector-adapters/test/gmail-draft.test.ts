import { describe, expect, it } from "vitest";
import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpRequest, HttpResponse } from "../src/http.js";
import type { ProviderCredentials, UserCredentialProvider } from "../src/credentials.js";
import { buildRawMessage, createGmailDraft } from "../src/gmail-draft.js";

const KEY = { organization_id: "org-1", user_id: "user-1" };
const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

describe("buildRawMessage", () => {
  it("produces a well-formed RFC 2822 message", () => {
    const text = decode(
      buildRawMessage({
        to: "bob@client.com",
        subject: "Re: Pricing",
        body: "Hi Bob,\n\nFollowing up.",
      }),
    );
    expect(text).toMatch(/^To: bob@client\.com\r\nSubject: Re: Pricing\r\n/);
    expect(text).toContain("\r\n\r\nHi Bob,\n\nFollowing up.");
    expect(text).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  it("threads the draft as a reply when a message id is known", () => {
    const text = decode(
      buildRawMessage({ to: "b@x.com", subject: "s", body: "b", in_reply_to: "<m1@x>" }),
    );
    expect(text).toContain("In-Reply-To: <m1@x>\r\n");
    expect(text).toContain("References: <m1@x>\r\n");
  });

  it("strips CR/LF from headers so a subject cannot inject a recipient", () => {
    // THE PROPERTY. "Subject: x\r\nBcc: attacker" would add a recipient the
    // person never reviewed — a send hiding inside a draft.
    const text = decode(
      buildRawMessage({ to: "b@x.com", subject: "Hi\r\nBcc: evil@x.com", body: "b" }),
    );
    // The injected text SURVIVES — inside the subject value, folded onto one
    // line — and that is fine. What must not exist is a HEADER named Bcc.
    expect(text).toContain("Subject: Hi Bcc: evil@x.com\r\n");
    const [headers] = text.split("\r\n\r\n");
    const names = headers!.split("\r\n").map((l) => l.split(":")[0]);
    expect(names).toEqual([
      "To",
      "Subject",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
    expect(names).not.toContain("Bcc");
  });

  it("round-trips non-ASCII body text", () => {
    const text = decode(
      buildRawMessage({ to: "b@x.com", subject: "s", body: "Danke schön — 谢谢" }),
    );
    expect(text).toContain("Danke schön — 谢谢");
  });
});

function fake(opts: { status?: number; body?: unknown; unauthorizedUntilRefresh?: boolean } = {}) {
  const requests: HttpRequest[] = [];
  let refreshed = false;
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    if (opts.unauthorizedUntilRefresh && !req.headers["authorization"]?.endsWith("fresh")) {
      return { status: 401, headers: {}, body: {} };
    }
    return {
      status: opts.status ?? 200,
      headers: {},
      body: opts.body ?? { id: "d1", message: { id: "m1" } },
    };
  };
  const credentials: UserCredentialProvider = {
    load: async () => ({ access_token: "stale" }) as ProviderCredentials,
    refresh: async () => {
      refreshed = true;
      return { access_token: "fresh" } as ProviderCredentials;
    },
  };
  return { transport, credentials, requests, wasRefreshed: () => refreshed };
}

describe("createGmailDraft", () => {
  it("POSTs to /drafts with the raw message and thread id, and returns the ids", async () => {
    const g = fake();
    const out = await createGmailDraft(g, KEY, {
      to: "b@x.com",
      subject: "s",
      body: "hi",
      thread_id: "t9",
    });
    expect(out).toEqual({ draft_id: "d1", message_id: "m1" });
    expect(g.requests).toHaveLength(1);
    const req = g.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toMatch(/\/users\/me\/drafts$/);
    const sent = JSON.parse(req.body!) as { message: { raw: string; threadId?: string } };
    expect(sent.message.threadId).toBe("t9");
    expect(decode(sent.message.raw)).toContain("To: b@x.com");
  });

  it("never touches the send endpoint", async () => {
    // The scope forbids it; this pins that the code does not try.
    const g = fake();
    await createGmailDraft(g, KEY, { to: "b@x.com", subject: "s", body: "hi" });
    expect(g.requests.every((r) => !/\/send\b/.test(r.url))).toBe(true);
  });

  it("refreshes once on 401 and retries", async () => {
    const g = fake({ unauthorizedUntilRefresh: true });
    await createGmailDraft(g, KEY, { to: "b@x.com", subject: "s", body: "hi" });
    expect(g.wasRefreshed()).toBe(true);
    expect(g.requests.at(-1)!.headers["authorization"]).toBe("Bearer fresh");
  });

  it("refuses when no connection is linked, without a request", async () => {
    const g = fake();
    const none: UserCredentialProvider = {
      load: async () => null,
      refresh: async () => {
        throw new Error("x");
      },
    };
    await expect(
      createGmailDraft({ ...g, credentials: none }, KEY, {
        to: "b@x.com",
        subject: "s",
        body: "hi",
      }),
    ).rejects.toBeInstanceOf(PermanentAdapterError);
    expect(g.requests).toHaveLength(0);
  });

  it("refuses a response with no draft id rather than reporting a draft that does not exist", async () => {
    const g = fake({ body: { ok: true } });
    await expect(
      createGmailDraft(g, KEY, { to: "b@x.com", subject: "s", body: "hi" }),
    ).rejects.toThrow(/no draft id/);
  });
});
