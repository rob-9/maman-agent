import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpResponse, HttpTransport } from "./http.js";
import {
  throwForStatus,
  throwTransientNetwork,
  type UserCredentialKey,
  type UserCredentialProvider,
} from "./credentials.js";

/**
 * Gmail draft creation — the ONLY write this connector performs.
 *
 * A draft is reversible and human-reviewed by construction: it lands in the
 * person's Drafts folder and nothing happens until THEY open it and press
 * Send. That is why it needs none of the verification machinery a CRM write
 * does, and why it is the first write in the product. The scope is
 * `gmail.compose`; `gmail.send` is never requested, so even a bug here cannot
 * send mail.
 *
 * The message builder is pure and tested on its own; the HTTP half mirrors
 * gmail.ts.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const PROVIDER = "gmail";

export type DraftMessage = {
  to: string;
  subject: string;
  body: string;
  /** Gmail thread to file the draft under, so it reads as a reply. */
  thread_id?: string;
  /** RFC 2822 Message-ID of the message being replied to, when known. */
  in_reply_to?: string;
};

/**
 * Builds the raw RFC 2822 message Gmail expects, base64url-encoded.
 *
 * Header values are sanitised of CR/LF so a subject can never inject a header
 * — "Subject: x\r\nBcc: attacker" is the classic, and a draft that quietly
 * gained a recipient would be a send the person never reviewed.
 */
export function buildRawMessage(m: DraftMessage): string {
  const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
  const lines = [
    `To: ${clean(m.to)}`,
    `Subject: ${clean(m.subject)}`,
    ...(m.in_reply_to
      ? [`In-Reply-To: ${clean(m.in_reply_to)}`, `References: ${clean(m.in_reply_to)}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    m.body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export type CreateDraftResult = { draft_id: string; message_id: string };

export async function createGmailDraft(
  config: { credentials: UserCredentialProvider; transport: HttpTransport },
  key: Omit<UserCredentialKey, "provider">,
  message: DraftMessage,
): Promise<CreateDraftResult> {
  const credKey: UserCredentialKey = { ...key, provider: PROVIDER };
  let creds = await config.credentials.load(credKey);
  if (!creds) throw new PermanentAdapterError("gmail.draft: no linked Gmail connection");

  const payload = JSON.stringify({
    message: {
      raw: buildRawMessage(message),
      ...(message.thread_id ? { threadId: message.thread_id } : {}),
    },
  });

  const run = async (token: string): Promise<HttpResponse> => {
    try {
      return await config.transport({
        method: "POST",
        url: `${GMAIL_BASE}/drafts`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: payload,
      });
    } catch (e) {
      throwTransientNetwork("gmail.draft", e);
    }
  };

  let res = await run(creds.access_token);
  if (res.status === 401) {
    creds = await config.credentials.refresh(credKey);
    res = await run(creds.access_token);
    if (res.status === 401)
      throw new PermanentAdapterError("gmail.draft: unauthorized after refresh");
  }
  if (res.status < 200 || res.status >= 300) {
    throwForStatus("gmail.draft", res.status, "draft not created");
  }
  const body = res.body as { id?: string; message?: { id?: string } };
  if (!body.id || !body.message?.id) {
    throw new PermanentAdapterError("gmail.draft: response carried no draft id");
  }
  return { draft_id: body.id, message_id: body.message.id };
}
