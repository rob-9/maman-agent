"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { me } from "./me.js";
import { endSession, signInUrl } from "./session.js";

/**
 * Mutations run on the server so identity never reaches the browser. Each
 * one revalidates the page it changed; the list re-renders from the API,
 * which is the only source of truth about what is pending.
 */

export async function snoozeAction(id: string): Promise<void> {
  const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
  await me.outcome(id, "snoozed", { snoozed_until: until });
  revalidatePath("/");
}

/** "Not needed", with an optional reason in the person's words. Both are kept as intent. */
export async function dismissAction(id: string, formData?: FormData): Promise<void> {
  const note = formData?.get("note");
  await me.outcome(
    id,
    "dismissed",
    typeof note === "string" && note.trim() ? { note: note.trim() } : {},
  );
  revalidatePath("/");
}

/** Something the person tells the agent, in their words. */
export async function stateIntentAction(formData: FormData): Promise<void> {
  const text = formData.get("text");
  if (typeof text !== "string" || text.trim() === "") return;
  const res = await me.stateIntent(text.trim());
  if (!res.ok) throw new Error(`could not save that (${res.status})`);
  revalidatePath("/");
}

export async function forgetIntentAction(id: string): Promise<void> {
  await me.retireIntent(id);
  revalidatePath("/");
}

export async function draftAction(id: string): Promise<void> {
  const res = await me.draft(id);
  revalidatePath("/");
  // A failed draft is a VISIBLE failure, not a silently unchanged list. The
  // obligation stays pending on the server (it is marked only after Gmail
  // confirms), so the person sees it again — and they see why.
  if (!res.ok)
    throw new Error(`Draft not created${res.detail ? `: ${res.detail}` : ""} (${res.status})`);
}

export async function syncAction(): Promise<void> {
  await me.sync();
  revalidatePath("/");
  revalidatePath("/connections");
}

export async function connectAction(provider: string): Promise<void> {
  const res = await me.authorize(provider);
  if (!res.ok) throw new Error(`could not start ${provider} connection (${res.status})`);
  redirect(res.data.authorization_url);
}

export async function signInAction(): Promise<void> {
  redirect(await signInUrl());
}

export async function signOutAction(): Promise<void> {
  await endSession();
}

/** Connects a CRM for the whole organization. An org-level connection, not a personal one. */
export async function connectOrgAction(provider: string): Promise<void> {
  const res = await me.connectOrg(provider);
  if (!res.ok) throw new Error(`could not start ${provider} connection (${res.status})`);
  redirect(res.data.authorization_url);
}

export async function disconnectOrgAction(provider: string): Promise<void> {
  await me.disconnectOrg(provider);
  revalidatePath("/connections");
  revalidatePath("/");
}

/** "Log to Salesforce" on a card: a proposal the person then approves. */
export async function proposeLogAction(obligationId: string): Promise<void> {
  const res = await me.proposeLog(obligationId);
  if (!res.ok) throw new Error(`nothing to log (${res.detail ?? res.status})`);
  revalidatePath("/");
}

/** Approval is bound to the exact diff shown; the write happens at once and is read back. */
export async function approveActionAction(id: string, diffSha256: string): Promise<void> {
  const res = await me.approveAction(id, diffSha256);
  revalidatePath("/");
  if (!res.ok) throw new Error(`could not apply (${res.detail ?? res.status})`);
}

export async function declineActionAction(id: string): Promise<void> {
  await me.declineAction(id);
  revalidatePath("/");
}

export async function revertActionAction(id: string): Promise<void> {
  const res = await me.revertAction(id);
  revalidatePath("/");
  if (!res.ok) throw new Error(`could not undo (${res.detail ?? res.status})`);
}

export async function alwaysActionAction(id: string): Promise<void> {
  const res = await me.alwaysAction(id);
  revalidatePath("/");
  if (!res.ok) throw new Error(`could not set that up (${res.detail ?? res.status})`);
}

/** "Update Salesforce" on a card: what the thread says about the deal, proposed with the sentence. */
export async function proposeCrmUpdateAction(obligationId: string): Promise<void> {
  const res = await me.proposeCrmUpdate(obligationId);
  revalidatePath("/");
  if (!res.ok) throw new Error(`could not read the thread (${res.detail ?? res.status})`);
}
