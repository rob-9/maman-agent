import { z } from "zod";
import { promptSafeText } from "./provider.js";

/**
 * THE AGENT PASS, as a contract.
 *
 * Input: the candidate the detector found, plus the thread content and the
 * facts around it (deal, meeting). Every free-text field is bounded and
 * refuses secret-shaped values before it can reach a model.
 *
 * Output: a judgment, not a list. `owed` narrows (false hides the item while
 * the agent is on), `ask` and `summary` annotate the card, `urgency` reorders
 * within the detector's band. Nothing here can create an obligation, change a
 * deal value, or touch a permission. Both providers implement it: the
 * deterministic one by rules, so the whole path runs with no key, and the
 * Anthropic one by model, with this schema as the gate on the way back.
 */

export const assessmentMessageSchema = z
  .object({
    from: promptSafeText(200),
    direction: z.enum(["inbound", "outbound"]),
    sent_at: z.string().datetime(),
    /** Plain text, quoted history stripped, bounded. Never HTML. */
    text: promptSafeText(4000),
  })
  .strict();
export type AssessmentMessage = z.infer<typeof assessmentMessageSchema>;

export const meetingRefSchema = z
  .object({ title: promptSafeText(200), at: z.string().datetime() })
  .strict();
export type MeetingRef = z.infer<typeof meetingRefSchema>;

export const assessmentInputSchema = z
  .object({
    kind: z.enum(["awaiting_you", "awaiting_them", "unsent_followup"]),
    contact_display_name: promptSafeText(120),
    account_name: promptSafeText(120).nullable(),
    subject: promptSafeText(300),
    days_elapsed: z.number().int().nonnegative(),
    has_open_deal: z.boolean().nullable(),
    open_deal_value: z.number().nonnegative().optional(),
    last_meeting_at: z.string().datetime().optional(),
    /** The last meeting with this person, and the next one booked, when known. */
    last_meeting: meetingRefSchema.extend({ notes: promptSafeText(1500).optional() }).optional(),
    next_meeting: meetingRefSchema.optional(),
    /** Oldest first. The last one is the message the obligation hinges on. */
    messages: z.array(assessmentMessageSchema).min(1).max(8),
    /** The relationship so far: other threads with this person, newest first. */
    history: z
      .array(
        z
          .object({
            subject: promptSafeText(300),
            last_message_at: z.string().datetime(),
            last_direction: z.enum(["inbound", "outbound"]),
            message_count: z.number().int().positive(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
export type AssessmentInput = z.infer<typeof assessmentInputSchema>;

export const assessmentOutputSchema = z
  .object({
    /** Is a follow-up actually owed? False hides the item while the agent is on. */
    owed: z.boolean(),
    /** What they are waiting on, in a few words. Empty when nothing specific. */
    ask: z.string().max(200),
    /** One sentence for the card. */
    summary: z.string().min(1).max(240),
    urgency: z.enum(["high", "normal", "low"]),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type AssessmentOutput = z.infer<typeof assessmentOutputSchema>;

const CLOSED_LOOP =
  /\b(thanks?|thank you|all set|no need|not interested|we'?ll pass|unsubscribe|got it,? thanks|sounds good,? thanks)\b/i;
const AUTOMATED =
  /\b(out of office|automatic reply|auto-?reply|do not reply|noreply|no-reply|unsubscribe)\b/i;

/** "Thursday", in UTC; the model and the card get the same word. */
export function weekday(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

/** The sentence holding the last question mark, trimmed to the field bound. */
export function lastQuestion(text: string): string {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const q = [...sentences].reverse().find((s) => s.includes("?"));
  return q ? q.slice(0, 200) : "";
}

/**
 * Rules, not a model. Same input, same judgment, always. Good enough to run
 * the whole path without a key, and the floor the model has to beat.
 */
export function assessDeterministically(input: AssessmentInput): AssessmentOutput {
  const last = input.messages[input.messages.length - 1]!;
  const lastInbound = [...input.messages].reverse().find((m) => m.direction === "inbound");
  const who = input.contact_display_name;
  const money =
    input.has_open_deal === true && input.open_deal_value !== undefined
      ? ` ($${Math.round(input.open_deal_value).toLocaleString("en-US")} open)`
      : "";
  const late = input.days_elapsed;

  if (input.kind === "awaiting_you") {
    const text = last.text;
    if (AUTOMATED.test(text)) {
      return {
        owed: false,
        ask: "",
        summary: `The last message from ${who} looks automated; nothing is owed.`,
        urgency: "low",
        confidence: 0.7,
      };
    }
    const ask = lastQuestion(text);
    if (!ask && CLOSED_LOOP.test(text)) {
      return {
        owed: false,
        ask: "",
        summary: `${who} closed the loop; nothing is owed.`,
        urgency: "low",
        confidence: 0.6,
      };
    }
    const urgency = ask && (late >= 4 || input.has_open_deal === true) ? "high" : "normal";
    return {
      owed: true,
      ask,
      summary: ask
        ? `${who} asked: "${ask.slice(0, 120)}" ${late} days ago and has no answer${money}.`
        : `${who} wrote ${late} days ago and is still waiting on you${money}.`,
      urgency,
      confidence: ask ? 0.8 : 0.6,
    };
  }

  if (input.kind === "unsent_followup") {
    const met = input.last_meeting ? ` for "${input.last_meeting.title.slice(0, 80)}"` : "";
    return {
      owed: true,
      ask: "",
      summary: `You met ${who}${met} and nothing has gone out since${money}.`,
      urgency: input.has_open_deal === true ? "high" : "normal",
      confidence: 0.7,
    };
  }

  // A meeting already booked with this person is the follow-up.
  if (input.kind === "awaiting_them" && input.next_meeting) {
    return {
      owed: false,
      ask: "",
      summary: `You are meeting ${who} for "${input.next_meeting.title.slice(0, 80)}" on ${weekday(input.next_meeting.at)}; no chase needed.`,
      urgency: "low",
      confidence: 0.8,
    };
  }

  // awaiting_them: you wrote, they went quiet. A follow-up is owed unless
  // their last word closed it.
  if (lastInbound && CLOSED_LOOP.test(lastInbound.text) && !lastQuestion(lastInbound.text)) {
    return {
      owed: false,
      ask: "",
      summary: `${who} had already closed this out; no follow-up needed.`,
      urgency: "low",
      confidence: 0.5,
    };
  }
  return {
    owed: true,
    ask: "",
    summary: `You wrote ${who} ${late} days ago about "${input.subject.slice(0, 80)}" and heard nothing back${money}.`,
    urgency: input.has_open_deal === true && late >= 7 ? "high" : "normal",
    confidence: 0.6,
  };
}
