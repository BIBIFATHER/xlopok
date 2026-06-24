"use client";

import Image from "next/image";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

const telegramUrl = "https://t.me/anosov.anton";

const navItems = [
  { href: "#production", label: "Производство" },
  { href: "#products", label: "Продукция" },
  { href: "#sound", label: "Звук" },
  { href: "#contacts", label: "Контакты" },
];

const steps = [
  {
    title: "Отбор сырья",
    text: "Используем длинноволокнистый хлопок высокого качества. Нить прочная, ровная, без примесей.",
    icon: "cotton",
  },
  {
    title: "Ткачество",
    text: "Формируем полотно на современных станках, контролируем плотность и структуру на каждом метре.",
    icon: "grid",
  },
  {
    title: "Проклейка",
    text: "Наносим экологичный клеевой состав для стабильности и долговечности полотна.",
    icon: "drop",
  },
  {
    title: "Натяжка и сборка",
    text: "Ручная натяжка на деревянный подрамник. Проверяем натяжение и геометрию каждого холста.",
    icon: "frame",
  },
];

// Реальный ассортимент из PDF (BLI-130). Цены и условия сотрудничества не публикуем.
// gallery — временные фото-ракурсы, заменить на реальные снимки каждого типа.
const catalogCards = [
  {
    title: "Подрамник / мелкое и среднее зерно",
    meta: ["100% хлопок", "Плотность: 280 / 300 г/м2", "Грунт: акриловый", "Профиль: 16x23 / 18x28 / 20x42 мм"],
    range: "15x15 — 100x150 см",
    gallery: ["/media/v2/hero-canvas.jpg", "/media/canvas-front-surface.jpg", "/media/v2/construction-corner.jpg"],
  },
  {
    title: "Подрамник / крупное зерно",
    meta: ["100% хлопок, двунитка", "Плотность: 430 г/м2", "Грунт: акриловый", "Профиль: 18x28 / 20x42 мм"],
    range: "18x24 — 100x150 см",
    gallery: ["/media/canvas-back-frame.jpg", "/media/canvas-stretch-process.jpg", "/media/v2/construction-corner.jpg"],
  },
  {
    title: "Холст на картоне",
    meta: ["100% хлопок, мелкое зерно", "Плотность: 280 г/м2", "Грунт: акриловый", "Картон: 2.5 / 3 мм"],
    range: "10x15 — 40x60 см",
    gallery: ["/media/canvas-front-surface.jpg", "/media/v2/hero-canvas.jpg", "/media/v2/sound-touch.jpg"],
  },
];

type FormState = {
  name: string;
  contact: string;
  need: string;
  company: string;
  comment: string;
};

const initialForm: FormState = {
  name: "",
  contact: "",
  need: "Размер",
  company: "",
  comment: "",
};

const WAVE_BARS = 62;

function SectionLabel({ value }: { value: string }) {
  return (
    <div className="mb-5 flex items-center gap-5 text-[16px] leading-none text-[#e59b6a]">
      <span>{value}</span>
      <span className="h-px w-16 bg-[#e59b6a]" />
    </div>
  );
}

