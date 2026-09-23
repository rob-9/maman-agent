import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { uuidv7, type WorkflowEvent } from "@maman/contracts";
import {
  latestWorkflowEventWrite,
  loadEventFacts,
  recordWorkflowEvents,
  type EventFacts,
  type UserContext,
} from "@maman/db";

/**
 * THE EVENT STREAM. Phase 3, step 1.
 *
 * Every fact a connector synced, and every click in the product, becomes a
 * WorkflowEvent in the person's store: what they did, on what kind of
 * record, when. This is what discovery runs on. It is DERIVED from what is
 * already stored, so it needs no observer, no new consent, and it can be
 * rebuilt from nothing.
 *
 * What an event carries is fixed by the contract: source, app, event type,
 * a role, a semantic type, an object type, hashed ids, counts, time. What it
 * never carries: a body, a subject, an address, a value, a raw record id.
 * The hash is one-way and salted with the organization, so an event can be
 * joined to its fact by us and by nobody else.
 */

/** A meeting joins the routine of at most this many contacts who were in it. */
const MEETING_CASE_CAP = 5;

/** The connectors are one virtual device: nothing here was observed on a screen. */
const CONNECTOR_DEVICE_ID = "1b7f4a2e-9c3d-4e5f-8a6b-7c8d9e0f1a2b";

export type DerivedEvent = { event: WorkflowEvent; dedupe_key: string };

const hashId = (organizationId: string, kind: string, id: string): string =>
  createHash("sha256").update(`${organizationId}:${kind}:${id}`).digest("hex").slice(0, 32);

/** The case a contact's events belong to. The same function the stream uses, so a view can join back. */
export const caseRefFor = (organizationId: string, contactAddress: string): string =>
  hashId(organizationId, "contact", contactAddress);

type Shape = {
  /** The party this is about: the contact. Becomes the case discovery groups by. */
  contact_address?: string | null | undefined;
  occurred_at: string;
  source: WorkflowEvent["source"];
  app: string;
  event_type: WorkflowEvent["event_type"];
  role?: string;
  semantic_type: string;
  object_type: string;
  record: { kind: string; id: string };
  field_names?: string[];
  item_count?: number;
  duration_ms?: number;
};

/**
 * Event ids are a function of the fact: the same fact derived twice, or on
 * two machines, is the same event, and events at the same second keep one
 * order. Nothing about the id is guessable without the organization.
 */
function seededRandom(seed: string): () => number {
  const bytes = createHash("sha256").update(seed).digest();
  let i = 0;
  return () => bytes[i++ % bytes.length]! / 256;
}

function derived(ctx: UserContext, dedupeKey: string, shape: Shape): DerivedEvent {
  return { dedupe_key: dedupeKey, event: build(ctx, shape, dedupeKey) };
}

function build(ctx: UserContext, shape: Shape, dedupeKey: string): WorkflowEvent {
  const at = new Date(shape.occurred_at);
  return {
    schema_version: 1,
    event_id: uuidv7({
      timestampMs: at.getTime(),
      random: seededRandom(`${ctx.organizationId}:${ctx.userId}:${dedupeKey}`),
    }),
    device_id: CONNECTOR_DEVICE_ID,
    user_id: ctx.userId,
    organization_id: ctx.organizationId,
    occurred_at: at.toISOString(),
    monotonic_ms: at.getTime(),
    source: shape.source,
    app: { display_name: shape.app },
    event_type: shape.event_type,
    target: {
      ...(shape.role ? { role: shape.role } : {}),
      semantic_type: shape.semantic_type,
      // The case: a salted hash of the contact, never the address.
      ...(shape.contact_address
        ? { stable_id_hash: hashId(ctx.organizationId, "contact", shape.contact_address) }
        : {}),
    },
    context: {
      object_type: shape.object_type,
      record_id_hash: hashId(ctx.organizationId, shape.record.kind, shape.record.id),
      ...(shape.field_names ? { field_names: shape.field_names } : {}),
      ...(shape.item_count !== undefined ? { item_count: shape.item_count } : {}),
    },
    ...(shape.duration_ms !== undefined ? { duration_ms: shape.duration_ms } : {}),
    sensitivity: "internal",
    redaction: { applied: false, reasons: [] },
  };
}

/**
 * Facts → events. Pure and deterministic apart from event ids; the dedupe
 * key names the fact, so deriving twice writes once.
 */
