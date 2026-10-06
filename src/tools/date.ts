/**
 * date tool: resolve a log line id to the local wall-clock time it was
 * written. Storage keeps ISO timestamps; the model sees local time plus date.
 */

/** Local date+time for an ISO timestamp, e.g. "2026-10-06 14:21:07". */
export function dateOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "invalid date";
  const p = (v: number): string => String(v).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** date(id): local time of the line, or "No line id." when the id is unknown. */
export function lookup(getDate: (id: number) => string | null, id: number): string {
  const iso = getDate(id);
  return iso === null ? `No line ${id}.` : dateOf(iso);
}