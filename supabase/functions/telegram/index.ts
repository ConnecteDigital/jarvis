// Conversa pelo Telegram: recebe a mensagem do Gabriel, deixa o Claude consultar
// o Google Ads (somente leitura) e o banco, e responde na mesma conversa.

import { db, json } from "../_shared/db.ts";
import { gadsMutate, gaqlSearch, getAccessToken } from "../_shared/googleAds.ts";
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
    name: "get_notes",
    description:
      "Lê as anotações guardadas sobre os clientes (preferências, restrições, histórico). Sem customer_id, devolve as de todas as contas. Consulte antes de revisar ou sugerir mudança numa conta.",
    input_schema: { type: "object", properties: { customer_id: { type: "string" } } },
  },
  {
    name: "add_note",
    description: "Guarda uma anotação sobre um cliente, quando o Gabriel pedir para anotar ou lembrar algo.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "ID da conta, só números" },
        account_name: { type: "string" },
        note: { type: "string", description: "A anotação, nas palavras do Gabriel" },
      },
      required: ["customer_id", "account_name", "note"],
    },
  },
  {
    name: "propose_action",
    description:
      "Prepara UMA alteração numa conta: pausar campanha, ativar campanha, mudar orçamento diário ou negativar termos na campanha. Não executa: grava como pendente e devolve a descrição. A execução só acontece se o Gabriel responder 'confirma'.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pause_campaign", "enable_campaign", "set_budget", "add_negatives"] },
        customer_id: { type: "string", description: "ID da conta, só números" },
        campaign_id: { type: "string", description: "ID da campanha (campaign.id)" },
        new_daily_budget: { type: "number", description: "Só para set_budget: novo orçamento diário em reais" },
        negatives: {
          type: "array",
          description: "Só para add_negatives",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              match_type: { type: "string", enum: ["BROAD", "PHRASE", "EXACT"] },
            },
            required: ["text", "match_type"],
          },
        },
      },
      required: ["action", "customer_id", "campaign_id"],
    },
  },
  {
    name: "open_alerts",
    description: "Lista os alertas em aberto detectados pelo vigia nas contas monitoradas.",
    input_schema: { type: "object", properties: {} },
  },
];

