import { z } from "zod";

/**
 * L2 — drafting. This is the DETERMINISTIC first cut, and it exists so the
 * pipeline (obligation → draft in the person's Drafts folder) is proven end to
 * end before a model is in it. The model version implements the same
 * `DraftComposer` and drops in behind the interface; nothing upstream or
 * downstream changes.
 *
 * What it must never do, model or not: invent a fact. With `gmail.metadata`
 * we know the subject, who, and how long — we do NOT know what was said. So
 * the draft names the gap ("following up on ...") and stops. A confident
 * sentence about content we have not read is the one thing that would make a
 * person stop trusting the drafts.
 */

export const composeInputSchema = z
  .object({
    kind: z.enum(["awaiting_you", "awaiting_them", "unsent_followup"]),
    contact_display_name: z.string().min(1),
    contact_address: z.string().min(1),
    account_name: z.string().nullable(),
    subject: z.string(),
    days_elapsed: z.number().int().nonnegative(),
    /** The sender's own name, for the sign-off. */
    sender_name: z.string().min(1),
  })
  .strict();
export type ComposeInput = z.infer<typeof composeInputSchema>;

export type ComposedDraft = {
  to: string;
  subject: string;
  body: string;
  /** Which composer produced it. Provenance, so a receipt can say. */
  composer: "deterministic" | "model";
};

export interface DraftComposer {
  compose(input: ComposeInput): Promise<ComposedDraft>;
}

/** "Sarah Chen" → "Sarah"; "sarah@acme.com" → "there". Never guesses a name from an address. */
export function firstNameOf(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed === "" || trimmed.includes("@")) return "there";
  return trimmed.split(/\s+/)[0]!;
}

function replySubject(subject: string): string {
  const s = subject.trim() || "our conversation";
  return /^re:\s*/i.test(s) ? s : `Re: ${s}`;
}

/** Deterministic composer. Same input, same draft, always. */
export const deterministicComposer: DraftComposer = {
  async compose(raw) {
    const input = composeInputSchema.parse(raw);
    const first = firstNameOf(input.contact_display_name);
    const topic = input.subject.trim() || "our conversation";
    const when =
      input.days_elapsed <= 1
        ? "yesterday"
        : input.days_elapsed < 7
          ? "earlier this week"
          : `${input.days_elapsed} days ago`;

    const opening =
      input.kind === "awaiting_you"
        ? `Thanks for your note on "${topic}" — apologies for the slow reply.`
        : input.kind === "unsent_followup"
          ? `Good to meet ${when} — following up on "${topic}".`
          : `Following up on "${topic}" from ${when}.`;

    const ask =
      input.kind === "awaiting_you"
        ? "Let me get you a proper answer — what's the best next step on your side?"
        : "Would it help to find a time this week to pick this up?";

    return {
      to: input.contact_address,
      subject: replySubject(input.subject),
      body: `Hi ${first},\n\n${opening}\n\n${ask}\n\nBest,\n${input.sender_name}\n`,
      composer: "deterministic",
    };
  },
};
