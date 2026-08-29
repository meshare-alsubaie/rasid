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
import type { Opportunity, Organisation } from "../types";

type Tab = "season" | "orgs" | "mine" | "settings";
type Mark = "interested" | "applied" | "ignored";

const MARKS_KEY = "rasid.marks.v1";
const THRESHOLD_KEY = "rasid.threshold.v1";

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
let tab: Tab = "season";
let sector = "";
let query = "";
let bannerDismissed = false;
let data: Dataset;

/* ---------- shared pieces ---------- */

const scoreLabel = (o: Opportunity): string =>
  o.relevanceScore === null
    ? `<span class="score unscored" title="لم يُصنَّف">؟</span>`
    : `<span class="score">${o.relevanceScore}</span>`;

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

  return `<li class="card${review ? " is-review" : ""}">
    <div class="row">
      <div>
        <h3>${esc(o.titleAr)}</h3>
        <div class="org">${esc(org?.nameAr ?? o.orgId)}</div>
      </div>
      ${scoreLabel(o)}
    </div>
    <div class="meta">
      <span>يفتح: ${formatDate(o.opensISO)}</span>
      <span>يغلق: ${formatDate(o.closesISO)}${days !== null && days >= 0 ? ` (بعد ${days} يوم)` : ""}</span>
      <span>المقاعد: ${o.seats ?? "لم يُعلن"}</span>
      <span>المكافأة: ${o.stipendSAR === null ? "لم تُعلن" : `${o.stipendSAR} ريال`}</span>
    </div>
    <p class="reason">${esc(o.relevanceReason)}</p>
    ${
      o.flags.includes("wrong_product")
        ? `<p class="chip no" style="justify-self:start">تطوير خريجين، وأنت غير مؤهّل قبل التخرّج</p>`
        : ""
    }
    ${
      o.statesZeroCoursesRule && o.zeroCoursesQuote
        ? `<blockquote class="quote">${esc(o.zeroCoursesQuote)}<cite>شرط منشور على صفحة الجهة</cite></blockquote>`
        : ""
    }
    <div class="sheet-actions">
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
    "لا توجد نوافذ مفتوحة اليوم، ولم تنشر أي جهة محقّقة تاريخ فتح بعد. الجدول أدناه يعرض ما نراقبه فعلاً.";

  return `${renderSeasonBar(lanes)}
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
  const list = data.orgs
    .filter((o) => (sector === "" || o.sector === sector) && (query === "" || o.nameAr.includes(query)))
    .sort((a, b) => "SABC".indexOf(a.tier) - "SABC".indexOf(b.tier) || a.nameAr.localeCompare(b.nameAr));

  return `<div class="filters">
      <input id="q" type="search" placeholder="ابحث باسم الجهة" value="${esc(query)}" aria-label="ابحث باسم الجهة" />
      <select id="sector" aria-label="القطاع">
        <option value="">كل القطاعات</option>
        ${sectors.map((s) => `<option value="${s}"${s === sector ? " selected" : ""}>${s}</option>`).join("")}
      </select>
    </div>
    <p class="empty" style="border-style:solid">${list.length} جهة من ${data.orgs.length}. الرمادي المتقطّع يعني «غير معروف»، لا «لا بأس».</p>
    <ul class="cards">
      ${list
        .map(
          (o) => `<li><button class="org-row" data-open-org="${esc(o.id)}">
            <span><span class="name">${esc(o.nameAr)}</span><span class="tier">فئة ${o.tier}</span></span>
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
        ${o ? `<div class="sheet-actions"><button class="secondary" data-open-org="${esc(o.orgId)}">تفاصيل الجهة</button><button class="secondary" data-mark="clear" data-opp="${esc(id)}">إزالة</button></div>` : ""}
      </li>`;
    })
    .join("")}</ul>`;
}

