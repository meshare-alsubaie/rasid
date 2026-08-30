/**
 * RASID shell.
 *
 * Plain TypeScript and one render function, because the whole app is a view
 * over five JSON files and a little local state. No framework earns its weight
 * here, and the spec explicitly does not want one.
 *
 * The rule that shapes every screen: a value the pipeline does not know is
 * shown as unknown, never as a default that happens to look reassuring.
 */
import "./style.css";
import { loadDataset, formatDate, timeAgo, daysUntil, type Dataset } from "./data";
import { renderSeasonBar, type LaneInput } from "./season-bar";
import { hijriOf } from "../types";
import type { Opportunity, Organisation } from "../types";

type Tab = "season" | "orgs" | "mine" | "settings";
type Mark = "interested" | "applied" | "ignored";

const MARKS_KEY = "rasid.marks.v1";
const THRESHOLD_KEY = "rasid.threshold.v1";
const THEME_KEY = "rasid.theme.v1";

/**
 * Themes are token overrides in the stylesheet, so this list is only the
 * labels. Every one of them is checked by npm run audit:contrast: a palette
 * is not finished until it measures, because a calm-looking theme that hides
 * a closing window is worse than no theme at all.
 */
const THEMES: [string, string, string][] = [
  ["instrument", "الأداة", "لوحة قياس باردة، الافتراضي"],
  ["night", "ليلي", "الصفحة كلها داكنة، للقراءة في الظلام"],
  ["warm", "دافئ", "ورقي هادئ، لقراءة طويلة"],
  ["sharp", "تقني", "تباين عالٍ وحواف حادّة"],
  ["playful", "مرح", "ألوان زاهية وزوايا دائرية"],
];

const app = document.getElementById("app")!;
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/* ---------- local state, never a server ---------- */

const readJSON = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};
const writeJSON = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, or storage full. The app still works, it just forgets. */
  }
};

let marks = readJSON<Record<string, { mark: Mark; atISO: string }>>(MARKS_KEY, {});
let threshold = readJSON<number>(THRESHOLD_KEY, 0);
let theme = readJSON<string>(THEME_KEY, "instrument");

const applyTheme = (): void => {
  if (theme === "instrument") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
};
applyTheme();
let tab: Tab = "season";
let sector = "";
let query = "";
let tierFilter = "";
let cityFilter = "";
let onlyNoZeroCourses = false;
let onlyStipend = false;
let onlyMyMajor = false;
let bannerDismissed = false;
let data: Dataset;

/* ---------- shared pieces ---------- */

const band = (o: Opportunity): string =>
  o.flags.includes("needs_manual_review") ? "is-review"
  : o.relevanceScore === null ? "is-review"
  : o.relevanceScore >= 85 ? "band-high"
  : o.relevanceScore >= 60 ? "band-mid"
  : "band-low";

const scoreLabel = (o: Opportunity): string =>
  o.relevanceScore === null
    ? `<span class="score unscored">؟<small>لم يُصنَّف</small></span>`
    : `<span class="score">${o.relevanceScore}<small>صلة</small></span>`;

/** A field with no published value is said in words, never left blank. */
const fact = (label: string, value: string | null): string =>
  `<div><dt>${label}</dt><dd class="${value === null ? "none" : ""}">${value ?? "لم يُعلن"}</dd></div>`;

function chip(state: boolean | null, yes: string, no: string, unknown: string): string {
  if (state === true) return `<li class="chip yes">${yes}</li>`;
  if (state === false) return `<li class="chip no">${no}</li>`;
  return `<li class="chip unknown">${unknown}</li>`;
}

function orgChips(org: Organisation): string {
  // requiresZeroCourses true is bad news for him, so the polarity is inverted
  // here on purpose: "no condition" is the green state.
  const zero = org.requiresZeroCourses.value;
  return `<ul class="chips">
    ${chip(zero === null ? null : !zero, "لم تشترط تصفير المواد", "تشترط تصفير المواد", "شرط المواد غير معروف")}
    ${chip(org.acceptsUserMajor, "تخصصي مقبول", "تخصصي غير مقبول", "قبول التخصص غير معروف")}
    ${chip(org.offersCoopProduct, "تدريب تعاوني", "ليس تدريباً تعاونياً", "نوع البرنامج غير معروف")}
  </ul>`;
}

