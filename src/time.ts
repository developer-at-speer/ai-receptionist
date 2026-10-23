export type ClockParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
};

export function formatParts(instant: Date, timeZone: string): ClockParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const read = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  let hour = read("hour");
  if (hour === "24") hour = "00";
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
  };
}

function offsetAt(instant: Date, timeZone: string): number {
  const parts = formatParts(instant, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    0,
  );
  return asUtc - instant.getTime();
}

export function zonedLocalToUtc(
  date: string,
  time: string,
  timeZone: string,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = desiredUtc - offsetAt(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export function parseClinicInstant(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return null;
  }
  const [hour, minute] = time.split(":").map(Number);
  if (hour > 23 || minute > 59) return null;
  const instant = zonedLocalToUtc(date, time, timeZone);
  const parts = formatParts(instant, timeZone);
  const roundTripDate = `${parts.year}-${parts.month}-${parts.day}`;
  const roundTripTime = `${parts.hour}:${parts.minute}`;
  if (roundTripDate !== date || roundTripTime !== time) return null;
  return instant;
}

function normalizeSpaces(value: string): string {
  return value.replace(/[\u202f\u00a0]/g, " ");
}

export function formatAppointment(
  instant: Date,
  timeZone: string,
): { date: string; time: string } {
  const date = normalizeSpaces(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(instant),
  );
  const clock = normalizeSpaces(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(instant),
  );
  return { date, time: `${clock} ${timeZone}` };
}
