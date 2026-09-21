"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { me } from "./me.js";

/**
 * Mutations run on the server so identity never reaches the browser. Each
 * one revalidates the page it changed; the list re-renders from the API,
 * which is the only source of truth about what is pending.
 */

export async function snoozeAction(id: string): Promise<void> {
  const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
  await me.outcome(id, "snoozed", until);
  revalidatePath("/");
}

export async function dismissAction(id: string): Promise<void> {
  await me.outcome(id, "dismissed");
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
