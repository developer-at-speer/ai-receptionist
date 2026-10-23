import assert from "node:assert/strict";
import test from "node:test";
import { formatAppointment, parseClinicInstant } from "../src/time.js";

test("appointment date and time render in America/Toronto", () => {
  const winter = parseClinicInstant("2026-11-03", "14:30", "America/Toronto");
  assert.ok(winter);
  assert.equal(winter.toISOString(), "2026-11-03T19:30:00.000Z");
  const winterText = formatAppointment(winter, "America/Toronto");
  assert.equal(winterText.date, "November 3, 2026");
  assert.match(winterText.time, /^2:30 PM America\/Toronto$/);

  const summer = parseClinicInstant("2026-07-15", "14:30", "America/Toronto");
  assert.ok(summer);
  assert.equal(summer.toISOString(), "2026-07-15T18:30:00.000Z");
  const summerText = formatAppointment(summer, "America/Toronto");
  assert.equal(summerText.date, "July 15, 2026");
  assert.match(summerText.time, /^2:30 PM America\/Toronto$/);
});

test("a spring-forward gap is not a bookable local time", () => {
  assert.equal(
    parseClinicInstant("2026-03-08", "02:30", "America/Toronto"),
    null,
  );
});
