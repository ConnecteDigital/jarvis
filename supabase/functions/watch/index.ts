// Vigia: roda de hora em hora, consulta cada conta ativa, grava a checagem,
// abre alertas novos e resolve os que deixaram de valer.
// Ainda não liga: a ligação entra quando o número do Jarvis estiver cadastrado.

import { authorized, db, json } from "../_shared/db.ts";
import { fetchAccountSnapshot, getAccessToken, type AccountSnapshot } from "../_shared/googleAds.ts";
import { type Account, evaluate, type PreviousCheck, withinHours } from "../_shared/rules.ts";

Deno.serve(async (req) => {
  if (!authorized(req, "CRON_SECRET")) return json({ error: "não autorizado" }, 401);

  const supabase = db();
  const now = new Date();

  const [accountsRes, rulesRes, overridesRes, settingsRes] = await Promise.all([
    supabase.from("accounts").select("*").eq("active", true),
    supabase.from("rules").select("*").eq("enabled", true),
    supabase.from("account_rules").select("*"),
    supabase.from("settings").select("*"),
  ]);
  for (const r of [accountsRes, rulesRes, overridesRes, settingsRes]) {
    if (r.error) return json({ error: r.error.message }, 500);
  }

  const accounts = accountsRes.data as Account[];
  const rules = rulesRes.data as {
    id: string;
    key: string;
    level: string;
    default_params: Record<string, unknown>;
  }[];
  const overrides = overridesRes.data as {
    account_id: string;
    rule_id: string;
    enabled: boolean;
    params: Record<string, unknown>;
  }[];
  const settings = Object.fromEntries(
    (settingsRes.data as { key: string; value: unknown }[]).map((s) => [s.key, s.value]),
  );
  const hours = (settings.call_hours ?? { start: "07:00", end: "22:00" }) as {
    start: string;
    end: string;
    timezone?: string;
  };
  const activeHours = withinHours(now, hours.start, hours.end, hours.timezone);

  if (accounts.length === 0) return json({ checked: 0, note: "nenhuma conta ativa cadastrada" });

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return json({ error: String(e) }, 502);
  }

  const report: Record<string, unknown>[] = [];

  for (const account of accounts) {
    let snapshot: AccountSnapshot | null = null;
    let error: string | null = null;
    try {
      snapshot = await fetchAccountSnapshot(accessToken, account.customer_id);
    } catch (e) {
      error = String(e);
    }
    const siteOk = account.site_url ? await checkSite(account.site_url) : null;

    const { data: prev } = await supabase
      .from("checks")
      .select("checked_at, metrics")
      .eq("account_id", account.id)
      .order("checked_at", { ascending: false })
      .limit(12);

    // Parâmetros de cada regra: padrão da regra + ajuste da conta. Regra desligada para a conta sai.
    const params: Record<string, Record<string, unknown>> = {};
    const enabledRules = rules.filter((rule) => {
      const o = overrides.find((x) => x.account_id === account.id && x.rule_id === rule.id);
      if (o && !o.enabled) return false;
      params[rule.key] = { ...rule.default_params, ...(o?.params ?? {}) };
      return true;
    });

    const findings = evaluate({
      account,
      snapshot,
      siteOk,
      previous: (prev ?? []) as PreviousCheck[],
      params,
      withinActiveHours: activeHours,
      now,
    }).filter((f) => enabledRules.some((r) => r.key === f.ruleKey));

    await supabase.from("checks").insert({
      account_id: account.id,
      ok: error === null,
      error,
      metrics: {
        impressions: snapshot?.impressions ?? null,
        clicks: snapshot?.clicks ?? null,
        cost: snapshot?.cost ?? null,
        conversions: snapshot?.conversions ?? null,
        budget: snapshot?.budget ?? null,
        customer_status: snapshot?.customerStatus ?? null,
        campaigns: snapshot?.campaigns.length ?? null,
        site_ok: siteOk,
      },
    });

    // Abre alerta novo. O índice único impede duplicar um alerta ainda em aberto.
    const opened: string[] = [];
    for (const f of findings) {
      const rule = enabledRules.find((r) => r.key === f.ruleKey)!;
      const { error: insertError } = await supabase.from("alerts").insert({
        account_id: account.id,
        rule_id: rule.id,
        level: rule.level,
        summary: f.summary,
        details: f.details,
      });
      if (!insertError) opened.push(f.ruleKey);
      else if (insertError.code !== "23505") console.error("alerta:", insertError.message);
    }

    // Resolve alertas em aberto cuja condição deixou de valer.
    // Se a consulta ao Google Ads falhou, só mexe no alerta de site, para não fechar no escuro.
    const { data: open } = await supabase
      .from("alerts")
      .select("id, rule_id")
      .eq("account_id", account.id)
      .neq("status", "resolved");
    const resolved: string[] = [];
    for (const alert of open ?? []) {
      const rule = rules.find((r) => r.id === alert.rule_id);
      if (!rule) continue;
      const stillBroken = findings.some((f) => f.ruleKey === rule.key);
      const canJudge = rule.key === "site_down" ? siteOk !== null : snapshot !== null;
      if (!stillBroken && canJudge) {
        await supabase
          .from("alerts")
          .update({ status: "resolved", resolved_at: now.toISOString() })
          .eq("id", alert.id);
        resolved.push(rule.key);
      }
    }

    report.push({ account: account.name, ok: error === null, error, opened, resolved });
  }

  return json({ checked: accounts.length, at: now.toISOString(), report });
});

/** O site responde? Qualquer resposta abaixo de 500 conta como no ar. */
async function checkSite(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "JarvisConnectDigital/1.0 (monitor)" },
    });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}
