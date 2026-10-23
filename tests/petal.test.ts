import assert from "node:assert/strict";
import test from "node:test";
import type { PetalBookingCard } from "../src/petal/petalClient.js";
import {
  bookingBody,
  createHarness,
  postBooking,
  withServer,
} from "./harness.js";

test("a booking uploads a Petal card without clinical or contact details", async () => {
  const cards: PetalBookingCard[] = [];
  const harness = await createHarness({
    petal: async (card) => {
      cards.push(card);
    },
  });
  await withServer(harness.app, async (base) => {
    const body = bookingBody();
    const result = await postBooking(
      base,
      harness.deps.config.bookingWebhookSecret,
      body,
    );
    assert.equal(result.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cards.length, 1);
    const card = cards[0];
    assert.equal(card.physician, "Dr. Shah");
    assert.equal(card.patient_reference, "demo-patient-001");
    assert.equal(card.clinic_name, "Harbourview Family Practice");
    assert.equal(card.demo, true);
    assert.match(card.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(card.time, /^\d{2}:\d{2}$/);
    const encoded = JSON.stringify(card);
    assert.equal(encoded.includes("1980-01-15"), false);
    assert.equal(encoded.includes("4165550999"), false);
    assert.equal(encoded.includes("chest pain"), false);
    assert.equal("date_of_birth" in card, false);
    assert.equal("caller_phone" in card, false);
    assert.equal("reason" in card, false);
  });
});
