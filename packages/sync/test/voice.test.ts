import { describe, expect, it } from "vitest";
import { editDistance, similarity } from "../src/voice.js";

describe("edits as signal", () => {
  it("measures how much of the draft survived", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(similarity("Hi Sarah,\n\nOn it.", "Hi Sarah,\r\n\r\nOn it.")).toBe(1);
    expect(similarity("abcd", "")).toBe(0);
    expect(similarity("", "")).toBe(1);
    const light = similarity(
      "Hi Sarah, yes the price holds for 60 seats. Cheers, Alex",
      "Hi Sarah, yes, the price holds for 60 seats. Cheers, Alex",
    );
    expect(light).toBeGreaterThan(0.95);
    const rewrite = similarity(
      "Hi Sarah, yes the price holds for 60 seats. Cheers, Alex",
      "Sarah, let me come back to you on Monday with numbers.",
    );
    expect(rewrite).toBeLessThan(0.5);
  });
});
