import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { confirmBooking } from "../src/booking/bookingService.js";
import { decryptString } from "../src/crypto/recipientCipher.js";
import { DeliveryError, SchedulingError } from "../src/errors.js";
import {
  countAppointments,
  countJobs,
  findAppointment,
  listJobs,
} from "../src/notifications/notificationRepository.js";
import { createResendEmailSender } from "../src/notifications/emailService.js";
import { createTwilioSmsSender, twilioMessageFields } from "../src/notifications/smsService.js";
import { loadConfig } from "../src/config.js";
import type { SchedulingService } from "../src/scheduling/schedulingService.js";
import {
  bookingBody,
  createHarness,
  futureSlot,
  postBooking,
  testConfig,
  withServer,
} from "./harness.js";

test("confirmed booking creates one admin email and one authorized SMS", async () => {
  const harness = await createHarness();
  const slot = futureSlot();
  await withServer(harness.app, async (base) => {
    const result = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(slot),
    );
    assert.equal(result.status, 200);
    assert.equal(result.json.demo, true);
    assert.equal(result.json.juno_appointment, false);
    assert.equal(result.json.scheduling_provider, "mock");
    assert.match(String(result.json.appointment_id), /^demo-/);
    assert.match(String(result.json.message), /not in Juno EMR/);
    assert.equal(harness.emailCalls.length, 0);
    assert.equal(countJobs(harness.deps.db), 2);
    const appointment = findAppointment(
      harness.deps.db,
      String(result.json.appointment_id),
    );
    assert.equal(appointment?.status, "confirmed");
  });

  const processed = await harness.processDue();
  assert.equal(processed, 2);
  assert.equal(harness.emailCalls.length, 1);
  assert.equal(harness.smsCalls.length, 1);
  assert.equal(harness.emailCalls[0]?.to, "mathew@speer.io");
  assert.equal(
    harness.emailCalls[0]?.subject,
    "New AI Receptionist Appointment — Dr. Shah's Family Practice",
  );
  assert.match(harness.emailCalls[0]?.text ?? "", /Booking Status: Confirmed/);
  assert.doesNotMatch(harness.emailCalls[0]?.text ?? "", /chest pain/);
  assert.doesNotMatch(harness.emailCalls[0]?.text ?? "", /416555/);
  assert.equal(harness.smsCalls[0]?.toE164, harness.authorizedPhone);
  assert.match(harness.smsCalls[0]?.body ?? "", /2:30 PM America\/Toronto/);
  assert.match(harness.smsCalls[0]?.body ?? "", /DEMO, not a Juno appointment/);
  assert.doesNotMatch(harness.smsCalls[0]?.body ?? "", /chest pain/);
});

test("a failed booking creates no notification jobs", async () => {
  const scheduler: SchedulingService = {
    provider: "mock",
    async book() {
      throw new SchedulingError("scheduling_rejected", "slot unavailable");
    },
  };
  const harness = await createHarness({ scheduler });
  await withServer(harness.app, async (base) => {
    const result = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(),
    );
    assert.equal(result.status, 502);
    assert.equal(result.json.error, "booking_failed");
  });
  assert.equal(countAppointments(harness.deps.db), 0);
  assert.equal(countJobs(harness.deps.db), 0);
  await harness.processDue();
  assert.equal(harness.emailCalls.length, 0);
  assert.equal(harness.smsCalls.length, 0);
});

test("a duplicate booking does not create another notification", async () => {
  let calls = 0;
  const scheduler: SchedulingService = {
    provider: "mock",
    async book() {
      calls += 1;
      return {
        appointmentId: `demo-${randomUUID()}`,
        provider: "mock",
        demo: true,
        status: "confirmed",
      };
    },
  };
  const harness = await createHarness({ scheduler });
  const body = bookingBody();
  await withServer(harness.app, async (base) => {
    const first = await postBooking(base, harness.deps.config.bookingWebhookSecret, body);
    const second = await postBooking(base, harness.deps.config.bookingWebhookSecret, body);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true);
    assert.equal(second.json.appointment_id, first.json.appointment_id);
  });
  assert.equal(calls, 1);
  assert.equal(countJobs(harness.deps.db), 2);
  await harness.processDue();
  assert.equal(harness.emailCalls.length, 1);
  assert.equal(harness.smsCalls.length, 1);
});

test("SMS is omitted when the patient has not authorized a mobile number", async () => {
  const harness = await createHarness({ authorizeSms: false });
  await withServer(harness.app, async (base) => {
    const result = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(),
    );
    assert.equal(result.status, 200);
  });
  const jobs = listJobs(
    harness.deps.db,
    String(
      (
        await findOnlyAppointment(harness)
      ).appointmentId,
    ),
  );
  assert.deepEqual(jobs.map((job) => job.channel), ["email"]);
  await harness.processDue();
  assert.equal(harness.emailCalls.length, 1);
  assert.equal(harness.smsCalls.length, 0);
});

