/**
 * Gmail → the shapes L1 detection consumes. PURE: no network, no clock.
 *
 * Separated from the HTTP orchestration because this is where the bugs live.
 * Address parsing, self-identification and direction are all fiddly, all
 * load-bearing, and all cheap to test exhaustively once they take plain data.
 *
 * THE SCOPE ENFORCES THE DESIGN. This connector holds
 * `gmail.metadata`, which grants headers and NOT message bodies — so a thread
 * projected here structurally cannot carry what was said. The plan calls
 * `threads` content-free on purpose; here that is not a convention anyone has
 * to respect, it is the only data we are permitted to read.
 */

export type GmailHeader = { name: string; value: string };

export type GmailMessage = {
  id: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
};

export type GmailThread = {
  id: string;
  messages?: GmailMessage[];
};

/** One participant, as an address plus whatever display name came with it. */
export type Participant = {
  /** Lower-cased, angle-brackets stripped. The comparison key. */
  address: string;
  /** "Sarah Chen" if the header carried one, else undefined. */
  display_name?: string;
};

export type ProjectedThread = {
  external_id: string;
  subject: string;
  last_message_at: string;
  last_direction: "inbound" | "outbound";
  message_count: number;
  /** The other party. Never the user themselves. */
  contact: Participant;
};

function headerValue(message: GmailMessage, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === wanted)?.value;
}

/**
 * Parses one address out of a header value.
 *
 * Handles `Sarah Chen <sarah@acme.com>`, bare `sarah@acme.com`, and quoted
 * display names. Returns undefined rather than guessing when there is no `@` —
 * a malformed header should drop one participant, never invent one.
 */
export function parseAddress(raw: string): Participant | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const angled = /^(.*?)<([^>]+)>\s*$/.exec(trimmed);
  const address = (angled?.[2] ?? trimmed).trim().toLowerCase();
  if (!address.includes("@")) return undefined;

  const rawName = angled?.[1]
    ?.trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  return rawName ? { address, display_name: rawName } : { address };
}

/** Every address in a comma-separated header, malformed entries dropped. */
export function parseAddressList(raw: string | undefined): Participant[] {
  if (raw === undefined) return [];
  // Split on commas that are not inside quotes — a display name may contain one
  // ("Chen, Sarah" <s@acme.com>), and splitting naively invents a participant.
  const parts = raw.match(/(?:[^,"]|"(?:\\.|[^"])*")+/g) ?? [];
  return parts.map(parseAddress).filter((p): p is Participant => p !== undefined);
}

/**
 * Is this address the user's own?
 *
 * Case-insensitive, and tolerant of plus-addressing: mail sent to
 * `me+crm@x.com` is still mine, and treating it as a separate person would
 * create an obligation to reply to myself. Gmail also ignores dots in
 * @gmail.com local parts, so `first.last@gmail.com` and `firstlast@gmail.com`
 * are the same mailbox and must compare equal — otherwise a user's own replies
 * read as inbound and every thread looks like an unanswered question.
 */
export function isSelf(address: string, selfAddresses: readonly string[]): boolean {
  const norm = normalizeAddress(address);
  return selfAddresses.some((s) => normalizeAddress(s) === norm);
}

function normalizeAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at === -1) return lower;
  let local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replaceAll(".", "");
  return `${local}@${domain}`;
}

/**
 * Projects one Gmail thread, or returns null when it is not a conversation
 * this product has anything to say about.
 *
 * Returns null for: a thread with no messages, one with no identifiable other
 * party (notes-to-self, and drafts addressed to nobody), and one whose last
 * message carries no usable timestamp — detection is entirely about elapsed
 * time, and a thread whose age is unknown cannot be ranked honestly.
 */
export function projectThread(
  thread: GmailThread,
  selfAddresses: readonly string[],
): ProjectedThread | null {
  const messages = thread.messages ?? [];
  if (messages.length === 0) return null;

  const last = messages[messages.length - 1]!;

  const lastMs = Number(last.internalDate ?? NaN);
  if (!Number.isFinite(lastMs)) return null;

  const from = parseAddress(headerValue(last, "From") ?? "");
  // No From on the last message means the direction is unknowable. Guessing
  // would put the thread in the wrong half of the list — the half that says
  // whose turn it is.
  if (!from) return null;
  const outbound = isSelf(from.address, selfAddresses);

  // The other party is whoever in the thread is not the user. Taken across ALL
  // messages, not just the last: on an outbound thread the last From is the
  // user, so the counterparty only appears in To — and on a long thread the
  // earliest sender is the most stable choice of "who this is with".
  const everyone: Participant[] = [];
  for (const message of messages) {
    const sender = parseAddress(headerValue(message, "From") ?? "");
    if (sender) everyone.push(sender);
    everyone.push(...parseAddressList(headerValue(message, "To")));
  }
  const contact = everyone.find((p) => !isSelf(p.address, selfAddresses));
  if (!contact) return null;

  // Prefer any display name seen for this contact anywhere in the thread — the
  // first occurrence is often a bare address while a later reply carries the
  // real name.
  const named = everyone.find((p) => p.address === contact.address && p.display_name !== undefined);

  return {
    external_id: thread.id,
    subject: headerValue(last, "Subject") ?? "(no subject)",
    last_message_at: new Date(lastMs).toISOString(),
    last_direction: outbound ? "outbound" : "inbound",
    message_count: messages.length,
    contact: named ?? contact,
  };
}

/** Projects a page of threads, silently skipping the ones that do not qualify. */
export function projectThreads(
  threads: readonly GmailThread[],
  selfAddresses: readonly string[],
): ProjectedThread[] {
  const projected: ProjectedThread[] = [];
  for (const thread of threads) {
    const one = projectThread(thread, selfAddresses);
    if (one) projected.push(one);
  }
  return projected;
}
