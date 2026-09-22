export type ObligationView = {
  id: string;
  thread_id: string;
  contact_id: string;
  kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
  rank: number;
  reason: {
    days_elapsed: number;
    threshold_days: number;
    last_direction: "inbound" | "outbound";
    message_count: number;
    has_open_deal: boolean | null;
    open_deal_value?: number;
  };
  detected_at: string;
  subject: string;
  contact_display_name: string;
  contact_account_name: string | null;
  last_meeting_at: string | null;
  last_meeting_title: string | null;
  next_meeting_at: string | null;
  next_meeting_title: string | null;
  /** The draft waiting in Gmail for this thread, if one is. */
  draft: {
    id: string;
    gmail_draft_id: string;
    gmail_message_id: string | null;
    composer: "deterministic" | "model";
    mode: "manual" | "auto";
    created_at: string;
  } | null;
  /** The agent's judgment, when it has read this thread in its current state. */
  assessment: {
    owed: boolean;
    ask: string;
    summary: string;
    urgency: "high" | "normal" | "low";
    confidence: number;
  } | null;
};

/**
 * The sentence for a card. Written here, from the FACTS the detector carried,
 * so the API never renders copy and the copy can never disagree with the
 * arithmetic. Every number below came from `reason`.
 */
export function explain(
  o: ObligationView,
  agentMode: "off" | "assist" = "off",
): { headline: string; detail: string; ask: string | null; source: "agent" | "facts" } {
  const who = o.contact_display_name;
  const d = o.reason.days_elapsed;
  const days = d === 1 ? "1 day" : `${d} days`;
  const facts = factsOf(o, who, days);
  // The agent's sentence leads when the agent is on and has read this thread.
  // The facts stay underneath either way, so the card never loses its evidence.
  if (agentMode === "assist" && o.assessment) {
    return {
      headline: facts.headline,
      detail: o.assessment.summary,
      ask: o.assessment.ask || null,
      source: "agent",
    };
  }
  return { ...facts, ask: null, source: "facts" };
}

function factsOf(
  o: ObligationView,
  who: string,
  days: string,
): { headline: string; detail: string } {
  switch (o.kind) {
    case "awaiting_you":
      return {
        headline: `${who} is waiting on you`,
        detail: `They wrote ${days} ago on "${o.subject}" and you haven't replied.`,
      };
    case "unsent_followup":
      return {
        headline: `No follow-up after meeting ${who}`,
        detail: o.last_meeting_title
          ? `You met ${days} ago for "${o.last_meeting_title}" and nothing has gone out since.`
          : `You met ${days} ago and nothing has gone out since.`,
      };
    case "awaiting_them":
      return {
        headline: `${who} has gone quiet`,
        detail: `You wrote ${days} ago on "${o.subject}" with no reply.`,
      };
  }
}

/** "Meeting Thursday: Pricing review", for the card's fact line. */
export function nextMeetingLine(o: ObligationView, now: Date = new Date()): string | null {
  if (!o.next_meeting_at || Date.parse(o.next_meeting_at) < now.getTime()) return null;
  const day = new Date(o.next_meeting_at).toLocaleDateString("en-US", { weekday: "long" });
  return o.next_meeting_title ? `Meeting ${day}: ${o.next_meeting_title}` : `Meeting ${day}`;
}

/** Where Gmail opens the draft. Falls back to the Drafts folder when the id is unknown. */
export function gmailDraftUrl(draft: NonNullable<ObligationView["draft"]>): string {
  return draft.gmail_message_id
    ? `https://mail.google.com/mail/#drafts/${encodeURIComponent(draft.gmail_message_id)}`
    : "https://mail.google.com/mail/#drafts";
}

/** "This week: 9 drafts, 6 sent as written." Empty when there is nothing to say yet. */
export function draftsLine(d: {
  drafted: number;
  sent: number;
  sent_as_written: number;
}): string | null {
  if (d.drafted === 0) return null;
  const drafts = d.drafted === 1 ? "1 draft" : `${d.drafted} drafts`;
  if (d.sent === 0) return `This week: ${drafts}, none sent yet.`;
  return `This week: ${drafts}, ${d.sent} sent, ${d.sent_as_written} as written.`;
}
