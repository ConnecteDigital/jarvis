// Testes das regras de alerta. Rodar com: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, withinHours, type EvalInput } from "../supabase/functions/_shared/rules.ts";

const account = {
  id: "a1",
  customer_id: "1234567890",
  name: "Cliente Teste",
  monitor_24h: false,
  site_url: "https://exemplo.com.br",
  daily_budget: 600,
};

const campaign = (over = {}) => ({
  id: "1",
  name: "Desentupidora",
  primaryStatus: "ELIGIBLE",
  primaryStatusReasons: [] as string[],
  budgetMicros: 600_000_000,
  impressions: 100,
  clicks: 10,
  costMicros: 50_000_000,
  conversions: 2,
  ...over,
});

const snapshot = (over = {}) => ({
  customerStatus: "ENABLED",
  campaigns: [campaign()],
  impressions: 100,
  clicks: 10,
  cost: 50,
  conversions: 2,
  budget: 600,
  ...over,
});

// 13/11/2026 15:00 em São Paulo
const now = new Date("2026-11-13T18:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

const base = (over: Partial<EvalInput> = {}): EvalInput => ({
  account,
  snapshot: snapshot(),
  siteOk: true,
  previous: [],
  params: {},
  withinActiveHours: true,
  now,
  ...over,
});

const keys = (input: EvalInput) => evaluate(input).map((f) => f.ruleKey);

test("conta saudável não gera alerta", () => {
  assert.deepEqual(keys(base()), []);
});

test("parou de veicular quando as impressões não crescem em 2 horas", () => {
  const previous = [{ checked_at: minutesAgo(125), metrics: { impressions: 100 } }];
  assert.deepEqual(keys(base({ previous })), ["stopped_serving"]);
});

test("não acusa parada se as impressões cresceram", () => {
  const previous = [{ checked_at: minutesAgo(125), metrics: { impressions: 80 } }];
  assert.deepEqual(keys(base({ previous })), []);
});

test("não acusa parada fora do horário, a menos que a conta seja 24h", () => {
  const previous = [{ checked_at: minutesAgo(125), metrics: { impressions: 100 } }];
  assert.deepEqual(keys(base({ previous, withinActiveHours: false })), []);
  assert.deepEqual(
    keys(base({ previous, withinActiveHours: false, account: { ...account, monitor_24h: true } })),
    ["stopped_serving"],
  );
});

test("não compara com checagem do dia anterior", () => {
  // 00:30 em São Paulo, comparando com 22:25 da véspera
  const early = new Date("2026-11-14T03:30:00Z");
  const previous = [{
    checked_at: new Date(early.getTime() - 125 * 60_000).toISOString(),
    metrics: { impressions: 900 },
  }];
  const input = base({ now: early, previous, snapshot: snapshot({ impressions: 3 }) });
  assert.deepEqual(keys(input), []);
});

test("site fora do ar só depois de falhas seguidas", () => {
  assert.deepEqual(keys(base({ siteOk: false })), []);
  const previous = [{ checked_at: minutesAgo(60), metrics: { impressions: 50, site_ok: false } }];
  assert.deepEqual(keys(base({ siteOk: false, previous })), ["site_down"]);
});

test("site fora do ar é detectado mesmo se o Google Ads falhar", () => {
  const previous = [{ checked_at: minutesAgo(60), metrics: { site_ok: false } }];
  assert.deepEqual(keys(base({ snapshot: null, siteOk: false, previous })), ["site_down"]);
});

test("conta suspensa", () => {
  assert.deepEqual(keys(base({ snapshot: snapshot({ customerStatus: "SUSPENDED" }) })), [
    "account_suspended",
  ]);
});

test("orçamento limitando campanha", () => {
  const limited = campaign({ primaryStatusReasons: ["BUDGET_CONSTRAINED"] });
  assert.deepEqual(keys(base({ snapshot: snapshot({ campaigns: [limited] }) })), ["budget_limited"]);
});

test("gasto sem conversão respeita o limite por conta", () => {
  const spent = snapshot({ cost: 320, conversions: 0 });
  assert.deepEqual(keys(base({ snapshot: spent })), ["spend_no_conversion"]);
  // com limite de 80% do orçamento, R$ 320 de R$ 600 ainda não dispara
  const params = { spend_no_conversion: { spend_ratio_of_budget: 0.8 } };
  assert.deepEqual(keys(base({ snapshot: spent, params })), []);
});

test("janela de horário, inclusive atravessando a meia-noite", () => {
  assert.equal(withinHours(now, "07:00", "22:00"), true); // 15:00
  assert.equal(withinHours(new Date("2026-11-14T02:30:00Z"), "07:00", "22:00"), false); // 23:30
  assert.equal(withinHours(new Date("2026-11-14T02:30:00Z"), "22:00", "06:00"), true);
});
