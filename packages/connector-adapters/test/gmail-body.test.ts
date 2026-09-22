import { describe, expect, it } from "vitest";
import { bodyText, stripHtml, stripQuoted, type GmailMessageFull } from "../src/gmail-body.js";
import { projectContent } from "../src/gmail-project.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const msg = (
  id: string,
  from: string,
  when: number,
  parts: { mime: string; text: string }[],
): GmailMessageFull => ({
  id,
  internalDate: String(when),
  payload: {
    mimeType: "multipart/alternative",
    headers: [{ name: "From", value: from }],
    parts: parts.map((p) => ({ mimeType: p.mime, body: { data: b64(p.text) } })),
  },
});

describe("what the agent gets to read", () => {
  it("prefers text/plain, falls back to stripped html, and cuts quoted history", () => {
    const plain = msg("1", "Sarah <sarah@acme.com>", 1, [
      { mime: "text/html", text: "<p>HTML version</p>" },
      {
        mime: "text/plain",
        text: "Can you confirm?\n\nOn Tue, Alex wrote:\n> earlier stuff\n> more",
      },
    ]);
    expect(bodyText(plain)).toBe("Can you confirm?");
    const html = msg("2", "Sarah <sarah@acme.com>", 2, [
      {
        mime: "text/html",
        text: "<div>Hi&nbsp;Alex,<br>Works for <b>us</b>.</div><style>p{}</style>",
      },
    ]);
    expect(bodyText(html).replace(/\s+/g, " ")).toBe("Hi Alex, Works for us .");
  });

  it("strips signatures and forwarded headers", () => {
    expect(stripQuoted("Sounds good.\n-- \nSarah Chen\nVP Sales")).toBe("Sounds good.");
    expect(stripQuoted("See below.\n\nFrom: Bob\nSent: yesterday\nold text")).toBe("See below.");
    expect(stripHtml("a<br/>b")).toBe("a\nb");
  });

  it("orders oldest first, marks direction from the user's own addresses, keeps the last N, bounds each", () => {
    const thread = {
      id: "t1",
      messages: [
        msg("b", "Sarah <sarah@acme.com>", 200, [{ mime: "text/plain", text: "x".repeat(50) }]),
        msg("a", "Alex <alex@co.example>", 100, [{ mime: "text/plain", text: "first" }]),
        msg("c", "ALEX@co.example", 300, [{ mime: "text/plain", text: "third" }]),
      ],
    };
    const content = projectContent(thread, ["alex@co.example"], { max_messages: 2, max_chars: 10 });
    expect(content.external_id).toBe("t1");
    expect(content.messages.map((m) => [m.from, m.direction, m.text])).toEqual([
      ["Sarah", "inbound", "x".repeat(10)],
      ["alex@co.example", "outbound", "third"],
    ]);
    expect(content.messages[0]!.sent_at).toBe(new Date(200).toISOString());
  });

  it("a message with no readable body is kept, empty, so the shape still makes sense", () => {
    const thread = {
      id: "t2",
      messages: [
        { id: "z", internalDate: "5", payload: { headers: [{ name: "From", value: "a@b.c" }] } },
      ],
    };
    expect(projectContent(thread, []).messages).toEqual([
      { from: "a@b.c", direction: "inbound", sent_at: new Date(5).toISOString(), text: "" },
    ]);
  });
});