function opportunityCard(o: Opportunity): string {
  const org = data.orgById.get(o.orgId);
  const days = daysUntil(o.closesISO);
  const review = o.flags.includes("needs_manual_review");
  const mark = marks[o.id]?.mark;

  return `<li class="card ${band(o)}">
    <div class="row">
      <div>
        <h3>${esc(o.titleAr)}</h3>
        <div class="org">${esc(org?.nameAr ?? o.orgId)}</div>
      </div>
      ${scoreLabel(o)}
    </div>
    <dl class="meta">
      ${fact("يفتح", o.opensISO === null ? null : formatDate(o.opensISO))}
      ${fact(
        "يغلق",
        o.closesISO === null
          ? null
          : `${formatDate(o.closesISO)}${days !== null && days >= 0 ? ` · بعد ${days} يوم` : ""}`,
      )}
      ${/* Spec 5: the Umm al-Qura date beside the Gregorian one. Computed here
            as well as stored, so records classified before it existed still
            show it rather than waiting for the page to change again. */ ""}
      ${fact("هجرياً", o.closesHijri ?? hijriOf(o.closesISO))}
      ${fact("المقاعد", o.seats === null ? null : String(o.seats))}
      ${fact("المكافأة", o.stipendSAR === null ? null : `${o.stipendSAR} ريال`)}
    </dl>
    <p class="reason">${esc(o.relevanceReason)}</p>
    ${
      review
        ? `<ul class="chips"><li class="chip no">تعذّر التصنيف، والدرجة فارغة لا صفر</li></ul>`
        : ""
    }
    ${
      o.flags.includes("wrong_product")
        ? `<ul class="chips"><li class="chip no">تطوير خريجين، وأنت غير مؤهّل قبل التخرّج</li></ul>`
        : ""
    }
    ${
      o.statesZeroCoursesRule && o.zeroCoursesQuote
        ? `<blockquote class="quote">${esc(o.zeroCoursesQuote)}<cite>شرط منشور على صفحة الجهة، منقول بنصّه</cite></blockquote>`
        : ""
    }
    <div class="actions">
      <button class="secondary" data-open-org="${esc(o.orgId)}">تفاصيل الجهة</button>
      ${(["interested", "applied", "ignored"] as const)
        .map(
          (m) =>
            `<button class="secondary" data-mark="${m}" data-opp="${esc(o.id)}" aria-pressed="${mark === m}">${
              { interested: "مهتم", applied: "قدّمت", ignored: "تجاهل" }[m]
            }</button>`,
        )
        .join("")}
    </div>
  </li>`;
}

/**
 * The first thing on the page, and the only thing acceptance criterion 1
 * actually asks for: what is open today, answered before anything is read.
 */
function answerBlock(): string {
  /*
   * Sorted before the superlative is spoken. The line said "أقربها إغلاقاً" and
   * then printed whichever record happened to be first in the file — which is
   * hash order, not date order. A confident claim over unsorted data, on the
   * second line of the home screen. Records with no closing date sort last:
   * they cannot be the nearest to closing, because nothing said when they close.
   */
  const open = data.opportunities
    .filter((o) => o.status === "open" || o.status === "closing_soon")
    .sort((a, b) => (daysUntil(a.closesISO) ?? Infinity) - (daysUntil(b.closesISO) ?? Infinity));
  const watched = data.health.filter((h) => h.lastSuccessISO !== null).length;
  const unread = data.health.filter((h) => h.state !== "healthy").length;
  const tracked = data.opportunities.length;

  const headline =
    open.length > 0
      ? `<div class="headline is-live">${open.length} نافذة مفتوحة الآن</div>`
      : `<div class="headline">لا شيء مفتوح اليوم</div>`;

  const soonest = open[0]!;
  const sub =
    open.length > 0
      ? soonest.closesISO !== null
        ? `أقربها إغلاقاً: ${esc(soonest.titleAr)}.`
        : `منها: ${esc(soonest.titleAr)} — ولم تُعلن أي منها تاريخ إغلاق.`
      : `لم تنشر أي جهة محقّقة تاريخ فتح بعد. ${tracked} برنامجاً قائماً تحت المراقبة، وسيظهر هنا أول ما يُعلَن.`;

  return `<section class="answer" aria-label="الحالة اليوم">
    ${headline}
    <p class="sub">${sub}</p>
    <div class="tally">
      ${/* Sources that have actually been read at least once. The count used to
            be every health record, which includes ones that have never once
            succeeded — claiming to watch a page nobody has ever read. */ ""}
      <span><b>${watched}</b> مصدراً قُرئ فعلاً</span>
      <span><b>${tracked}</b> برنامجاً معروفاً</span>
      ${unread > 0 ? `<span class="warn"><b>${unread}</b> مصدراً لا يُقرأ</span>` : ""}
    </div>
  </section>`;
}

function group(title: string, items: Opportunity[], emptyText: string, open: boolean): string {
  return `<details class="group"${open ? " open" : ""}>
    <summary>${title}<span class="count">${items.length}</span></summary>
    ${
      items.length === 0
        ? `<p class="empty">${emptyText}</p>`
        : `<ul class="cards">${items.map(opportunityCard).join("")}</ul>`
    }
  </details>`;
}

/* ---------- screens ---------- */

function seasonScreen(): string {
  const visible = data.opportunities.filter(
    (o) => (o.relevanceScore ?? 100) >= threshold && marks[o.id]?.mark !== "ignored",
  );
  const by = (s: Opportunity["status"]): Opportunity[] => visible.filter((o) => o.status === s);

  const lanes: LaneInput[] = data.orgs
    .filter((o) => o.sources.some((s) => s.verifiedAtISO !== null))
    .map((org) => ({
      org,
      opportunity: visible.find((o) => o.orgId === org.id),
      health: data.healthOf(org.id),
      // Only an organisation whose sole route is a standing mailbox counts as
      // rolling. Where a programme page produced a verdict, the lane has to
      // say what that page says, which is usually that no dates are published.
      rolling:
        org.applyVia?.method === "email" && !visible.some((o) => o.orgId === org.id),
    }));

  const nextHint =
    "لا نافذة مفتوحة. حين تُعلن جهة تاريخاً ستظهر هنا، وسيتلوّن مسارها في الشريط أعلاه.";

  return `<div class="season-head">
      <h2>الموسم</h2>
      <p class="season-note">سبتمبر إلى فبراير · ${lanes.length} جهة مراقَبة</p>
    </div>
    ${renderSeasonBar(lanes)}
    ${group("مفتوح الآن", by("open"), nextHint, true)}
    ${group("يغلق قريباً", by("closing_soon"), "لا شيء يغلق خلال ٤٨ ساعة.", true)}
    ${group("أُعلن ولم يفتح", by("announced_not_open"), "لا إعلان بتاريخ فتح مستقبلي.", true)}
    ${group(
      "برامج قائمة بلا تواريخ معلنة",
      by("unknown"),
      "لا شيء هنا.",
      true,
    )}`;
}

