import { describe, expect, it } from "vitest";
import { projectEvent, projectEvents } from "../src/calendar-project.js";

const ME = ["alex@co.example"];
const ev = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  status: "confirmed",
  summary: "Pricing review",
  description: "Agenda: seats, term",
  start: { dateTime: "2026-09-17T15:00:00-04:00" },
  end: { dateTime: "2026-09-17T15:30:00-04:00" },
  organizer: { email: "alex@co.example", self: true },
  attendees: [
    { email: "Alex@co.example", self: true, responseStatus: "accepted" },
    { email: "Sarah@Acme.com", displayName: "Sarah Chen", responseStatus: "accepted" },
  ],
  ...over,
});

describe("what a meeting carries", () => {
  it("keeps the other people, lower-cased, with names and responses; times in UTC", () => {
    const m = projectEvent(ev(), ME)!;
    expect(m).toEqual({
      external_id: "e1",
      title: "Pricing review",
      description: "Agenda: seats, term",
      starts_at: "2026-09-17T19:00:00.000Z",
      ends_at: "2026-09-17T19:30:00.000Z",
      all_day: false,
      organizer_address: "alex@co.example",
      attendees: [{ address: "sarah@acme.com", display_name: "Sarah Chen", response: "accepted" }],
      self_response: "accepted",
      status: "confirmed",
    });
  });

  it("drops what is not a meeting between people: no other attendee, no time, working-location markers", () => {
    expect(
      projectEvent(ev({ attendees: [{ email: "alex@co.example", self: true }] }), ME),
    ).toBeNull();
    expect(projectEvent(ev({ start: {}, end: {} }), ME)).toBeNull();
    expect(projectEvent(ev({ eventType: "workingLocation" }), ME)).toBeNull();
  });

  it("an all-day event is kept as such; an outside organizer counts as an attendee; declines and cancellations are recorded", () => {
    const allDay = projectEvent(
      ev({ start: { date: "2026-09-18" }, end: { date: "2026-09-19" } }),
      ME,
    )!;
    expect(allDay).toMatchObject({ all_day: true, starts_at: "2026-09-18T00:00:00.000Z" });
    const theirs = projectEvent(
      ev({
        organizer: { email: "pat@client.com" },
        attendees: [{ email: "alex@co.example", self: true, responseStatus: "declined" }],
      }),
      ME,
    )!;
    expect(theirs.attendees).toEqual([{ address: "pat@client.com" }]);
    expect(theirs.self_response).toBe("declined");
    expect(projectEvent(ev({ status: "cancelled" }), ME)!.status).toBe("cancelled");
    expect(projectEvents([ev(), ev({ id: "e2", attendees: [] })], ME)).toHaveLength(1);
  });
});
