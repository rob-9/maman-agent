import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpResponse, HttpTransport } from "./http.js";
import {
  throwForStatus,
  throwTransientNetwork,
  type UserCredentialKey,
  type UserCredentialProvider,
} from "./credentials.js";
import { projectContent, type GmailThread, type ThreadContent } from "./gmail-project.js";

/**
 * Reads ONE thread's content straight from Gmail. The sync stores content
 * for every thread it sees, so this is the fallback for a thread the store
 * does not hold (older than the sync window, or synced before content was
 * kept). Projected, bounded, handed to the caller.
 */

const PROVIDER = "gmail";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailContentConfig = {
  credentials: UserCredentialProvider;
  transport: HttpTransport;
};

export interface ThreadContentReader {
  read(
    key: Omit<UserCredentialKey, "provider">,
    threadExternalId: string,
    selfAddresses: readonly string[],
  ): Promise<ThreadContent>;
}

export function gmailContentReader(config: GmailContentConfig): ThreadContentReader {
  return {
    async read(key, threadExternalId, selfAddresses) {
      const credKey: UserCredentialKey = { ...key, provider: PROVIDER };
      let creds = await config.credentials.load(credKey);
      if (!creds) throw new PermanentAdapterError("gmail.content: no linked Gmail connection");
      const url = `${GMAIL_BASE}/threads/${encodeURIComponent(threadExternalId)}?format=full`;
      const run = async (token: string): Promise<HttpResponse> => {
        try {
          return await config.transport({
            method: "GET",
            url,
            headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          });
        } catch (e) {
          throwTransientNetwork("gmail.content", e);
        }
      };
      let res = await run(creds.access_token);
      if (res.status === 401) {
        creds = await config.credentials.refresh(credKey);
        res = await run(creds.access_token);
        if (res.status === 401) {
          throw new PermanentAdapterError("gmail.content: unauthorized after refresh");
        }
      }
      if (res.status < 200 || res.status >= 300) throwForStatus("gmail.content", res.status);
      return projectContent(res.body as GmailThread, selfAddresses);
    },
  };
}