export function deriveEvents(ctx: UserContext, facts: EventFacts, now: Date): DerivedEvent[] {
  const out: DerivedEvent[] = [];

  for (const m of facts.messages) {
    // What the person did on the thread, or what arrived. The semantic type
    // says which move it was: a new thread, a reply, a chase, or the other
    // side's turn.
    const semantic =
      m.direction === "outbound"
        ? m.position === 1
          ? "sent_new"
          : m.previous_direction === "inbound"
            ? "sent_reply"
            : "sent_chase"
        : m.position === 1
          ? "received_new"
          : m.previous_direction === "outbound"
            ? "received_reply"
            : "received_more";
    out.push(
      derived(ctx, `message:${m.thread_external_id}:${m.message_external_id}`, {
        contact_address: m.contact_address,
        occurred_at: m.sent_at,
        source: "google",
        app: "Gmail",
        event_type: "record_updated",
        role: m.direction === "outbound" ? "sender" : "recipient",
        semantic_type: semantic,
        object_type: "email_thread",
        record: { kind: "thread", id: m.thread_external_id },
        item_count: m.position,
      }),
    );
  }

  for (const mt of facts.meetings) {
    // A meeting that happened. Not one that is booked, not one declined,
    // not one cancelled: those are not things the person did. It belongs to
    // the routine around each contact who was in it (bounded), or to no
    // case when nobody in it is a contact.
    if (mt.status !== "confirmed" || mt.self_response === "declined") continue;
    if (new Date(mt.ends_at).getTime() > now.getTime()) continue;
    const duration = Math.max(0, new Date(mt.ends_at).getTime() - new Date(mt.starts_at).getTime());
    const contacts = mt.contact_addresses.slice(0, MEETING_CASE_CAP);
    const cases: Array<string | null> = contacts.length > 0 ? contacts : [null];
    for (const contact of cases) {
      const key = contact
        ? `meeting:${mt.external_id}:held:${hashId(ctx.organizationId, "contact", contact)}`
        : `meeting:${mt.external_id}:held`;
      out.push(
        derived(ctx, key, {
          contact_address: contact,
          occurred_at: mt.ends_at,
          source: "google",
          app: "Google Calendar",
          event_type: "record_updated",
          role: "attendee",
          semantic_type: "meeting_held",
          object_type: "meeting",
          record: { kind: "meeting", id: mt.external_id },
          item_count: mt.attendee_count,
          duration_ms: duration,
        }),
      );
    }
  }

  for (const a of facts.actions) {
    const object = a.kind.endsWith("log_activity")
      ? "task"
      : a.kind.endsWith("update_opportunity")
        ? "opportunity"
        : a.kind.replace(/^.*\./, "");
    const semantic = a.kind.replace(/^.*\./, "");
    if (a.approved_at && a.approved_by === "user") {
      // The click: the person approved this write.
      out.push(
        derived(ctx, `action:${a.id}:approved`, {
          contact_address: a.contact_address,
          occurred_at: a.approved_at,
          source: "product",
          app: "inbox",
          event_type: "element_activated",
          role: "button",
          semantic_type: `approve_${semantic}`,
          object_type: object,
          record: { kind: "action", id: a.id },
        }),
      );
    }
    if (a.verified_at) {
      // The write that landed, verified by read-back. Field names only.
      out.push(
        derived(ctx, `action:${a.id}:verified`, {
          contact_address: a.contact_address,
          occurred_at: a.verified_at,
          source: "salesforce",
          app: "Salesforce",
          event_type: "record_updated",
          semantic_type: semantic,
          object_type: object,
          record: { kind: "action", id: a.id },
          field_names: a.field_names,
        }),
      );
    }
    if (a.reverted_at) {
      out.push(
        derived(ctx, `action:${a.id}:reverted`, {
          contact_address: a.contact_address,
          occurred_at: a.reverted_at,
          source: "product",
          app: "inbox",
          event_type: "element_activated",
          role: "button",
          semantic_type: `undo_${semantic}`,
          object_type: object,
          record: { kind: "action", id: a.id },
        }),
      );
    }
  }

  for (const d of facts.decisions) {
    out.push(
      derived(ctx, `decision:${d.obligation_id}:${d.outcome}`, {
        contact_address: d.contact_address,
        occurred_at: d.decided_at,
        source: "product",
        app: "inbox",
        event_type: "element_activated",
        role: "button",
        semantic_type: d.outcome,
        object_type: d.kind,
        record: { kind: "obligation", id: d.obligation_id },
      }),
    );
  }

  for (const i of facts.intents) {
    // A sentence the person gave the agent, or one their action implied.
    // The sentence itself stays in the intent store; this is that it happened.
    out.push(
      derived(ctx, `intent:${i.id}`, {
        contact_address: i.contact_address,
        occurred_at: i.created_at,
        source: "product",
        app: "inbox",
        event_type: "value_committed",
        role: "textbox",
        semantic_type: `intent_${i.source}`,
        object_type: `intent_${i.scope_kind}`,
        record: { kind: "intent", id: i.id },
      }),
    );
  }

  out.sort((a, b) => a.event.occurred_at.localeCompare(b.event.occurred_at));
  return out;
}

export type EventStepResult = {
  /** No events yet: derived over the whole window. */
  backfill: boolean;
  derived: number;
  written: number;
  refused: string | null;
};

export type EventStepDeps = { sql: Sql; now: () => Date };

/** Default window for a backfill, and the floor for what is derived at all. */
export const EVENT_WINDOW_DAYS = 90;
/** Overlap with the previous run, so a fact written during it is not missed. */
const SINCE_MARGIN_MS = 60 * 60 * 1000;

/**
 * One sweep's worth of the stream. The first run derives everything in the
 * window; later runs only what moved since the last write, with a margin.
 * Idempotent either way.
 */
export async function runEventStep(
  deps: EventStepDeps,
  ctx: UserContext,
  opts: { window_days?: number | undefined } = {},
): Promise<EventStepResult> {
  const now = deps.now();
  const last = await latestWorkflowEventWrite(deps.sql, ctx);
  const since = last ? new Date(last.getTime() - SINCE_MARGIN_MS) : null;
  const windowStart = new Date(
    now.getTime() - (opts.window_days ?? EVENT_WINDOW_DAYS) * 86_400_000,
  );
  const facts = await loadEventFacts(deps.sql, ctx, { since, window_start: windowStart });
  const events = deriveEvents(ctx, facts, now);
  const result = await recordWorkflowEvents(deps.sql, ctx, events);
  return { backfill: last === null, derived: events.length, ...result };
}
