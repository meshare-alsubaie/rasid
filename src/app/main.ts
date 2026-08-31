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
import { hijriOf, unattested } from "../types";
import type { Attested, Opportunity, Organisation, Provenance } from "../types";

type Tab = "season" | "orgs" | "mine" | "settings";
type Mark = "interested" | "applied" | "ignored";

const MARKS_KEY = "rasid.marks.v1";
/**
 * When a push from the server last reached this device.
 *
 * Separate from the worker's own arrival log, and deliberately so: that log is
 * the evidence and lives in the cache, while this is a single timestamp the
 * home screen can consult without opening anything. Local tests are excluded —
 * a test I fired myself proves the device can display a notification, not that
 * the server can still reach it.
 */
const LAST_PUSH_KEY = "rasid.lastPush.v1";
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

/**
 * Where a value came from, said in the same breath as the value.
 *
 * Spec 8.2: no field is displayed whose provenance is not represented visually.
 * A number with nothing beside it reads as fact, and half the numbers here are
 * inferences or third-party reports.
 */
function provenanceTag(p: Provenance): string {
  const label = {
    official: "من الجهة",
    reported: "من طرف ثالث",
    inferred: "استنتاج من دورات سابقة",
    unknown: "مصدر غير معروف",
  }[p];
  return `<span class="prov prov-${p}">${label}</span>`;
}

/** A field with no published value is said in words, never left blank. */
const fact = (label: string, value: string | null): string =>
  `<div><dt>${label}</dt><dd class="${value === null ? "none" : ""}">${value ?? "لم يُعلن"}</dd></div>`;

/**
 * A decision chip, which cannot be built from a bare value.
 *
 * The parameter is `Attested<boolean | null>` and not `boolean | null`, and
 * that is the whole point: a caller with a value whose provenance the dataset
 * does not record has to say so, in code, by wrapping it in `unattested`. The
 * compiler refuses anything else. Spec 8.2 asked for this guarantee and it was
 * previously kept by discipline, which an audit showed was not kept at all —
 * two of these three chips were rendered green and red from fields carrying no
 * provenance of any kind.
 *
 * The mark before the label carries the same information as the colour, for a
 * reader who cannot use colour: ✓ yes, ✗ no, ؟ unknown.
 */
function chip(
  state: Attested<boolean | null>,
  yes: string,
  no: string,
  unknown: string,
): string {
  const known = state.provenance !== "unknown";
  const title = known ? "" : ` title="لا يُعرف مصدر هذه المعلومة"`;
  if (state.value === true) return `<li class="chip yes"${title}><b aria-hidden="true">✓</b> ${yes}</li>`;
  if (state.value === false) return `<li class="chip no"${title}><b aria-hidden="true">✗</b> ${no}</li>`;
  return `<li class="chip unknown"${title}><b aria-hidden="true">؟</b> ${unknown}</li>`;
}

