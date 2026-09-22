import type { Sql } from "postgres";
import {
  syncCalendarEvents,
  type HttpTransport,
  type ProjectedMeeting,
  type UserCredentialProvider,
} from "@maman/connector-adapters";
import {
  getCalendarSyncToken,
  refreshContactMeetingStamps,
  setCalendarSyncToken,
  upsertSyncedMeetings,
  type SyncedMeeting,
  type UserContext,
} from "@maman/db";
import { encryptBody } from "./content.js";

/**
 * THE CALENDAR STEP. Same Google grant as the mailbox, read only. Meetings
 * land in the store (description encrypted to the person) and the two stamps
 * every contact carries, last meeting and next, are recomputed. Runs inside
 * the mailbox sync, before detection, so "met them, sent nothing" is counted
 * from a real meeting and a booked call cancels a chase.
 *
 * A calendar that fails does not take the mailbox down: the step reports
 * it and the sync goes on with the stamps it already had.
 */

export type CalendarStepDeps = {
  sql: Sql;
  credentials: UserCredentialProvider;
  transport: HttpTransport;
  contentKey: Buffer;
  now: () => Date;
};

export type CalendarStepResult =
  | {
      ok: true;
      listed: number;
      meetings_upserted: number;
      cancelled: number;
      contacts_stamped: number;
      resynced: boolean;
    }
  | { ok: false; reason: "no_calendar_scope" }
  | { ok: false; reason: "sync_failed"; error: string };

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export async function runCalendarStep(
  deps: CalendarStepDeps,
  ctx: UserContext,
  connection: { id: string; scopes: readonly string[] },
  selfAddresses: readonly string[],
): Promise<CalendarStepResult> {
  // A grant made before the calendar scope existed has no calendar. The
  // person reconnects Google once; nothing else changes.
  if (!connection.scopes.some((s) => s === CALENDAR_SCOPE || s.endsWith("calendar.readonly"))) {
    return { ok: false, reason: "no_calendar_scope" };
  }
  const token = await getCalendarSyncToken(deps.sql, ctx, connection.id);
  let synced;
  try {
    synced = await syncCalendarEvents(
      { credentials: deps.credentials, transport: deps.transport },
      { organization_id: ctx.organizationId, user_id: ctx.userId },
      { sync_token: token ?? undefined, self_addresses: selfAddresses, now: deps.now },
    );
  } catch (e) {
    return { ok: false, reason: "sync_failed", error: e instanceof Error ? e.message : String(e) };
  }
  const upserted = await upsertSyncedMeetings(deps.sql, ctx, {
    connection_id: connection.id,
    meetings: synced.meetings
      .filter((m) => m.status !== "cancelled")
      .map((m) => toSyncedMeeting(m, deps.contentKey, ctx)),
    cancelled: synced.cancelled,
  });
  await setCalendarSyncToken(deps.sql, ctx, connection.id, synced.next_sync_token);
  const stamped = await refreshContactMeetingStamps(deps.sql, ctx, deps.now());
  return {
    ok: true,
    listed: synced.listed,
    meetings_upserted: upserted.meetings,
    cancelled: upserted.cancelled,
    contacts_stamped: stamped.contacts,
    resynced: synced.resynced,
  };
}

export function toSyncedMeeting(m: ProjectedMeeting, key: Buffer, ctx: UserContext): SyncedMeeting {
  return {
    external_id: m.external_id,
    title: m.title,
    description_ciphertext: m.description ? encryptBody(m.description, key, ctx) : null,
    description_chars: m.description.length,
    starts_at: m.starts_at,
    ends_at: m.ends_at,
    all_day: m.all_day,
    organizer_address: m.organizer_address,
    attendees: m.attendees,
    self_response: m.self_response,
    status: m.status,
  };
}
