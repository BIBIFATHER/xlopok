// Приём заявок с формы → Supabase (таблица public.leads).
// Ключи только в env, не в коде. Publishable-ключ работает как роль anon
// под RLS-политикой insert-only.

type LeadPayload = {
  name?: string;
  contact?: string;
  need?: string;
  company?: string;
  comment?: string;
};

const clip = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

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

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    // Временная диагностика: какие SUPABASE_*-переменные видит рантайм (без значений).
    const seen = Object.keys(process.env).filter((k) => k.includes("SUPABASE"));
    return Response.json(
      { error: "not configured", hasUrl: !!url, hasKey: !!key, seen },
      { status: 500 },
    );
  }

  const res = await fetch(`${url}/rest/v1/leads`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      name,
      contact,
      need: clip(body.need, 100),
      company: clip(body.company, 300),
      comment: clip(body.comment, 4000),
      source: "site-v2",
    }),
  });

  if (!res.ok) {
    return Response.json({ error: "upstream error" }, { status: 502 });
  }

  return Response.json({ ok: true });
}
