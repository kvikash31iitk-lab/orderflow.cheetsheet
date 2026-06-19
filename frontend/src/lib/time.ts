// Centralized IST (Asia/Kolkata) time formatting.
//
// All timestamps stay epoch-UTC (ms) internally; ONLY display is converted to IST.
// We pass timeZone explicitly to Intl so the output never depends on the viewer's
// browser timezone. Chart axis/crosshair labels go through the formatters below.
import { TickMarkType, type Time } from "lightweight-charts";

export const APP_TIME_ZONE = "Asia/Kolkata";
export const APP_TIME_LABEL = "IST";

const fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIME_ZONE, hour12: false, ...opts });

const hm = fmt({ hour: "2-digit", minute: "2-digit" });
const hms = fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dmHm = fmt({ day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const dmy = fmt({ day: "2-digit", month: "short", year: "numeric" });
const monthYr = fmt({ month: "short", year: "2-digit" });
const dayMon = fmt({ day: "2-digit", month: "short" });
const yr = fmt({ year: "numeric" });

export function formatIstTime(ms: number, withSeconds = false): string {
  return (withSeconds ? hms : hm).format(ms);
}
export function formatIstDateTime(ms: number): string {
  return dmHm.format(ms);
}
export function formatIstDate(ms: number): string {
  return dmy.format(ms);
}

// lightweight-charts chart time is a UTCTimestamp (seconds); convert to epoch ms.
function chartTimeToMs(t: Time): number {
  if (typeof t === "number") return t * 1000;
  if (typeof t === "string") return Date.parse(t);
  // BusinessDay { year, month, day }
  const b = t as { year: number; month: number; day: number };
  return Date.UTC(b.year, b.month - 1, b.day);
}

// localization.timeFormatter -> crosshair time label (shows IST date + time)
export function istCrosshairFormatter(t: Time): string {
  return formatIstDateTime(chartTimeToMs(t));
}

// timeScale.tickMarkFormatter -> axis tick labels in IST.
// NOTE: lightweight-charts decides tick TYPE/placement from UTC day boundaries; the
// LABELS here are IST, which is what the user reads. (Exact IST-midnight tick placement
// would require shifting the data clock, which we avoid to keep drawing/data coords UTC.)
export function istTickFormatter(t: Time, tickMarkType: TickMarkType): string {
  const ms = chartTimeToMs(t);
  switch (tickMarkType) {
    case TickMarkType.Year:
      return yr.format(ms);
    case TickMarkType.Month:
      return monthYr.format(ms);
    case TickMarkType.DayOfMonth:
      return dayMon.format(ms);
    case TickMarkType.TimeWithSeconds:
      return hms.format(ms);
    default: // TickMarkType.Time
      return hm.format(ms);
  }
}