test("an email API failure keeps the booking and schedules a retry", async () => {
  const harness = await createHarness({
    email: {
      async send() {
        throw new DeliveryError("resend_unavailable", false);
      },
    },
  });
  const booked = await bookDirect(harness);
  await harness.processDue();
  const jobs = listJobs(harness.deps.db, booked.appointmentId);
  const email = jobs.find((job) => job.channel === "email");
  const sms = jobs.find((job) => job.channel === "sms");
  assert.equal(findAppointment(harness.deps.db, booked.appointmentId)?.status, "confirmed");
  assert.equal(email?.status, "retry");
  assert.equal(email?.attemptCount, 1);
  assert.equal(email?.lastErrorCode, "resend_unavailable");
  assert.ok(email?.nextAttemptAt);
  assert.equal(sms?.status, "queued");
  assert.equal(harness.smsCalls.length, 1);
});

test("an SMS API failure keeps the booking and schedules a retry", async () => {
  const harness = await createHarness({
    sms: {
      async send() {
        throw new DeliveryError("20429", false);
      },
    },
  });
  const booked = await bookDirect(harness);
  await harness.processDue();
  const sms = listJobs(harness.deps.db, booked.appointmentId).find(
    (job) => job.channel === "sms",
  );
  assert.equal(findAppointment(harness.deps.db, booked.appointmentId)?.status, "confirmed");
  assert.equal(sms?.status, "retry");
  assert.equal(sms?.attemptCount, 1);
  assert.equal(sms?.lastErrorCode, "20429");
  assert.ok(sms?.nextAttemptAt);
  assert.equal(harness.emailCalls.length, 1);
});

test("a permanent SMS error is not retried forever", async () => {
  let calls = 0;
  const harness = await createHarness({
    sms: {
      async send() {
        calls += 1;
        throw new DeliveryError("21211", true);
      },
    },
  });
  await bookDirect(harness);
  await harness.processDue();
  await harness.processDue();
  assert.equal(calls, 1);
  const sms = listJobs(harness.deps.db, (await findOnlyAppointment(harness)).appointmentId).find(
    (job) => job.channel === "sms",
  );
  assert.equal(sms?.status, "failed");
  assert.equal(sms?.nextAttemptAt, null);
});

test("caller ID is not used as the SMS recipient", async () => {
  const harness = await createHarness();
  await withServer(harness.app, async (base) => {
    const result = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(futureSlot(), { caller_phone: "+14165550999" }),
    );
    assert.equal(result.status, 200);
  });
  await harness.processDue();
  assert.equal(harness.smsCalls[0]?.toE164, "+14165550100");
  assert.notEqual(harness.smsCalls[0]?.toE164, "+14165550999");
  const smsJob = listJobs(
    harness.deps.db,
    (await findOnlyAppointment(harness)).appointmentId,
  ).find((job) => job.channel === "sms");
  assert.ok(smsJob?.recipientCiphertext);
  assert.equal(
    decryptString(harness.deps.config.recipientDataKey, smsJob.recipientCiphertext),
    "+14165550100",
  );
});

test("several bookings in one call get separate confirmations", async () => {
  const harness = await createHarness();
  await withServer(harness.app, async (base) => {
    const first = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(futureSlot(40), { conversation_id: "conv-multi" }),
    );
    const second = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(futureSlot(41), { conversation_id: "conv-multi" }),
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first.json.appointment_id, second.json.appointment_id);
  });
  assert.equal(countAppointments(harness.deps.db), 2);
  assert.equal(countJobs(harness.deps.db), 4);
  await harness.processDue();
  assert.equal(harness.emailCalls.length, 2);
  assert.equal(harness.smsCalls.length, 2);
  assert.equal(new Set(harness.emailCalls.map((call) => call.idempotencyKey)).size, 2);
});

test("pending notifications are recovered after a worker restart", async () => {
  const harness = await createHarness();
  const booked = await bookDirect(harness);
  harness.deps.db
    .prepare(
      `UPDATE notification_jobs
       SET status = 'processing', locked_until = ?
       WHERE appointment_id = ?`,
    )
    .run("2000-01-01T00:00:00.000Z", booked.appointmentId);
  const recovered = await harness.processDue();
  assert.equal(recovered, 2);
  assert.equal(harness.emailCalls.length, 1);
  assert.equal(harness.smsCalls.length, 1);

  const delayed = await createHarness();
  const second = await bookDirect(delayed);
  delayed.deps.db
    .prepare(
      `UPDATE notification_jobs
       SET status = 'retry', next_attempt_at = ?
       WHERE appointment_id = ?`,
    )
    .run("2999-01-01T00:00:00.000Z", second.appointmentId);
  assert.equal(await delayed.processDue(), 0);
  delayed.deps.db
    .prepare(
      `UPDATE notification_jobs
       SET next_attempt_at = ?
       WHERE appointment_id = ?`,
    )
    .run("2000-01-01T00:00:00.000Z", second.appointmentId);
  assert.equal(await delayed.processDue(), 2);
});

