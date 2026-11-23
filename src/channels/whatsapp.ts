/**
 * WhatsApp Business Cloud API adapter. Inactive until WHATSAPP_TOKEN and
 * WHATSAPP_PHONE_NUMBER_ID are set. Inbound messages arrive on /webhooks/whatsapp.
 *
 * Note: WhatsApp only allows free-form replies within 24 hours of the buyer's last
 * message. Messages after that (e.g. a waitlist "back in stock" offer) need a
 * pre-approved template; that is not wired up in v1.
 */
import type { Channel } from "./index.ts";

export interface InboundMessage {
  externalId: string;
  handle: string;
  name: string | null;
  text: string;
}

export function whatsappEnabled(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

export const whatsapp: Channel = {
  name: "whatsapp",
  async deliver(handle: string, text: string): Promise<void> {
    if (!whatsappEnabled()) throw new Error("WhatsApp is not configured");
    const version = process.env.WHATSAPP_API_VERSION || "v21.0";
    const res = await fetch(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: handle, type: "text", text: { body: text, preview_url: true } }),
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  },
};

/** Pull text messages out of a Cloud API webhook payload. Non-text messages are skipped. */
export function parseWebhook(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: { value?: Record<string, unknown> }[] }[]) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const contacts = (value.contacts as { wa_id: string; profile?: { name?: string } }[] | undefined) ?? [];
      for (const m of (value.messages as { id: string; from: string; type: string; text?: { body: string } }[] | undefined) ?? []) {
        if (m.type !== "text" || !m.text?.body) continue;
        const name = contacts.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        out.push({ externalId: `wa:${m.id}`, handle: m.from, name, text: m.text.body });
      }
    }
  }
  return out;
}
