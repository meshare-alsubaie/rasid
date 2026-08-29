/**
 * The Season Bar.
 *
 * One horizontal axis for the academic season, one thin lane per tracked
 * organisation, and a single vertical hairline for today that does not move
 * during a session, so the eye reads position instantly.
 *
 * The legend is honest by construction. A lane can only show a filled segment
 * when an announcement actually published dates; with no dates it shows "?",
 * and a source we can no longer read is greyed with a warning. Nothing here
 * can draw a window that was inferred, because nothing in the dataset infers
 * one - if prediction is added later it must arrive with its own hatched fill
 * and the label "متوقع", never as a solid bar.
 *
 * Time runs left to right inside the track, as in the spec's sketch, while the
 * labels sit on the right where an Arabic reader meets them first.
 */
import type { Opportunity, Organisation, SourceHealth } from "../types";
import { daysUntil } from "./data";

export interface LaneInput {
  org: Organisation;
  opportunity: Opportunity | undefined;
  health: SourceHealth["state"] | "unwatched";
  /** A rolling email channel, which has no window to draw. */
  rolling: boolean;
}

const W = 860;
const LABEL_W = 210;
const TRACK_X = 8;
const TRACK_W = W - LABEL_W - TRACK_X * 2;
const HEADER_H = 26;
const LANE_H = 20;

const MONTHS = ["سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر", "يناير", "فبراير"];

/** September of the current academic season through the end of February. */
export function seasonBounds(now = new Date()): { start: Date; end: Date } {
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return { start: new Date(year, 8, 1), end: new Date(year + 1, 2, 1) };
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Cut on a word boundary. Arabic mid-word truncation is unreadable. */
function truncate(name: string, max: number): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Sort: open now, then closing soon, then everything still silent. */
function rank(l: LaneInput): number {
  const s = l.opportunity?.status;
  if (s === "closing_soon") return 0;
  if (s === "open") return 1;
  if (s === "announced_not_open") return 2;
  if (l.rolling) return 3;
  if (l.health === "broken" || l.health === "degraded") return 5;
  return 4;
}

export function renderSeasonBar(lanes: LaneInput[], now = new Date()): string {
  const { start, end } = seasonBounds(now);
  const span = end.getTime() - start.getTime();
  const xOf = (t: number): number =>
    TRACK_X + Math.max(0, Math.min(1, (t - start.getTime()) / span)) * TRACK_W;

  const sorted = [...lanes].sort((a, b) => rank(a) - rank(b) || a.org.nameAr.localeCompare(b.org.nameAr));
  const height = HEADER_H + sorted.length * LANE_H + 10;

  const monthTicks = MONTHS.map((name, i) => {
    const x = xOf(new Date(start.getFullYear(), start.getMonth() + i, 1).getTime());
    return `<text class="month" x="${x + 4}" y="14">${name}</text>
      <line class="lane-rule" x1="${x}" y1="18" x2="${x}" y2="${height - 6}" />`;
  }).join("");

  const todayX = xOf(now.getTime());
  const inSeason = now >= start && now < end;

  const rows = sorted.map((lane, i) => {
    const y = HEADER_H + i * LANE_H;
    const mid = y + LANE_H / 2;
    const label = truncate(lane.org.nameAr, 30);
    const broken = lane.health === "broken" || lane.health === "degraded";

    let body: string;
    let described: string;

    const opp = lane.opportunity;
    const opens = opp?.opensISO ? Date.parse(opp.opensISO) : null;
    const closes = opp?.closesISO ? Date.parse(opp.closesISO) : null;

    if (opens !== null || closes !== null) {
      const x1 = xOf(opens ?? start.getTime());
      const x2 = xOf(closes ?? end.getTime());
      const soon = opp?.status === "closing_soon";
      const d = daysUntil(opp?.closesISO ?? null);
      body = `<rect class="${soon ? "seg-urgent" : "seg-open"} lane-anim" x="${x1}" y="${mid - 4}"
        width="${Math.max(3, x2 - x1)}" height="8" rx="2" style="animation-delay:${i * 90}ms" />`;
      described = soon && d !== null ? `نافذة تغلق بعد ${d} يوم` : "نافذة معلنة";
    } else if (lane.rolling) {
      body = `<line class="seg-rolling lane-anim" x1="${TRACK_X}" y1="${mid - 2}" x2="${TRACK_X + TRACK_W}" y2="${mid - 2}" style="animation-delay:${i * 90}ms" />
        <line class="seg-rolling lane-anim" x1="${TRACK_X}" y1="${mid + 2}" x2="${TRACK_X + TRACK_W}" y2="${mid + 2}" style="animation-delay:${i * 90}ms" />`;
      described = "قناة بريد مفتوحة دائماً، بلا نافذة معلنة";
    } else {
      const x = inSeason ? todayX : TRACK_X + TRACK_W / 2;
      body = `<text class="seg-unknown" x="${x}" y="${mid + 4}" text-anchor="middle">${broken ? "⚠" : "؟"}</text>`;
      described = broken
        ? "المصدر لا يُقرأ الآن، والبيانات قد تكون قديمة"
        : "لم يُعلن تاريخ فتح أو إغلاق";
    }

    return `<g class="lane${broken ? " lane-broken" : ""}" role="button" tabindex="0"
        data-org="${esc(lane.org.id)}" aria-label="${esc(`${lane.org.nameAr}: ${described}`)}">
        <rect class="lane-hit" x="0" y="${y}" width="${W}" height="${LANE_H}" fill="transparent" />
        ${body}
        <text class="lane-label" x="${W - 6}" y="${mid + 4}" text-anchor="end">${esc(label)}</text>
      </g>`;
  });

  const today = inSeason
    ? `<line class="today today-anim" x1="${todayX}" y1="18" x2="${todayX}" y2="${height - 6}" />
       <text class="today-label today-anim" x="${todayX + 4}" y="${height - 8}">اليوم</text>`
    : "";

  /*
   * Before the season opens there is no honest place to put the hairline, and
   * simply omitting it leaves the reader wondering where "now" is. Say it in
   * words instead of drawing a line at a date that is not today.
   */
  const offSeason = inSeason
    ? ""
    : now < start
      ? `<p class="season-note">اليوم قبل بداية الموسم بـ${Math.ceil((start.getTime() - now.getTime()) / 86400000)} يوم، فلا خطّ لليوم على المحور بعد.</p>`
      : `<p class="season-note">انتهى هذا الموسم. المحور يعرض سبتمبر إلى فبراير الماضيين.</p>`;

  return `${offSeason}<div class="season">
    <svg viewBox="0 0 ${W} ${height}" role="img"
      aria-label="موسم التقديم من سبتمبر إلى فبراير، مسار لكل جهة، وخطّ رأسي يحدّد اليوم">
      ${monthTicks}
      ${rows.join("")}
      ${today}
    </svg>
  </div>
  <ul class="legend">
    <li><span class="swatch" style="background:var(--live)"></span> نافذة معلنة بتواريخ منشورة</li>
    <li><span class="swatch" style="background:var(--urgent)"></span> تغلق خلال ٤٨ ساعة</li>
    <li><span class="swatch" style="border-top:2px solid var(--live);border-bottom:2px solid var(--live);height:8px"></span> قناة بريد مفتوحة دائماً</li>
    <li><span class="swatch" style="display:grid;place-items:center;color:var(--dormant-text)">؟</span> المصدر يُقرأ، ولا شيء معلن</li>
    <li><span class="swatch" style="display:grid;place-items:center">⚠</span> المصدر لا يُقرأ، والبيانات قد تكون قديمة</li>
  </ul>`;
}