function orgsScreen(): string {
  const sectors = [...new Set(data.orgs.map((o) => o.sector))].sort();
  const cities = [...new Set(data.orgs.flatMap((o) => o.city))].sort((a, b) => a.localeCompare(b));

  /*
   * Spec 6.2B asks for six filters; the screen had two. The four that were
   * missing are the ones that answer a decision rather than a curiosity — a
   * student with unfinished courses needs the zero-courses filter more than a
   * search box. Each is a plain include/exclude, and none of them can turn an
   * unknown into a yes: `يقبل تخصّصي` shows organisations that published a
   * match, and silence never counts as one.
   */
  const list = data.orgs
    .filter((o) => sector === "" || o.sector === sector)
    .filter((o) => query === "" || o.nameAr.includes(query) || o.nameEn.toLowerCase().includes(query.toLowerCase()))
    .filter((o) => tierFilter === "" || o.tier === tierFilter)
    .filter((o) => cityFilter === "" || o.city.includes(cityFilter))
    .filter((o) => !onlyNoZeroCourses || o.requiresZeroCourses.value === false)
    .filter((o) => !onlyStipend || (o.stipend.amountSAR !== null && o.stipend.amountSAR > 0))
    .filter((o) => !onlyMyMajor || o.acceptsUserMajor === true)
    .sort((a, b) => "SABC".indexOf(a.tier) - "SABC".indexOf(b.tier) || a.nameAr.localeCompare(b.nameAr));

  const toggle = (id: string, label: string, on: boolean): string =>
    `<button class="filter-toggle" data-filter="${id}" aria-pressed="${on}">${label}</button>`;

  return `<div class="filters">
      <input id="q" type="search" placeholder="ابحث باسم الجهة" value="${esc(query)}" aria-label="ابحث باسم الجهة" />
      <select id="sector" aria-label="القطاع">
        <option value="">كل القطاعات</option>
        ${sectors.map((s) => `<option value="${s}"${s === sector ? " selected" : ""}>${s}</option>`).join("")}
      </select>
      <select id="tier" aria-label="الفئة">
        <option value="">كل الفئات</option>
        ${["S", "A", "B", "C"].map((t) => `<option value="${t}"${t === tierFilter ? " selected" : ""}>فئة ${t}</option>`).join("")}
      </select>
      <select id="city" aria-label="المدينة">
        <option value="">كل المدن</option>
        ${cities.map((c) => `<option value="${esc(c)}"${c === cityFilter ? " selected" : ""}>${esc(c)}</option>`).join("")}
      </select>
    </div>
    <div class="filter-toggles">
      ${toggle("zero", "لا تشترط تصفير المواد", onlyNoZeroCourses)}
      ${toggle("stipend", "لها مكافأة معلنة", onlyStipend)}
      ${toggle("major", "تقبل تخصّصي", onlyMyMajor)}
    </div>
    <p class="count-line">${list.length} جهة من ${data.orgs.length}. الشريحة المتقطّعة تعني «غير معروف»، لا «لا بأس».
      ${onlyNoZeroCourses || onlyStipend || onlyMyMajor ? "هذه المرشِّحات تُظهر ما نُشر صراحةً فقط، والصمت ليس موافقة." : ""}</p>
    <ul class="cards">
      ${list
        .map(
          (o) => `<li><button class="org-row" data-open-org="${esc(o.id)}">
            <span class="head"><span class="name">${esc(o.nameAr)}</span><span class="tier">${o.tier}</span></span>
            ${orgChips(o)}
          </button></li>`,
        )
        .join("")}
    </ul>`;
}

function mineScreen(): string {
  const entries = Object.entries(marks).filter(([, v]) => v.mark !== "ignored");
  if (entries.length === 0) {
    return `<p class="empty">لم تعلّم أي فرصة بعد. علّم «مهتم» أو «قدّمت» من شاشة الموسم، ويُذكّرك التطبيق بعد ١٤ يوماً من التقديم.</p>`;
  }
  return `<ul class="cards">${entries
    .map(([id, v]) => {
      const o = data.opportunities.find((x) => x.id === id);
      const since = Math.floor((Date.now() - Date.parse(v.atISO)) / 86_400_000);
      const due = v.mark === "applied" && since >= 14;
      return `<li class="card${due ? " is-review" : ""}">
        <div class="row">
          <h3>${esc(o?.titleAr ?? "فرصة لم تعد في البيانات")}</h3>
          <span class="chip ${v.mark === "applied" ? "yes" : "unknown"}">${v.mark === "applied" ? "قدّمت" : "مهتم"}</span>
        </div>
        <div class="meta"><span>منذ ${since} يوم</span>${due ? "<span>حان وقت المتابعة</span>" : ""}</div>
        ${o ? `<div class="actions"><button class="secondary" data-open-org="${esc(o.orgId)}">تفاصيل الجهة</button><button class="secondary" data-mark="clear" data-opp="${esc(id)}">إزالة</button></div>` : ""}
      </li>`;
    })
    .join("")}</ul>`;
}

