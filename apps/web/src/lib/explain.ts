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

/** "Seen 4 times on 4 days, around Bob Ray, Sarah Chen and one more." */
export function routineEvidenceLine(r: {
  occurrence_count: number;
  distinct_day_count: number;
  evidence: Array<{ contact_display_name: string | null }>;
}): string {
  const times = r.occurrence_count === 1 ? "once" : `${r.occurrence_count} times`;
  const days = r.distinct_day_count === 1 ? "1 day" : `${r.distinct_day_count} days`;
  const names = [
    ...new Set(r.evidence.map((e) => e.contact_display_name).filter((n): n is string => !!n)),
  ];
  if (names.length === 0) return `Seen ${times} on ${days}.`;
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  // "A, B and C" when that is everyone; "A, B, C and 2 more" when it is not.
  const list =
    rest > 0
      ? `${shown.join(", ")} and ${rest} more`
      : shown.length === 1
        ? shown[0]!
        : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  return `Seen ${times} on ${days}, around ${list}.`;
}

/** What a forming routine still needs, in one line. */
export function formingLine(r: { why_not: string[] }): string {
  return r.why_not.length > 0 ? r.why_not.join("; ") : "still forming";
}

/** "Ran alongside you 3 times, agreed 3 times. Ready to start." */
export function routineRunsLine(runs: {
  mode: "shadow" | "supervised" | null;
  shadow_completed: number;
  shadow_successful: number;
  required: number;
  ready_to_start: boolean;
  supervised_completed: number;
}): string {
  if (runs.mode === "supervised") {
    const n = runs.supervised_completed;
    return n === 0
      ? "Running. Its drafts and proposals will show up here for your approval."
      : `Running. Produced drafts or proposals ${n === 1 ? "once" : `${n} times`}, each for your approval.`;
  }
  const done = runs.shadow_completed;
  const agreed = runs.shadow_successful;
  if (done === 0) return "Accepted. It will run alongside you the next time this comes up.";
  const base = `Ran alongside you ${done === 1 ? "once" : `${done} times`}, agreed ${agreed === 1 ? "once" : `${agreed} times`}.`;
  return runs.ready_to_start
    ? `${base} Ready to start.`
    : `${base} Needs ${runs.required} that agree before it can start.`;
}
