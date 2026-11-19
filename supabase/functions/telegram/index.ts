// Conversa pelo Telegram: recebe a mensagem do Gabriel, deixa o Claude consultar
// o Google Ads (somente leitura) e o banco, e responde na mesma conversa.

import { db, json } from "../_shared/db.ts";
import { gaqlSearch, getAccessToken } from "../_shared/googleAds.ts";
import { sendTelegram } from "../_shared/telegram.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const MODEL = Deno.env.get("JARVIS_MODEL")?.trim() || "claude-sonnet-5-5";
const FUNCTION_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram`;

const TOOLS = [
  {
    name: "find_account",
    description:
      "Procura contas de clientes na MCC da Connect Digital pelo nome. Devolve id, nome e status. Use antes de consultar uma conta cujo id você não sabe.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Parte do nome da conta, ex.: 'sos', 'hidro dutra'" } },
      required: ["query"],
    },
  },
  {
    name: "run_gaql",
    description:
      "Roda uma consulta GAQL de leitura numa conta do Google Ads e devolve as linhas (no máximo 60). Custos vêm em micros: divida por 1.000.000 para reais.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "ID da conta, só números" },
        query: { type: "string", description: "Consulta GAQL começando com SELECT" },
      },
      required: ["customer_id", "query"],
    },
  },
  {
    name: "open_alerts",
    description: "Lista os alertas em aberto detectados pelo vigia nas contas monitoradas.",
    input_schema: { type: "object", properties: {} },
  },
];

function systemPrompt(): string {
  const now = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
  return `Você é o Jarvis, assistente do Gabriel, dono da Connect Digital, agência de tráfego pago focada em desentupidoras e serviços emergenciais. Você conversa com ele pelo Telegram. Agora é ${now}, horário de São Paulo.

Como responder:
- Português do Brasil, direto, como um colega de trabalho. Respostas curtas.
- Texto puro: o Telegram não formata markdown aqui. Não use asteriscos, cerquilhas nem tabelas. Para listar, use uma linha por item.
- Valores em reais (R$ 1.234,56). Diga sempre de qual período são os números.
- Nunca invente número. Se a consulta falhar ou vier vazia, diga isso.

O que você pode fazer:
- Consultar qualquer conta da MCC com as ferramentas. A MCC tem cerca de 110 contas; se o nome bater com mais de uma, pergunte qual.
- Você só lê. Não pausa campanha, não muda orçamento, não negativa palavra. Se ele pedir uma alteração, diga que essa parte ainda não está ligada.
- A API não informa saldo da conta. Se perguntarem de saldo, explique e mostre o gasto recente.

