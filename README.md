# Jarvis

Agente de voz interno da Connect Digital. Vigia as contas de Google Ads dos clientes,
abre alertas quando algo sai do normal e conversa por ligação (ElevenLabs).

## Peças

| Peça | Onde fica | O que faz |
| --- | --- | --- |
| Banco | Supabase, projeto `jarvis` | Contas, regras, checagens, alertas, ligações |
| Vigia | `supabase/functions/watch` | Consulta cada conta de hora em hora e abre ou resolve alertas |
| Ferramentas do agente | `supabase/functions/agent-tools` | O que o agente de voz consulta durante a ligação |
| Regras | `supabase/functions/_shared/rules.ts` | Lógica dos alertas, testada em `tests/` |
| Voz | ElevenLabs, agente "Jarvis" | Conversa por voz em português |

## Estado atual

Pronto e testado:

- Esquema do banco aplicado, com sete regras cadastradas.
- Lógica de cinco regras: parou de veicular, site fora do ar, conta suspensa,
  orçamento limitando, gasto sem conversão.

Escrito, ainda não executado contra dados reais:

- Vigia (`watch`) e ferramentas do agente (`agent-tools`). Falta publicar as funções
  e configurar os segredos.

Ainda não feito:

- Regras de anúncios reprovados e de CPA acima da média.
- Disparo da ligação quando abre um alerta crítico (depende do número do Jarvis).
- Agendamento de hora em hora.
- Ações por voz.

## Segredos das funções

Ficam em Supabase > Edge Functions > Secrets. Nunca neste repositório.

| Nome | Para quê |
| --- | --- |
| `CRON_SECRET` | Protege a chamada do vigia |
| `AGENT_TOOLS_SECRET` | Protege as ferramentas chamadas pela ElevenLabs |
| `GOOGLE_ADS_CLIENT_ID` | OAuth do projeto "Connect Digital Ads" |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth do projeto "Connect Digital Ads" |
| `GOOGLE_ADS_REFRESH_TOKEN` | Acesso à MCC |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | ID da MCC, sem hífens |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Opcional, se a API ainda exigir |
| `GOOGLE_ADS_API_VERSION` | Opcional, padrão `v25` |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem dentro das funções.

## Testes

```
node --test --experimental-strip-types tests/rules.test.ts
```

## Cota da API do Google Ads

O vigia faz uma consulta por conta por checagem. Com 50 contas de hora em hora,
das 7h às 22h, são cerca de 750 operações por dia.