test("automated tests cannot contact Resend or Twilio", async () => {
  assert.equal(process.env.NODE_ENV, "test");
  const config = testConfig({ allowLiveSends: true, resendApiKey: "re_test" });
  await assert.rejects(
    () => createResendEmailSender(config).send({
      idempotencyKey: "job-1",
      to: "mathew@speer.io",
      subject: "should not send",
      text: "should not send",
    }),
    (error: unknown) =>
      error instanceof DeliveryError && error.code === "live_sends_blocked_in_test",
  );
  await assert.rejects(
    () => createTwilioSmsSender(config).send({
      idempotencyKey: "job-2",
      toE164: "+14165550100",
      body: "should not send",
      statusCallbackUrl: "https://receptionist.example/webhooks/twilio/status",
    }),
    (error: unknown) =>
      error instanceof DeliveryError && error.code === "live_sends_blocked_in_test",
  );
});

test("the booking API sends one SMS from the imported Twilio number", async () => {
  const harness = await createHarness({
    config: { twilioPhoneNumber: "+12622394630" },
  });
  const body = bookingBody();
  const secret = harness.deps.config.bookingWebhookSecret;
  await withServer(harness.app, async (base) => {
    const created = await postBooking(
      base,
      secret,
      body,
      `Bearer ${secret}`,
      "/api/appointments/book",
    );
    const repeat = await postBooking(
      base,
      secret,
      body,
      `Bearer ${secret}`,
      "/webhooks/elevenlabs/book-appointment",
    );
    assert.equal(created.status, 200);
    assert.match(String(created.json.agent_instruction), /Do not send a confirmation SMS/);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.json.duplicate, true);
    assert.equal(repeat.json.appointment_id, created.json.appointment_id);
  });
  assert.equal(countJobs(harness.deps.db), 2);
  await harness.processDue();
  assert.equal(harness.smsCalls.length, 1);
  const fields = twilioMessageFields(harness.deps.config, harness.smsCalls[0]!);
  assert.equal(fields.From, "+12622394630");
  assert.equal(fields.To, "+14165550100");
  assert.equal(
    fields.StatusCallback,
    "https://receptionist.example/webhooks/twilio/status",
  );
  assert.equal(Object.hasOwn(fields, "SmsUrl"), false);
});

test("the clinic sender defaults to +12622394630", () => {
  const config = loadConfig({
    BOOKING_WEBHOOK_SECRET: "test-booking-secret",
    ELEVENLABS_WEBHOOK_SECRET: "test-elevenlabs-secret",
    RECIPIENT_DATA_KEY: Buffer.alloc(32, 7).toString("base64"),
    NODE_ENV: "test",
  });
  assert.equal(config.twilioPhoneNumber, "+12622394630");
});

test("Juno mode does not invent an appointment", async () => {
  const harness = await createHarness({
    config: { demoMode: false },
    scheduler: {
      provider: "juno",
      async book() {
        throw new SchedulingError(
          "juno_not_connected",
          "Juno EMR scheduling is not connected. No appointment was created.",
        );
      },
    },
  });
  await assert.rejects(
    () => bookDirect(harness),
    (error: unknown) => error instanceof Error && error.message === "booking_failed",
  );
  assert.equal(countAppointments(harness.deps.db), 0);
  assert.equal(countJobs(harness.deps.db), 0);
});

async function bookDirect(harness: Awaited<ReturnType<typeof createHarness>>) {
  const slot = futureSlot(45 + Math.floor(Math.random() * 20));
  const result = await confirmBooking(
    harness.deps.db,
    harness.deps.config,
    harness.deps.scheduler,
    {
      patientReference: "demo-patient-001",
      dateOfBirth: "1980-01-15",
      appointmentDate: slot.date,
      appointmentTime: slot.time,
      physician: "Dr. Shah",
      conversationId: "conv-direct",
    },
    new Date(),
  );
  return result.appointment;
}

async function findOnlyAppointment(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  const row = harness.deps.db.prepare("SELECT appointment_id FROM appointments").get();
  const appointment = findAppointment(harness.deps.db, String(row?.appointment_id));
  if (!appointment) throw new Error("missing appointment");
  return appointment;
}
