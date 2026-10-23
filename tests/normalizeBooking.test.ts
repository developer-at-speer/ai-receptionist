import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBookingBody } from "../src/booking/normalizeBooking.js";

const friday = new Date("2026-10-23T15:00:00.000Z");

test("spoken booking details become the stored booking format", () => {
  const normalized = normalizeBookingBody(
    {
      patient_reference: "Demo-Patient-001",
      date_of_birth: "January 15th, 1980",
      appointment_date: "Wednesday",
      appointment_time: "2:00 PM",
      physician: "dr shah",
    },
    {
      now: friday,
      timeZone: "America/Toronto",
      physicianName: "Dr. Shah",
      patientReference: "demo-patient-001",
    },
  );
  assert.equal(normalized.patient_reference, "demo-patient-001");
  assert.equal(normalized.date_of_birth, "1980-01-15");
  assert.equal(normalized.appointment_date, "2026-10-28");
  assert.equal(normalized.appointment_time, "14:00");
  assert.equal(normalized.physician, "Dr. Shah");
});
