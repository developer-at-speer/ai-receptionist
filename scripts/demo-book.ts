import "dotenv/config";
import { formatParts } from "../src/time.js";

const secret = process.env.BOOKING_WEBHOOK_SECRET?.trim() ?? "";
const port = process.env.PORT || "3000";
const base = (process.env.APP_BASE_URL || `http://127.0.0.1:${port}`).replace(
  /\/$/,
  "",
);
const reference = process.env.DEMO_PATIENT_REFERENCE?.trim() || "demo-patient-001";
const dateOfBirth = process.env.DEMO_PATIENT_DOB?.trim() || "1980-01-15";
const physician = process.env.PHYSICIAN_NAME?.trim() || "Dr. Shah";

function futureDate(daysAhead: number): string {
  const future = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const parts = formatParts(future, process.env.CLINIC_TIMEZONE || "America/Toronto");
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function main(): Promise<void> {
  if (!secret) {
    throw new Error("BOOKING_WEBHOOK_SECRET is required in the environment.");
  }
  const appointmentDate = process.env.DEMO_APPOINTMENT_DATE || futureDate(14);
  const appointmentTime = process.env.DEMO_APPOINTMENT_TIME || "14:30";
  const response = await fetch(`${base}/api/appointments/book`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      patient_reference: reference,
      date_of_birth: dateOfBirth,
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
      physician,
      conversation_id: "demo-script",
      caller_phone: "+14165550999",
      reason: "routine visit",
    }),
  });
  const body = (await response.json()) as {
    appointment_id?: string;
    error?: string;
    message?: string;
    demo?: boolean;
    juno_appointment?: boolean;
  };
  console.log(JSON.stringify({ httpStatus: response.status, ...body }, null, 2));
  if (!response.ok || !body.appointment_id) process.exit(1);
  if (process.env.ALLOW_LIVE_SENDS !== "true") {
    console.log(
      "ALLOW_LIVE_SENDS is not true. The booking is stored, and notification jobs stay pending until you restart the server with live sends enabled.",
    );
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const statusResponse = await fetch(
      `${base}/api/appointments/${body.appointment_id}`,
      { headers: { authorization: `Bearer ${secret}` } },
    );
    const statusBody = await statusResponse.json();
    console.log(JSON.stringify(statusBody));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "demo_book_failed";
  console.error(message);
  process.exit(1);
});
