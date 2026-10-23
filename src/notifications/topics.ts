/**
 * Forum-topic routing: map an event category to a Telegram `message_thread_id`.
 *
 * Mapping syntax (TELEGRAM_TOPIC_MAP): `claims:12,resolutions:15,squad:20`.
 */

export type TopicMap = ReadonlyMap<string, number>;

const CATEGORY_RE = /^[a-z0-9_-]+$/;

/** Parses a topic mapping. Throws an Error with a clear message when invalid. */
export function parseTopicMap(raw: string | undefined | null): TopicMap {
  const map = new Map<string, number>();
  if (raw === undefined || raw === null || raw.trim() === "") return map;
  for (const piece of raw.split(",")) {
    const entry = piece.trim();
    if (entry === "") continue;
    const idx = entry.indexOf(":");
    const category = (idx < 0 ? entry : entry.slice(0, idx)).trim().toLowerCase();
    const idText = idx < 0 ? "" : entry.slice(idx + 1).trim();
    if (!CATEGORY_RE.test(category)) {
      throw new Error(
        `invalid topic entry "${entry}": expected "<category>:<threadId>" (e.g. claims:12)`,
      );
    }
    if (!/^\d+$/.test(idText) || Number(idText) < 1 || !Number.isSafeInteger(Number(idText))) {
      throw new Error(
        `invalid thread id "${idText}" for category "${category}": must be a positive integer`,
      );
    }
    if (map.has(category)) throw new Error(`duplicate topic category "${category}"`);
    map.set(category, Number(idText));
  }
  return map;
}

/** Thread id for a category, or undefined (general topic) when unmapped. */
export function resolveTopicThreadId(
  map: TopicMap | undefined,
  category: string | undefined | null,
): number | undefined {
  if (!map || typeof category !== "string") return undefined;
  return map.get(category.trim().toLowerCase());
}
