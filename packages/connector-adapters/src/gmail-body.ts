/**
 * Gmail message content → plain text the agent can read. PURE.
 *
 * Runs only on the candidate threads the detector already found, at
 * judgment time; the result goes to the model and is discarded. Nothing here
 * is written to the database.
 *
 * Preference order for a body: text/plain, then text/html with tags
 * stripped. Quoted history ("On ... wrote:", "> " lines) is cut so each
 * message carries only what its author typed, and each is bounded.
 */

export type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

export type GmailMessageFull = {
  id: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
};

export type GmailThreadFull = { id: string; messages?: GmailMessageFull[] };

export const CONTENT_MAX_MESSAGES = 8;
export const CONTENT_MAX_CHARS = 4000;
/** Stored per message. Generous; the prompt bound is applied at read time. */
export const STORED_MAX_CHARS = 20_000;

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Depth-first search for the first part of a mime type with a body. */
function findPart(part: GmailPart | undefined, mime: string): string | undefined {
  if (!part) return undefined;
  if (part.mimeType?.toLowerCase() === mime && part.body?.data) return part.body.data;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return undefined;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Cuts quoted history and signature separators; collapses whitespace. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*On .{3,200} wrote:\s*$/.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(line)) break;
    if (/^\s*From: .+$/.test(line) && kept.length > 0 && /^\s*$/.test(kept[kept.length - 1]!))
      break;
    if (/^\s*>/.test(line)) continue;
    if (/^\s*--\s*$/.test(line)) break;
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function bodyText(message: GmailMessageFull): string {
  const plain = findPart(message.payload, "text/plain");
  if (plain) return stripQuoted(decodeBase64Url(plain));
  const html = findPart(message.payload, "text/html");
  if (html) return stripQuoted(stripHtml(decodeBase64Url(html)));
  return "";
}
