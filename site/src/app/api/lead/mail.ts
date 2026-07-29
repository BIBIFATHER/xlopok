// Дубль заявки письмом на ящик, подключённый к Битриксу: если вебхук CRM
// недоступен, письмо всё равно превратится в лид (из текста, а не по полям).
// Настраивается независимо от вебхука — без переменных просто выключено.

import nodemailer from "nodemailer";

export type MailLead = {
  name: string;
  contact: string;
  need: string | null;
  company: string | null;
  comment: string | null;
};

export type SinkResult = "ok" | "not-configured" | "failed";

const env = (name: string) => process.env[name]?.trim() || null;

export function mailConfigured(): boolean {
  return Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASSWORD") && env("LEAD_EMAIL_TO"));
}

export async function toEmail(lead: MailLead): Promise<SinkResult> {
  if (!mailConfigured()) return "not-configured";

  const host = env("SMTP_HOST")!;
  const user = env("SMTP_USER")!;
  const pass = env("SMTP_PASSWORD")!;
  const to = env("LEAD_EMAIL_TO")!;
  // 465 — implicit TLS, 587 — STARTTLS. Порт задаётся явно, чтобы не гадать.
  const port = Number(env("SMTP_PORT") ?? 465);

  const lines = [
    `Имя: ${lead.name}`,
    `Контакт: ${lead.contact}`,
    lead.need ? `Что нужно: ${lead.need}` : null,
    lead.company ? `Компания: ${lead.company}` : null,
    lead.comment ? `Комментарий: ${lead.comment}` : null,
    "",
    "Отправлено формой на canvaslab.ru",
  ].filter((line) => line !== null);

  try {
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 8000,
    });

    await transport.sendMail({
      from: user,
      to,
      // Тема попадает в название лида, если письмо разбирает Битрикс.
      subject: `Заявка с сайта: ${lead.name}`,
      text: lines.join("\n"),
      replyTo: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead.contact) ? lead.contact : undefined,
    });
    return "ok";
  } catch (error) {
    // Пароль в сообщение об ошибке не попадает: логируем только тип.
    console.error("[lead] почта не отправлена:", (error as Error).message.slice(0, 120));
    return "failed";
  }
}
