import {
  DEFAULT_DETECTION_CONFIG,
  type Contact,
  type DetectionConfig,
  type Obligation,
  type ObligationKind,
  type Thread,
} from "./types.js";

/**
 * Deterministic obligation detection. Same inputs, same output, always.
 *
 * No model, no network, no clock of its own — `now` is passed in, so a test can
 * pin it and two runs a millisecond apart cannot disagree about whether
 * something crossed a threshold.
 */

const DAY_MS = 86_400_000;

/** Whole days elapsed. Floored, so "1.9 days" is 1 and a threshold of 2 holds. */
export function daysBetween(from: string, to: Date): number {
  const elapsed = to.getTime() - Date.parse(from);
  return elapsed <= 0 ? 0 : Math.floor(elapsed / DAY_MS);
}

function thresholdFor(kind: ObligationKind, config: DetectionConfig): number {
  switch (kind) {
    case "awaiting_you":
      return config.awaiting_you_days;
    case "awaiting_them":
      return config.awaiting_them_days;
    case "unsent_followup":
      return config.unsent_followup_days;
  }
}

/**
 * Urgency, as a pure function of the facts.
 *
 * Three terms, in deliberate priority order:
 *
 *  - KIND. Owing someone a reply outranks waiting on one, always. They wrote to
 *    you and you went quiet; that is the one that damages a relationship rather
 *    than merely delaying it. The weights are separated enough that no amount of
 *    deal value promotes an `awaiting_them` above an `awaiting_you`.
 *  - OVERDUE. How far past its threshold, RELATIVE to that threshold, so kinds
 *    with different thresholds stay comparable. Saturating, because past a
 *    point "very late" stops being a useful distinction and a single ancient
 *    thread should not monopolise the top of the list.
 *  - VALUE. A tiebreaker, not a driver. Ranking primarily by deal size would
 *    make the product a pipeline report; it is meant to be a list of dropped
 *    balls.
 */
export function rankObligation(
  kind: ObligationKind,
  daysElapsed: number,
  thresholdDays: number,
  openDealValue: number | undefined,
  config: DetectionConfig,
  hasOpenDeal: boolean | null = true,
): number {
  const kindWeight = kind === "awaiting_you" ? 100 : kind === "unsent_followup" ? 60 : 30;
  // An UNKNOWN deal state ranks below a known-open one at equal lateness — the
  // CRM's confirmation promotes. Smaller than the kind gap on purpose, so it
  // can reorder within a band and never across one.
  const unknownPenalty = hasOpenDeal === null ? 5 : 0;

  const overdue = Math.max(0, daysElapsed - thresholdDays);
  // Saturating: 0 at the threshold, approaching 1, ~0.5 at one threshold past.
  const overdueTerm = overdue / (overdue + thresholdDays);

  // Also saturating, so one enormous deal cannot dominate every other signal.
  const value = openDealValue ?? 0;
  const valueTerm = value / (value + config.value_normalizer);

  return round4(kindWeight + 20 * overdueTerm + 10 * valueTerm - unknownPenalty);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Which obligation, if any, a thread represents.
 *
 * Returns the KIND only; thresholds and ranking are applied by the caller, so
 * the classification stays readable on its own.
 */
function kindFor(
  thread: Thread,
  contact: Contact,
  now: Date,
  config: DetectionConfig,
): {
  kind: ObligationKind;
  days: number;
} | null {
  // A KNOWN-closed relationship owes nothing. Checked first: without it the
  // list fills with won and lost deals, which is the fastest way to teach
  // someone that the list is not worth reading. `null` — no CRM has said — is
  // not closed, and must pass: a user with only Gmail connected would otherwise
  // see nothing at all.
  if (contact.has_open_deal === false) return null;

  const days = daysBetween(thread.last_message_at, now);

  // Past the ceiling this is history, not a pending obligation.
  if (days > config.max_days) return null;

  if (thread.last_direction === "inbound") {
    return days >= config.awaiting_you_days ? { kind: "awaiting_you", days } : null;
  }

  // Outbound. A meeting AFTER the last message, with nothing sent since, is a
  // different and more specific failure than an unanswered email — and it is
  // checked first, because it is the one the user would recognise.
  if (contact.last_meeting_at !== undefined) {
    const meetingAfterLastMessage =
      Date.parse(contact.last_meeting_at) > Date.parse(thread.last_message_at);
    if (meetingAfterLastMessage) {
      const sinceMeeting = daysBetween(contact.last_meeting_at, now);
      if (sinceMeeting > config.max_days) return null;
      return sinceMeeting >= config.unsent_followup_days
        ? { kind: "unsent_followup", days: sinceMeeting }
        : null;
    }
  }

  return days >= config.awaiting_them_days ? { kind: "awaiting_them", days } : null;
}

export type DetectInput = {
  threads: readonly Thread[];
  contacts: readonly Contact[];
  now: Date;
  config?: Partial<DetectionConfig>;
};

/**
 * Every obligation across a person's threads, most urgent first.
 *
 * A thread with no matching contact is SKIPPED rather than assumed open. The
 * two systems sync independently and will disagree; guessing "probably still
 * open" produces exactly the false positives that make the list ignorable.
 */
export function detectObligations(input: DetectInput): Obligation[] {
  const config: DetectionConfig = { ...DEFAULT_DETECTION_CONFIG, ...input.config };
  const byId = new Map(input.contacts.map((c) => [c.contact_id, c]));

  const obligations: Obligation[] = [];
  for (const thread of input.threads) {
    const contact = byId.get(thread.contact_id);
    if (!contact) continue;

    const matched = kindFor(thread, contact, input.now, config);
    if (!matched) continue;

    const thresholdDays = thresholdFor(matched.kind, config);
    obligations.push({
      thread_id: thread.thread_id,
      contact_id: thread.contact_id,
      kind: matched.kind,
      rank: rankObligation(
        matched.kind,
        matched.days,
        thresholdDays,
        contact.open_deal_value,
        config,
        contact.has_open_deal,
      ),
      reason: {
        kind: matched.kind,
        days_elapsed: matched.days,
        threshold_days: thresholdDays,
        last_direction: thread.last_direction,
        message_count: thread.message_count,
        has_open_deal: contact.has_open_deal,
        ...(contact.open_deal_value !== undefined
          ? { open_deal_value: contact.open_deal_value }
          : {}),
      },
    });
  }

  // Rank desc, then thread_id, so equal-rank items keep a stable order across
  // runs. An unstable list reshuffles under the cursor and looks untrustworthy.
  return obligations.sort((a, b) => b.rank - a.rank || a.thread_id.localeCompare(b.thread_id));
}
