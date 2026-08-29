/**
 * The dataset is the backend.
 *
 * Everything the interface knows comes from the JSON the pipeline commits, so
 * a data-only commit republishes the site without a rebuild. Nothing here
 * invents a value: where the pipeline stored null, this layer keeps null, and
 * the rendering decides how to say "not announced".
 */
import type {
  AggregatorSource,
  Opportunity,
  Organisation,
  SourceHealth,
} from "../types";

export interface Dataset {
  orgs: Organisation[];
  aggregators: AggregatorSource[];
  opportunities: Opportunity[];
  health: SourceHealth[];
  orgById: Map<string, Organisation>;
  /** Worst health state across an organisation's sources. */
  healthOf: (orgId: string) => SourceHealth["state"] | "unwatched";
  lastCheckISO: string | null;
}

const base = import.meta.env.BASE_URL;

async function load<T>(name: string): Promise<T[]> {
  const res = await fetch(`${base}data/${name}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`تعذّر تحميل ${name}.json (${res.status})`);
  return (await res.json()) as T[];
}

const WORST: Record<SourceHealth["state"], number> = { healthy: 0, degraded: 1, broken: 2 };

export async function loadDataset(): Promise<Dataset> {
  const [orgs, aggregators, opportunities, health] = await Promise.all([
    load<Organisation>("organisations"),
    load<AggregatorSource>("aggregators"),
    load<Opportunity>("opportunities"),
    load<SourceHealth>("health"),
  ]);

  const byOrg = new Map<string, SourceHealth[]>();
  for (const h of health) {
    const list = byOrg.get(h.orgId);
    if (list) list.push(h);
    else byOrg.set(h.orgId, [h]);
  }

  const lastCheckISO =
    health.length === 0
      ? null
      : health.reduce((a, b) => (a.lastAttemptISO > b.lastAttemptISO ? a : b)).lastAttemptISO;

  return {
    orgs,
    aggregators,
    opportunities,
    health,
    orgById: new Map(orgs.map((o) => [o.id, o])),
    // "unwatched" is its own answer, distinct from healthy. An organisation
    // with no verified source is not a source in good standing, and the
    // interface must never let those two read alike.
    healthOf: (orgId) => {
      const list = byOrg.get(orgId);
      if (!list || list.length === 0) return "unwatched";
      return list.reduce((worst, h) => (WORST[h.state] > WORST[worst] ? h.state : worst),
        "healthy" as SourceHealth["state"]);
    },
    lastCheckISO,
  };
}

/* ---------- small shared formatters ---------- */

const AR_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

export function formatDate(iso: string | null): string {
  if (iso === null) return "لم يُعلن";
  const d = new Date(iso);
  return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "قبل ٤ ساعات". Deliberately coarse: precision we do not have is a lie. */
export function timeAgo(iso: string | null): string {
  if (iso === null) return "لم يُفحص بعد";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 2) return "الآن";
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `قبل ${hours} ساعة`;
  const days = Math.round(hours / 24);
  return `قبل ${days} يوم`;
}

export const daysUntil = (iso: string | null): number | null =>
  iso === null ? null : Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