/* ---------- notifications ---------- */

interface PushDiag {
  supported: boolean;
  keyPresent: boolean;
  permission: NotificationPermission | "unavailable";
  workerReady: boolean;
  subscribed: boolean;
  endpointTail: string | null;
  standalone: boolean;
  lastArrival: { at: string; via: string; title?: string } | null;
}

let pushDiag: PushDiag | null = null;

/**
 * Reads the real state of the notification chain on this device.
 *
 * Every step here is a place the chain actually broke for someone: a browser
 * without push at all, a permission granted on one device and assumed on
 * another, a worker that never activated, a subscription made against an older
 * key. Guessing which one it was cost a whole evening, so the app now simply
 * reports each link instead.
 */
async function readPushDiag(): Promise<void> {
  const supported = "serviceWorker" in navigator && "PushManager" in window;
  const diag: PushDiag = {
    supported,
    keyPresent: Boolean(import.meta.env.VITE_VAPID_PUBLIC_KEY),
    permission: "Notification" in window ? Notification.permission : "unavailable",
    workerReady: false,
    subscribed: false,
    endpointTail: null,
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    lastArrival: null,
  };

  if (supported) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      diag.workerReady = Boolean(reg?.active);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        diag.subscribed = true;
        diag.endpointTail = sub.endpoint.slice(-12);
      }
    } catch {
      /* an unreachable worker is itself the answer, and it is already false */
    }
    try {
      const cache = await caches.open("rasid-push-log");
      const keys = await cache.keys();
      const last = keys[keys.length - 1];
      if (last) {
        const body = await cache.match(last);
        if (body) diag.lastArrival = (await body.json()) as PushDiag["lastArrival"];
      }
    } catch {
      /* no log yet */
    }
  }

  pushDiag = diag;
  render();
}

function diagRow(label: string, ok: boolean, detail: string): string {
  return `<li class="diag-row">
    <span class="chip ${ok ? "yes" : "no"}">${ok ? "✓" : "✗"}</span>
    <span class="diag-label">${label}</span>
    <span class="diag-detail">${esc(detail)}</span>
  </li>`;
}

function notificationsCard(): string {
  const d = pushDiag;
  if (d === null) {
    return `<div class="card"><h3>التنبيهات</h3><p class="reason">يفحص حالة هذا الجهاز…</p></div>`;
  }

  const permText =
    d.permission === "granted"
      ? "مسموح"
      : d.permission === "denied"
        ? "مرفوض — أعد السماح من إعدادات الموقع في المتصفّح"
        : d.permission === "default"
          ? "لم يُسأل بعد"
          : "المتصفّح لا يعرف الإشعارات";

  const arrival =
    d.lastArrival === null
      ? `<p class="reason warn">لم يصل هذا الجهاز أي إشعار بعد. اضغط «جرّب إشعاراً الآن» أولاً: إن ظهر، فالعرض يعمل والمشكلة في الإرسال. وإن لم يظهر مع أن الإذن مسموح، فالنظام يحجب إشعارات المتصفّح.</p>`
      : `<p class="reason">آخر إشعار وصل هذا الجهاز: <strong>${timeAgo(d.lastArrival.at)}</strong> (${d.lastArrival.via === "push" ? "من الخادم" : "تجربة محلية"})${d.lastArrival.title ? ` — ${esc(d.lastArrival.title)}` : ""}.</p>`;

  const iphone = /iPhone|iPad/.test(navigator.userAgent) && !d.standalone;

  return `<div class="card">
    <h3>التنبيهات</h3>
    <ul class="diag">
      ${diagRow("المتصفّح يدعم التنبيهات", d.supported, d.supported ? "نعم" : "لا")}
      ${diagRow("الإذن", d.permission === "granted", permText)}
      ${diagRow("عامل الخدمة نشط", d.workerReady, d.workerReady ? "نعم" : "غير مسجَّل — أعد تحميل الصفحة")}
      ${diagRow("هذا الجهاز مشترك", d.subscribed, d.subscribed ? `نعم …${d.endpointTail}` : "لا")}
      ${diagRow("مفتاح الإرسال مبنيّ", d.keyPresent, d.keyPresent ? "نعم" : "ناقص في البناء")}
    </ul>
    ${arrival}
    ${iphone ? `<p class="reason warn">على الآيفون لا تصل الإشعارات إلا بعد «إضافة إلى الشاشة الرئيسية» وفتح التطبيق من هناك.</p>` : ""}
    <div class="actions">
      <button class="secondary" id="test-notif">جرّب إشعاراً الآن</button>
      <button class="secondary" id="subscribe">${d.subscribed ? "أعد التسجيل" : "فعّل التنبيهات على هذا الجهاز"}</button>
    </div>
    <p class="reason" id="sub-out"></p>
  </div>`;
}

const FOLLOW_UP_DAYS = 14;
const REMINDED_KEY = "rasid.reminded.v1";

/**
 * The follow-up the spec asks for: a fortnight after marking something
 * "applied", say so.
 *
 * It has to happen here rather than in the collector, and that is a consequence
 * of the design rather than an oversight. Marks live in this browser's storage
 * because there is no account and no database, so the only place that knows a
 * fortnight has passed is the device holding the mark. It fires once per
 * opportunity, on the first open after the day arrives.
 */
