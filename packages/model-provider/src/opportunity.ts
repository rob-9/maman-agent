import { z } from "zod";
import { promptSafeText } from "./provider.js";
import { assessmentMessageSchema, meetingRefSchema } from "./assessment.js";

/**
 * FACTS READ FROM THE THREAD, for the opportunity record: the next step and
 * the close date. These are claims about what was said, so every one
 * carries the sentence it came from, and the sentence is checked against
 * the thread in code (`groundOpportunityUpdate`). No quote, no update. A
 * close date is accepted only when our own date reading of the quote agrees
 * with the value, so a model cannot invent a date the sentence does not
 * hold.
 */

export const opportunityInputSchema = z
  .object({
    contact_display_name: promptSafeText(120),
    account_name: promptSafeText(120).nullable(),
    subject: promptSafeText(300),
    current: z
      .object({
        stage: promptSafeText(120).nullable(),
        next_step: promptSafeText(255).nullable(),
        close_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
      })
      .strict(),
    /** Oldest first; the last is the latest word. */
    messages: z.array(assessmentMessageSchema).min(1).max(8),
    next_meeting: meetingRefSchema.optional(),
    /** The person's own instructions that bear on this. */
    preferences: z.array(promptSafeText(300)).max(12).optional(),
  })
  .strict();
export type OpportunityInput = z.infer<typeof opportunityInputSchema>;