GAQL, para lembrar:
- Períodos: segments.date DURING TODAY | YESTERDAY | LAST_7_DAYS | LAST_30_DAYS, ou BETWEEN 'AAAA-MM-DD' AND 'AAAA-MM-DD'.
- Visão geral: FROM campaign, com campaign.name, campaign.status, campaign.primary_status, campaign.primary_status_reasons, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.cost_per_conversion. Para dia a dia, inclua segments.date.
- Palavras-chave: FROM keyword_view com ad_group_criterion.keyword.text e ad_group_criterion.keyword.match_type.
- Termos de pesquisa: FROM search_term_view com search_term_view.search_term.
- Cliques individuais: FROM click_view exige filtro de um único dia (segments.date = 'AAAA-MM-DD').
- Use ORDER BY e LIMIT para trazer só o necessário. Cada consulta gasta cota, então prefira poucas consultas bem feitas.`;
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
type Message = { role: "user" | "assistant"; content: string | unknown[] };

Deno.serve(async (req) => {
  const supabase = db();
  const { data: rows } = await supabase
    .from("settings")
    .select("key, value")
    .in("key", ["cron_secret", "telegram_webhook_secret", "telegram_chat_id"]);
  const s = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value as string]));

  // Configuração: chamada interna (com o segredo do agendamento) registra o webhook no Telegram.
  if (s.cron_secret && req.headers.get("authorization") === `Bearer ${s.cron_secret}`) {
    const res = await tg("setWebhook", {
      url: FUNCTION_URL,
      secret_token: s.telegram_webhook_secret,
      allowed_updates: ["message"],
    });
    return json({ setup: await res.json() });
  }

  // Só aceita chamadas do Telegram (segredo do webhook) e só a conversa do Gabriel.
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (!s.telegram_webhook_secret || secret !== s.telegram_webhook_secret) {
    return json({ error: "não autorizado" }, 401);
  }
  const update = await req.json().catch(() => null);
  const msg = update?.message;
  if (!msg?.text || String(msg.chat?.id) !== String(s.telegram_chat_id)) return json({ ok: true });

  // Responde ao Telegram na hora e processa em segundo plano, para ele não reenviar a mensagem.
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime.waitUntil(handle(supabase, String(msg.chat.id), msg.text));
  return json({ ok: true });
});

async function handle(supabase: SupabaseClient, chatId: string, text: string): Promise<void> {
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });

    const { data: hist } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("chat_id", chatId)
      .order("id", { ascending: false })
      .limit(12);
    const messages: Message[] = (hist ?? []).reverse().map((h) => ({ role: h.role, content: h.content }));
    while (messages.length && messages[0].role !== "user") messages.shift();
    messages.push({ role: "user", content: text });

    const ctx: { accessToken: string | null } = { accessToken: null };
    let answer = "";
    for (let i = 0; i < 8; i++) {
      const res = await claude(messages);
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason !== "tool_use") {
        answer = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        break;
      }
      const results = [];
      for (const b of res.content) {
        if (b.type !== "tool_use") continue;
        results.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: await runTool(supabase, ctx, b.name!, b.input ?? {}),
        });
      }
      messages.push({ role: "user", content: results });
    }
    if (!answer) answer = "Não consegui fechar a resposta. Tenta perguntar de outro jeito.";

    await supabase.from("chat_messages").insert([
      { chat_id: chatId, role: "user", content: text },
      { chat_id: chatId, role: "assistant", content: answer },
    ]);
    for (let i = 0; i < answer.length; i += 4000) await sendTelegram(chatId, answer.slice(i, i + 4000));
  } catch (e) {
    console.error("telegram:", e);
    await sendTelegram(chatId, `Deu erro aqui do meu lado: ${String(e).slice(0, 300)}`);
  }
}

async function claude(messages: Message[]): Promise<{ content: Block[]; stop_reason: string }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY ausente");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: systemPrompt(), tools: TOOLS, messages }),
  });
  if (!res.ok) throw new Error(`Claude (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

async function runTool(
  supabase: SupabaseClient,
  ctx: { accessToken: string | null },
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    if (name === "open_alerts") {
      const { data, error } = await supabase
        .from("alerts")
        .select("level, summary, opened_at, accounts(name)")
        .neq("status", "resolved")
        .order("opened_at", { ascending: false })
        .limit(30);
      if (error) throw new Error(error.message);
      return JSON.stringify(data);
    }

    ctx.accessToken ??= await getAccessToken();
    const mcc = Deno.env.get("GOOGLE_ADS_LOGIN_CUSTOMER_ID")!.trim();

    if (name === "find_account") {
      const rows = await gaqlSearch(
        ctx.accessToken,
        mcc,
        "SELECT customer_client.id, customer_client.descriptive_name, customer_client.status FROM customer_client WHERE customer_client.level = 1 AND customer_client.manager = false",
        500,
      );
      const q = normalize(String(input.query ?? ""));
      const found = rows
        .map((r) => r.customerClient as { id: string; descriptiveName?: string; status: string })
        .filter((c) => normalize(c.descriptiveName ?? "").includes(q))
        .slice(0, 15)
        .map((c) => ({ id: c.id, name: c.descriptiveName, status: c.status }));
      return JSON.stringify(found.length ? found : { found: 0, note: "nenhuma conta com esse nome" });
    }

    if (name === "run_gaql") {
      const customerId = String(input.customer_id ?? "").replace(/\D/g, "");
      const query = String(input.query ?? "").trim();
      if (!/^\d{8,12}$/.test(customerId)) return "ERRO: customer_id inválido";
      if (!/^select\s/i.test(query)) return "ERRO: a consulta precisa começar com SELECT";
      const rows = await gaqlSearch(ctx.accessToken, customerId, query, 60);
      return JSON.stringify({ rows: rows.length, data: rows }).slice(0, 14000);
    }

    return "ERRO: ferramenta desconhecida";
  } catch (e) {
    return `ERRO: ${String(e).slice(0, 800)}`;
  }
}

function tg(method: string, body: unknown): Promise<Response> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Minúsculas e sem acento. */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
