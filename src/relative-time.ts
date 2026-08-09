// How long ago something was, in words.
//
// One implementation, because the two places that need it — "as of <time>" on a review
// page and the last delivery per installation in settings — are two readings of the
// same question and would otherwise drift into two vocabularies for one age.
//
// Deliberately coarse. The point of both callers is "this is older than you probably
// assume", and a minute of precision on a fortnight-old observation is noise dressed as
// rigour.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** `ms` is an age, not a timestamp. A negative age (a clock that moved backwards
 *  between the write and the read) reads as "just now" rather than as the future. */
export function agoWords(ms: number): string {
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour");
  return plural(Math.floor(ms / DAY), "day");
}
