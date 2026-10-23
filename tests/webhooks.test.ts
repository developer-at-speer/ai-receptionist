import assert from "node:assert/strict";
import test from "node:test";
import {
  countJobs,
  countProviderEvents,
  listJobs,
} from "../src/notifications/notificationRepository.js";
import { expectedTwilioSignature } from "../src/notifications/smsService.js";
import {
  bookingBody,
  createHarness,
  postBooking,
  withServer,
} from "./harness.js";
import { elevenLabsSignature } from "../src/http/elevenlabs.js";

test("invalid webhook signatures are rejected", async () => {
  const harness = await createHarness();
  await withServer(harness.app, async (base) => {
    const booked = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(),
    );
    assert.equal(booked.status, 200);
    const unauthenticated = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(),
      "Bearer wrong-booking-secret",
    );
    assert.equal(unauthenticated.status, 401);

    const raw = JSON.stringify({
      type: "post_call_transcription",
      event_timestamp: 1730000000,
      data: {
        conversation_id: "conv-1",
        transcript: [{ role: "agent", message: "clinical detail" }],
      },
    });
    const invalid = await fetch(`${base}/webhooks/elevenlabs/post-call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "elevenlabs-signature": "t=1,v0=deadbeef",
      },
      body: raw,
    });
    assert.equal(invalid.status, 401);
    assert.equal(countProviderEvents(harness.deps.db), 0);

    const params = {
      MessageSid: `SM${"b".repeat(32)}`,
      MessageStatus: "delivered",
      To: "+19999999999",
    };
    const badTwilio = await fetch(`${base}/webhooks/twilio/status`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "not-a-signature",
      },
      body: new URLSearchParams(params),
    });
    assert.equal(badTwilio.status, 403);
    assert.equal(countJobs(harness.deps.db), 2);
  });
});

test("a repeated post-call webhook does not add notifications", async () => {
  const harness = await createHarness();
  await withServer(harness.app, async (base) => {
    const booked = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(),
    );
    assert.equal(booked.status, 200);
    const raw = JSON.stringify({
      type: "post_call_transcription",
      event_timestamp: 1730000000,
      data: {
        conversation_id: "conv-1",
        analysis: { success: true },
        transcript: [{ role: "agent", message: "booked" }],
      },
    });
    const signature = elevenLabsSignature(
      harness.deps.config.elevenlabsWebhookSecret,
      raw,
    );
    const first = await fetch(`${base}/webhooks/elevenlabs/post-call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "elevenlabs-signature": signature,
      },
      body: raw,
    });
    const second = await fetch(`${base}/webhooks/elevenlabs/post-call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "elevenlabs-signature": signature,
      },
      body: raw,
    });
    const firstBody = (await first.json()) as { duplicate: boolean };
    const secondBody = (await second.json()) as { duplicate: boolean };
    assert.equal(first.status, 200);
    assert.equal(firstBody.duplicate, false);
    assert.equal(second.status, 200);
    assert.equal(secondBody.duplicate, true);
    assert.equal(countProviderEvents(harness.deps.db), 1);
    assert.equal(countJobs(harness.deps.db), 2);
  });
});

test("Twilio delivery status updates the stored SMS job", async () => {
  const harness = await createHarness();
  const booked = await postBookingDirect(harness);
  await harness.processDue();
  const sms = listJobs(harness.deps.db, booked).find((job) => job.channel === "sms");
  assert.equal(sms?.status, "queued");
  assert.ok(sms?.providerMessageId);

  await withServer(harness.app, async (base) => {
    const params = {
      MessageSid: sms?.providerMessageId ?? "",
      MessageStatus: "delivered",
      ErrorCode: "",
      To: "+19999999999",
    };
    const url = `${harness.deps.config.appBaseUrl}/webhooks/twilio/status`;
    const signature = expectedTwilioSignature(
      harness.deps.config.twilioAuthToken,
      url,
      params,
    );
    const response = await fetch(`${base}/webhooks/twilio/status`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: new URLSearchParams(params),
    });
    assert.equal(response.status, 200);
    const again = await fetch(`${base}/webhooks/twilio/status`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: new URLSearchParams(params),
    });
    assert.equal(again.status, 200);
  });

  const updated = listJobs(harness.deps.db, booked).find((job) => job.channel === "sms");
  assert.equal(updated?.status, "delivered");
  assert.equal(countJobs(harness.deps.db), 2);
});

test("a long caller phone value does not reject the booking", async () => {
  const harness = await createHarness();
  await withServer(harness.app, async (base) => {
    const result = await postBooking(base, harness.deps.config.bookingWebhookSecret, {
      ...bookingBody(),
      caller_phone: "{{system__caller_id}}. The server does not text this number.",
      conversation_id: "{{system__conversation_id}}",
      reason: "Initial consultation",
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
  });
});

test("any caller name and date books in demo mode", async () => {
  const harness = await createHarness();
  await withServer(harness.app, async (base) => {
    const result = await postBooking(base, harness.deps.config.bookingWebhookSecret, {
      patient_reference: "Maya Ellis",
      date_of_birth: "1992-04-02",
      appointment_date: "Thursday",
      appointment_time: "9:30 AM",
      physician: "Dr. Patel",
      caller_phone: "+14165550999",
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
  });
  await harness.processDue();
  assert.equal(harness.smsCalls.length, 1);
  assert.equal(harness.smsCalls[0]?.toE164, "+14165550100");
});

test("a live booking still requires a verified patient", async () => {
  const harness = await createHarness({ config: { demoMode: false } });
  await withServer(harness.app, async (base) => {
    const result = await postBooking(base, harness.deps.config.bookingWebhookSecret, {
      patient_reference: "Maya Ellis",
      date_of_birth: "1992-04-02",
      appointment_date: "2026-10-29",
      appointment_time: "09:30",
      physician: "Dr. Shah",
    });
    assert.equal(result.status, 403);
    assert.equal(result.json.error, "patient_not_verified");
  });
});

test("a spoken Wednesday at 2 PM books the demo patient", async () => {
  const harness = await createHarness();
  await withServer(harness.app, async (base) => {
    const result = await postBooking(base, harness.deps.config.bookingWebhookSecret, {
      patient_reference: "Demo-Patient-001",
      date_of_birth: "January 15th, 1980",
      appointment_date: "October 28, 2026",
      appointment_time: "2:00 PM",
      physician: "dr shah",
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.match(String(result.json.appointment_id), /^demo-/);
  });
});

async function postBookingDirect(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<string> {
  let appointmentId = "";
  await withServer(harness.app, async (base) => {
    const result = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      bookingBody(),
    );
    assert.equal(result.status, 200);
    appointmentId = String(result.json.appointment_id);
  });
  return appointmentId;
}