function checkFollowUps(): void {
  if (!("serviceWorker" in navigator)) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const reminded = readJSON<Record<string, string>>(REMINDED_KEY, {});
  const due = Object.entries(marks).filter(([id, v]) => {
    if (v.mark !== "applied" || reminded[id]) return false;
    return Date.now() - Date.parse(v.atISO) >= FOLLOW_UP_DAYS * 86_400_000;
  });
  if (due.length === 0) return;

  void navigator.serviceWorker.ready.then((reg) => {
    for (const [id] of due) {
      const title = data.opportunities.find((o) => o.id === id)?.titleAr ?? "فرصة قدّمت عليها";
      reg.active?.postMessage({
        type: "follow-up",
        title: "⏱ مضى أسبوعان على تقديمك",
        body: `${title} — تابع الجهة إن لم يصلك ردّ.`,
        tag: `rasid-follow-${id}`,
      });
      reminded[id] = new Date().toISOString();
    }
    writeJSON(REMINDED_KEY, reminded);
  });
}

/**
 * Fires the test through the worker rather than the page, because the worker is
 * the path a real push takes. A notification that only works from the tab would
 * prove nothing about the thing being tested.
 */
async function testNotification(): Promise<void> {
  const out = document.getElementById("sub-out")!;
  const say = (m: string): void => {
    out.textContent = m;
  };
  if (!("serviceWorker" in navigator)) return say("هذا المتصفّح لا يدعم عامل الخدمة.");
  if ("Notification" in window && Notification.permission !== "granted") {
    if ((await Notification.requestPermission()) !== "granted") {
      return say("لم تُمنح الإذن، فلا يمكن عرض إشعار.");
    }
  }
  const reg = await navigator.serviceWorker.ready;
  if (!reg.active) return say("عامل الخدمة غير نشط بعد. أعد تحميل الصفحة ثم جرّب.");
  reg.active.postMessage({ type: "test-notification" });
  say("أُرسل الطلب إلى عامل الخدمة. إن لم يظهر إشعار خلال ثوانٍ فالنظام يحجب إشعارات المتصفّح.");
  window.setTimeout(() => void readPushDiag(), 1500);
}

/**
 * How many watched pages actually said they were about cooperative training.
 *
 * The distinction is the difference between "we are watching the right page"
 * and "we are watching a page". Reporting only the total let eighty-six of the
 * second kind be read as the first.
 */
function confirmedPages(): number {
  return data.orgs.filter((o) => o.sources.some((s) => s.coopConfirmed === true)).length;
}

function settingsScreen(): string {
  return `<div class="cards">
    <div class="card">
      <h3>ما الذي يضمنه هذا التطبيق، وما الذي لا يضمنه</h3>
      <p class="reason">
        يراقب ${data.health.length} مصدراً فُتح كل منها وقُرئ بنصّه، من أصل ${data.orgs.length} جهة في القاعدة.
        ${confirmedPages()} منها صفحة قالت عن نفسها إنها للتدريب التعاوني؛ والبقية صفحات حقيقية للجهة
        تُراقَب لأن الإعلان قد يظهر عليها، لا لأنها أثبتت أنها صفحة تدريب. الفرق مذكور داخل كل جهة.
      </p>
      <p class="reason">
        لا يَعِد بأنه سيرى كل إعلان. الجهات تنشر في أماكن مختلفة وبلا تقويم مسبق،
        وبعض الصفحات لا تُقرأ آلياً. حين يعجز عن قراءة مصدر يقول ذلك في السطر أعلى الشاشة
        بدل أن يبقى أخضر، لأن ضوءاً أخضر كاذباً أسوأ من أحمر صريح.
      </p>
      <p class="reason">افحص دائماً بنفسك عبر «افتح الصفحة الرسمية» قبل أي قرار.</p>
    </div>
    <div class="card">
      <h3>المظهر</h3>
      <p class="reason">اختر ما يريح عينك. كل مظهر مقيس، ولا يُعتمد إلا إذا بقي كل نصّ فيه مقروءاً.</p>
      <ul class="themes">
        ${THEMES.map(
          ([id, name, desc]) => `<li>
            <button class="theme-btn" data-theme-pick="${id}" aria-pressed="${theme === id}">
              <span class="swatches" aria-hidden="true">
                <i style="background:var(--sw-a)"></i><i style="background:var(--sw-b)"></i><i style="background:var(--sw-c)"></i>
              </span>
              <span class="theme-name">${name}</span>
              <span class="theme-desc">${desc}</span>
            </button>
          </li>`,
        ).join("")}
      </ul>
    </div>
    ${notificationsCard()}
    <div class="card">
      <h3>ساعات الصمت وحدّ التنبيهات</h3>
      <dl class="facts">
        ${fact("لا تُرسل تنبيهات بين", "١١ مساءً و٧ صباحاً بتوقيت الرياض")}
        ${fact("أقصى عدد تنبيهات في اليوم", "٦، والباقي يُؤجَّل لا يُلغى")}
        ${fact("دورية الفحص", "كل ٦ ساعات")}
      </dl>
      <p class="reason">
        هذه القيم تُضبط في الجولة الآلية نفسها، لا في المتصفّح، لأن الإرسال يحدث والتطبيق مغلق.
        عُرضت هنا لتعرفها، ولم تُعرض كأزرار لأن ضغطها لن يغيّر شيئاً — وزرّ لا يفعل شيئاً أسوأ من غيابه.
      </p>
    </div>
    <div class="card">
      <h3>افحص الآن</h3>
      <p class="reason">
        يعيد تحميل البيانات من الشبكة متجاوزاً النسخة المخزّنة. لا يشغّل جولة قراءة جديدة للجهات:
        تلك تعمل كل ٦ ساعات على جهازك وعلى GitHub، ولا يستطيع المتصفّح إطلاقها.
      </p>
      <div class="actions"><button class="secondary" id="refresh-now">حدّث البيانات الآن</button></div>
      <p class="reason" id="refresh-out"></p>
    </div>
    <div class="card">
      <h3>عتبة الصلة</h3>
      <label for="threshold" class="reason">أخفِ الفرص التي تقلّ درجتها عن <strong>${threshold}</strong>. الفرص غير المصنّفة تبقى ظاهرة دائماً.</label>
      <input id="threshold" type="range" min="0" max="90" step="5" value="${threshold}" />
    </div>
  </div>`;
}

