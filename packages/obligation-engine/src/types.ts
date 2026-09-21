import { z } from "zod";

/**
 * L1 — what a person is about to drop.
 *
 * The customer's stated #1 cause of lost deals is forgetting to follow up:
 * "if it's not surfaced in my CRM, I won't be reminded". This package is that
 * reminder, and it is DELIBERATELY MODEL-FREE.
 *
 * A model could plausibly rank these, and it must not. The whole credibility of
 * the product rests on the first screen being right: a list containing threads
 * that are actually finished teaches the user to ignore it, and a list that
 * cannot explain itself cannot be trusted with anything larger. Every
 * obligation here carries the facts that produced it, so the UI can say WHY
 * rather than asserting.
 *
 * Where judgement genuinely is needed — "did they answer, or did I leave this
 * hanging?" — that is a separate, typed classification step that NARROWS this
 * list. It never adds to it, and it never reorders it.
 */

/** Who owes the next move. */
export const obligationKind = z.enum([
  /** They replied; the ball is with the user. The most urgent kind. */
  "awaiting_you",
  /** The user sent; no reply yet. The classic forgotten follow-up. */
  "awaiting_them",
  /** A meeting happened and nothing was sent afterwards. */
  "unsent_followup",
]);
export type ObligationKind = z.infer<typeof obligationKind>;

/** Which way the last message travelled. */
export const direction = z.enum(["outbound", "inbound"]);
export type Direction = z.infer<typeof direction>;

/**
 * A conversation, projected from whichever connector supplied it.
 *
 * Content-free by design: a subject line and participants are enough to detect
 * an obligation, and the body is only fetched later, for the one thread the
 * user asked to draft against. Detection never needs it.
 */
export const threadSchema = z
  .object({
    thread_id: z.string().min(1),
    contact_id: z.string().min(1),
    subject: z.string(),
    last_message_at: z.string().datetime(),
    last_direction: direction,
    /** Messages exchanged, used to tell a real conversation from a one-shot. */
    message_count: z.number().int().positive(),
  })
  .strict();
export type Thread = z.infer<typeof threadSchema>;

export const contactSchema = z
  .object({
    contact_id: z.string().min(1),
    display_name: z.string().min(1),
    account_name: z.string().optional(),
    /** Open deal value in whole currency units, when the CRM has one. */
    open_deal_value: z.number().nonnegative().optional(),
    /** False for a closed/won/lost relationship — no obligation is owed. */
    has_open_deal: z.boolean(),
    /** Last meeting, from the calendar connector. */
    last_meeting_at: z.string().datetime().optional(),
  })
  .strict();
export type Contact = z.infer<typeof contactSchema>;

/**
 * The facts that produced an obligation.
 *
 * Carried rather than rendered, so the UI writes the sentence and this package
 * stays presentation-free — and so a reviewer can check the arithmetic without
 * re-running the detector.
 */
export const obligationReasonSchema = z
  .object({
    kind: obligationKind,
    days_elapsed: z.number().int().nonnegative(),
    threshold_days: z.number().int().positive(),
    last_direction: direction,
    message_count: z.number().int().positive(),
    has_open_deal: z.boolean(),
    open_deal_value: z.number().nonnegative().optional(),
  })
  .strict();
export type ObligationReason = z.infer<typeof obligationReasonSchema>;

export const obligationSchema = z
  .object({
    thread_id: z.string().min(1),
    contact_id: z.string().min(1),
    kind: obligationKind,
    /** Higher is more urgent. Comparable only within one detection run. */
    rank: z.number().nonnegative(),
    reason: obligationReasonSchema,
  })
  .strict();
export type Obligation = z.infer<typeof obligationSchema>;

/**
 * Tunable thresholds.
 *
 * Exposed because a two-day silence means different things in different sales
 * motions, and hard-coding it would make the product wrong for half its users.
 * Note this is NOT a workflow builder — it is a handful of numbers with
 * defaults that work, not a canvas someone has to maintain.
 */
export const detectionConfigSchema = z
  .object({
    /** Silence after THEY wrote, before the user is told they owe a reply. */
    awaiting_you_days: z.number().int().positive().default(2),
    /** Silence after the USER wrote, before it counts as a forgotten follow-up. */
    awaiting_them_days: z.number().int().positive().default(5),
    /** Silence after a meeting with nothing sent. */
    unsent_followup_days: z.number().int().positive().default(1),
    /**
     * Beyond this, a thread is stale rather than pending, and surfacing it is
     * noise. Without a ceiling the list fills with months-old threads that
     * quietly outrank this week's real work.
     */
    max_days: z.number().int().positive().default(45),
    /** Deal value that counts as "large" when ranking. Scales the value term. */
    value_normalizer: z.number().positive().default(50_000),
  })
  .strict();
export type DetectionConfig = z.infer<typeof detectionConfigSchema>;

export const DEFAULT_DETECTION_CONFIG: DetectionConfig = detectionConfigSchema.parse({});
