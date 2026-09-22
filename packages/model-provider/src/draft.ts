import { z } from "zod";
import { promptSafeText } from "./provider.js";
import { assessmentMessageSchema, meetingRefSchema, weekday } from "./assessment.js";

/**
 * THE DRAFT, as a contract.
 *
 * Voice comes from everything the person has written: their messages to this
 * contact, their past follow-ups in the same situation, and a sample of their
 * recent writing. Facts come only from the thread and the facts we hold. The
 * model may sound like them; it may not claim anything the thread does not
 * support. That second rule is enforced by `groundDraft`, not by asking.
 */

const exemplar = promptSafeText(2000);

export const draftInputSchema = z
  .object({
    kind: z.enum(["awaiting_you", "awaiting_them", "unsent_followup"]),
    contact_display_name: promptSafeText(120),
    contact_address: promptSafeText(200),
    account_name: promptSafeText(120).nullable(),
    subject: promptSafeText(300),
    days_elapsed: z.number().int().nonnegative(),
    has_open_deal: z.boolean().nullable(),
    open_deal_value: z.number().nonnegative().optional(),
    last_meeting_at: z.string().datetime().optional(),
    last_meeting: meetingRefSchema.extend({ notes: promptSafeText(1500).optional() }).optional(),
    next_meeting: meetingRefSchema.optional(),
    sender_name: promptSafeText(120),
    sender_address: promptSafeText(200),
    /** Oldest first; the last is what the draft answers. */
    messages: z.array(assessmentMessageSchema).min(1).max(8),
    /** The agent's judgment, when it has one: what they are waiting on. */
    ask: promptSafeText(200).optional(),
    voice: z
      .object({
        to_this_contact: z.array(exemplar).max(3),
        similar_situations: z.array(exemplar).max(3),
        recent: z.array(exemplar).max(4),
      })
      .strict(),
  })
  .strict();
export type DraftInput = z.infer<typeof draftInputSchema>;

export const draftOutputSchema = z
  .object({
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(6000),
  })
  .strict();
export type DraftOutput = z.infer<typeof draftOutputSchema>;

// ---- grounding: what a draft may and may not say ----

/** Words that commit the sender to something. Allowed only when the thread said them. */
const RISK_WORDS = [
  "meeting",
  "call",
  "demo",
  "contract",
  "invoice",
  "discount",
  "refund",
  "cancel",
  "signed",
  "approved",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export type GroundingSources = {
  messages: readonly { text: string }[];
  subject: string;
  days_elapsed: number;
  open_deal_value?: number | undefined;
  ask?: string | undefined;
  /** A meeting is a fact: its title, its weekday and its date may be named. */
  meetings?: readonly { title: string; at: string; notes?: string | undefined }[] | undefined;
};

/** The ways a date is written in a sentence. */
function dateForms(iso: string): string[] {
  const d = new Date(iso);
  return [
    weekday(iso),
    d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }),
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    String(d.getUTCDate()),
  ];
}

export type GroundingResult = { ok: true } | { ok: false; violations: string[] };

/**
 * Every number, sum of money, URL and committing word in the draft must
 * appear in the thread, the subject, or a fact we hold. The person's voice
 * exemplars are deliberately NOT a source: a number from another deal is
 * exactly the kind of thing that must not leak into this one.
 */
export function groundDraft(body: string, sources: GroundingSources): GroundingResult {
  const haystack = [
    ...sources.messages.map((m) => m.text),
    sources.subject,
    sources.ask ?? "",
    String(sources.days_elapsed),
    ...(sources.open_deal_value !== undefined
      ? [
          String(sources.open_deal_value),
          Math.round(sources.open_deal_value).toLocaleString("en-US"),
        ]
      : []),
    ...(sources.meetings ?? []).flatMap((m) => [m.title, m.notes ?? "", ...dateForms(m.at)]),
  ]
    .join("\n")
    .toLowerCase();
  const violations: string[] = [];
  const seen = new Set<string>();
  const check = (token: string, label: string) => {
    const t = token.toLowerCase();
    if (seen.has(t)) return;
    seen.add(t);
    if (!haystack.includes(t)) violations.push(`${label}: ${token}`);
  };
  for (const m of body.matchAll(/https?:\/\/\S+/gi)) check(m[0].replace(/[).,]+$/, ""), "url");
  for (const m of body.matchAll(/\$\s?[\d,]+(?:\.\d+)?/g)) {
    const digits = m[0].replace(/[^\d.]/g, "");
    const t = `${digits}`;
    if (seen.has(t)) continue;
    seen.add(t);
    const n = Number(digits);
    const forms = [digits, Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : digits];
    if (!forms.some((f) => haystack.includes(f.toLowerCase()))) violations.push(`money: ${m[0]}`);
  }
  // Percentages of any size, then plain numbers of two or more digits.
  for (const m of body.matchAll(/\b\d+(?:[.,]\d+)?%/g)) check(m[0], "number");
  for (const m of body.matchAll(/\b\d{2,}(?:[.,]\d+)?\b(?!%)/g)) check(m[0], "number");
  const words = body.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const w of new Set(words)) if (RISK_WORDS.includes(w)) check(w, "claim");
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

// ---- the deterministic draft: grounded by construction ----

/** "Sarah Chen" → "Sarah"; an address → "there". Never guesses a name from an address. */
export function firstName(displayName: string): string {
  const t = displayName.trim();
  if (t === "" || t.includes("@")) return "there";
  return t.split(/\s+/)[0]!;
}

/** The sign-off the person actually uses, from their own writing; else a plain one. */
export function signOffFrom(exemplars: readonly string[], senderName: string): string {
  for (const text of exemplars) {
    const lines = text
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const tail = lines.slice(-2);
    const closing = tail.find((l) =>
      /^(best|thanks|thank you|cheers|regards|kind regards|talk soon|warmly|all the best)[,!.]?$/i.test(
        l,
      ),
    );
    if (closing) return `${closing.replace(/[,!.]?$/, ",")}\n${senderName}`;
  }
  return `Best,\n${senderName}`;
}

export function composeDeterministically(input: DraftInput): DraftOutput {
  const first = firstName(input.contact_display_name);
  const topic = input.subject.trim() || "our conversation";
  const when =
    input.days_elapsed <= 1
      ? "yesterday"
      : input.days_elapsed < 7
        ? "earlier this week"
        : `${input.days_elapsed} days ago`;
  const ask = input.ask?.trim();
  let opening: string;
  let close: string;
  if (input.kind === "awaiting_you") {
    opening = ask
      ? `Thanks for your note on "${topic}", and apologies for the slow reply. On your question, "${ask}":`
      : `Thanks for your note on "${topic}", and apologies for the slow reply.`;
    close = ask
      ? "Let me get you a proper answer on that today. Is there anything else you need alongside it?"
      : "Let me get you a proper answer. What is the best next step on your side?";
  } else if (input.kind === "unsent_followup") {
    opening = input.last_meeting
      ? `Good to meet ${when} for "${input.last_meeting.title}". Following up on "${topic}".`
      : `Good to meet ${when}. Following up on "${topic}".`;
    close = "Would it help to find a time this week to pick this up?";
  } else {
    opening = `Following up on "${topic}" from ${when}.`;
    close = "Would it help to find a time this week to pick this up?";
  }
  const signOff = signOffFrom(
    [...input.voice.to_this_contact, ...input.voice.similar_situations, ...input.voice.recent],
    input.sender_name,
  );
  const subject = /^re:\s*/i.test(topic) ? topic : `Re: ${topic}`;
  return { subject, body: `Hi ${first},\n\n${opening}\n\n${close}\n\n${signOff}\n` };
}