/* ---------- header ---------- */

function honestyLine(): string {
  const broken = data.health.filter((h) => h.state !== "healthy");
  const review = data.opportunities.filter((o) => o.flags.includes("needs_manual_review")).length;
  const tierSA = broken.filter((h) => {
    const t = data.orgById.get(h.orgId)?.tier;
    return t === "S" || t === "A";
  });

  return `<button class="honesty" id="honesty" aria-expanded="false" aria-controls="health-panel">
      <span>✓ ${data.health.length} مصدراً مراقَباً</span>
      <span>آخر فحص ${timeAgo(data.lastCheckISO)}</span>
      ${broken.length > 0 ? `<span class="warn">${broken.length} يحتاج فحصاً يدوياً</span>` : ""}
      ${review > 0 ? `<span class="warn">${review} بلا تصنيف</span>` : ""}
      <span class="caret" aria-hidden="true">▾</span>
    </button>
    ${
      tierSA.length > 0 && !bannerDismissed
        ? `<div class="banner" role="status">مصدر من الفئة S أو A لا يُقرأ الآن (${esc(tierSA.map((h) => h.orgId).join("، "))}). افحصه بنفسك.<button id="dismiss">إخفاء</button></div>`
        : ""
    }
    <div id="health-panel" hidden>
      <ul class="health-list">
        ${data.health
          .slice()
          .sort((a, b) => a.state.localeCompare(b.state))
          .map(
            (h) => `<li class="${h.state}">
              <strong>${esc(data.orgById.get(h.orgId)?.nameAr ?? h.orgId)}</strong> — ${
                { healthy: "سليم", degraded: "متعثّر", broken: "معطوب" }[h.state]
              }، آخر نجاح ${timeAgo(h.lastSuccessISO)}
              <div class="url">${esc(h.sourceUrl)}</div>
              ${h.lastError ? `<div>${esc(h.lastError)}</div>` : ""}
            </li>`,
          )
          .join("")}
      </ul>
    </div>`;
}

/* ---------- render ---------- */

const TABS: [Tab, string][] = [
  ["season", "الموسم"],
  ["orgs", "الجهات"],
  ["mine", "طلباتي"],
  ["settings", "الإعدادات"],
];

function render(): void {
  const screen =
    tab === "season" ? seasonScreen()
    : tab === "orgs" ? orgsScreen()
    : tab === "mine" ? mineScreen()
    : settingsScreen();

  app.innerHTML = `<div class="shell">
    <header class="masthead">
      <h1>راصد</h1>
      <p>نوافذ التدريب التعاوني، ومتى لا يمكن الوثوق بما تراه.</p>
    </header>
    ${answerBlock()}
    ${honestyLine()}
    <nav class="tabs" role="tablist" aria-label="الأقسام">
      ${TABS.map(
        ([id, label]) =>
          `<button role="tab" id="tab-${id}" aria-selected="${tab === id}" data-tab="${id}">${label}</button>`,
      ).join("")}
    </nav>
    <main id="main" role="tabpanel" aria-labelledby="tab-${tab}">${screen}</main>
  </div>
  <dialog class="sheet" id="sheet"><div class="sheet-body"></div></dialog>`;
  app.setAttribute("aria-busy", "false");

  /*
   * With the labels on the left, scroll position zero already shows the names
   * and the start of the season, which is the right default. It only moves for
   * something worth moving for: a real window, or today's hairline. A column
   * of "?" is not worth scrolling away from the labels to see.
   */
  const track = document.querySelector<HTMLElement>(".season");
  if (track && track.scrollWidth > track.clientWidth) {
    const svg = track.querySelector("svg")!;
    const marker =
      svg.querySelector<SVGElement>(".seg-urgent") ??
      svg.querySelector<SVGElement>(".seg-open") ??
      svg.querySelector<SVGElement>(".today");
    if (marker) {
      const at = marker.getBoundingClientRect().left - svg.getBoundingClientRect().left;
      track.scrollLeft = Math.max(0, at - track.clientWidth / 2);
    }
  }
}

/* ---------- organisation sheet ---------- */