function settingsScreen(): string {
  const verified = data.orgs.filter((o) => o.manualCheckUrl !== null).length;
  return `<div class="cards">
    <div class="card">
      <h3>ما الذي يضمنه هذا التطبيق، وما الذي لا يضمنه</h3>
      <p class="reason">
        يراقب ${data.health.length} مصدراً محقّقاً فُتح كل منها وقُرئ بنصّه، من أصل ${data.orgs.length} جهة في القاعدة.
        هذا يعني أن ${data.orgs.length - verified} جهة ليس لها رابط محقّق بعد، ولن يراها التطبيق إن أعلنت.
      </p>
      <p class="reason">
        لا يَعِد بأنه سيرى كل إعلان. الجهات تنشر في أماكن مختلفة وبلا تقويم مسبق،
        وبعض الصفحات لا تُقرأ آلياً. حين يعجز عن قراءة مصدر يقول ذلك في السطر أعلى الشاشة
        بدل أن يبقى أخضر، لأن ضوءاً أخضر كاذباً أسوأ من أحمر صريح.
      </p>
      <p class="reason">افحص دائماً بنفسك عبر «افتح الصفحة الرسمية» قبل أي قرار.</p>
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
      ${honestyLine()}
    </header>
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
   * On a narrow screen the Season Bar is wider than the viewport, and an RTL
   * container starts scrolled to the labels, showing a column of names beside
   * an empty stretch of axis. Bring the part that carries information into
   * view instead: today when we are in season, the middle of the track when
   * we are not.
   */
  const track = document.querySelector<HTMLElement>(".season");
  if (track && track.scrollWidth > track.clientWidth) {
    const svg = track.querySelector("svg")!;
    const marker =
      svg.querySelector<SVGElement>(".today") ??
      svg.querySelector<SVGElement>(".seg-open") ??
      svg.querySelector<SVGElement>(".seg-unknown");
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
  const quote = org.requiresZeroCourses.quote ?? opp?.zeroCoursesQuote ?? null;

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
    <dl>
      <dt>المكافأة</dt><dd>${org.stipend.amountSAR === null ? "غير معروفة" : `${org.stipend.amountSAR} ريال`}</dd>
      <dt>قناة التقديم</dt><dd>${org.applyVia === null ? "غير معروفة" : esc(org.applyVia.target)}</dd>
      <dt>مصدر السجل</dt><dd>${org.importSource === "spec" ? "المواصفة" : org.importSource === "coop_pdf_2021" ? "ملف COOP ‏٢٠٢١، غير محقّق" : "إدخال يدوي"}</dd>
      <dt>آخر فحص ناجح</dt><dd>${health.length === 0 ? "لا مصدر مراقَب" : timeAgo(health[0]!.lastSuccessISO)}</dd>
    </dl>
    ${
      org.historicalWindows.length > 0
        ? `<dl>${org.historicalWindows
            .map((w) => `<dt>${esc(w.seasonLabel)}</dt><dd>${formatDate(w.openedISO)} — ${formatDate(w.closedISO)}</dd>`)
            .join("")}</dl>`
        : ""
    }
    <div class="sheet-actions">
      ${
        org.manualCheckUrl
          ? `<a class="primary" href="${esc(org.manualCheckUrl.url)}" target="_blank" rel="noopener noreferrer">افتح الصفحة الرسمية</a>`
          : `<p class="chip unknown">لا رابط محقّق بعد، ولن يُعرض رابط لم يُفتح ويُقرأ</p>`
      }
      <button class="secondary" id="close-sheet">إغلاق</button>
    </div>`;
  dialog.showModal();
}

/* ---------- events ---------- */

app.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const hit = (sel: string): HTMLElement | null => el.closest(sel);

  const tabBtn = hit("[data-tab]");
  if (tabBtn) {
    tab = tabBtn.dataset.tab as Tab;
    render();
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
  } else if (el.id === "threshold") {
    threshold = Number(el.value);
    writeJSON(THRESHOLD_KEY, threshold);
    render();
    document.getElementById("threshold")?.focus();
  }
});

loadDataset()
  .then((d) => {
    data = d;
    render();
  })
  .catch((err: unknown) => {
    app.innerHTML = `<div class="shell"><p class="empty">تعذّر تحميل البيانات: ${esc(
      err instanceof Error ? err.message : String(err),
    )}<br />هذا عطب في التطبيق نفسه، لا خبر عن الجهات. لا تعتبره «لا توجد فرص».</p></div>`;
  });
