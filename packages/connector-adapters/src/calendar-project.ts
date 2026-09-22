/**
 * Google Calendar events → the shapes the store keeps. PURE.
 *
 * What a meeting carries that a thread cannot: that two people actually
 * spoke, when, about what, and whether they are about to again. Addresses
 * are lower-cased so a contact synced from mail matches an attendee.
 */

export type CalendarAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
};

export type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: CalendarAttendee[];
  eventType?: string;
};

export type ProjectedAttendee = {
  address: string;
  display_name?: string;
  response?: "accepted" | "tentative" | "declined" | "needsAction";
};

export type ProjectedMeeting = {
  external_id: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  organizer_address: string | null;
  /** Everyone but the user. */
  attendees: ProjectedAttendee[];
  self_response: "accepted" | "tentative" | "declined" | "needsAction";
  status: "confirmed" | "tentative" | "cancelled";
};

const RESPONSES = new Set(["accepted", "tentative", "declined", "needsAction"]);

function responseOf(raw: string | undefined): ProjectedAttendee["response"] | undefined {
  return raw && RESPONSES.has(raw) ? (raw as ProjectedAttendee["response"]) : undefined;
}

function whenOf(part: { dateTime?: string; date?: string } | undefined): {
  iso: string;
  all_day: boolean;
} | null {
  if (part?.dateTime) {
    const ms = Date.parse(part.dateTime);
    return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), all_day: false } : null;
  }
  if (part?.date) {
    const ms = Date.parse(`${part.date}T00:00:00Z`);
    return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), all_day: true } : null;
  }
  return null;
}

/**
 * Projects one event, or null when it is not a meeting between people:
 * no usable time, no other attendee (a reminder, a block, a note to self),
 * or a working-location / out-of-office marker.
 */
export function projectEvent(
  event: CalendarEvent,
  selfAddresses: readonly string[],
): ProjectedMeeting | null {
  if (event.eventType && event.eventType !== "default") return null;
  const start = whenOf(event.start);
  const end = whenOf(event.end);
  if (!start) return null;
  const self = new Set(selfAddresses.map((a) => a.toLowerCase()));

  const attendees: ProjectedAttendee[] = [];
  let selfResponse: ProjectedMeeting["self_response"] = "needsAction";
  for (const a of event.attendees ?? []) {
    const address = a.email?.trim().toLowerCase();
    if (!address) continue;
    if (a.self || self.has(address)) {
      selfResponse = responseOf(a.responseStatus) ?? selfResponse;
      continue;
    }
    const response = responseOf(a.responseStatus);
    attendees.push({
      address,
      ...(a.displayName ? { display_name: a.displayName } : {}),
      ...(response !== undefined ? { response } : {}),
    });
  }
  // The organizer is a participant even when Google lists no attendees block for them.
  const organizer = event.organizer?.email?.toLowerCase() ?? null;
  if (organizer && !self.has(organizer) && !attendees.some((a) => a.address === organizer)) {
    attendees.push({ address: organizer });
  }
  if (attendees.length === 0) return null;
  if (event.organizer?.self)
    selfResponse = selfResponse === "needsAction" ? "accepted" : selfResponse;

  const status =
    event.status === "cancelled"
      ? "cancelled"
      : event.status === "tentative"
        ? "tentative"
        : "confirmed";
  return {
    external_id: event.id,
    title: (event.summary ?? "").trim() || "(no title)",
    description: (event.description ?? "").trim(),
    starts_at: start.iso,
    ends_at: end?.iso ?? start.iso,
    all_day: start.all_day,
    organizer_address: organizer,
    attendees,
    self_response: selfResponse,
    status,
  };
}

export function projectEvents(
  events: readonly CalendarEvent[],
  selfAddresses: readonly string[],
): ProjectedMeeting[] {
  const out: ProjectedMeeting[] = [];
  for (const e of events) {
    const m = projectEvent(e, selfAddresses);
    if (m) out.push(m);
  }
  return out;
}