function orgChips(org: Organisation): string {
  // requiresZeroCourses true is bad news for him, so the polarity is inverted
  // here on purpose: "no condition" is the green state.
  const zero = org.requiresZeroCourses;
  const noCondition: Attested<boolean | null> = {
    value: zero.value === null ? null : !zero.value,
    provenance: zero.provenance,
    quote: zero.quote,
    sourceUrl: zero.sourceUrl,
  };

  /*
   * These two carry no provenance in the dataset at all — `boolean | null` and
   * nothing else — so they are marked unknown-provenance here rather than
   * quietly rendered as fact. That is the gap made visible; closing it means
   * adding provenance to the schema, which is a data change, not a display one.
   */
  return `<ul class="chips">
    ${chip(noCondition, "لم تشترط تصفير المواد", "تشترط تصفير المواد", "شرط المواد غير معروف")}
    ${chip(unattested(org.acceptsUserMajor), "تخصصي مقبول", "تخصصي غير مقبول", "قبول التخصص غير معروف")}
    ${chip(unattested(org.offersCoopProduct), "تدريب تعاوني", "ليس تدريباً تعاونياً", "نوع البرنامج غير معروف")}
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
      o.flags.includes("more_on_page")
        ? `<p class="reason warn">هذه الصفحة تحمل إعلانات أخرى غير هذا، ولا يُسجَّل منها إلا واحد. افتحها بنفسك لترى البقية.</p>`
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
  /*
   * Counted against what is configured, not against what happened to be
   * fetched.
   *
   * The old count was `data.health.length` — one row per source the collector
   * has actually attempted — so a source nobody had ever touched simply did not
   * exist in the arithmetic. With 413 sources configured and 79 attempted, the
   * screen showed "✓ 79 مصدراً مراقَباً" and a reader would take 79 for the
   * whole. The denominator is now what he is relying on, and the gap is stated
   * rather than hidden by leaving it out of the sum.
   */
  const configured = coverage();
  const watched = configured.read;
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

  /*
   * The alarm for the alarm.
   *
   * Everything else on this screen reports what the last round found. Nothing
   * reported that there had been no round. An audit caught both collectors
   * failing at once — the scheduled task had failed twice without writing a
   * line, and the cloud run timed out having collected nothing and reported
   * success — while the app went on showing a calm "checked 11 hours ago". At
   * a six-hour cadence, twelve hours of silence is not lateness, it is a
   * failure, and it is the one failure that hides every other.
   */
  const sinceCheck =
    data.lastCheckISO === null ? Infinity : (Date.now() - Date.parse(data.lastCheckISO)) / 3_600_000;
  const stalled =
    sinceCheck > 12
      ? `<p class="stalled">⚠ لم تعمل جولة قراءة منذ ${
          sinceCheck === Infinity ? "بدء التطبيق" : `${Math.floor(sinceCheck)} ساعة`
        }، والمفترض كل ٦. ما تراه هنا قديم، وقد تكون فُتحت نوافذ لا يعرف بها. افحص الجهات المهمة بنفسك حتى تعود الجولة.</p>`
      : "";

  /*
   * Silence has two meanings and they must not look alike.
   *
   * "No notification in a week" is excellent news when the collector has been
   * running and found nothing, and it is a broken product when the push channel
   * has quietly died — an expired subscription, a revoked permission, a phone
   * that was reinstalled. From the user's chair the two are identical: nothing
   * happens. So the app watches its own delivery channel: if rounds have been
   * running and no push has arrived in seven days, that is worth saying out
   * loud, because the alternative is finding out when a deadline has passed.
   */
  const lastPush = readJSON<string | null>(LAST_PUSH_KEY, null);
  const collectorAlive = sinceCheck < 24;
  const daysSincePush =
    lastPush === null ? null : (Date.now() - Date.parse(lastPush)) / 86_400_000;
  const pushSilent =
    collectorAlive && daysSincePush !== null && daysSincePush > 7
      ? `<p class="stalled">⚠ لم يصل أي إشعار منذ ${Math.floor(daysSincePush)} يوماً، والجولات تعمل. قد تكون الإشعارات معطّلة على هذا الجهاز — افتح الإعدادات واضغط «جرّب إشعاراً الآن».</p>`
      : "";

  /*
   * The judge is down, and that is not the same as nothing happening.
   *
   * Pages are still being read and every source is green, but nothing can be
   * scored — and `decide` never notifies about a record it could not score, so
   * the app would go completely quiet while looking perfectly healthy. Three is
   * the same threshold the notifier uses: one page that failed twice is bad
   * luck, several in a round is an outage.
   */
  const unjudged = data.opportunities.filter((o) =>
    o.flags.includes("needs_manual_review"),
  ).length;
  const classifierDown =
    unjudged >= 3
      ? `<p class="stalled">⚠ قُرئت الصفحات ولم يُحكَم على ${unjudged} منها. لن تصل تنبيهات عن فرص جديدة حتى يعود التصنيف، والمصادر تبدو سليمة لأن القراءة نفسها تعمل. افحص الجهات المهمة بنفسك.</p>`
      : "";

  return `<section class="answer" aria-label="الحالة اليوم">
    ${stalled}
    ${classifierDown}
    ${pushSilent}
    ${headline}
    <p class="sub">${sub}</p>
    ${/* Spec E4: three numbers he must never have to tap for. How much was
          actually read, how many organisations he is blind to, and when the
          last round finished. Bad news among them is shown as bad news rather
          than omitted — a count that only appears when it is comfortable is a
          count that cannot be trusted when it is not. */ ""}
    <div class="tally">
      <span><b>${watched}</b> من ${configured.total} مصدراً قُرئ فعلاً</span>
      <span class="${configured.orgsUnread > 0 ? "warn" : ""}"><b>${configured.orgsUnread}</b> جهة بلا مصدر مقروء</span>
      <span>آخر جولة ناجحة ${timeAgo(data.lastCheckISO)}</span>
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

/**
 * Whether an application address names what it is for.
 *
 * `Co.op.training@tadawul.com.sa` is a channel. `info@sama.gov.sa` is a
 * switchboard, and the two must not be drawn the same way on a bar whose legend
 * promises a standing route to apply.
 */
function isDedicatedChannel(org: Organisation): boolean {
  const target = org.applyVia?.target;
  if (org.applyVia?.method !== "email" || !target) return false;
  const local = target.split("@")[0] ?? "";
  return /co-?\.?op|training|career|recruit|tadreeb/i.test(local);
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
      /*
       * A standing channel, and the bar has to mean it.
       *
       * This was "has an email address", and it drew the double line — legend:
       * "قناة بريد مفتوحة دائماً" — on seventy-two lanes. None of those
       * addresses is verified, and forty-nine are general switchboards like
       * `info@` scraped from a 2021 directory. Telling a student he can apply
       * year-round through `webmaster@sfda.gov.sa` is exactly the false green
       * light this project refuses to show.
       *
       * So the line is drawn only for an address that names the thing it is
       * for — coop, training, careers — which is the difference between a
       * published channel and a switchboard. The rest fall through to "؟",
       * and their address is still shown in the organisation sheet, where it
       * is labelled as unconfirmed.
       */
      rolling: isDedicatedChannel(org) && !visible.some((o) => o.orgId === org.id),
    }));

  const nextHint =
    "لا نافذة مفتوحة. حين تُعلن جهة تاريخاً ستظهر هنا، وسيتلوّن مسارها في الشريط أعلاه.";

  /*
   * The groups below list announcements, not organisations, and the difference
   * confused the first person to read the screen: "why only fourteen?" Because
   * fourteen pages have said something the classifier could read. The other
   * ninety-odd lanes are being read every six hours and have published nothing,
   * which is the normal state outside a window — and silence is exactly what
   * this app exists to sit through. So the count is now stated rather than left
   * to be inferred from a shorter list than expected.
   */
  /*
   * "Published nothing" and "we have not read it" are different sentences, and
   * only one of them is reassuring. A lane with no announcement was counted as
   * silent whether its pages had been read or not — so an organisation nobody
   * had fetched was reported as having published nothing.
   */
  const silent = lanes.filter(
    (l) => l.opportunity === undefined && l.health !== "unwatched" && l.health !== "broken",
  ).length;
  const unread = lanes.filter((l) => l.health === "unwatched" || l.health === "broken").length;

  return `<div class="season-head">
      <h2>الموسم</h2>
      <p class="season-note">سبتمبر إلى فبراير · ${lanes.length} جهة مراقَبة</p>
    </div>
    <p class="reason season-note">
      المسارات أدناه كل الجهات المراقَبة. أما المجموعات تحتها فتعرض <strong>الإعلانات</strong> لا الجهات:
      ${data.opportunities.length} إعلاناً قُرئ وصُنِّف حتى الآن، و${silent} جهة قُرئت ولم تنشر شيئاً${
        unread > 0 ? `، و<strong>${unread} جهة لم تُقرأ</strong> فلا يُعرف عنها شيء` : ""
      }.
      لا تُعطى الجهة درجة صلة، لأن الدرجة تُقاس على إعلان بعينه — وجهة صامتة لا إعلان لها تُقاس.
    </p>
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

  /*
   * A local test and a server push are reported separately, because they answer
   * different questions and one was mistaken for the other. A test fired from
   * this page proves the device can display a notification. Only a push proves
   * the server can still reach it while the phone is locked and the laptop is
   * off, which is the thing he is actually relying on.
   */
  const lastServerPush = readJSON<string | null>(LAST_PUSH_KEY, null);
  const arrival =
    d.lastArrival === null
      ? `<p class="reason warn">لم يصل هذا الجهاز أي إشعار بعد. اضغط «جرّب إشعاراً الآن» أولاً: إن ظهر، فالعرض يعمل والمشكلة في الإرسال. وإن لم يظهر مع أن الإذن مسموح، فالنظام يحجب إشعارات المتصفّح.</p>`
      : `<p class="reason">آخر إشعار وصل هذا الجهاز: <strong>${timeAgo(d.lastArrival.at)}</strong> (${d.lastArrival.via === "push" ? "من الخادم" : "تجربة محلية"})${d.lastArrival.title ? ` — ${esc(d.lastArrival.title)}` : ""}.</p>
         ${
           lastServerPush === null
             ? `<p class="reason warn">ولم يصل أي إشعار <strong>من الخادم</strong> بعد. التجربة المحلية تُثبت أن جهازك يعرض الإشعارات، ولا تُثبت أن الخادم يصل إليك وأنت نائم — وهذا هو ما تعتمد عليه.</p>`
             : `<p class="reason">وآخر إشعار من الخادم: <strong>${timeAgo(lastServerPush)}</strong>. هذه هي الحلقة التي تهمّ.</p>`
         }`;

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

/**
 * How much of what is configured has actually been read.
 *
 * Kept as one function because four separate screens were each computing their
 * own version of "watched" from `health.json` — the table of sources the
 * collector has attempted — and so every one of them silently excluded the
 * sources it had never reached. An audit found 334 of 413 in that state while
 * the app called itself healthy. A source that has never been fetched is not a
 * source in good standing; it is a promise nobody has kept yet.
 */
function coverage(): { total: number; read: number; orgsFullyRead: number; orgsUnread: number } {
  const readUrls = new Set(
    data.health.filter((h) => h.lastSuccessISO !== null).map((h) => h.sourceUrl),
  );
  let total = 0;
  let read = 0;
  let orgsFullyRead = 0;
  let orgsUnread = 0;
  for (const o of data.orgs) {
    const configured = o.sources.filter((s) => s.verifiedAtISO !== null);
    if (configured.length === 0) continue;
    const hit = configured.filter((s) => readUrls.has(s.url)).length;
    total += configured.length;
    read += hit;
    if (hit === configured.length) orgsFullyRead++;
    if (hit === 0) orgsUnread++;
  }
  return { total, read, orgsFullyRead, orgsUnread };
}

function settingsScreen(): string {
  return `<div class="cards">
    <div class="card">
      <h3>ما الذي يضمنه هذا التطبيق، وما الذي لا يضمنه</h3>
      <p class="reason">
        ${(() => {
          const c = coverage();
          return `مُهيَّأ لقراءة ${c.total} مصدراً على ${data.orgs.length} جهة، وقُرئ منها ${c.read} فعلاً.
        ${c.orgsUnread > 0 ? `<strong>${c.orgsUnread} جهة لم يُقرأ لها مصدر واحد بعد</strong>، فلن يراها التطبيق إن أعلنت.` : ""}
        ${confirmedPages()} جهة لها صفحة قالت عن نفسها إنها للتدريب التعاوني؛ والبقية صفحات حقيقية للجهة
        تُراقَب لأن الإعلان قد يظهر عليها، لا لأنها أثبتت أنها صفحة تدريب. الفرق مذكور داخل كل جهة.`;
        })()}
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
      <p class="reason">
        وحدّ واحد معروف: تنبيه «يغلق قريباً» يصلك حتى لو علّمت الفرصة «قدّمت». علاماتك محفوظة
        في هذا الجهاز وحده ولا يراها المُرسِل، وهذا مقصود — لا حساب ولا قاعدة بيانات تحفظ ما تفعله.
      </p>
    </div>
    <div class="card">
      <h3>ثبّت التطبيق على جهازك</h3>
      <p class="reason">
        التثبيت ليس تحسيناً شكلياً: على الآيفون لا تصل الإشعارات إطلاقاً قبله، وعلى أندرويد
        يفتح التطبيق بلا شريط متصفّح ويعمل بلا إنترنت بآخر بيانات قرأها.
      </p>
      <ol class="steps">
        <li><strong>أندرويد (Chrome):</strong> زر ⋮ في أعلى المتصفّح ← «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».</li>
        <li><strong>آيفون (Safari):</strong> زر المشاركة ⬆︎ ← «إضافة إلى الشاشة الرئيسية». ثمّ افتحه من الأيقونة، لا من سفاري، وفعّل التنبيهات من هناك.</li>
        <li><strong>ويندوز (Chrome أو Edge):</strong> أيقونة التثبيت في يمين شريط العنوان، أو ⋮ ← «تثبيت».</li>
      </ol>
      <p class="reason">${pushDiag?.standalone ? "هذا الجهاز يفتح التطبيق مثبَّتاً الآن." : "يبدو أنك تفتحه من المتصفّح لا من أيقونة مثبَّتة."}</p>
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

  /*
   * The tick was the last false green light on the screen.
   *
   * It counted `health.length` — one row per source the collector has ever
   * attempted — and put a checkmark in front of it. A source configured but
   * never fetched simply was not in the arithmetic, so the number was both
   * smaller than the truth and presented as the whole of it. It now reads as a
   * fraction, and the tick only appears when the fraction is complete.
   */
  const c = coverage();
  const complete = c.read === c.total;

  return `<button class="honesty" id="honesty" aria-expanded="false" aria-controls="health-panel">
      <span>${complete ? "✓" : "◔"} ${c.read} من ${c.total} مصدراً قُرئ</span>
      <span>آخر فحص ${timeAgo(data.lastCheckISO)}</span>
      ${c.orgsUnread > 0 ? `<span class="warn">${c.orgsUnread} جهة بلا مصدر مقروء</span>` : ""}
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

/**
 * Why an organisation is not being watched, in its own terms.
 *
 * "No link has been opened" is true of every unwatched organisation and
 * therefore tells the reader nothing. The reasons are different in kind and
 * one of them is permanent: a site whose robots.txt forbids every crawler but
 * the search engines will never be readable by this app, however long he waits,
 * and he should know to check it himself rather than expect an alert.
 */
function unwatchableReason(org: Organisation): string {
  if (org.sources.length === 0) return "لم يُعثر لها على رابط بعد.";
  const tried = org.sources.map((s) => s.verifiedNote ?? "").join(" ");
  if (/disallowed by robots/i.test(tried)) {
    return "موقعها يمنع القراءة الآلية في ملف robots.txt، ويسمح لمحرّكات البحث وحدها. هذا منع دائم، ونحن نحترمه.";
  }
  if (/لم تُخرج نصاً/.test(tried)) {
    return "صفحتها تُرسم بجافاسكربت ولا تُخرج نصاً يُقرأ، حتى بمتصفّح حقيقي.";
  }
  if (/403/.test(tried)) return "خادمها يرفض طلباتنا (403) حتى من متصفّح حقيقي.";
  if (/robots\.txt/i.test(tried)) return "لا يمكن قراءة ملف robots.txt من خادمها، ولا نقرأ موقعاً قبل قراءة شروطه.";
  return "جُرِّبت روابطها ولم يُقرأ منها نصّ.";
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
      ${/* Spec 8.2: no field is shown without its provenance visible. The
            amount was rendered bare, so a figure taken from a third-party
            report looked exactly like one published by the organisation. */ ""}
      ${fact(
        "المكافأة",
        org.stipend.amountSAR === null
          ? null
          : `${org.stipend.amountSAR} ريال ${provenanceTag(org.stipend.provenance)}`,
      )}
      ${/* Labelled, because none of these addresses has ever been confirmed:
            most came from a 2021 directory and many are switchboards. */ ""}
      ${fact(
        "قناة التقديم",
        org.applyVia === null
          ? null
          : `${esc(org.applyVia.target)}${org.applyVia.verifiedAtISO === null ? " — عنوان منشور، لم يُؤكَّد أنه يستقبل طلبات التدريب" : ""}`,
      )}
      ${fact(
        "مصدر السجل",
        org.importSource === "spec" ? "المواصفة"
        : org.importSource === "coop_pdf_2021" ? "ملف COOP ٢٠٢١، غير محقّق"
        : "إدخال يدوي",
      )}
      ${/* Per organisation, not per whichever health row came first. A body
            with seven pages of which one was ever fetched used to print that
            one's timestamp above all seven, as though it covered them. */ ""}
      ${(() => {
        const readUrls = new Set(
          data.health.filter((h) => h.lastSuccessISO !== null).map((h) => h.sourceUrl),
        );
        const hit = watched.filter((s) => readUrls.has(s.url)).length;
        const newest = health
          .map((h) => h.lastSuccessISO)
          .filter((t): t is string => t !== null)
          .sort()
          .at(-1);
        if (watched.length === 0) return fact("آخر فحص ناجح", null);
        return fact(
          "آخر فحص ناجح",
          newest === undefined
            ? null
            : `${timeAgo(newest)} · ${hit} من ${watched.length} من قنواتها قُرئت`,
        );
      })()}
    </dl>
    ${
      watched.length === 0
        ? `<p class="reason warn">لا تُراقَب هذه الجهة، فلن يراها التطبيق إن أعلنت. افحص موقعها بنفسك.
             ${unwatchableReason(org)}</p>`
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
            .map((w) =>
              fact(
                esc(w.seasonLabel),
                `${formatDate(w.openedISO)} — ${formatDate(w.closedISO)} ${provenanceTag(w.provenance)}`,
              ),
            )
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
/*
 * Returns an ArrayBuffer rather than a Uint8Array, and the difference is not
 * pedantry. `PushManager.subscribe` takes a `BufferSource` whose backing store
 * must be an ArrayBuffer, and a `Uint8Array` in modern lib types may be backed
 * by a SharedArrayBuffer — so the value was not assignable, and nothing said
 * so because this whole file was never being type-checked. It happens to work
 * at runtime; it is fixed here because the next such mismatch might not.
 */
const b64ToBytes = (b64: string): ArrayBuffer => {
  const clean = b64.trim().replace(/[^A-Za-z0-9_-]/g, "");
  const padded = (clean + "=".repeat((4 - (clean.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
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
      <strong>تمّ تسجيل هذا الجهاز.</strong>
      <span>لا يوجد خادم ولا حساب، فتسجيل الجهاز نفسه هو ما يُحفظ — احتفظ بالنصّ التالي مرّة واحدة،
      ويُضبط في إعدادات الجولة الآلية باسم <code>RASID_PUSH_SUBSCRIPTION</code>. لن تحتاجه ثانيةً
      ما لم تُلغِ الإذن أو تُعِد تثبيت التطبيق.</span>
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
    const msg = e.data as { type?: string; at?: string; via?: string } | null;
    if (msg?.type !== "push-arrived") return;
    // Kept outside the worker's cache as well, because the home screen has to
    // answer "has anything arrived lately" before anyone opens the settings.
    if (msg.at && msg.via === "push") writeJSON(LAST_PUSH_KEY, msg.at);
    void readPushDiag();
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
