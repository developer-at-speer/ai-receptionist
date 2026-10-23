import type { Express } from "express";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { encryptString } from "../src/crypto/recipientCipher.js";
import { migrate, openDatabase } from "../src/db/database.js";
import type { EmailSender, OutboundEmail } from "../src/notifications/emailService.js";
import type { OutboundSms, SmsSender } from "../src/notifications/smsService.js";
import { processDueNotifications } from "../src/notifications/worker.js";
import { savePatient } from "../src/patients/patientRepository.js";
import { MockSchedulingService } from "../src/scheduling/mockSchedulingService.js";
import type { SchedulingService } from "../src/scheduling/schedulingService.js";
import type { PetalPublisher } from "../src/petal/petalClient.js";
import { formatParts } from "../src/time.js";

export const TEST_KEY = Buffer.alloc(32, 7);

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    nodeEnv: "test",
    appBaseUrl: "https://receptionist.example",
    databaseUrl: ":memory:",
    demoMode: true,
    bookingWebhookSecret: "test-booking-secret",
    elevenlabsWebhookSecret: "test-elevenlabs-secret",
    resendApiKey: "",
    emailFrom: "receptionist@example.com",
    adminEmail: "mathew@speer.io",
    twilioAccountSid: `AC${"1".repeat(32)}`,
    twilioAuthToken: "test-twilio-auth-token",
    twilioPhoneNumber: "+14165550000",
    twilioMessagingServiceSid: "",
    recipientDataKey: TEST_KEY,
    demoPatientReference: "demo-patient-001",
    demoPatientDob: "1980-01-15",
    demoAuthorizedSmsE164: "+14165550100",
    allowLiveSends: false,
    physicianName: "Dr. Shah",
    clinicName: "Dr. Shah's Family Practice",
    timeZone: "America/Toronto",
    notificationMaxAttempts: 5,
    workerIntervalMs: 60_000,
    junoBaseUrl: "",
    junoApiToken: "",
    petalApiUrl: "",
    petalBookingSecret: "",
    petalClinicName: "Harbourview Family Practice",
    ...overrides,
  };
}

export function futureSlot(daysAhead = 40, time = "14:30"): {
  date: string;
  time: string;
} {
  const future = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const parts = formatParts(future, "America/Toronto");
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time };
}

export async function createHarness(options?: {
  scheduler?: SchedulingService;
  email?: EmailSender;
  sms?: SmsSender;
  authorizeSms?: boolean;
  config?: Partial<AppConfig>;
  petal?: PetalPublisher;
}): Promise<{
  app: Express;
  deps: AppDeps;
  emailCalls: OutboundEmail[];
  smsCalls: OutboundSms[];
  authorizedPhone: string;
  processDue: () => Promise<number>;
}> {
  const db = await openDatabase(":memory:");
  migrate(db);
  const config = testConfig(options?.config);
  const authorizedPhone = "+14165550100";
  const authorizeSms = options?.authorizeSms !== false;
  savePatient(db, {
    reference: "demo-patient-001",
    dateOfBirth: "1980-01-15",
    smsAuthorized: authorizeSms,
    smsCiphertext: authorizeSms
      ? encryptString(config.recipientDataKey, authorizedPhone)
      : null,
    createdAt: "2026-10-23T12:00:00.000Z",
  });
  savePatient(db, {
    reference: "demo-patient-002",
    dateOfBirth: "1990-02-02",
    smsAuthorized: false,
    smsCiphertext: null,
    createdAt: "2026-10-23T12:00:00.000Z",
  });

  const emailCalls: OutboundEmail[] = [];
  const smsCalls: OutboundSms[] = [];
  const email: EmailSender = options?.email ?? {
    async send(message) {
      emailCalls.push(message);
      return { providerMessageId: "email_1", initialStatus: "sent" };
    },
  };
  const sms: SmsSender = options?.sms ?? {
    async send(message) {
      smsCalls.push(message);
      return {
        providerMessageId: `SM${"a".repeat(32)}`,
        initialStatus: "queued",
      };
    },
  };
  const deps: AppDeps = {
    config,
    db,
    scheduler: options?.scheduler ?? new MockSchedulingService(),
    email,
    sms,
    sendsEnabled: true,
    now: () => new Date(),
    leaseMs: 120_000,
    autoDispatch: false,
    petal: options?.petal,
  };
  return {
    app: createApp(deps),
    deps,
    emailCalls,
    smsCalls,
    authorizedPhone,
    processDue: () => processDueNotifications(deps),
  };
}

export async function withServer(
  app: Express,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export function bookingBody(
  slot = futureSlot(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    patient_reference: "demo-patient-001",
    date_of_birth: "1980-01-15",
    appointment_date: slot.date,
    appointment_time: slot.time,
    physician: "Dr. Shah",
    conversation_id: "conv-1",
    caller_phone: "+14165550999",
    reason: "chest pain",
    ...overrides,
  };
}

export async function postBooking(
  base: string,
  secret: string,
  body: Record<string, unknown>,
  authorization = `Bearer ${secret}`,
  path = "/webhooks/elevenlabs/book-appointment",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}
