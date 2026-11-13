// Avaliação das regras de alerta. Função pura: recebe os dados da checagem
// e devolve quais regras estão quebradas, com a frase que o Jarvis vai falar.

import type { AccountSnapshot } from "./googleAds.ts";

export interface Account {
  id: string;
  customer_id: string;
  name: string;
  monitor_24h: boolean;
  site_url: string | null;
  daily_budget: number | null;
}

export interface PreviousCheck {
  checked_at: string;
  metrics: { impressions?: number; site_ok?: boolean | null };
}

export interface Finding {
  ruleKey: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface EvalInput {
  account: Account;
  snapshot: AccountSnapshot | null; // null quando a consulta ao Google Ads falhou
  siteOk: boolean | null; // null quando a conta não tem site cadastrado
  previous: PreviousCheck[]; // checagens anteriores, da mais nova para a mais velha
  params: Record<string, Record<string, unknown>>; // parâmetros por regra, já mesclados
  withinActiveHours: boolean;
  now: Date;
}

const brl = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`;

export function evaluate(input: EvalInput): Finding[] {
  const { account, snapshot, siteOk, previous, params, withinActiveHours, now } = input;
  const findings: Finding[] = [];
  const p = (rule: string, key: string, fallback: number) =>
    Number(params[rule]?.[key] ?? fallback);

  // Site fora do ar: falhou agora e nas checagens anteriores seguidas.
  if (siteOk === false) {
    const needed = p("site_down", "consecutive_failures", 2);
    const earlierFailures = countLeading(previous, (c) => c.metrics.site_ok === false);
    if (earlierFailures + 1 >= needed) {
      findings.push({
        ruleKey: "site_down",
        summary: `O site da ${account.name} está fora do ar.`,
        details: { site_url: account.site_url, failures: earlierFailures + 1 },
      });
    }
  }

  if (!snapshot) return findings;

  if (snapshot.customerStatus && snapshot.customerStatus !== "ENABLED") {
    findings.push({
      ruleKey: "account_suspended",
      summary: `A conta da ${account.name} não está ativa no Google Ads.`,
      details: { customer_status: snapshot.customerStatus },
    });
  }

  // Parou de veicular: há campanha ativa, estamos no horário em que a conta roda,
  // e as impressões de hoje não cresceram desde uma checagem de N minutos atrás.
  const activeNow = account.monitor_24h || withinActiveHours;
  if (activeNow && snapshot.campaigns.length > 0) {
    const windowMin = p("stopped_serving", "window_minutes", 120);
    const reference = previous.find(
      (c) => now.getTime() - new Date(c.checked_at).getTime() >= windowMin * 60_000,
    );
    // Só compara dentro do mesmo dia: as métricas zeram à meia-noite.
    if (
      reference &&
      sameLocalDay(new Date(reference.checked_at), now) &&
      typeof reference.metrics.impressions === "number" &&
      snapshot.impressions <= reference.metrics.impressions
    ) {
      findings.push({
        ruleKey: "stopped_serving",
        summary:
          `A ${account.name} parou de veicular: nenhuma impressão nova nos últimos ${windowMin} minutos.`,
        details: {
          impressions_now: snapshot.impressions,
          impressions_before: reference.metrics.impressions,
          since: reference.checked_at,
        },
      });
    }
  }

  const limited = snapshot.campaigns.filter((c) =>
    c.primaryStatusReasons.includes("BUDGET_CONSTRAINED")
  );
  if (limited.length > 0) {
    findings.push({
      ruleKey: "budget_limited",
      summary: `Na ${account.name}, o orçamento está limitando ${limited.length} campanha(s).`,
      details: { campaigns: limited.map((c) => c.name) },
    });
  }

  // Gasto sem conversão: passou de uma fração do orçamento diário e nada converteu.
  const budget = account.daily_budget ?? snapshot.budget;
  const ratio = p("spend_no_conversion", "spend_ratio_of_budget", 0.5);
  if (budget > 0 && snapshot.conversions === 0 && snapshot.cost >= budget * ratio) {
    findings.push({
      ruleKey: "spend_no_conversion",
      summary: `A ${account.name} já gastou ${brl(snapshot.cost)} hoje sem nenhuma conversão.`,
      details: { cost: snapshot.cost, budget, ratio },
    });
  }

  return findings;
}

function countLeading<T>(items: T[], test: (item: T) => boolean): number {
  let n = 0;
  for (const item of items) {
    if (!test(item)) break;
    n++;
  }
  return n;
}

const TZ = "America/Sao_Paulo";
const dayKey = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, dateStyle: "short" }).format(d);

export function sameLocalDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

/** A hora atual (em São Paulo) está dentro da janela "HH:MM" a "HH:MM"? */
export function withinHours(now: Date, start: string, end: string, timeZone = TZ): boolean {
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}
