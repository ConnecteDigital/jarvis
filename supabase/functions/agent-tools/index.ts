// Ferramentas que o agente de voz chama durante a ligação.
// Lê só do banco (última checagem do vigia), então não gasta cota do Google Ads.
//
// POST { "tool": "account_status", "query": "sos" }   -> números de hoje de uma conta
// POST { "tool": "open_alerts" }                      -> alertas em aberto

import { authorized, db, json } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (!authorized(req, "AGENT_TOOLS_SECRET")) return json({ error: "não autorizado" }, 401);
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  let body: { tool?: string; query?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "corpo inválido" }, 400);
  }

  const supabase = db();

  if (body.tool === "open_alerts") {
    const { data, error } = await supabase
      .from("alerts")
      .select("level, summary, opened_at, accounts(name)")
      .neq("status", "resolved")
      .order("opened_at", { ascending: false })
      .limit(20);
    if (error) return json({ error: error.message }, 500);
    return json({ count: data.length, alerts: data });
  }

  if (body.tool === "account_status") {
    const query = normalize(body.query ?? "");
    if (!query) return json({ error: "informe o nome da conta" }, 400);

    const { data: accounts, error } = await supabase
      .from("accounts")
      .select("id, name, customer_id")
      .eq("active", true);
    if (error) return json({ error: error.message }, 500);

    const matches = accounts.filter((a) => normalize(a.name).includes(query));
    if (matches.length === 0) {
      return json({ found: false, message: "Nenhuma conta com esse nome.", accounts: accounts.map((a) => a.name) });
    }
    if (matches.length > 1) {
      return json({ found: false, message: "Mais de uma conta bate com esse nome.", options: matches.map((a) => a.name) });
    }

    const account = matches[0];
    const [{ data: checks }, { data: alerts }] = await Promise.all([
      supabase
        .from("checks")
        .select("checked_at, ok, error, metrics")
        .eq("account_id", account.id)
        .order("checked_at", { ascending: false })
        .limit(1),
      supabase
        .from("alerts")
        .select("level, summary, opened_at")
        .eq("account_id", account.id)
        .neq("status", "resolved"),
    ]);

    const last = checks?.[0];
    return json({
      found: true,
      account: account.name,
      // O agente deve dizer de quando são os números: a checagem não é em tempo real.
      checked_at: last?.checked_at ?? null,
      today: last?.metrics ?? null,
      check_error: last?.ok === false ? last.error : null,
      open_alerts: alerts ?? [],
    });
  }

  return json({ error: "ferramenta desconhecida" }, 400);
});

/** Minúsculas e sem acento, para casar "sos", "SOS", "hidro dutra". */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
