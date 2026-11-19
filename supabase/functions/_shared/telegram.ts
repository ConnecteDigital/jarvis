// Avisos por Telegram. O token do bot fica no segredo TELEGRAM_BOT_TOKEN.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

/**
 * Conversa que recebe os avisos. Na primeira vez, usa a conversa privada mais
 * recente que falou com o bot e grava em settings.telegram_chat_id; depois disso
 * só essa conversa recebe, mesmo que outra pessoa escreva para o bot.
 */
export async function telegramChatId(
  supabase: SupabaseClient,
  settings: Record<string, unknown>,
): Promise<string | null> {
  const saved = settings.telegram_chat_id;
  if (saved) return String(saved);

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  if (!token) return null;
  const res = await fetch(api(token, "getUpdates"));
  if (!res.ok) return null;
  const data = await res.json();
  const chats = (data.result ?? [])
    .map((u: { message?: { chat?: { id: number; type: string } } }) => u.message?.chat)
    .filter((c: { type: string } | undefined) => c?.type === "private");
  const chat = chats.at(-1);
  if (!chat) return null;

  await supabase.from("settings").upsert({ key: "telegram_chat_id", value: String(chat.id) });
  return String(chat.id);
}

export async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  if (!token) return false;
  const res = await fetch(api(token, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) console.error("telegram:", res.status, await res.text());
  return res.ok;
}