function systemPrompt(manual: string): string {
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
- Alterar conta só por propose_action, uma alteração por vez: pausar campanha, ativar campanha, mudar orçamento diário e negativar termos. Depois de chamar a ferramenta, mostre ao Gabriel a descrição que ela devolveu, sem mudar o sentido, e peça para ele responder "confirma". Você nunca executa nada: quem executa é o sistema, e só se a próxima mensagem dele for uma confirmação. Qualquer outra resposta cancela.
- Nunca diga que uma alteração foi feita. Isso só o sistema informa.
- Criar campanha, mexer em anúncio, lance ou segmentação ainda não está ligado: diga isso e sugira fazer pelo Claude.
- Antes de revisar uma conta ou sugerir mudança, leia as anotações do cliente com get_notes e siga o manual abaixo.
- A API não informa saldo da conta. Se perguntarem de saldo, explique e mostre o gasto recente.

GAQL, para lembrar:
- Períodos: segments.date DURING TODAY | YESTERDAY | LAST_7_DAYS | LAST_30_DAYS, ou BETWEEN 'AAAA-MM-DD' AND 'AAAA-MM-DD'.
- Visão geral: FROM campaign, com campaign.name, campaign.status, campaign.primary_status, campaign.primary_status_reasons, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.cost_per_conversion. Para dia a dia, inclua segments.date.
- Palavras-chave: FROM keyword_view com ad_group_criterion.keyword.text e ad_group_criterion.keyword.match_type.
- Termos de pesquisa: FROM search_term_view com search_term_view.search_term.
- Cliques individuais: FROM click_view exige filtro de um único dia (segments.date = 'AAAA-MM-DD').
- Use ORDER BY e LIMIT para trazer só o necessário. Cada consulta gasta cota, então prefira poucas consultas bem feitas.

${manual}`;
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
type Message = { role: "user" | "assistant"; content: string | unknown[] };

Deno.serve(async (req) => {
  const supabase = db();
  const { data: rows } = await supabase
    .from("settings")
    .select("key, value")
    .in("key", ["cron_secret", "telegram_webhook_secret", "telegram_chat_id", "manual"]);
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
  if (!msg || String(msg.chat?.id) !== String(s.telegram_chat_id)) return json({ ok: true });
  const voiceId: string | undefined = msg.voice?.file_id ?? msg.audio?.file_id;
  if (!msg.text && !voiceId) return json({ ok: true });

  // Responde ao Telegram na hora e processa em segundo plano, para ele não reenviar a mensagem.
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime.waitUntil(handle(supabase, String(msg.chat.id), msg.text ?? "", voiceId, s.manual ?? ""));
  return json({ ok: true });
});

async function handle(
  supabase: SupabaseClient,
  chatId: string,
  text: string,
  voiceId: string | undefined,
  manual: string,
): Promise<void> {
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });

    if (voiceId) {
      text = await transcribe(voiceId);
      if (!text) {
        await sendTelegram(chatId, "Não consegui entender o áudio. Manda de novo ou escreve.");
        return;
      }
    }

    // Ação pendente: quem decide é o código, não o modelo. Só executa com confirmação explícita.
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const { data: pend } = await supabase
      .from("actions")
      .select("id, params")
      .eq("status", "pending")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);
    const pending = pend?.[0];
    if (pending) {
      const said = normalize(text).replace(/[.!]/g, "");
      if (YES.has(said)) {
        const result = await execute(supabase, pending.id, pending.params as ActionParams);
        await remember(supabase, chatId, text, result);
        await sendTelegram(chatId, result);
        return;
      }
      await supabase.from("actions").update({ status: "cancelled" }).eq("id", pending.id);
      if (NO.has(said)) {
        await remember(supabase, chatId, text, "Cancelado. Não mexi em nada.");
        await sendTelegram(chatId, "Cancelado. Não mexi em nada.");
        return;
      }
      // Qualquer outra mensagem cancela a pendência e segue a conversa normal.
    }

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
      const res = await claude(messages, manual);
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

    await remember(supabase, chatId, text, answer);
    for (let i = 0; i < answer.length; i += 4000) await sendTelegram(chatId, answer.slice(i, i + 4000));
  } catch (e) {
    console.error("telegram:", e);
    await sendTelegram(chatId, `Deu erro aqui do meu lado: ${String(e).slice(0, 300)}`);
  }
}

async function claude(messages: Message[], manual: string): Promise<{ content: Block[]; stop_reason: string }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY ausente");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: systemPrompt(manual), tools: TOOLS, messages }),
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

    if (name === "get_notes") {
      let q = supabase.from("account_notes").select("customer_id, account_name, note, created_at").order("id");
      const cid = String(input.customer_id ?? "").replace(/\D/g, "");
      if (cid) q = q.eq("customer_id", cid);
      const { data, error } = await q.limit(200);
      if (error) throw new Error(error.message);
      return JSON.stringify(data?.length ? data : { notes: 0 });
    }

    if (name === "add_note") {
      const cid = String(input.customer_id ?? "").replace(/\D/g, "");
      const note = String(input.note ?? "").trim();
      if (!/^\d{8,12}$/.test(cid) || !note) return "ERRO: customer_id ou anotação inválidos";
      const { error } = await supabase
        .from("account_notes")
        .insert({ customer_id: cid, account_name: String(input.account_name ?? ""), note });
      if (error) throw new Error(error.message);
      return "anotação guardada";
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

    if (name === "propose_action") return await propose(supabase, ctx.accessToken, input);

    return "ERRO: ferramenta desconhecida";
  } catch (e) {
    return `ERRO: ${String(e).slice(0, 800)}`;
  }
}

// ---------- Alterações com confirmação ----------

const YES = new Set(["confirma", "confirmo", "confirmado", "sim", "pode", "pode fazer", "pode mandar", "manda ver", "ok"]);
const NO = new Set(["nao", "cancela", "cancelar", "deixa", "deixa quieto", "para"]);

type ActionParams = {
  type: "pause_campaign" | "enable_campaign" | "set_budget" | "add_negatives";
  customer_id: string;
  account_name: string;
  campaign_id: string;
  campaign_name: string;
  campaign_resource: string;
  budget_resource: string;
  old_budget: number;
  new_budget?: number;
  negatives?: { text: string; match_type: string }[];
  description: string;
};

const brl = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`;
const MATCH: Record<string, string> = { BROAD: "ampla", PHRASE: "frase", EXACT: "exata" };

/** Confere a campanha, monta a descrição e grava a ação como pendente. Não altera nada. */
async function propose(
  supabase: SupabaseClient,
  accessToken: string,
  input: Record<string, unknown>,
): Promise<string> {
  const type = String(input.action) as ActionParams["type"];
  const customerId = String(input.customer_id ?? "").replace(/\D/g, "");
  const campaignId = String(input.campaign_id ?? "").replace(/\D/g, "");
  if (!/^\d{8,12}$/.test(customerId) || !campaignId) return "ERRO: conta ou campanha inválida";

  const rows = await gaqlSearch(
    accessToken,
    customerId,
    `SELECT customer.descriptive_name, campaign.id, campaign.name, campaign.status, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${campaignId}`,
    1,
  );
  if (!rows.length) return "ERRO: campanha não encontrada nessa conta";
  // deno-lint-ignore no-explicit-any
  const row = rows[0] as any;
  const account = row.customer?.descriptiveName ?? customerId;
  const camp = row.campaign;
  const oldBudget = Number(row.campaignBudget?.amountMicros ?? 0) / 1_000_000;

  let description: string;
  const p: ActionParams = {
    type,
    customer_id: customerId,
    account_name: account,
    campaign_id: campaignId,
    campaign_name: camp.name,
    campaign_resource: camp.resourceName,
    budget_resource: camp.campaignBudget,
    old_budget: oldBudget,
    description: "",
  };

  if (type === "pause_campaign") {
    if (camp.status === "PAUSED") return "A campanha já está pausada. Nada a fazer.";
    description = `Pausar a campanha "${camp.name}" na conta ${account}.`;
  } else if (type === "enable_campaign") {
    if (camp.status === "ENABLED") return "A campanha já está ativa. Nada a fazer.";
    description = `Ativar a campanha "${camp.name}" na conta ${account}.`;
  } else if (type === "set_budget") {
    const nb = Number(input.new_daily_budget);
    if (!(nb > 0) || nb > 20000) return "ERRO: orçamento inválido (precisa ser entre R$ 0,01 e R$ 20.000,00 por dia)";
    p.new_budget = nb;
    description = `Mudar o orçamento diário da campanha "${camp.name}" na conta ${account} de ${brl(oldBudget)} para ${brl(nb)}.`;
    if (row.campaignBudget?.explicitlyShared) {
      description += " Atenção: esse orçamento é compartilhado, então a mudança vale para todas as campanhas que usam ele.";
    }
  } else if (type === "add_negatives") {
    const list = (Array.isArray(input.negatives) ? input.negatives : [])
      .map((n: { text?: string; match_type?: string }) => ({
        text: String(n.text ?? "").trim().toLowerCase(),
        match_type: String(n.match_type ?? "").toUpperCase(),
      }))
      .filter((n) => n.text && MATCH[n.match_type]);
    if (!list.length) return "ERRO: nenhuma negativa válida";
    if (list.length > 30) return "ERRO: no máximo 30 negativas por vez. Para listas maiores, entregue a lista escrita.";
    p.negatives = list;
    description = `Negativar ${list.length} termo(s) na campanha "${camp.name}" da conta ${account}:\n` +
      list.map((n) => `- ${n.text} (${MATCH[n.match_type]})`).join("\n");
  } else {
    return "ERRO: ação desconhecida";
  }

  p.description = description;
  await supabase.from("actions").update({ status: "cancelled" }).eq("status", "pending");
  const { error } = await supabase.from("actions").insert({ action: type, params: p });
  if (error) throw new Error(error.message);
  return JSON.stringify({
    pendente: true,
    descricao: description,
    instrucao: "Mostre esta descrição ao Gabriel e peça para ele responder 'confirma'. Vale por 15 minutos.",
  });
}

/** Executa a ação confirmada e devolve o texto que vai para o Gabriel. */
async function execute(supabase: SupabaseClient, id: string, p: ActionParams): Promise<string> {
  try {
    const token = await getAccessToken();
    let result: unknown;
    if (p.type === "pause_campaign" || p.type === "enable_campaign") {
      const status = p.type === "pause_campaign" ? "PAUSED" : "ENABLED";
      result = await gadsMutate(token, p.customer_id, "campaigns", [
        { update: { resourceName: p.campaign_resource, status }, updateMask: "status" },
      ]);
    } else if (p.type === "set_budget") {
      result = await gadsMutate(token, p.customer_id, "campaignBudgets", [
        {
          update: { resourceName: p.budget_resource, amountMicros: String(Math.round(p.new_budget! * 1_000_000)) },
          updateMask: "amount_micros",
        },
      ]);
    } else {
      result = await gadsMutate(
        token,
        p.customer_id,
        "campaignCriteria",
        p.negatives!.map((n) => ({
          create: { campaign: p.campaign_resource, negative: true, keyword: { text: n.text, matchType: n.match_type } },
        })),
      );
    }
    await supabase
      .from("actions")
      .update({ status: "executed", confirmed: true, result, executed_at: new Date().toISOString() })
      .eq("id", id);
    return `Feito. ${p.description}`;
  } catch (e) {
    await supabase
      .from("actions")
      .update({ status: "failed", confirmed: true, result: { error: String(e) } })
      .eq("id", id);
    return `Não consegui executar, e nada foi alterado. ${p.description}\nErro: ${String(e).slice(0, 300)}`;
  }
}

async function remember(supabase: SupabaseClient, chatId: string, user: string, assistant: string) {
  await supabase.from("chat_messages").insert([
    { chat_id: chatId, role: "user", content: user },
    { chat_id: chatId, role: "assistant", content: assistant },
  ]);
}

// ---------- Áudio ----------

/** Baixa o áudio do Telegram e transcreve pela ElevenLabs. Devolve "" se não der. */
async function transcribe(fileId: string): Promise<string> {
  const key = Deno.env.get("ELEVENLABS_API_KEY")?.trim();
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  if (!key) throw new Error("áudio ainda não está ligado: falta o segredo ELEVENLABS_API_KEY");
  const info = await (await tg("getFile", { file_id: fileId })).json();
  const path = info?.result?.file_path;
  if (!path) return "";
  const audio = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!audio.ok) return "";
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("language_code", "por");
  form.append("file", await audio.blob(), "audio.ogg");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  if (!res.ok) throw new Error(`transcrição (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return String((await res.json()).text ?? "").trim();
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
