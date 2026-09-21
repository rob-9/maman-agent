import { describe, expect, it } from "vitest";
import {
  isSelf,
  parseAddress,
  parseAddressList,
  projectThread,
  projectThreads,
  type GmailThread,
} from "../src/gmail-project.js";

const ME = ["sarah.rep@acme.com"];
const at = (iso: string) => String(Date.parse(iso));

function msg(
  from: string,
  to: string,
  when: string,
  subject = "Pricing",
): NonNullable<GmailThread["messages"]>[number] {
  return {
    id: `m-${when}`,
    internalDate: at(when),
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Subject", value: subject },
      ],
    },
  };
}

describe("parseAddress", () => {
  it.each([
    ["sarah@acme.com", "sarah@acme.com", undefined],
    ["<sarah@acme.com>", "sarah@acme.com", undefined],
    ["Sarah Chen <sarah@acme.com>", "sarah@acme.com", "Sarah Chen"],
    ['"Chen, Sarah" <sarah@acme.com>', "sarah@acme.com", "Chen, Sarah"],
    ["  SARAH@ACME.COM  ", "sarah@acme.com", undefined],
  ])("parses %s", (raw, address, name) => {
    const p = parseAddress(raw)!;
    expect(p.address).toBe(address);
    expect(p.display_name).toBe(name);
  });

  it.each(["", "   ", "not-an-address", "Sarah Chen"])(
    "returns undefined rather than inventing a participant from %j",
    (raw) => {
      expect(parseAddress(raw)).toBeUndefined();
    },
  );
});

