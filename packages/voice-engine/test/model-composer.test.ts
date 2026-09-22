import { describe, expect, it, vi } from "vitest";
import {
  DeterministicModelProvider,
  type DraftInput,
  type ModelProvider,
} from "@maman/model-provider";
import { deterministicContextComposer, modelComposer } from "../src/model-composer.js";

const input: DraftInput = {
  kind: "awaiting_you",
  contact_display_name: "Sarah Chen",
  contact_address: "sarah@acme.com",
  account_name: null,
  subject: "Pricing",
  days_elapsed: 4,
  has_open_deal: null,
  sender_name: "Alex",
  sender_address: "alex@co.example",
  messages: [
    {
      from: "Sarah Chen",
      direction: "inbound",
      sent_at: "2026-09-17T09:00:00.000Z",
      text: "Can you confirm 60 seats?",
    },
  ],
  voice: {
    to_this_contact: ["Hey Sarah, on it.\n\nCheers,\nAlex"],
    similar_situations: [],
    recent: [],
  },
};
const template = deterministicContextComposer(new DeterministicModelProvider());
const provider = (compose: ModelProvider["composeDraft"]) => ({ composeDraft: vi.fn(compose) });

describe("the model composer", () => {
  it("uses the model's draft when it is grounded, addressed to the contact, with provenance", async () => {
    const p = provider(async () => ({
      ok: true,
      value: { subject: "Re: Pricing", body: "Hey Sarah, yes, 60 seats is fine.\n\nCheers,\nAlex" },
      usage: { input_tokens: 1, output_tokens: 1, model_alias: "m" },
    }));
    const d = await modelComposer({ provider: p, fallback: template }).compose(input);
    expect(d).toEqual({
      to: "sarah@acme.com",
      subject: "Re: Pricing",
      body: "Hey Sarah, yes, 60 seats is fine.\n\nCheers,\nAlex",
      composer: "model",
      model_alias: "m",
    });
    // The voice went with the request.
    expect(p.composeDraft.mock.calls[0]![0]!.voice.to_this_contact).toEqual([
      "Hey Sarah, on it.\n\nCheers,\nAlex",
    ]);
  });

  it("falls back to the template when the model fails, and says why", async () => {
    const p = provider(async () => ({ ok: false, error: "unavailable" }));
    const d = await modelComposer({ provider: p, fallback: template }).compose(input);
    expect(d.composer).toBe("deterministic");
    expect(d.fallback_reason).toBe("model unavailable");
    expect(d.body.startsWith("Hi Sarah,")).toBe(true);
  });

  it("falls back when the model invents a fact, and names the violation", async () => {
    const p = provider(async () => ({
      ok: true,
      value: {
        subject: "Re: Pricing",
        body: "Hey Sarah, 60 seats at $12,000 works. Let's book a demo.",
      },
      usage: { input_tokens: 1, output_tokens: 1, model_alias: "m" },
    }));
    const d = await modelComposer({ provider: p, fallback: template }).compose(input);
    expect(d.composer).toBe("deterministic");
    expect(d.fallback_reason).toContain("money: $12,000");
    expect(d.fallback_reason).toContain("claim: demo");
  });
});
