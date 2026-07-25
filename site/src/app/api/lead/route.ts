// Приём заявок с формы. Пишем в два приёмника:
//   1. Supabase (public.leads) — как было;
//   2. Bitrix24 CRM (crm.lead.add) через входящий вебхук.
// Секреты только в серверном env (process.env), НИКОГДА не в NEXT_PUBLIC_ и
// не в ответе/логах. Запрос считается успешным, если сработал хотя бы один
// приёмник — падение одного не роняет заявку.

type LeadPayload = {
  name?: string;
  contact?: string;
  need?: string;
  company?: string;
  comment?: string;
};

const clip = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

type CleanLead = {
  name: string;
  contact: string;
  need: string | null;
  company: string | null;
  comment: string | null;
};

async function toSupabase(lead: CleanLead): Promise<boolean> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return false;

  const res = await fetch(`${url}/rest/v1/leads`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      name: lead.name,
      contact: lead.contact,
      need: lead.need,
      company: lead.company,
      comment: lead.comment,
      source: "site-v2",
    }),
  });
  return res.ok;
}

async function toBitrix(lead: CleanLead): Promise<boolean> {
  // Полный URL входящего вебхука, БЕЗ имени метода. Только серверный env.
  const webhook = process.env.BITRIX24_WEBHOOK_URL;
  if (!webhook || !/\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(webhook)) return false;
  const base = webhook.replace(/\/+$/, "") + "/";

  const comments = [
    lead.need ? `Потребность: ${lead.need}` : null,
    lead.comment,
  ]
    .filter(Boolean)
    .join("\n");

  const fields: Record<string, unknown> = {
    TITLE: `Заявка с сайта: ${lead.name}`,
    NAME: lead.name,
    SOURCE_ID: "WEB",
    OPENED: "Y",
    ...(lead.company ? { COMPANY_TITLE: lead.company } : {}),
    ...(comments ? { COMMENTS: comments } : {}),
  };
  if (isEmail(lead.contact)) {
    fields.EMAIL = [{ VALUE: lead.contact, VALUE_TYPE: "WORK" }];
  } else {
    fields.PHONE = [{ VALUE: lead.contact, VALUE_TYPE: "WORK" }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${base}crm.lead.add.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields, params: { REGISTER_SONET_EVENT: "Y" } }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data: { result?: number; error?: string } = await res.json();
    return typeof data.result === "number";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request) {
  let body: LeadPayload;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const name = clip(body.name, 200);
  const contact = clip(body.contact, 200);
  if (!name || !contact) {
    return Response.json({ error: "name and contact required" }, { status: 400 });
  }

  const lead: CleanLead = {
    name,
    contact,
    need: clip(body.need, 100),
    company: clip(body.company, 300),
    comment: clip(body.comment, 4000),
  };

  // Оба приёмника независимо и без взаимной блокировки.
  const [supabase, bitrix] = await Promise.allSettled([toSupabase(lead), toBitrix(lead)]);
  const okSupabase = supabase.status === "fulfilled" && supabase.value;
  const okBitrix = bitrix.status === "fulfilled" && bitrix.value;

  if (!okSupabase && !okBitrix) {
    return Response.json({ error: "upstream error" }, { status: 502 });
  }

  return Response.json({ ok: true });
}
