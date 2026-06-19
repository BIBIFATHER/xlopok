"use client";

import Image from "next/image";
import { FormEvent, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

const telegramUrl = "https://t.me/anosov.anton";

const navItems = [
  { href: "#process", label: "Процесс" },
  { href: "#priming", label: "Грунт" },
  { href: "#construction", label: "Основа" },
  { href: "#sound", label: "Звук" },
  { href: "#assortment", label: "Размеры" },
];

const productCards = [
  {
    title: "Подрамник / мелкое и среднее зерно",
    specs: ["280 / 300 г/м2", "100% хлопок", "Акриловый грунт", "16x23 / 18x28 / 20x42 мм"],
    range: "15x15 - 100x150 см",
  },
  {
    title: "Подрамник / крупное зерно",
    specs: ["430 г/м2", "Двунитка", "100% хлопок", "18x28 / 20x42 мм"],
    range: "18x24 - 100x150 см",
  },
  {
    title: "Холст на картоне",
    specs: ["280 г/м2", "Мелкое зерно", "100% хлопок", "Картон 2.5 / 3 мм"],
    range: "10x15 - 40x60 см",
  },
];

const processItems = [
  "Подбираем основу, зерно и профиль под задачу.",
  "Натягиваем холст с контролем поверхности и геометрии.",
  "Проверяем натяжение руками и звуком.",
  "Готовим стандартные позиции и партии под заказ.",
];

const brandLetters = Array.from("Хлопок");

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

function SectionNumber({ value }: { value: string }) {
  return <p className="font-serif text-5xl leading-none text-[#f7aa74]">{value}</p>;
}

const WAVE_BARS = 56;

function Waveform({ pulseKey, reduce }: { pulseKey: number; reduce: boolean | null }) {
  const mid = (WAVE_BARS - 1) / 2;
  return (
    <div className="flex h-44 w-full items-center justify-center gap-[2px] md:gap-[4px]">
      {Array.from({ length: WAVE_BARS }).map((_, index) => {
        const dist = Math.abs(index - mid) / mid;
        const idle = 0.05 + (1 - dist) * 0.06;
        const peak = 0.2 + (1 - dist) * 0.8;
        return (
          <motion.span
            key={`${index}-${pulseKey}`}
            className="h-full w-[2px] origin-center rounded-full bg-[#f7aa74] md:w-[3px]"
            initial={{ scaleY: idle }}
            animate={
              reduce || pulseKey === 0
                ? { scaleY: idle }
                : { scaleY: [idle, peak, idle * 1.5, idle] }
            }
            transition={{ duration: 0.85, delay: dist * 0.14, ease: [0.22, 1, 0.36, 1] }}
          />
        );
      })}
    </div>
  );
}

export default function HlopokLanding() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const [form, setForm] = useState<FormState>(initialForm);
  const [formStatus, setFormStatus] = useState("");
  const shouldReduceMotion = useReducedMotion();

  const playTension = async () => {
    const audio = audioRef.current;
    setPulseKey((key) => key + 1);

    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(35);
    }

    if (!audio) return;
    audio.currentTime = 0;
    await audio.play().catch(() => {
      setFormStatus("Нажмите еще раз: браузер ждет явного запуска звука.");
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!form.name.trim() || !form.contact.trim()) {
      setFormStatus("Заполните имя и контакт — иначе не сможем ответить.");
      return;
    }

    const message = [
      "Заявка с сайта Хлопок",
      `Имя: ${form.name || "-"}`,
      `Контакт: ${form.contact || "-"}`,
      `Что нужно: ${form.need || "-"}`,
      `Реквизиты компании: ${form.company || "-"}`,
      `Комментарий: ${form.comment || "-"}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(message);
      setFormStatus("Сообщение скопировано. Откроется Telegram - просто вставьте текст в чат.");
    } catch {
      setFormStatus("Откроется Telegram. Скопируйте детали заявки из формы вручную.");
    }

    window.open(telegramUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <main className="min-h-screen overflow-hidden bg-[#fafafa] text-[#645f4b]">
      <audio ref={audioRef} preload="auto" src="/media/canvas-tension-hit.m4a" />

      <header className="fixed left-0 right-0 top-0 z-50 bg-[#fafafa]/85 px-5 py-5 backdrop-blur-md md:px-10">
        <nav className="mx-auto flex max-w-[1260px] items-center justify-between border-b border-[#645f4b]/12 pb-5">
          <div className="hidden items-center gap-10 text-[10px] font-semibold uppercase tracking-[0.28em] text-[#82846f] md:flex">
            {navItems.map((item) => (
              <a className="transition hover:text-[#645f4b]" href={item.href} key={item.href}>
                {item.label}
              </a>
            ))}
          </div>
          <a
            className="rounded-full bg-[#645f4b] px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#fafafa] shadow-[0_16px_40px_rgba(100,95,75,0.18)] transition hover:bg-[#4c2f23]"
            href={telegramUrl}
            target="_blank"
            rel="noreferrer"
          >
            Написать
          </a>
        </nav>
      </header>

      <section id="top" className="relative min-h-screen overflow-hidden px-5 pb-20 pt-28 md:px-10 md:pt-32">
        <div className="pointer-events-none absolute bottom-16 left-0 h-px w-1/3 bg-[#f7aa74]" />

        <div className="relative z-10 mx-auto flex min-h-[calc(100vh-8rem)] max-w-[1260px] flex-col justify-center">
          <motion.div
            initial={shouldReduceMotion ? false : { opacity: 0, y: 22 }}
            animate={shouldReduceMotion ? undefined : { opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="pt-8"
          >
            <div className="min-w-0">
              <div className="overflow-hidden">
                <h1
                  aria-label="Хлопок"
                  className="flex max-w-full font-serif text-[4.8rem] font-bold leading-[0.82] tracking-[-0.09em] text-[#645f4b] sm:max-w-none sm:text-[clamp(7rem,35vw,32rem)] sm:leading-[0.78]"
                >
                  {brandLetters.map((letter, index) => (
                    <motion.span
                      aria-hidden="true"
                      className="inline-block"
                      initial={shouldReduceMotion ? false : { y: "115%", opacity: 0 }}
                      animate={shouldReduceMotion ? undefined : { y: "0%", opacity: 1 }}
                      transition={{
                        delay: 0.05 + index * 0.085,
                        duration: 0.95,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                      key={`${letter}-${index}`}
                    >
                      {letter}
                    </motion.span>
                  ))}
                </h1>
              </div>
              <div className="mt-9 grid max-w-2xl gap-7 border-t border-[#645f4b]/14 pt-7 md:grid-cols-[9rem_1fr] lg:ml-auto lg:mt-16">
                <SectionNumber value="01" />
                <div>
                  <p className="max-w-md text-[1.04rem] leading-8 text-[#645f4b]/85">
                    Производство холстов на подрамнике для студий, художников и оптовых клиентов.
                  </p>
                  <div className="mt-8 flex flex-wrap items-center gap-4">
                    <a
                      className="inline-flex h-12 items-center rounded-full bg-[#f7aa74] px-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#645f4b] transition hover:bg-[#dfb48e]"
                      href={telegramUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Написать
                    </a>
                    <a
                      className="inline-flex h-12 items-center rounded-full border border-[#645f4b]/18 px-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#645f4b] transition hover:border-[#645f4b]/35"
                      href="#process"
                    >
                      Производство
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      <section id="process" className="scroll-mt-28 px-5 py-24 md:px-10">
        <div className="mx-auto grid max-w-[1260px] gap-12 lg:grid-cols-[0.86fr_1.14fr]">
          <div className="relative min-h-[560px] overflow-hidden rounded-[8px]">
            <Image
              src="/media/canvas-stretch-process.jpg"
              alt="Подрамник на ткани в процессе натяжки"
              fill
              sizes="(min-width: 1024px) 45vw, 100vw"
              className="object-cover saturate-[0.84]"
            />
          </div>
          <div className="self-center border-t border-[#645f4b]/14 pt-7">
            <SectionNumber value="02" />
            <h2 className="mt-8 font-serif text-5xl font-medium leading-[0.94] tracking-[-0.045em] text-[#645f4b] md:text-7xl">
              Чистый процесс вместо обещаний.
            </h2>
            <div className="mt-11 grid gap-0">
              {processItems.map((item, index) => (
                <div key={item} className="grid grid-cols-[4.5rem_1fr] items-start border-t border-[#645f4b]/12 py-5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#82846f]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <p className="text-[1.05rem] leading-8 text-[#645f4b]/85">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="priming" className="scroll-mt-28 px-5 pb-24 md:px-10">
        <div className="mx-auto grid max-w-[1260px] gap-12 lg:grid-cols-[1.08fr_0.92fr]">
          <figure className="relative min-h-[520px] overflow-hidden rounded-[8px]">
            <Image
              src="/media/canvas-priming-line.jpeg"
              alt="Рулонная линия грунтовки холста"
              fill
              sizes="(min-width: 1024px) 56vw, 100vw"
              className="object-cover saturate-[0.86]"
            />
            <figcaption className="absolute bottom-4 left-4 rounded-full bg-[#fafafa]/85 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#645f4b] backdrop-blur">
              Грунтовочная линия · textile coating line
            </figcaption>
          </figure>
          <div className="self-center border-t border-[#645f4b]/14 pt-7">
            <SectionNumber value="03" />
            <h2 className="mt-8 max-w-3xl font-serif text-5xl font-medium leading-[0.94] tracking-[-0.045em] text-[#645f4b] md:text-7xl">
              Холст, который приятно трогать ещё до первого мазка
            </h2>
            <div className="mt-9 space-y-6 text-[1.04rem] leading-8 text-[#645f4b]/85">
              <p>Основа хорошего холста — не только ткань. Главное начинается на этапе грунтовки.</p>
              <p>
                На рулонной линии грунт ложится ровным контролируемым слоем по всей ширине полотна —
                без случайных пропусков, грубых наплывов и «голых» участков. Поверхность получается
                стабильной и предсказуемой.
              </p>
              <p className="font-medium text-[#645f4b]">
                Кисть не цепляется, краска не проваливается, цвет остаётся насыщенным. Мы готовим
                рабочую поверхность, на которой хочется писать.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="construction" className="scroll-mt-28 px-5 pb-24 md:px-10">
        <div className="mx-auto grid max-w-[1260px] gap-6 lg:grid-cols-[1.42fr_0.58fr]">
          <figure className="relative min-h-[500px] overflow-hidden rounded-[8px]">
            <Image
              src="/media/canvas-back-frame.jpg"
              alt="Обратная сторона холста с подрамником и крестовиной"
              fill
              sizes="(min-width: 1024px) 66vw, 100vw"
              className="object-cover saturate-[0.82]"
            />
          </figure>
          <div className="rounded-[8px] bg-[#e1e4dd] p-8">
            <SectionNumber value="04" />
            <h2 className="mt-9 font-serif text-4xl font-medium leading-[0.96] tracking-[-0.04em] text-[#645f4b]">
              Подрамник держит форму.
            </h2>
            <p className="mt-7 text-[1.02rem] leading-8 text-[#645f4b]/82">
              Стабильное натяжение начинается с основы: профиль, крестовина, ровная геометрия и
              чистая работа с тканью.
            </p>
          </div>
        </div>
      </section>

      <section id="sound" className="scroll-mt-28 bg-[#2c2521] px-5 py-28 text-[#fafafa] md:px-10">
        <div className="mx-auto max-w-[1260px]">
          <div className="max-w-3xl border-t border-white/12 pt-7">
            <p className="font-serif text-5xl leading-none text-[#f7aa74]">05</p>
            <h2 className="mt-8 font-serif text-5xl font-medium leading-[0.94] tracking-[-0.045em] md:text-7xl">
              Должен звучать как барабан.
            </h2>
            <p className="mt-8 max-w-xl text-[1.05rem] leading-8 text-[#e1e4dd]/85">
              Натянутый холст отвечает на касание плотно и быстро — короткий, сухой отклик. Нажмите,
              чтобы услышать пробу натяжения.
            </p>
          </div>

          <div className="mt-14 grid gap-8 lg:grid-cols-[1.25fr_0.75fr] lg:items-start">
            <div className="flex flex-col gap-9 rounded-[12px] border border-white/10 bg-black/20 p-8">
              <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.26em] text-[#e1e4dd]/55">
                <span>проба натяжения</span>
                <span className="text-[#f7aa74]">{pulseKey > 0 ? "сигнал" : "готов"}</span>
              </div>
              <Waveform pulseKey={pulseKey} reduce={shouldReduceMotion} />
              <button
                onClick={playTension}
                className="inline-flex h-14 w-fit items-center rounded-full bg-[#f7aa74] px-8 text-[12px] font-semibold uppercase tracking-[0.2em] text-[#2c2521] transition hover:bg-[#dfb48e]"
                type="button"
              >
                Ударить
              </button>
            </div>

            <div className="relative mx-auto aspect-[9/16] w-full max-w-[320px] overflow-hidden rounded-[12px] bg-[#1f1a17] shadow-[0_28px_90px_rgba(0,0,0,0.4)]">
              <video
                className="h-full w-full object-cover saturate-[0.9]"
                src="/media/canvas-tension-demo.mp4"
                autoPlay
                muted
                loop
                playsInline
              />
              {pulseKey > 0 && !shouldReduceMotion ? (
                <motion.div
                  key={pulseKey}
                  className="pointer-events-none absolute left-1/2 top-[36%] h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#f7aa74]/80"
                  initial={{ scale: 0.35, opacity: 0.9 }}
                  animate={{ scale: 4.2, opacity: 0 }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                />
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section id="assortment" className="scroll-mt-28 bg-[#e1e4dd] px-5 py-24 md:px-10">
        <div className="mx-auto max-w-[1260px]">
          <div className="grid gap-8 border-t border-[#645f4b]/14 pt-7 lg:grid-cols-[12rem_1fr]">
            <SectionNumber value="06" />
            <h2 className="max-w-3xl font-serif text-5xl font-medium leading-[0.94] tracking-[-0.045em] text-[#645f4b] md:text-7xl">
              Размеры, материалы и заказные позиции.
            </h2>
          </div>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {productCards.map((card) => (
              <article key={card.title} className="rounded-[8px] border border-[#645f4b]/10 bg-[#fafafa] p-7">
                <h3 className="min-h-14 text-xl font-medium leading-7 text-[#645f4b]">{card.title}</h3>
                <p className="mt-6 font-serif text-3xl font-medium text-[#f7aa74]">{card.range}</p>
                <ul className="mt-8 space-y-3 text-sm text-[#645f4b]/80">
                  {card.specs.map((spec) => (
                    <li key={spec} className="border-t border-[#645f4b]/10 pt-3">
                      {spec}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <div className="mt-8 rounded-[8px] bg-[#645f4b] p-8 text-[#fafafa] md:flex md:items-center md:justify-between md:gap-10">
            <div>
              <h3 className="font-serif text-3xl font-medium tracking-[-0.03em]">Не нашли нужный размер?</h3>
              <p className="mt-3 max-w-3xl text-[1.02rem] leading-8 text-[#e1e4dd]">
                Делаем позиции под задачу: нестандартный размер, другой профиль, другое зерно, партии и упаковку.
              </p>
            </div>
            <a
              className="mt-6 inline-flex h-13 items-center rounded-full bg-[#f7aa74] px-7 text-[12px] font-semibold uppercase tracking-[0.2em] text-[#645f4b] md:mt-0"
              href={telegramUrl}
              target="_blank"
              rel="noreferrer"
            >
              Запросить размер
            </a>
          </div>
        </div>
      </section>

      <section className="px-5 py-24 md:px-10">
        <div className="mx-auto grid max-w-[1260px] gap-12 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="border-t border-[#645f4b]/14 pt-7">
            <SectionNumber value="07" />
            <h2 className="mt-8 font-serif text-5xl font-medium leading-[0.94] tracking-[-0.045em] text-[#645f4b] md:text-7xl">
              Расскажите, какой холст нужен.
            </h2>
            <p className="mt-8 text-[1.05rem] leading-8 text-[#645f4b]/85">
              Ответим в Telegram и подскажем по размеру, партии, материалу или заказной позиции.
            </p>
            <div className="mt-8 space-y-3 text-base text-[#645f4b]/82">
              <p>
                Telegram:{" "}
                <a className="underline decoration-[#f7aa74] underline-offset-4" href={telegramUrl}>
                  @anosov.anton
                </a>
              </p>
              <p>
                Телефон: <a href="tel:+79166332732">+7 916 633-27-32</a>
              </p>
              <p>
                Email: <a href="mailto:anosov.anton@gmail.com">anosov.anton@gmail.com</a>
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="rounded-[8px] bg-[#e1e4dd] p-6 shadow-[0_28px_80px_rgba(100,95,75,0.1)] md:p-8">
            <div className="grid gap-5 md:grid-cols-2">
              <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-[#82846f]">
                Имя <span className="text-[#f7aa74]">*</span>
                <input
                  className="h-13 rounded-full border border-[#645f4b]/14 bg-[#fafafa]/88 px-5 text-base normal-case tracking-normal text-[#645f4b] outline-none focus:border-[#f7aa74]"
                  value={form.name}
                  onChange={(event) => {
                    setForm({ ...form, name: event.target.value });
                    if (formStatus) setFormStatus("");
                  }}
                  placeholder="Антон"
                  required
                  aria-required="true"
                />
              </label>
              <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-[#82846f]">
                Телефон или Telegram <span className="text-[#f7aa74]">*</span>
                <input
                  className="h-13 rounded-full border border-[#645f4b]/14 bg-[#fafafa]/88 px-5 text-base normal-case tracking-normal text-[#645f4b] outline-none focus:border-[#f7aa74]"
                  value={form.contact}
                  onChange={(event) => {
                    setForm({ ...form, contact: event.target.value });
                    if (formStatus) setFormStatus("");
                  }}
                  placeholder="@username или телефон"
                  required
                  aria-required="true"
                />
              </label>
              <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-[#82846f]">
                Что нужно
                <select
                  className="h-13 rounded-full border border-[#645f4b]/14 bg-[#fafafa]/88 px-5 text-base normal-case tracking-normal text-[#645f4b] outline-none focus:border-[#f7aa74]"
                  value={form.need}
                  onChange={(event) => setForm({ ...form, need: event.target.value })}
                >
                  <option>Размер</option>
                  <option>Партия</option>
                  <option>Под заказ</option>
                </select>
              </label>
              <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-[#82846f]">
                Реквизиты компании
                <input
                  className="h-13 rounded-full border border-[#645f4b]/14 bg-[#fafafa]/88 px-5 text-base normal-case tracking-normal text-[#645f4b] outline-none focus:border-[#f7aa74]"
                  value={form.company}
                  onChange={(event) => setForm({ ...form, company: event.target.value })}
                  placeholder="ИНН / название"
                />
              </label>
            </div>
            <label className="mt-5 grid gap-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-[#82846f]">
              Комментарий
              <textarea
                className="min-h-36 rounded-[8px] border border-[#645f4b]/14 bg-[#fafafa]/88 p-5 text-base normal-case tracking-normal text-[#645f4b] outline-none focus:border-[#f7aa74]"
                value={form.comment}
                onChange={(event) => setForm({ ...form, comment: event.target.value })}
                placeholder="Размер, тираж, профиль, сроки, упаковка"
              />
            </label>
            <button
              className="mt-6 h-15 w-full rounded-full bg-[#645f4b] px-7 text-[12px] font-semibold uppercase tracking-[0.2em] text-[#fafafa] transition hover:bg-[#4c2f23]"
              type="submit"
            >
              Написать в Telegram
            </button>
            {formStatus ? <p className="mt-4 text-sm leading-6 text-[#645f4b]/72">{formStatus}</p> : null}
          </form>
        </div>
      </section>
    </main>
  );
}
