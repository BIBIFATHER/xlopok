// Приём заявок с формы. Пишем в два приёмника:
//   1. Bitrix24 CRM (crm.lead.add) через входящий вебхук — основной;
//   2. Supabase (public.leads) — резервный, может быть не настроен.
// Секреты только в серверном env (process.env), НИКОГДА не в NEXT_PUBLIC_ и
// не в ответе/логах. Запрос считается успешным, если сработал хотя бы один
// приёмник — падение одного не роняет заявку.
//
// Молчаливых отказов быть не должно: каждая неудача приёмника пишется в
// stderr, а потерянная заявка — целиком, чтобы контакт клиента можно было
// достать из логов. GET /api/lead показывает, что вообще сконфигурировано.

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

async function toSupabase(lead: CleanLead): Promise<SinkResult> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !key) return "not-configured";

  try {
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
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`[lead] supabase ответил ${res.status}`);
    return res.ok ? "ok" : "failed";
  } catch (error) {
    // Проект может быть удалён или приостановлен — домен тогда не резолвится.
    console.error("[lead] supabase недоступен:", (error as Error).name);
    return "failed";
  }
}

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

  // Оба приёмника независимо и без взаимной блокировки.
  const [supabase, bitrix] = await Promise.allSettled([toSupabase(lead), toBitrix(lead)]);
  const supabaseResult = supabase.status === "fulfilled" ? supabase.value : "failed";
  const bitrixResult = bitrix.status === "fulfilled" ? bitrix.value : "failed";

  if (supabaseResult !== "ok" && bitrixResult !== "ok") {
    // Заявка потеряна. Пишем её в лог целиком — иначе контакт клиента исчезнет
    // бесследно, а форма на клиенте лишь предложит продублировать в Telegram.
    console.error(
      "[lead] ЗАЯВКА НЕ СОХРАНЕНА:",
      JSON.stringify({ ...lead, supabase: supabaseResult, bitrix: bitrixResult }),
    );
    return Response.json({ error: "upstream error" }, { status: 502 });
  }

  if (bitrixResult !== "ok") {
    console.error(`[lead] в CRM не попало (${bitrixResult}), заявка только в Supabase`);
  }

  return Response.json({ ok: true });
}

/**
 * Проверка конфигурации без отправки заявки: GET /api/lead.
 * Отдаёт только флаги — ни URL, ни ключей. Нужна, чтобы поломку окружения
 * на проде было видно сразу, а не по отсутствию лидов через неделю.
 */
export async function GET() {
  const supabaseReady = Boolean(env("SUPABASE_URL") && env("SUPABASE_PUBLISHABLE_KEY"));
  const bitrixReady = bitrixConfigured();
  // ready считаем по CRM: настроенный Supabase ещё не значит живой (проект может
  // быть удалён), и «ready: true» при мёртвом резерве маскировал бы потерю заявок.
  return Response.json(
    {
      bitrix: bitrixReady ? "configured" : "missing",
      supabase: supabaseReady ? "configured" : "missing",
      ready: bitrixReady,
    },
    { status: bitrixReady ? 200 : 503 },
  );
}