function openSheet(orgId: string): void {
  const org = data.orgById.get(orgId);
  if (!org) return;
  const dialog = document.getElementById("sheet") as HTMLDialogElement;
  const health = data.health.filter((h) => h.orgId === orgId);
  const opp = data.opportunities.find((o) => o.orgId === orgId);
  /*
   * Only shown when the record says the rule exists. The card path already
   * checked both; this one showed any stored quote under the caption "نصّ الشرط
   * كما نُشر", so a quote captured alongside `statesZeroCoursesRule: false`
   * would have been presented as a live condition on the organisation.
   */
  const quote =
    org.requiresZeroCourses.value === true
      ? (org.requiresZeroCourses.quote ?? null)
      : opp?.statesZeroCoursesRule
        ? (opp.zeroCoursesQuote ?? null)
        : null;

  const watched = org.sources.filter((s) => s.verifiedAtISO !== null);
  const confirmed = watched.some((s) => s.coopConfirmed === true);

  dialog.querySelector(".sheet-body")!.innerHTML = `
    <h2>${esc(org.nameAr)}</h2>
    <p class="org">${esc(org.nameEn)} — فئة ${org.tier} — ${esc(org.sector)}</p>
    ${orgChips(org)}
    ${
      quote
        ? `<blockquote class="quote">${esc(quote)}<cite>نصّ الشرط كما نُشر على صفحة الجهة</cite></blockquote>`
        : `<p class="reason">لم يُرصد أي شرط منشور بخصوص تصفير المواد. غياب الشرط ليس دليل مرونة، هو غياب فقط.</p>`
    }
    ${org.notes ? `<p class="reason">${esc(org.notes)}</p>` : ""}
    <dl class="facts">
      ${fact("المكافأة", org.stipend.amountSAR === null ? null : `${org.stipend.amountSAR} ريال`)}
      ${fact("قناة التقديم", org.applyVia === null ? null : esc(org.applyVia.target))}
      ${fact(
        "مصدر السجل",
        org.importSource === "spec" ? "المواصفة"
        : org.importSource === "coop_pdf_2021" ? "ملف COOP ٢٠٢١، غير محقّق"
        : "إدخال يدوي",
      )}
      ${fact("آخر فحص ناجح", health.length === 0 ? null : timeAgo(health[0]!.lastSuccessISO))}
    </dl>
    ${
      watched.length === 0
        ? `<p class="reason warn">لا تُراقَب هذه الجهة بعد: لم يُفتح لها رابط ويُقرأ، فلن يراها التطبيق إن أعلنت.</p>`
        : confirmed
          ? `<p class="reason"><span class="chip yes">صفحة تدريب مؤكّدة</span> الصفحة المراقَبة ذكرت التدريب التعاوني بنصّها.</p>`
          : `<p class="reason"><span class="chip unknown">صفحة الجهة، لا صفحة تدريب</span> تُراقَب صفحة حقيقية على نطاق الجهة، لكنها لم تذكر التدريب التعاوني وقت الفحص. الإعلان قد يظهر عليها، وقد يظهر في مكان آخر.</p>`
    }
    ${watched
      .map(
        (s) =>
          `<p class="reason src-note"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a><br />${esc(s.verifiedNote ?? "")}</p>`,
      )
      .join("")}
    ${
      org.historicalWindows.length > 0
        ? `<dl class="facts">${org.historicalWindows
            .map((w) => fact(esc(w.seasonLabel), `${formatDate(w.openedISO)} — ${formatDate(w.closedISO)}`))
            .join("")}</dl>`
        : ""
    }
    <div class="actions">
      ${
        org.manualCheckUrl
          ? `<a class="primary" href="${esc(org.manualCheckUrl.url)}" target="_blank" rel="noopener noreferrer">افتح الصفحة الرسمية</a>`
          : `<p class="chip unknown">لا رابط محقّق بعد، ولن يُعرض رابط لم يُفتح ويُقرأ</p>`
      }
      <button class="secondary" id="close-sheet">إغلاق</button>
    </div>`;
  dialog.showModal();
}

/* ---------- push subscription ---------- */

/**
 * base64url to bytes.
 *
 * Trimmed first, and hard: a secret set through a shell pipe arrives with a
 * trailing newline, and that one invisible character made atob throw about
 * Latin1 with no hint of where it came from. Anything outside the base64url
 * alphabet is stripped rather than trusted.
 */
