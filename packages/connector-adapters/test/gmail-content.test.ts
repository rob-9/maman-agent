import { describe, expect, it, vi } from "vitest";
import { PermanentAdapterError, TransientAdapterError } from "@maman/agent-runtime";
import { gmailContentReader, type HttpRequest, type UserCredentialProvider } from "../src/index.js";

const key = { organization_id: "org-1", user_id: "user-1" };
const creds = (refreshed?: string) => {
  let token = "tok-1";
  const refresh = vi.fn(async () => {
    if (!refreshed) throw new PermanentAdapterError("no refresh");
    token = refreshed;
    return { access_token: token };
  });
  const provider: UserCredentialProvider = { load: async () => ({ access_token: token }), refresh };
  return { provider, refresh };
};
const thread = {
  id: "t1",
  messages: [
    {
      id: "m",
      internalDate: "1",
      payload: {
        headers: [{ name: "From", value: "s@a.com" }],
        mimeType: "text/plain",
        body: { data: Buffer.from("hello?").toString("base64url") },
      },
    },
  ],
};

describe("reading one thread's content", () => {
  it("asks for exactly that thread, in full, as a GET with the bearer, and projects it", async () => {
    const calls: HttpRequest[] = [];
    const reader = gmailContentReader({
      credentials: creds().provider,
      transport: async (req) => {
        calls.push(req);
        return { status: 200, headers: {}, body: thread };
      },
    });
    const content = await reader.read(key, "t1", ["me@co.example"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/threads/t1?format=full",
    );
    expect(calls[0]!.headers["authorization"]).toBe("Bearer tok-1");
    expect(content.messages[0]).toMatchObject({ direction: "inbound", text: "hello?" });
  });

  it("refreshes once on 401; maps 5xx transient and 4xx permanent", async () => {
    const c = creds("tok-2");
    const seen: string[] = [];
    const reader = gmailContentReader({
      credentials: c.provider,
      transport: async (req) => {
        seen.push(req.headers["authorization"]!);
        return req.headers["authorization"] === "Bearer tok-2"
          ? { status: 200, headers: {}, body: thread }
          : { status: 401, headers: {}, body: {} };
      },
    });
    await reader.read(key, "t1", []);
    expect(seen).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    expect(c.refresh).toHaveBeenCalledTimes(1);
    const down = gmailContentReader({
      credentials: creds().provider,
      transport: async () => ({ status: 503, headers: {}, body: {} }),
    });
    await expect(down.read(key, "t1", [])).rejects.toBeInstanceOf(TransientAdapterError);
    const gone = gmailContentReader({
      credentials: creds().provider,
      transport: async () => ({ status: 404, headers: {}, body: {} }),
    });
    await expect(gone.read(key, "t1", [])).rejects.toBeInstanceOf(PermanentAdapterError);
  });
});
