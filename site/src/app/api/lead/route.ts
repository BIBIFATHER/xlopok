// Приём заявок с формы. Два приёмника:
//   1. Bitrix24 CRM (crm.lead.add) через входящий вебхук — основной;
//   2. письмо на ящик, подключённый к CRM — резерв на случай, если вебхук
//      недоступен. Настраивается отдельно, без переменных просто выключен.
// Секреты только в серверном env (process.env), НИКОГДА не в NEXT_PUBLIC_ и
// не в ответе/логах.
//
// Молчаливых отказов быть не должно: неудача приёмника пишется в stderr, а
// потерянная заявка — целиком, чтобы контакт клиента можно было достать из
// логов хостинга. GET /api/lead показывает, что сконфигурировано.

import { mailConfigured, toEmail } from "./mail";

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

/** Причина отказа приёмника. Секреты сюда не попадают — только состояние. */
type SinkResult = "ok" | "not-configured" | "failed";

/** Переменная задана и непустая: пробелы из панели хостинга не считаются значением. */
const env = (name: string) => process.env[name]?.trim() || null;

/** Вебхук задан и похож на правильный URL. Значение наружу не отдаём. */
function bitrixConfigured(): boolean {
  const webhook = env("BITRIX24_WEBHOOK_URL");
  return Boolean(webhook && /\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(webhook));
}

async function toBitrix(lead: CleanLead): Promise<SinkResult> {
  // Полный URL входящего вебхука, БЕЗ имени метода. Только серверный env.
  const webhook = env("BITRIX24_WEBHOOK_URL");
  if (!bitrixConfigured()) {
    console.error(
      "[lead] BITRIX24_WEBHOOK_URL не задан или задан неверно — заявка не попадёт в CRM",
    );
    return "not-configured";
  }
  const base = webhook!.replace(/\/+$/, "") + "/";

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
    if (!res.ok) {
      console.error(`[lead] bitrix ответил ${res.status}`);
      return "failed";
    }
    const data: { result?: number; error?: string; error_description?: string } = await res.json();
    if (typeof data.result !== "number") {
      // error_description приходит от Битрикса и не содержит наш вебхук.
      console.error("[lead] bitrix отклонил заявку:", data.error_description ?? data.error);
      return "failed";
    }
    return "ok";
  } catch (error) {
    console.error("[lead] bitrix недоступен:", (error as Error).name);
    return "failed";
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

  // Приёмники независимы: письмо уходит, даже если вебхук лёг, и наоборот.
  const [bitrixSettled, mailSettled] = await Promise.allSettled([toBitrix(lead), toEmail(lead)]);
  const bitrix = bitrixSettled.status === "fulfilled" ? bitrixSettled.value : "failed";
  const mail = mailSettled.status === "fulfilled" ? mailSettled.value : "failed";

  if (bitrix !== "ok" && mail !== "ok") {
    // Заявка потеряна. Пишем её в лог целиком — иначе контакт клиента исчезнет
    // бесследно, а форма на клиенте лишь предложит продублировать в Telegram.
    console.error("[lead] ЗАЯВКА НЕ СОХРАНЕНА:", JSON.stringify({ ...lead, bitrix, mail }));
    return Response.json({ error: "upstream error" }, { status: 502 });
  }

  if (bitrix !== "ok") {
    console.error(`[lead] в CRM напрямую не попало (${bitrix}) — заявка ушла письмом`);
  }

  return Response.json({ ok: true });
}

/**
 * Проверка конфигурации без отправки заявки: GET /api/lead.
 * Отдаёт только флаги — ни URL, ни ключей. Нужна, чтобы поломку окружения
 * на проде было видно сразу, а не по отсутствию лидов через неделю.
 */
export async function GET() {
  const bitrixReady = bitrixConfigured();
  const mailReady = mailConfigured();
  return Response.json(
    {
      bitrix: bitrixReady ? "configured" : "missing",
      mail: mailReady ? "configured" : "missing",
      ready: bitrixReady || mailReady,
    },
    { status: bitrixReady || mailReady ? 200 : 503 },
  );
}
