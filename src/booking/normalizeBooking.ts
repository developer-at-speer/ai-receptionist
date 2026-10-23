const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export type BookingNormalization = {
  now: Date;
  timeZone: string;
  physicianName: string;
  patientReference: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function clinicToday(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function weekdayDate(name: string, now: Date, timeZone: string): string | null {
  const target = WEEKDAYS.indexOf(name);
  if (target < 0) return null;
  const today = clinicToday(now, timeZone);
  const [year, month, day] = today.split("-").map(Number);
  const current = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const delta = (target - current + 7) % 7;
  return addDays(today, delta);
}

export function normalizeDate(
  value: string,
  now: Date,
  timeZone: string,
): string | null {
  const cleaned = value.trim().replace(/,/g, "").replace(/\s+/g, " ");
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  const weekday = /^(?:next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.exec(
    cleaned,
  );
  const bareWeekday = weekday?.[1] ?? (/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.exec(cleaned)?.[1] ?? "");
  if (bareWeekday) return weekdayDate(bareWeekday.toLowerCase(), now, timeZone);

  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/i.exec(cleaned);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    const day = Number(monthFirst[2]);
    const year = monthFirst[3] ? Number(monthFirst[3]) : Number(clinicToday(now, timeZone).slice(0, 4));
    if (month) return isoDate(year, month, day);
  }

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{4}))?$/i.exec(cleaned);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    const day = Number(dayFirst[1]);
    const year = dayFirst[3] ? Number(dayFirst[3]) : Number(clinicToday(now, timeZone).slice(0, 4));
    if (month) return isoDate(year, month, day);
  }

  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(cleaned);
  if (numeric) return isoDate(Number(numeric[3]), Number(numeric[1]), Number(numeric[2]));
  return null;
}

export function normalizeTime(value: string): string | null {
  const cleaned = value.trim().replace(/\./g, "").replace(/\s+/g, " ").toLowerCase();
  const clock = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap]m)?$/.exec(cleaned);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? "0");
  const meridian = clock[3] ?? "";
  if (minute > 59 || hour > 23) return null;
  if (meridian) {
    if (hour < 1 || hour > 12) return null;
    if (meridian === "pm" && hour < 12) hour += 12;
    if (meridian === "am" && hour === 12) hour = 0;
  } else if (hour >= 1 && hour <= 7) {
    hour += 12;
  }
  if (hour > 23) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

function samePhysician(value: string, canonical: string): boolean {
  const letters = (input: string) => input.toLowerCase().replace(/[^a-z]/g, "");
  return letters(value) === letters(canonical);
}

export function normalizeBookingBody(
  body: Record<string, unknown>,
  options: BookingNormalization,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  const reference = text(body.patient_reference) || text(body.patient_name) || text(body.name);
  if (reference) next.patient_reference = reference;
  const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (reference && compact(reference) === compact(options.patientReference)) {
    next.patient_reference = options.patientReference;
  }

  let dateSource = text(body.appointment_date);
  let timeSource = text(body.appointment_time);
  const combined = /^(.+?)\s+at\s+(.+)$/i.exec(dateSource);
  if (combined && !timeSource) {
    dateSource = combined[1];
    timeSource = combined[2];
  }

  const appointmentDate = dateSource
    ? normalizeDate(dateSource, options.now, options.timeZone)
    : null;
  if (appointmentDate) next.appointment_date = appointmentDate;

  const appointmentTime = timeSource ? normalizeTime(timeSource) : null;
  if (appointmentTime) next.appointment_time = appointmentTime;

  const birth = text(body.date_of_birth);
  const birthDate = birth ? normalizeDate(birth, options.now, options.timeZone) : null;
  if (birthDate) next.date_of_birth = birthDate;

  const physician = text(body.physician);
  if (!physician || samePhysician(physician, options.physicianName)) {
    next.physician = options.physicianName;
  }
  return next;
}