describe("parseAddressList", () => {
  it("splits multiple recipients", () => {
    expect(parseAddressList("a@x.com, Bob <b@x.com>").map((p) => p.address)).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });

  it("does not split on a comma inside a quoted display name", () => {
    // '"Chen, Sarah" <s@acme.com>' naively split on commas invents a second
    // participant and can make a thread look like it has a counterparty it
    // does not.
    const parsed = parseAddressList('"Chen, Sarah" <s@acme.com>, bob@x.com');
    expect(parsed.map((p) => p.address)).toEqual(["s@acme.com", "bob@x.com"]);
    expect(parsed[0]!.display_name).toBe("Chen, Sarah");
  });

  it("returns empty for an absent header", () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe("isSelf", () => {
  it("matches case-insensitively", () => {
    expect(isSelf("SARAH.REP@ACME.COM", ME)).toBe(true);
  });

  it("matches plus-addressing", () => {
    // Mail to me+crm@ is still mine. Treating it as someone else creates an
    // obligation to reply to myself.
    expect(isSelf("sarah.rep+crm@acme.com", ME)).toBe(true);
  });

  it("ignores dots in a gmail local part, both directions", () => {
    // THE ONE THAT SILENTLY BREAKS EVERYTHING. Gmail treats these as one
    // mailbox. If they do not compare equal, the user's own replies read as
    // inbound and every thread looks like an unanswered question.
    expect(isSelf("firstlast@gmail.com", ["first.last@gmail.com"])).toBe(true);
    expect(isSelf("first.last@gmail.com", ["firstlast@gmail.com"])).toBe(true);
    expect(isSelf("f.i.r.s.t@googlemail.com", ["first@googlemail.com"])).toBe(true);
  });

  it("does NOT ignore dots on a non-gmail domain", () => {
    // Only Google does this. Applying it everywhere would merge two genuinely
    // different corporate mailboxes.
    expect(isSelf("first.last@acme.com", ["firstlast@acme.com"])).toBe(false);
  });

  it("does not match a different person", () => {
    expect(isSelf("bob@acme.com", ME)).toBe(false);
  });

  it("supports several of the user's own addresses", () => {
    expect(isSelf("s@personal.com", [...ME, "s@personal.com"])).toBe(true);
  });
});

describe("projectThread", () => {
  it("reads an outbound thread — the user spoke last", () => {
    const p = projectThread(
      { id: "t1", messages: [msg("sarah.rep@acme.com", "bob@client.com", "2026-09-10T09:00:00Z")] },
      ME,
    )!;
    expect(p.last_direction).toBe("outbound");
    expect(p.contact.address).toBe("bob@client.com");
    expect(p.message_count).toBe(1);
    expect(p.last_message_at).toBe("2026-09-10T09:00:00.000Z");
  });

  it("reads an inbound thread — they spoke last", () => {
    const p = projectThread(
      {
        id: "t2",
        messages: [
          msg("sarah.rep@acme.com", "bob@client.com", "2026-09-10T09:00:00Z"),
          msg("bob@client.com", "sarah.rep@acme.com", "2026-09-11T09:00:00Z"),
        ],
      },
      ME,
    )!;
    expect(p.last_direction).toBe("inbound");
    expect(p.contact.address).toBe("bob@client.com");
    expect(p.message_count).toBe(2);
  });

  it("finds the counterparty on an outbound thread, where they are only in To", () => {
    // On an outbound thread the last From is the user, so looking only at the
    // last sender would find nobody and drop a real obligation.
    const p = projectThread(
      {
        id: "t3",
        messages: [msg("sarah.rep@acme.com", "Bob <bob@client.com>", "2026-09-10T09:00:00Z")],
      },
      ME,
    )!;
    expect(p.contact).toEqual({ address: "bob@client.com", display_name: "Bob" });
  });

  it("prefers a display name seen anywhere in the thread", () => {
    // The first mention is often a bare address; a later reply carries the name.
    const p = projectThread(
      {
        id: "t4",
        messages: [
          msg("sarah.rep@acme.com", "bob@client.com", "2026-09-10T09:00:00Z"),
          msg("Bob Jones <bob@client.com>", "sarah.rep@acme.com", "2026-09-11T09:00:00Z"),
        ],
      },
      ME,
    )!;
    expect(p.contact.display_name).toBe("Bob Jones");
  });

  it("skips a note to self — there is no one to owe anything to", () => {
    expect(
      projectThread(
        {
          id: "t5",
          messages: [msg("sarah.rep@acme.com", "sarah.rep@acme.com", "2026-09-10T09:00:00Z")],
        },
        ME,
      ),
    ).toBeNull();
  });

  it("skips a thread with no messages", () => {
    expect(projectThread({ id: "t6" }, ME)).toBeNull();
    expect(projectThread({ id: "t7", messages: [] }, ME)).toBeNull();
  });

  it("skips a thread whose age is unknowable rather than guessing", () => {
    // Detection is entirely elapsed time. A thread with no usable timestamp
    // cannot be ranked honestly, and defaulting to "now" would hide it forever
    // while defaulting to the epoch would pin it to the top.
    const noDate = {
      id: "t8",
      messages: [{ id: "m", payload: { headers: [{ name: "From", value: "bob@client.com" }] } }],
    };
    expect(projectThread(noDate, ME)).toBeNull();
  });

  it("skips a thread whose last message has no From", () => {
    // Direction would be a coin flip, and direction decides whose turn it is.
    const noFrom = {
      id: "t9",
      messages: [
        {
          id: "m",
          internalDate: at("2026-09-10T09:00:00Z"),
          payload: { headers: [{ name: "To", value: "bob@client.com" }] },
        },
      ],
    };
    expect(projectThread(noFrom, ME)).toBeNull();
  });

  it("falls back to a placeholder subject rather than dropping the thread", () => {
    // A missing subject is cosmetic; a dropped obligation is not.
    const p = projectThread(
      {
        id: "t10",
        messages: [
          {
            id: "m",
            internalDate: at("2026-09-10T09:00:00Z"),
            payload: {
              headers: [
                { name: "From", value: "bob@client.com" },
                { name: "To", value: "sarah.rep@acme.com" },
              ],
            },
          },
        ],
      },
      ME,
    )!;
    expect(p.subject).toBe("(no subject)");
  });

  it("matches headers case-insensitively", () => {
    // Real MIME headers arrive as FROM, from, From.
    const p = projectThread(
      {
        id: "t11",
        messages: [
          {
            id: "m",
            internalDate: at("2026-09-10T09:00:00Z"),
            payload: {
              headers: [
                { name: "FROM", value: "bob@client.com" },
                { name: "to", value: "sarah.rep@acme.com" },
                { name: "SuBjEcT", value: "Hello" },
              ],
            },
          },
        ],
      },
      ME,
    )!;
    expect(p.subject).toBe("Hello");
    expect(p.last_direction).toBe("inbound");
  });
});

describe("projectThreads", () => {
  it("keeps what qualifies and silently drops what does not", () => {
    const out = projectThreads(
      [
        {
          id: "good",
          messages: [msg("bob@client.com", "sarah.rep@acme.com", "2026-09-10T09:00:00Z")],
        },
        { id: "empty" },
        {
          id: "self",
          messages: [msg("sarah.rep@acme.com", "sarah.rep@acme.com", "2026-09-10T09:00:00Z")],
        },
      ],
      ME,
    );
    expect(out.map((t) => t.external_id)).toEqual(["good"]);
  });
});