export const opportunityOutputSchema = z
  .object({
    next_step: z
      .object({
        /** A short excerpt of the quote, never a paraphrase with new facts. */
        value: z.string().min(1).max(255),
        /** The sentence in the thread this comes from, verbatim. */
        quote: z.string().min(1).max(400),
      })
      .strict()
      .nullable(),
    close_date: z
      .object({
        value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        quote: z.string().min(1).max(400),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type OpportunityOutput = z.infer<typeof opportunityOutputSchema>;

// ---- reading dates the way people write them ----

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * The date a sentence names, relative to when it was written. Returns null
 * when the sentence names none, or names it ambiguously. Conservative on
 * purpose: a wrong close date on a forecast is worse than none.
 */
export function readDate(text: string, writtenAt: string): string | null {
  const at = new Date(writtenAt);
  if (Number.isNaN(at.getTime())) return null;
  const t = text.toLowerCase();
  const year = at.getUTCFullYear();

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const eoq = /\bend of (?:the |this )?quarter\b|\beoq\b/.exec(t);
  if (eoq) {
    const q = Math.floor(at.getUTCMonth() / 3);
    return ymd(new Date(Date.UTC(year, q * 3 + 3, 0)));
  }
  const eom = /\bend of (?:the |this )?month\b|\beom\b/.exec(t);
  if (eom) return ymd(new Date(Date.UTC(year, at.getUTCMonth() + 1, 0)));
  const eoy = /\bend of (?:the |this )?year\b|\beoy\b/.exec(t);
  if (eoy) return `${year}-12-31`;

  const monthDay = new RegExp(
    `\\b(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`,
  ).exec(t);
  if (monthDay) {
    const mi = MONTHS.findIndex((m) => m.startsWith(monthDay[1]!.slice(0, 3)));
    const day = Number(monthDay[2]);
    let y = monthDay[3] ? Number(monthDay[3]) : year;
    // "January 5" said in December means next year.
    if (!monthDay[3] && mi < at.getUTCMonth() - 1) y += 1;
    const d = new Date(Date.UTC(y, mi, day));
    return d.getUTCMonth() === mi ? ymd(d) : null;
  }
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (numeric) {
    const m = Number(numeric[1]);
    const day = Number(numeric[2]);
    const y = numeric[3]
      ? numeric[3].length === 2
        ? 2000 + Number(numeric[3])
        : Number(numeric[3])
      : year;
    if (m >= 1 && m <= 12) {
      const d = new Date(Date.UTC(y, m - 1, day));
      return d.getUTCMonth() === m - 1 ? ymd(d) : null;
    }
  }
  const weekday = new RegExp(`\\b(?:by |on |before |this |next )?(${WEEKDAYS.join("|")})\\b`).exec(
    t,
  );
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1]!);
    const delta = (target - at.getUTCDay() + 7) % 7 || 7;
    const d = new Date(at.getTime());
    d.setUTCDate(d.getUTCDate() + delta + (/\bnext /.test(weekday[0]) ? 7 : 0));
    return ymd(d);
  }
  return null;
}

export type OpportunityGrounding = { ok: true } | { ok: false; violations: string[] };

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Every quote must be in the thread verbatim; a close date must be what the quote says. */
export function groundOpportunityUpdate(
  output: OpportunityOutput,
  messages: readonly { text: string; sent_at: string }[],
): OpportunityGrounding {
  const violations: string[] = [];
  const find = (quote: string) => messages.find((m) => norm(m.text).includes(norm(quote)));
  if (output.next_step) {
    const m = find(output.next_step.quote);
    if (!m) violations.push("next_step: quote not in thread");
    else if (
      !norm(output.next_step.quote).includes(norm(output.next_step.value)) &&
      norm(output.next_step.value) !== norm(output.next_step.quote)
    ) {
      violations.push("next_step: value is not an excerpt of the quote");
    }
  }
  if (output.close_date) {
    const m = find(output.close_date.quote);
    if (!m) violations.push("close_date: quote not in thread");
    else {
      const read = readDate(output.close_date.quote, m.sent_at);
      if (read !== output.close_date.value)
        violations.push(
          `close_date: the quote reads as ${read ?? "no date"}, not ${output.close_date.value}`,
        );
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

// ---- the deterministic reading ----

const NEXT_STEP_PATTERNS = [
  /\bnext steps?\s*(?:is|are|:)\s*([^.!?\n]{6,200})/i,
  /\b(?:i|we)(?:'ll| will)\s+(send|share|get|put|set up|schedule|circulate|forward|draft|prepare|review|confirm)\s+([^.!?\n]{4,180})/i,
  /\b(?:can|could) you\s+(send|share|confirm|review|sign|forward|approve)\s+([^.!?\n]{4,180})/i,
];
const CLOSE_PATTERNS = [
  /\b(?:close|sign|wrap(?: this)? up|finalize|finalise|get this done|have (?:this|it) (?:signed|done))\b[^.!?\n]{0,80}?\b(by|before|end of|eoq|eom|eoy)\b[^.!?\n]{0,60}/i,
  /\b(?:by|before)\s+(?:end of (?:the |this )?(?:quarter|month|year)|eoq|eom|eoy)\b/i,
];

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Rules, no model. Reads the latest message for an explicit next step and
 * for a sentence about when the deal closes. Proposes a field only when it
 * differs from what the record holds.
 */
export function readOpportunityDeterministically(input: OpportunityInput): OpportunityOutput {
  const last = input.messages[input.messages.length - 1]!;
  const out: OpportunityOutput = { next_step: null, close_date: null };
  for (const s of sentences(last.text)) {
    if (!out.next_step) {
      for (const re of NEXT_STEP_PATTERNS) {
        const m = re.exec(s);
        if (m) {
          const value = (m[2] ? `${m[1]} ${m[2]}` : m[1]!)
            .trim()
            .replace(/[,;]$/, "")
            .slice(0, 255);
          if (value.length >= 6 && norm(value) !== norm(input.current.next_step ?? "")) {
            out.next_step = { value, quote: s.slice(0, 400) };
          }
          break;
        }
      }
    }
    if (!out.close_date) {
      for (const re of CLOSE_PATTERNS) {
        if (re.test(s)) {
          const value = readDate(s, last.sent_at);
          if (value && value !== input.current.close_date)
            out.close_date = { value, quote: s.slice(0, 400) };
          break;
        }
      }
    }
  }
  return out;
}
