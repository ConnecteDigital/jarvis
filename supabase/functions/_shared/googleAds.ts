// Cliente mínimo da API do Google Ads (REST). Uma consulta por conta por checagem,
// para economizar a cota diária de operações.

const API_VERSION = Deno.env.get("GOOGLE_ADS_API_VERSION") ?? "v23";

export interface CampaignRow {
  id: string;
  name: string;
  primaryStatus: string;
  primaryStatusReasons: string[];
  budgetMicros: number;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
}

export interface AccountSnapshot {
  customerStatus: string | null;
  campaigns: CampaignRow[];
  impressions: number;
  clicks: number;
  cost: number; // em reais
  conversions: number;
  budget: number; // soma dos orçamentos diários das campanhas ativas, em reais
}

/** Troca o refresh token por um access token. */
export async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: need("GOOGLE_ADS_CLIENT_ID"),
    client_secret: need("GOOGLE_ADS_CLIENT_SECRET"),
    refresh_token: need("GOOGLE_ADS_REFRESH_TOKEN"),
  });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!res.ok) throw new Error(`OAuth falhou (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.access_token as string;
}

const QUERY = `
  SELECT
    customer.status,
    campaign.id,
    campaign.name,
    campaign.primary_status,
    campaign.primary_status_reasons,
    campaign_budget.amount_micros,
    metrics.impressions,
    metrics.clicks,
    metrics.cost_micros,
    metrics.conversions
  FROM campaign
  WHERE campaign.status = 'ENABLED'
    AND segments.date DURING TODAY`;

/** Métricas de hoje das campanhas ativas de uma conta. */
export async function fetchAccountSnapshot(
  accessToken: string,
  customerId: string,
): Promise<AccountSnapshot> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "login-customer-id": need("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
  };
  const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")?.trim();
  if (devToken) headers["developer-token"] = devToken;

  const campaigns: CampaignRow[] = [];
  let customerStatus: string | null = null;
  let pageToken: string | undefined;

  do {
    const res = await fetch(
      `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`,
      { method: "POST", headers, body: JSON.stringify({ query: QUERY, pageToken }) },
    );
    if (!res.ok) throw new Error(`Google Ads ${customerId} (${res.status}): ${await res.text()}`);
    const data = await res.json();
    for (const row of data.results ?? []) {
      customerStatus = row.customer?.status ?? customerStatus;
      campaigns.push({
        id: String(row.campaign?.id ?? ""),
        name: row.campaign?.name ?? "",
        primaryStatus: row.campaign?.primaryStatus ?? "UNKNOWN",
        primaryStatusReasons: row.campaign?.primaryStatusReasons ?? [],
        budgetMicros: Number(row.campaignBudget?.amountMicros ?? 0),
        impressions: Number(row.metrics?.impressions ?? 0),
        clicks: Number(row.metrics?.clicks ?? 0),
        costMicros: Number(row.metrics?.costMicros ?? 0),
        conversions: Number(row.metrics?.conversions ?? 0),
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  const sum = (f: (c: CampaignRow) => number) => campaigns.reduce((t, c) => t + f(c), 0);
  return {
    customerStatus,
    campaigns,
    impressions: sum((c) => c.impressions),
    clicks: sum((c) => c.clicks),
    cost: sum((c) => c.costMicros) / 1_000_000,
    conversions: sum((c) => c.conversions),
    budget: sum((c) => c.budgetMicros) / 1_000_000,
  };
}

function need(name: string): string {
  const value = Deno.env.get(name)?.trim(); // tira espaço ou quebra de linha colados junto
  if (!value) throw new Error(`Variável ${name} ausente`);
  return value;
}
