"use server";

import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { applyPolicyFix, latestPolicyCheck, requestReviewFor, runPolicyCheck, startPolicyCheck, type ApplyResult, type PolicyIssue } from "@/lib/ai-tools/policy";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The Google policy checker's screen (client page · Google Ads · Policy, and the KPI board's Google card): "Check
// everything" starts a run that reads the account, Google's articles and the landing pages after the response; the panel
// asks for the latest check until it's done.

export type PolicyState = { id: string; account: string; status: string; summary: string | null; error: string | null; createdAt: string; finishedAt: string | null; issues: PolicyIssue[] } | null;

/** The client, if this person can see it (their own access decides) */
async function visible(clientId: string) {
  await requireStaff();
  const { data } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  return Boolean(data);
}

export async function policyState(clientId: string): Promise<PolicyState> {
  if (!adminConfigured() || !(await visible(clientId))) return null;
  const c = await latestPolicyCheck(createAdminClient(), clientId);
  if (!c) return null;
  return { id: c.id as string, account: c.account as string, status: c.status as string, summary: (c.summary as string) ?? null, error: (c.error as string) ?? null, createdAt: c.created_at as string, finishedAt: (c.finished_at as string) ?? null, issues: c.issues };
}

export async function checkEverything(clientId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured() || !(await visible(clientId))) return { ok: false, error: "Not found." };
  try {
    const admin = createAdminClient();
    const s = await startPolicyCheck(admin, clientId, me.id);
    if (!s.already) after(() => runPolicyCheck(createAdminClient(), s.id));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't start the check." };
  }
}

export async function applyPolicyFixAction(checkId: string, key: string): Promise<ApplyResult> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data } = await admin.from("policy_checks").select("client_id").eq("id", checkId).maybeSingle();
  if (!data || !(await visible(data.client_id as string))) return { ok: false, error: "Not found." };
  return applyPolicyFix(admin, me, checkId, key);
}

export async function requestReviewAction(checkId: string, key: string) {
  await requireStaff();
  const { data } = await createAdminClient().from("policy_checks").select("client_id, account, issues").eq("id", checkId).maybeSingle();
  if (!data || !(await visible(data.client_id as string))) return null;
  const issue = ((data.issues ?? []) as PolicyIssue[]).find((i) => i.key === key);
  return issue ? requestReviewFor(issue, data.account as string) : null;
}
