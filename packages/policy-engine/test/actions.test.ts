import { describe, expect, it } from "vitest";
import { orgActionPolicy } from "../src/actions.js";
import { DEFAULT_ORG_POLICY, orgPolicySchema } from "../src/org-policy.js";

describe("what the organization allows the agent to write", () => {
  it("a witnessed, undoable write may run unattended by default; a medium one only where listed", () => {
    expect(orgActionPolicy(DEFAULT_ORG_POLICY, "salesforce.log_activity")).toEqual({
      allowed: true,
      unattended: true,
    });
    expect(orgActionPolicy(DEFAULT_ORG_POLICY, "salesforce.update_opportunity")).toEqual({
      allowed: true,
      unattended: false,
    });
    const listed = orgPolicySchema.parse({
      ...DEFAULT_ORG_POLICY,
      unattended_medium_capabilities: ["salesforce.update_opportunity"],
    });
    expect(orgActionPolicy(listed, "salesforce.update_opportunity").unattended).toBe(true);
    expect(orgActionPolicy(DEFAULT_ORG_POLICY, "made.up")).toMatchObject({ allowed: false });
  });

  it("sending mail is allowed but never unattended unless the organization opened that gate", () => {
    expect(orgActionPolicy(DEFAULT_ORG_POLICY, "gmail.send")).toEqual({
      allowed: true,
      unattended: false,
    });
    const open = orgPolicySchema.parse({ ...DEFAULT_ORG_POLICY, allow_unattended_send: true });
    expect(orgActionPolicy(open, "gmail.send")).toEqual({ allowed: true, unattended: true });
    // The medium list does not open it.
    const medium = orgPolicySchema.parse({
      ...DEFAULT_ORG_POLICY,
      unattended_medium_capabilities: ["gmail.send"],
    });
    expect(orgActionPolicy(medium, "gmail.send").unattended).toBe(false);
    const off = orgPolicySchema.parse({
      ...DEFAULT_ORG_POLICY,
      disabled_capabilities: ["gmail.send"],
    });
    expect(orgActionPolicy(off, "gmail.send")).toMatchObject({ allowed: false, unattended: false });
    expect(DEFAULT_ORG_POLICY.allow_unattended_send).toBe(false);
  });
});