function ProcessIcon({ type }: { type: string }) {
  if (type === "grid") {
    return (
      <svg viewBox="0 0 40 40" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.4">
        {[10, 20, 30].map((x) => (
          <path d={`M${x} 5v30`} key={x} />
        ))}
        {[10, 20, 30].map((y) => (
          <path d={`M5 ${y}h30`} key={y} />
        ))}
      </svg>
    );
  }
  if (type === "drop") {
    return (
      <svg viewBox="0 0 40 40" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M20 5c6 8 10 13 10 19a10 10 0 0 1-20 0c0-6 4-11 10-19Z" />
      </svg>
    );
  }
  if (type === "frame") {
    return (
      <svg viewBox="0 0 40 40" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M12 5h16v30H12z" />
        <path d="M16 9v26M28 5l-4 4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M20 32V12" />
      <path d="M20 12c-6-5-13-2-12 5 7 1 10-1 12-5Z" />
      <path d="M20 12c6-5 13-2 12 5-7 1-10-1-12-5Z" />
      <path d="M20 23c-5-4-10-1-9 5 5 0 7-1 9-5Z" />
      <path d="M20 23c5-4 10-1 9 5-5 0-7-1-9-5Z" />
    </svg>
  );
}

function Waveform({ pulseKey, reduce }: { pulseKey: number; reduce: boolean | null }) {
  const mid = (WAVE_BARS - 1) / 2;
  return (
    <div className="flex h-10 items-center gap-[3px]">
      {Array.from({ length: WAVE_BARS }).map((_, index) => {
        const dist = Math.abs(index - mid) / mid;
        const idle = 4 + (1 - dist) * 6;
        const peak = 10 + (1 - dist) * 30;
        return (
          <motion.span
            key={`${index}-${pulseKey}`}
            className="w-px bg-[#4d4b3a]/55"
            initial={{ height: idle }}
            animate={
              reduce || pulseKey === 0
                ? { height: idle }
                : { height: [idle, peak, idle * 1.4, idle] }
            }
            transition={{ duration: 0.85, delay: dist * 0.12, ease: [0.22, 1, 0.36, 1] }}
          />
        );
      })}
    </div>
  );
}

export default function HlopokLandingV2() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const [form, setForm] = useState<FormState>(initialForm);
  const [status, setStatus] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [lightbox, setLightbox] = useState<{ card: number; photo: number } | null>(null);
  const shouldReduceMotion = useReducedMotion();

  const closeLightbox = useCallback(() => setLightbox(null), []);
  const stepLightbox = useCallback((delta: number) => {
    setLightbox((current) => {
      if (!current) return current;
      const total = catalogCards[current.card].gallery.length;
      return { ...current, photo: (current.photo + delta + total) % total };
    });
  }, []);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeLightbox();
      if (event.key === "ArrowRight") stepLightbox(1);
      if (event.key === "ArrowLeft") stepLightbox(-1);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [lightbox, closeLightbox, stepLightbox]);

  const playTension = async () => {
    setPulseKey((key) => key + 1);

    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(35);
    }

    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    await audio.play().catch(() => setStatus("Нажмите ещё раз: браузер ждёт явный запуск звука."));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!form.name.trim() || !form.contact.trim()) {
      setStatus("Заполните имя и контакт — иначе не сможем ответить.");
      return;
    }

    const text = [
      "Заявка с сайта Хлопок / v2",
      `Имя: ${form.name || "-"}`,
      `Контакт: ${form.contact || "-"}`,
      `Что нужно: ${form.need || "-"}`,
      `Реквизиты компании: ${form.company || "-"}`,
      `Комментарий: ${form.comment || "-"}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setStatus("Сообщение скопировано. Откроется Telegram — вставьте текст в чат.");
    } catch {
      setStatus("Откроется Telegram. Скопируйте детали заявки вручную.");
    }

    window.open(telegramUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <main className="min-h-screen bg-[#fbfaf6] text-[#4d4b3a]">
      <audio ref={audioRef} preload="auto" src="/media/canvas-tension-hit.m4a" />

      <header className="relative z-50 mx-auto flex max-w-[1720px] items-center justify-between gap-6 px-8 py-7 md:px-14">
        <button
          type="button"
          className="flex h-10 w-10 flex-col items-center justify-center gap-[5px] md:hidden"
          aria-label="Меню"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((value) => !value)}
        >
          <span className={`h-px w-6 bg-[#4d4b3a] transition ${mobileOpen ? "translate-y-[6px] rotate-45" : ""}`} />
          <span className={`h-px w-6 bg-[#4d4b3a] transition ${mobileOpen ? "opacity-0" : ""}`} />
          <span className={`h-px w-6 bg-[#4d4b3a] transition ${mobileOpen ? "-translate-y-[6px] -rotate-45" : ""}`} />
        </button>
        <nav className="hidden items-center gap-20 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#4d4b3a]/70 md:flex">
          {navItems.map((item) => (
            <a className="transition hover:text-[#4d4b3a]" href={item.href} key={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <a
          className="rounded-[3px] bg-[#4d4b3a] px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#fbfaf6] md:px-8"
          href={telegramUrl}
          target="_blank"
          rel="noreferrer"
        >
          Связаться с нами
        </a>

        {mobileOpen ? (
          <div className="absolute left-0 right-0 top-full border-t border-[#4d4b3a]/12 bg-[#fbfaf6] px-8 py-6 md:hidden">
            <nav className="flex flex-col gap-5 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#4d4b3a]/80">
              {navItems.map((item) => (
                <a
                  className="transition hover:text-[#4d4b3a]"
                  href={item.href}
                  key={item.href}
                  onClick={() => setMobileOpen(false)}
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
        ) : null}
      </header>

      <section className="relative mx-auto max-w-[1720px] px-8 pb-12 md:px-14">
        <h1 className="relative z-10 -ml-2 font-serif text-[clamp(6.7rem,19vw,24rem)] font-semibold leading-[0.74] tracking-[-0.075em] text-[#4d4b3a]">
          Хлопок
        </h1>
        <div className="relative -mt-4 grid items-end md:-mt-10 md:grid-cols-[0.34fr_0.66fr]">
          <div className="relative z-20 rounded-br-[72px] bg-[#fbfaf6] pb-16 pr-8 pt-14">
            <SectionLabel value="01" />
            <h2 className="max-w-[420px] font-serif text-4xl leading-[1.08] tracking-[-0.02em] md:text-5xl">
              Холсты из хлопка профессионального качества
            </h2>
            <p className="mt-8 max-w-[360px] text-[15px] leading-7 text-[#4d4b3a]/70">
              Собственное производство в России. Контроль на каждом этапе. Честные материалы и
              стабильное качество.
            </p>
            <a
              className="mt-10 inline-flex items-center gap-8 border-b border-[#e59b6a] pb-2 text-[12px] font-semibold uppercase tracking-[0.08em]"
              href="#products"
            >
              Смотреть продукцию <span className="h-px w-16 bg-[#e59b6a]" />
            </a>
          </div>
          <figure className="relative min-h-[320px] overflow-hidden md:min-h-[660px]">
            <Image
              src="/media/v2/hero-canvas.jpg"
              alt="Крупный план хлопкового холста на деревянном подрамнике"
              fill
              priority
              sizes="(min-width: 768px) 66vw, 100vw"
              className="object-cover"
            />
            <span className="absolute bottom-6 right-[-3px] hidden h-24 border-r border-[#e59b6a] text-[#e59b6a] md:block" />
            <span className="absolute bottom-8 right-5 text-[16px] text-[#e59b6a]">02</span>
          </figure>
        </div>
      </section>

      <section id="production" className="mx-auto grid max-w-[1540px] gap-14 px-8 py-16 md:grid-cols-[0.46fr_0.54fr] md:px-14">
        <div>
          <SectionLabel value="03" />
          <h2 className="font-serif text-5xl tracking-[-0.03em]">Производство</h2>
          <figure className="relative mt-8 aspect-[342/229] overflow-hidden">
            <Image src="/media/v2/production-roll.jpg" alt="Рулон хлопковой ткани на производстве" fill className="object-cover" />
          </figure>
        </div>
        <div className="pt-8">
          {steps.map((step, index) => (
            <article className="grid grid-cols-[4rem_5rem_1fr] border-b border-[#4d4b3a]/18 py-7" key={step.title}>
              <span className="text-xl text-[#e59b6a]">{String(index + 1).padStart(2, "0")}</span>
              <div className="text-[#4d4b3a]/80">
                <ProcessIcon type={step.icon} />
              </div>
              <div>
                <h3 className="font-serif text-2xl">{step.title}</h3>
                <p className="mt-2 text-[14px] leading-6 text-[#4d4b3a]/70">{step.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="sound" className="mx-auto grid max-w-[1540px] gap-10 px-8 py-16 md:grid-cols-[0.44fr_0.56fr] md:px-14">
        <div>
          <SectionLabel value="04" />
          <h2 className="font-serif text-5xl leading-[1.05] tracking-[-0.03em]">
            Звук натяжения — наше качество
          </h2>
          <p className="mt-8 max-w-[420px] text-[15px] leading-7 text-[#4d4b3a]/70">
            Натянутый холст отвечает на касание плотно и быстро — короткий сухой отклик. Нажмите,
            чтобы услышать пробу натяжения.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-7">
            <button
              className="inline-flex h-12 items-center rounded-full bg-[#eaa16f] px-7 text-[12px] font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-[#e59b6a]"
              onClick={playTension}
              type="button"
            >
              Проверить натяжение
            </button>
            <Waveform pulseKey={pulseKey} reduce={shouldReduceMotion} />
          </div>
          {status && pulseKey > 0 ? (
            <p className="mt-4 text-[13px] leading-6 text-[#4d4b3a]/55">{status}</p>
          ) : null}
        </div>
        <figure className="relative min-h-[260px] overflow-hidden md:min-h-[360px]">
          <Image src="/media/v2/sound-touch.jpg" alt="Палец проверяет натяжение холста" fill className="object-cover" />
          {pulseKey > 0 && !shouldReduceMotion ? (
            <motion.span
              key={pulseKey}
              className="pointer-events-none absolute left-1/2 top-1/2 h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/80"
              initial={{ scale: 0.35, opacity: 0.9 }}
              animate={{ scale: 4.4, opacity: 0 }}
              transition={{ duration: 0.8, ease: "easeOut" }}
            />
          ) : null}
        </figure>
      </section>

      <section id="products" className="mx-auto max-w-[1540px] px-8 py-12 md:px-14">
        <div className="flex items-end justify-between gap-8 border-t border-[#4d4b3a]/16 pt-8">
          <div>
            <SectionLabel value="05" />
            <h2 className="font-serif text-5xl tracking-[-0.03em]">Размеры и материалы</h2>
          </div>
          <a className="hidden items-center gap-5 border-b border-[#e59b6a] pb-2 text-[12px] uppercase tracking-[0.08em] md:inline-flex" href="#contacts">
            Запросить размер <span className="h-px w-14 bg-[#e59b6a]" />
          </a>
        </div>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {catalogCards.map((card, cardIndex) => (
            <button
              type="button"
              onClick={() => setLightbox({ card: cardIndex, photo: 0 })}
              className="group flex flex-col overflow-hidden border border-[#4d4b3a]/12 bg-white/48 text-left transition hover:border-[#e59b6a]/60 hover:shadow-[0_18px_50px_rgba(77,75,58,0.08)]"
              key={card.title}
            >
              <div className="relative h-40 overflow-hidden bg-[#edece7]">
                <Image
                  src={card.gallery[0]}
                  alt={card.title}
                  fill
                  sizes="(min-width: 768px) 33vw, 100vw"
                  className="object-cover transition duration-500 group-hover:scale-[1.04]"
                />
              </div>
              <div className="flex flex-1 flex-col p-6">
                <h3 className="min-h-14 font-serif text-2xl leading-7">{card.title}</h3>
                <ul className="mt-5 space-y-2 text-[13px] leading-5 text-[#4d4b3a]/72">
                  {card.meta.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <div className="mt-auto flex items-center justify-between pt-8 text-[13px] text-[#4d4b3a]/75">
                  <span>{card.range}</span>
                  <span className="text-[#e59b6a] transition group-hover:translate-x-1">→</span>
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="mt-6 flex flex-col gap-5 bg-[#4d4b3a] p-8 text-[#fbfaf6] md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="font-serif text-3xl tracking-[-0.02em]">Не нашли нужный размер?</h3>
            <p className="mt-3 max-w-[640px] text-[14px] leading-7 text-[#fbfaf6]/80">
              Делаем позиции под задачу: нестандартный размер, другой профиль, другое зерно, партии и
              упаковку.
            </p>
          </div>
          <a
            className="inline-flex h-12 w-fit items-center rounded-[3px] bg-[#eaa16f] px-7 text-[12px] font-semibold uppercase tracking-[0.08em] text-white"
            href={telegramUrl}
            target="_blank"
            rel="noreferrer"
          >
            Обсудить партию
          </a>
        </div>
      </section>

      <section id="contacts" className="mx-auto grid max-w-[1540px] gap-10 px-8 py-16 md:grid-cols-[0.32fr_0.40fr_0.28fr] md:px-14">
        <div>
          <SectionLabel value="06" />
          <h2 className="font-serif text-5xl tracking-[-0.03em]">Расскажите, какой холст нужен</h2>
          <p className="mt-8 text-[15px] leading-7 text-[#4d4b3a]/72">
            Ответим в Telegram и подскажем по размеру, партии, материалу или заказной позиции.
          </p>
        </div>
        <form className="grid gap-3" onSubmit={submit}>
          <div className="grid gap-3 md:grid-cols-2">
            <input
              className="h-12 border border-[#4d4b3a]/14 bg-white/65 px-4 outline-none focus:border-[#e59b6a]"
              placeholder="Имя *"
              value={form.name}
              onChange={(event) => {
                setForm({ ...form, name: event.target.value });
                if (status) setStatus("");
              }}
              required
              aria-required="true"
            />
            <input
              className="h-12 border border-[#4d4b3a]/14 bg-white/65 px-4 outline-none focus:border-[#e59b6a]"
              placeholder="Телефон или Telegram *"
              value={form.contact}
              onChange={(event) => {
                setForm({ ...form, contact: event.target.value });
                if (status) setStatus("");
              }}
              required
              aria-required="true"
            />
            <select
              className="h-12 border border-[#4d4b3a]/14 bg-white/65 px-4 outline-none focus:border-[#e59b6a]"
              value={form.need}
              onChange={(event) => setForm({ ...form, need: event.target.value })}
              aria-label="Что нужно"
            >
              <option>Размер</option>
              <option>Партия</option>
              <option>Под заказ</option>
            </select>
            <input
              className="h-12 border border-[#4d4b3a]/14 bg-white/65 px-4 outline-none focus:border-[#e59b6a]"
              placeholder="Реквизиты компании"
              value={form.company}
              onChange={(event) => setForm({ ...form, company: event.target.value })}
            />
          </div>
          <textarea
            className="min-h-28 border border-[#4d4b3a]/14 bg-white/65 p-4 outline-none focus:border-[#e59b6a]"
            placeholder="Комментарий: размер, тираж, профиль, сроки, упаковка"
            value={form.comment}
            onChange={(event) => setForm({ ...form, comment: event.target.value })}
          />
          <button className="h-12 w-full max-w-[280px] rounded-[3px] bg-[#4d4b3a] text-[12px] font-semibold uppercase tracking-[0.08em] text-white" type="submit">
            Написать в Telegram
          </button>
          {status ? <p className="text-sm leading-6 text-[#4d4b3a]/70">{status}</p> : null}
        </form>
        <address className="not-italic bg-[#eef0ea] p-8 text-[15px] leading-7 text-[#4d4b3a]/72">
          <p>
            <a href="tel:+79166332732">+7 916 633-27-32</a>
          </p>
          <p>Пн-Пт 10:00 - 18:00</p>
          <p className="mt-6">
            <a href="mailto:anosov.anton@gmail.com">anosov.anton@gmail.com</a>
          </p>
          <p className="mt-6">Россия и СНГ. Отгрузка по согласованию.</p>
          <a className="mt-8 inline-block text-[12px] uppercase tracking-[0.08em] text-[#e59b6a]" href={telegramUrl} target="_blank" rel="noreferrer">
            Написать в Telegram
          </a>
        </address>
      </section>

      <footer className="mx-auto flex max-w-[1540px] flex-col gap-8 border-t border-[#4d4b3a]/12 px-8 py-8 text-[12px] text-[#4d4b3a]/65 md:flex-row md:items-center md:justify-between md:px-14">
        <span>© Хлопок, 2026. Производство холстов из хлопка</span>
        <span>Сделано в России с уважением к делу</span>
      </footer>

      {lightbox ? (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-[#1f1e18]/85 px-4 py-10 backdrop-blur-sm"
          initial={shouldReduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          onClick={closeLightbox}
          role="dialog"
          aria-modal="true"
          aria-label={catalogCards[lightbox.card].title}
        >
          <div className="relative flex w-full max-w-[1040px] flex-col" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between text-[#fbfaf6]">
              <p className="font-serif text-xl md:text-2xl">{catalogCards[lightbox.card].title}</p>
              <button
                type="button"
                onClick={closeLightbox}
                aria-label="Закрыть"
                className="grid h-10 w-10 place-items-center rounded-full border border-white/30 text-lg transition hover:bg-white/10"
              >
                ✕
              </button>
            </div>

            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[6px] bg-black/30 md:aspect-[16/10]">
              <Image
                key={catalogCards[lightbox.card].gallery[lightbox.photo]}
                src={catalogCards[lightbox.card].gallery[lightbox.photo]}
                alt={`${catalogCards[lightbox.card].title} — ракурс ${lightbox.photo + 1}`}
                fill
                sizes="(min-width: 768px) 1040px, 100vw"
                className="object-contain"
              />
              {catalogCards[lightbox.card].gallery.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => stepLightbox(-1)}
                    aria-label="Предыдущее фото"
                    className="absolute left-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-[#fbfaf6]/90 text-lg text-[#4d4b3a] transition hover:bg-[#fbfaf6]"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() => stepLightbox(1)}
                    aria-label="Следующее фото"
                    className="absolute right-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-[#fbfaf6]/90 text-lg text-[#4d4b3a] transition hover:bg-[#fbfaf6]"
                  >
                    ›
                  </button>
                </>
              ) : null}
            </div>

            <div className="mt-4 flex items-center justify-between text-[#fbfaf6]/70">
              <div className="flex gap-2">
                {catalogCards[lightbox.card].gallery.map((src, index) => (
                  <button
                    type="button"
                    key={src}
                    onClick={() => setLightbox({ card: lightbox.card, photo: index })}
                    aria-label={`Фото ${index + 1}`}
                    className={`relative h-14 w-20 overflow-hidden rounded-[3px] border transition ${
                      index === lightbox.photo ? "border-[#e59b6a]" : "border-white/20 opacity-60 hover:opacity-100"
                    }`}
                  >
                    <Image src={src} alt="" fill sizes="80px" className="object-cover" />
                  </button>
                ))}
              </div>
              <span className="text-[12px]">
                {lightbox.photo + 1} / {catalogCards[lightbox.card].gallery.length}
              </span>
            </div>
          </div>
        </motion.div>
      ) : null}
    </main>
  );
}
