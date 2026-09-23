import { describe, expect, it } from "vitest";
import { createDemoWorld, DEMO_SALESFORCE_INSTANCE } from "../src/demo-world.js";
import {
  syncGmailThreads,
  salesforceActivityWriter,
  salesforceOpportunityWriter,
  salesforceDealSource,
  createGmailDraft,
  syncCalendarEvents,
} from "../src/index.js";
import type { CredentialProvider, UserCredentialProvider } from "../src/index.js";

const NOW = new Date("2026-09-22T15:00:00.000Z");
const world = createDemoWorld({ now: () => NOW });
const userCreds: UserCredentialProvider = {
  load: async () => ({ access_token: "t" }),
  refresh: async () => ({ access_token: "t" }),
};
const orgCreds: CredentialProvider = {
  load: async () => ({ access_token: "t", instance_url: DEMO_SALESFORCE_INSTANCE }),
  refresh: async () => ({ access_token: "t", instance_url: DEMO_SALESFORCE_INSTANCE }),
};
const key = { organization_id: "org", user_id: "u" };

describe("the demo world answers the real adapters", () => {
  it("a mailbox with a story: threads both ways, full bodies, the person's own address", async () => {
    const r = await syncGmailThreads({ credentials: userCreds, transport: world.transport }, key, {
      max_threads: 50,
      newer_than_days: 60,
    });
    expect(r.self_addresses).toEqual([world.self]);
    expect(r.threads.length).toBe(8);
    const sarah = r.threads.find((t) => t.subject.includes("Enterprise pricing"))!;
    expect(sarah.last_direction).toBe("inbound");
    expect(sarah.contact.address).toBe("sarah@northwind.example");
    expect(sarah.messages?.at(-1)?.text ?? "").toContain("Next step: send over the MSA");
    const bob = r.threads.find((t) => t.subject === "Renewal proposal")!;
    expect(bob.last_direction).toBe("outbound");
  });

  it("a calendar with meetings held and one booked, and a sync token on the second read", async () => {
    const first = await syncCalendarEvents(
      { credentials: userCreds, transport: world.transport },
      key,
      { self_addresses: [world.self], now: () => NOW },
    );
    expect(first.meetings.length).toBe(6);
    expect(first.meetings.some((m) => m.title.includes("Contract review"))).toBe(true);
    expect(first.next_sync_token).toBe("demo-cal-sync");
    const second = await syncCalendarEvents(
      { credentials: userCreds, transport: world.transport },
      key,
      { sync_token: "demo-cal-sync", self_addresses: [world.self], now: () => NOW },
    );
    expect(second.meetings.length).toBe(0);
  });

  it("a Salesforce that knows the deals, takes a task and reads it back, and updates an opportunity in place", async () => {
    const deals = salesforceDealSource({ credentials: orgCreds, transport: world.transport });
    const answer = await deals.lookup(key, [
      "sarah@northwind.example",
      "dan@fable.example",
      "nobody@x.example",
    ]);
    expect(answer.signals.find((s) => s.address === "sarah@northwind.example")).toMatchObject({
      has_open_deal: true,
      open_deal_value: 48_000,
    });
    expect(answer.signals.find((s) => s.address === "dan@fable.example")).toBeUndefined();
    const writer = salesforceActivityWriter({ credentials: orgCreds, transport: world.transport });
    const contact = await writer.findContact("org", "sarah@northwind.example");
    expect(contact?.id).toBe("003NW01");
    expect(await writer.findOpenOpportunity("org", "003NW01")).toBe("006NW01");
    const task = await writer.createTask("org", {
      who_id: "003NW01",
      what_id: "006NW01",
      subject: "Email: Enterprise pricing",
      description: "[maman:abc]",
      activity_date: "2026-09-22",
    });
    expect((await writer.readTask("org", task.id))?.description).toBe("[maman:abc]");
    expect((await writer.findTaskByMarker("org", "[maman:abc]"))?.id).toBe(task.id);
    await writer.deleteTask("org", task.id);
    expect(await writer.readTask("org", task.id)).toBeNull();
    const opps = salesforceOpportunityWriter({ credentials: orgCreds, transport: world.transport });
    await opps.updateOpportunity("org", "006NW01", { next_step: "Send the MSA" });
    expect((await opps.readOpportunity("org", "006NW01"))?.next_step).toBe("Send the MSA");
    expect(world.state().opportunities.find((o) => o["Id"] === "006NW01")?.["NextStep"]).toBe(
      "Send the MSA",
    );
  });

  it("a draft lands in the world and is never sent; the token exchange always answers", async () => {
    const d = await createGmailDraft({ credentials: userCreds, transport: world.transport }, key, {
      to: "sarah@northwind.example",
      subject: "Re: Enterprise pricing",
      body: "Hi Sarah",
      thread_id: "t-northwind",
    });
    expect(d.draft_id).toBe("draft-1");
    expect(world.state().drafts).toEqual([{ id: "draft-1", thread_id: "t-northwind" }]);
    const tok = await world.token("https://any", {
      grant_type: "authorization_code",
      code: "demo",
    });
    expect(tok.status).toBe(200);
    expect((tok.body as { instance_url: string }).instance_url).toBe(DEMO_SALESFORCE_INSTANCE);
  });
});
