import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpResponse, HttpTransport } from "./http.js";
import {
  throwForStatus,
  throwTransientNetwork,
  type UserCredentialKey,
  type UserCredentialProvider,
} from "./credentials.js";

/**
 * Sending a Gmail draft, and reading the sent message back.
 *
 * The draft is sent as it is in Gmail at that moment (Gmail's drafts.send
 * takes the draft's id, not a body), which is why the caller checks the
 * draft's text against what was approved before calling this. Nothing here
 * retries a send: a timeout after the request left is an unknown result,
 * and the read-back is how it is settled. The scope is `gmail.compose`, the
 * same one drafts use; Google lets it send.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const PROVIDER = "gmail";

export type GmailSendConfig = { credentials: UserCredentialProvider; transport: HttpTransport };

export type SentMessage = { message_id: string; thread_id: string | null };

async function authed(
  config: GmailSendConfig,
  key: Omit<UserCredentialKey, "provider">,
  capability: string,
  request: (token: string) => Promise<HttpResponse>,
): Promise<HttpResponse> {
  const credKey: UserCredentialKey = { ...key, provider: PROVIDER };
  let creds = await config.credentials.load(credKey);
  if (!creds) throw new PermanentAdapterError(`${capability}: no linked Gmail connection`);
  let res = await request(creds.access_token);
  if (res.status === 401) {
    creds = await config.credentials.refresh(credKey);
    res = await request(creds.access_token);
    if (res.status === 401)
      throw new PermanentAdapterError(`${capability}: unauthorized after refresh`);
  }
  return res;
}

export async function sendGmailDraft(
  config: GmailSendConfig,
  key: Omit<UserCredentialKey, "provider">,
  gmailDraftId: string,
): Promise<SentMessage> {
  const res = await authed(config, key, "gmail.send", async (token) => {
    try {
      return await config.transport({
        method: "POST",
        url: `${GMAIL_BASE}/drafts/send`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ id: gmailDraftId }),
      });
    } catch (e) {
      throwTransientNetwork("gmail.send", e);
    }
  });
  if (res.status === 404) throw new PermanentAdapterError("gmail.send: the draft is gone");
  if (res.status < 200 || res.status >= 300) throwForStatus("gmail.send", res.status, "not sent");
  const body = res.body as { id?: string; threadId?: string };
  if (!body.id) throw new PermanentAdapterError("gmail.send: response carried no message id");
  return { message_id: body.id, thread_id: body.threadId ?? null };
}

export type SentReadback = { message_id: string; thread_id: string | null; sent: boolean };

/** The message as Gmail holds it now. Null when Gmail has no such message. */
export async function readSentMessage(
  config: GmailSendConfig,
  key: Omit<UserCredentialKey, "provider">,
  messageId: string,
): Promise<SentReadback | null> {
  const res = await authed(config, key, "gmail.send.verify", async (token) => {
    try {
      return await config.transport({
        method: "GET",
        url: `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=metadata`,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (e) {
      throwTransientNetwork("gmail.send.verify", e);
    }
  });
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throwForStatus("gmail.send.verify", res.status);
  const body = res.body as { id?: string; threadId?: string; labelIds?: string[] };
  if (!body.id) return null;
  return {
    message_id: body.id,
    thread_id: body.threadId ?? null,
    sent: (body.labelIds ?? []).includes("SENT"),
  };
}