const b64ToBytes = (b64: string): Uint8Array => {
  const clean = b64.trim().replace(/[^A-Za-z0-9_-]/g, "");
  const padded = (clean + "=".repeat((4 - (clean.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

/**
 * There is no server and no account, so the device subscription is handed back
 * to the owner to paste into a repository secret. It is the only storage this
 * design has, and it keeps the promise in spec section 9: no database.
 */
async function subscribeToPush(): Promise<void> {
  const out = document.getElementById("sub-out")!;
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  const say = (msg: string): void => {
    out.textContent = msg;
  };

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return say("هذا المتصفّح لا يدعم التنبيهات. على الآيفون ثبّت التطبيق على الشاشة الرئيسية أولاً.");
  }
  if (!key) return say("مفتاح VAPID العام غير مضبوط في البناء (VITE_VAPID_PUBLIC_KEY).");

  try {
    if ((await Notification.requestPermission()) !== "granted") {
      return say("لم تُمنح الإذن، فلن تصل تنبيهات.");
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToBytes(key),
    });
    const json = JSON.stringify(sub.toJSON());

    /*
     * This block of JSON is the whole storage layer for notifications: there
     * is no server and no account, so the device's own subscription is what
     * gets kept, and the owner keeps it. Showing it raw looked like an error
     * the first time, so it is labelled, boxed, and copied by a button.
     */
    out.innerHTML = `
      <strong>تمّ التسجيل. انسخ النصّ التالي وأرسله لي:</strong>
      <textarea class="sub-out" readonly rows="4">${esc(json)}</textarea>
      <button class="secondary" id="copy-sub">انسخ</button>
      <span id="copy-done" class="chip yes" hidden>نُسخ</span>`;
    document.getElementById("copy-sub")?.addEventListener("click", () => {
      void navigator.clipboard.writeText(json).then(() => {
        const done = document.getElementById("copy-done");
        if (done) done.hidden = false;
      });
    });
    // The panel above this now says "subscribed", so it has to be re-read.
    pushDiag = { ...pushDiag!, subscribed: true, endpointTail: sub.endpoint.slice(-12) };
  } catch (err) {
    say(`تعذّر التسجيل: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ---------- events ---------- */

app.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const hit = (sel: string): HTMLElement | null => el.closest(sel);

  const tabBtn = hit("[data-tab]");
  if (tabBtn) {
    tab = tabBtn.dataset.tab as Tab;
    render();
    // The device may have been given permission, or lost it, since last look.
    if (tab === "settings") void readPushDiag();
    return;
  }
  if (hit("#dismiss")) {
    bannerDismissed = true;
    render();
    return;
  }
  if (hit("#honesty")) {
    const btn = document.getElementById("honesty")!;
    const panel = document.getElementById("health-panel")!;
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    panel.hidden = open;
    return;
  }
  if (hit("#close-sheet")) {
    (document.getElementById("sheet") as HTMLDialogElement).close();
    return;
  }
  const orgBtn = hit("[data-open-org]");
  if (orgBtn) {
    openSheet(orgBtn.dataset.openOrg!);
    return;
  }
  const themeBtn = hit("[data-theme-pick]");
  if (themeBtn) {
    theme = themeBtn.dataset.themePick!;
    writeJSON(THEME_KEY, theme);
    applyTheme();
    render();
    return;
  }
  if (hit("#subscribe")) {
    void subscribeToPush();
    return;
  }
  if (hit("#test-notif")) {
    void testNotification();
    return;
  }
  if (hit("#refresh-now")) {
    const out = document.getElementById("refresh-out")!;
    out.textContent = "يحدّث…";
    void caches
      .delete("rasid-data-v2")
      .catch(() => false)
      .then(() => loadDataset())
      .then((d) => {
        data = d;
        render();
        const again = document.getElementById("refresh-out");
        if (again) again.textContent = `تم. آخر فحص للجهات ${timeAgo(data.lastCheckISO)}.`;
      })
      .catch((err: unknown) => {
        out.textContent = `تعذّر التحديث: ${err instanceof Error ? err.message : String(err)}`;
      });
    return;
  }
  const filterBtn = hit("[data-filter]");
  if (filterBtn) {
    const which = filterBtn.dataset.filter;
    if (which === "zero") onlyNoZeroCourses = !onlyNoZeroCourses;
    if (which === "stipend") onlyStipend = !onlyStipend;
    if (which === "major") onlyMyMajor = !onlyMyMajor;
    render();
    return;
  }
  const markBtn = hit("[data-mark]");
  if (markBtn) {
    const id = markBtn.dataset.opp!;
    const m = markBtn.dataset.mark!;
    if (m === "clear" || marks[id]?.mark === m) delete marks[id];
    else marks[id] = { mark: m as Mark, atISO: new Date().toISOString() };
    writeJSON(MARKS_KEY, marks);
    render();
  }
});

// Lanes are SVG groups given a button role, so they need the key handling a
// real button would get for free.
app.addEventListener("keydown", (e) => {
  const lane = (e.target as HTMLElement).closest?.("[data-org]");
  if (lane && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    openSheet((lane as HTMLElement).dataset.org!);
  }
});

app.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "q") {
    query = el.value;
    const at = el.selectionStart;
    render();
    const next = document.getElementById("q") as HTMLInputElement | null;
    next?.focus();
    if (next && at !== null) next.setSelectionRange(at, at);
  } else if (el.id === "sector") {
    sector = el.value;
    render();
  } else if (el.id === "tier") {
    tierFilter = el.value;
    render();
  } else if (el.id === "city") {
    cityFilter = el.value;
    render();
  } else if (el.id === "threshold") {
    threshold = Number(el.value);
    writeJSON(THRESHOLD_KEY, threshold);
    render();
    document.getElementById("threshold")?.focus();
  }
});

/*
 * Registered in production only. In dev a worker caching the shell turns every
 * edit into a hunt for why the page did not change.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(() => {
      void readPushDiag();
    });
  });
  // A push that lands while the app is open should update the panel, so the
  // arrival line is never stale in front of the person reading it.
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    if ((e.data as { type?: string } | null)?.type === "push-arrived") void readPushDiag();
  });
} else {
  void readPushDiag();
}

loadDataset()
  .then((d) => {
    data = d;
    render();
    checkFollowUps();
  })
  .catch((err: unknown) => {
    app.innerHTML = `<div class="shell"><p class="empty">تعذّر تحميل البيانات: ${esc(
      err instanceof Error ? err.message : String(err),
    )}<br />هذا عطب في التطبيق نفسه، لا خبر عن الجهات. لا تعتبره «لا توجد فرص».</p></div>`;
  });
