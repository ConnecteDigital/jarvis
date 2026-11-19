// Acesso ao banco com a chave de serviço (só o backend usa).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export function db(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente");
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Confere o segredo compartilhado enviado no cabeçalho Authorization. */
export function authorized(req: Request, envName: string): boolean {
  const secret = Deno.env.get(envName);
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

/**
 * Autoriza a chamada do vigia: aceita o segredo CRON_SECRET ou o segredo gerado
 * dentro do banco (settings.cron_secret), usado pelo agendamento.
 */
export async function cronAuthorized(req: Request, supabase: SupabaseClient): Promise<boolean> {
  if (authorized(req, "CRON_SECRET")) return true;
  const header = req.headers.get("authorization") ?? "";
  const { data } = await supabase.from("settings").select("value").eq("key", "cron_secret").maybeSingle();
  return !!data?.value && header === `Bearer ${data.value}`;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
