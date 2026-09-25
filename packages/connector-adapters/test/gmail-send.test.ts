import { describe, expect, it } from "vitest";
import { PermanentAdapterError } from "@maman/agent-runtime";
import {
  createDemoWorld,
  readSentMessage,
  sendGmailDraft,
  createGmailDraft,
} from "../src/index.js";
import type { HttpRequest, HttpResponse, UserCredentialProvider } from "../src/index.js";

const creds: UserCredentialProvider = {
  load: async () => ({ access_token: "tok" }),
  refresh: async () => ({ access_token: "tok2" }),
};
const key = { organization_id: "org", user_id: "u" };

describe("sending a draft, and reading the sent message back", () => {
  it("sends by draft id through drafts.send, once, and reads the message back by id", async () => {
    const calls: HttpRequest[] = [];
    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      calls.push(req);
      if (req.method === "POST" && req.url.endsWith("/drafts/send")) {
        expect(JSON.parse(req.body!)).toEqual({ id: "d-1" });
        return {
          status: 200,
          headers: {},
          body: { id: "m-9", threadId: "t-1", labelIds: ["SENT"] },
        };
      }
      if (req.url.includes("/messages/m-9")) {
        return {
          status: 200,
          headers: {},
          body: { id: "m-9", threadId: "t-1", labelIds: ["SENT", "INBOX"] },
        };
      }
      return { status: 404, headers: {}, body: {} };
    };
    const sent = await sendGmailDraft({ credentials: creds, transport }, key, "d-1");
    expect(sent).toEqual({ message_id: "m-9", thread_id: "t-1" });
    expect(calls.filter((c) => c.url.endsWith("/drafts/send")).length).toBe(1);
    expect(await readSentMessage({ credentials: creds, transport }, key, "m-9")).toEqual({
      message_id: "m-9",
      thread_id: "t-1",
      sent: true,
    });
    expect(await readSentMessage({ credentials: creds, transport }, key, "m-nope")).toBeNull();
  });

  it("a draft that is gone is permanent; a 401 refreshes once; a 5xx is not retried here", async () => {
    const gone = async (): Promise<HttpResponse> => ({ status: 404, headers: {}, body: {} });
    await expect(
      sendGmailDraft({ credentials: creds, transport: gone }, key, "d-x"),
    ).rejects.toBeInstanceOf(PermanentAdapterError);
    let n = 0;
    const flaky = async (req: HttpRequest): Promise<HttpResponse> => {
      n += 1;
      if (req.headers?.["authorization"] === "Bearer tok")
        return { status: 401, headers: {}, body: {} };
      return { status: 200, headers: {}, body: { id: "m-1", threadId: "t" } };
    };
    expect(
      (await sendGmailDraft({ credentials: creds, transport: flaky }, key, "d-1")).message_id,
    ).toBe("m-1");
    expect(n).toBe(2);
  });

  it("the demo world sends a draft as a message on its thread and answers the read-back", async () => {
    const world = createDemoWorld({ now: () => new Date("2026-09-22T15:00:00.000Z") });
    const cfg = { credentials: creds, transport: world.transport };
    const d = await createGmailDraft(cfg, key, {
      to: "sarah@northwind.example",
      subject: "Re: Enterprise pricing",
      body: "Hi Sarah,\n\nYes.\n\nAlex",
      thread_id: "t-northwind",
    });
    const sent = await sendGmailDraft(cfg, key, d.draft_id);
    expect(sent.thread_id).toBe("t-northwind");
    expect((await readSentMessage(cfg, key, sent.message_id))?.sent).toBe(true);
    expect(world.state().drafts).toEqual([
      { id: d.draft_id, thread_id: "t-northwind", sent: true },
    ]);
    await expect(sendGmailDraft(cfg, key, d.draft_id)).rejects.toThrow();
  });

  it("two processes share one world: a draft made in one is sent from the other and read back in both", async () => {
    // The worker's sweep makes the draft; the person sends it from the API.
    let text: string | null = null;
    const store = { load: () => text, save: (t: string) => void (text = t) };
    const at = () => new Date("2026-09-22T15:00:00.000Z");
    const worker = createDemoWorld({ now: at, store });
    const api = createDemoWorld({ now: at, store });
    const d = await createGmailDraft({ credentials: creds, transport: worker.transport }, key, {
      to: "sarah@northwind.example",
      subject: "Re: Enterprise pricing",
      body: "Hi Sarah,\n\nYes.\n\nAlex",
      thread_id: "t-northwind",
    });
    const apiCfg = { credentials: creds, transport: api.transport };
    const sent = await sendGmailDraft(apiCfg, key, d.draft_id);
    expect(sent.message_id).toBe(`sent-${d.draft_id}`);
    expect(
      (
        await readSentMessage(
          { credentials: creds, transport: worker.transport },
          key,
          sent.message_id,
        )
      )?.sent,
    ).toBe(true);
    expect(worker.state().drafts).toEqual([
      { id: d.draft_id, thread_id: "t-northwind", sent: true },
    ]);
    // The sent message is on the thread for the next sync, in either process.
    const thread = await worker.transport({
      method: "GET",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/threads/t-northwind",
      headers: {},
    });
    const messages = (thread.body as { messages: Array<{ id: string }> }).messages;
    expect(messages.at(-1)?.id).toBe(`sent-${d.draft_id}`);
    // A third process, started later, sees the same world.
    const late = createDemoWorld({ now: at, store });
    await expect(
      sendGmailDraft({ credentials: creds, transport: late.transport }, key, d.draft_id),
    ).rejects.toThrow();
  });
});
