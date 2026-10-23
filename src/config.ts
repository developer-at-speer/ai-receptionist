import { toE164 } from "./phone.js";

export type AppConfig = {
  port: number;
  nodeEnv: string;
  appBaseUrl: string;
  databaseUrl: string;
  demoMode: boolean;
  bookingWebhookSecret: string;
  elevenlabsWebhookSecret: string;
  resendApiKey: string;
  emailFrom: string;
  adminEmail: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  twilioMessagingServiceSid: string;
  recipientDataKey: Buffer;
  demoPatientReference: string;
  demoPatientDob: string;
  demoAuthorizedSmsE164: string;
  allowLiveSends: boolean;
  physicianName: string;
  clinicName: string;
  timeZone: string;
  notificationMaxAttempts: number;
  workerIntervalMs: number;
  junoBaseUrl: string;
  junoApiToken: string;
  petalApiUrl: string;
  petalBookingSecret: string;
  petalClinicName: string;
};

function requiredSecret(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length < 16) {
    throw new Error(`${name} must be set to at least 16 characters.`);
  }
  return trimmed;
}

function optionalSecret(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.length < 16) {
    throw new Error(`${name} must be at least 16 characters.`);
  }
  return trimmed;
}

function readHttpOrigin(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials.`);
  }
  return url.origin;
}

function readKey(value: string | undefined): Buffer {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error("RECIPIENT_DATA_KEY is required.");
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error("RECIPIENT_DATA_KEY must decode to 32 bytes.");
  }
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowLiveSends = env.ALLOW_LIVE_SENDS === "true";
  const config: AppConfig = {
    port: Number(env.PORT || 3000),
    nodeEnv: env.NODE_ENV || "development",
    appBaseUrl: (env.APP_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, ""),
    databaseUrl: env.DATABASE_URL || "file:./data/receptionist.db",
    demoMode: env.DEMO_MODE !== "false",
    bookingWebhookSecret: requiredSecret(
      "BOOKING_WEBHOOK_SECRET",
      env.BOOKING_WEBHOOK_SECRET,
    ),
    elevenlabsWebhookSecret: requiredSecret(
      "ELEVENLABS_WEBHOOK_SECRET",
      env.ELEVENLABS_WEBHOOK_SECRET,
    ),
    resendApiKey: env.RESEND_API_KEY?.trim() ?? "",
    emailFrom: env.EMAIL_FROM?.trim() ?? "",
    adminEmail: env.ADMIN_EMAIL?.trim() || "mathew@speer.io",
    twilioAccountSid: env.TWILIO_ACCOUNT_SID?.trim() ?? "",
    twilioAuthToken: env.TWILIO_AUTH_TOKEN?.trim() ?? "",
    twilioPhoneNumber: "",
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? "",
    recipientDataKey: readKey(env.RECIPIENT_DATA_KEY),
    demoPatientReference: env.DEMO_PATIENT_REFERENCE?.trim() || "demo-patient-001",
    demoPatientDob: env.DEMO_PATIENT_DOB?.trim() || "1980-01-15",
    demoAuthorizedSmsE164: "",
    allowLiveSends,
    physicianName: env.PHYSICIAN_NAME?.trim() || "Dr. Shah",
    clinicName: env.CLINIC_NAME?.trim() || "Dr. Shah's Family Practice",
    timeZone: env.CLINIC_TIMEZONE?.trim() || "America/Toronto",
    notificationMaxAttempts: Number(env.NOTIFICATION_MAX_ATTEMPTS || 5),
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS || 5000),
    junoBaseUrl: env.JUNO_BASE_URL?.trim() ?? "",
    junoApiToken: env.JUNO_API_TOKEN?.trim() ?? "",
    petalApiUrl: readHttpOrigin("PETAL_API_URL", env.PETAL_API_URL),
    petalBookingSecret: optionalSecret(
      "PETAL_BOOKING_SECRET",
      env.PETAL_BOOKING_SECRET,
    ),
    petalClinicName: (env.PETAL_CLINIC_NAME?.trim() || env.CLINIC_NAME?.trim() || "Dr. Shah's Family Practice").slice(0, 120),
  };

  const configuredSender = env.TWILIO_PHONE_NUMBER?.trim() || "+12622394630";
  const sender = toE164(configuredSender);
  if (!sender) {
    throw new Error("TWILIO_PHONE_NUMBER must be a valid telephone number.");
  }
  config.twilioPhoneNumber = sender;

  if (env.DEMO_AUTHORIZED_SMS_E164?.trim()) {
    const normalized = toE164(env.DEMO_AUTHORIZED_SMS_E164);
    if (!normalized) {
      throw new Error("DEMO_AUTHORIZED_SMS_E164 must be a valid telephone number.");
    }
    config.demoAuthorizedSmsE164 = normalized;
  }

  if (!Number.isInteger(config.port) || config.port < 1) {
    throw new Error("PORT must be a positive integer.");
  }

  if (allowLiveSends) {
    const missing: string[] = [];
    if (!config.resendApiKey) missing.push("RESEND_API_KEY");
    if (!config.emailFrom) missing.push("EMAIL_FROM");
    if (!config.twilioAccountSid) missing.push("TWILIO_ACCOUNT_SID");
    if (!config.twilioAuthToken) missing.push("TWILIO_AUTH_TOKEN");
    if (!config.twilioPhoneNumber) missing.push("TWILIO_PHONE_NUMBER");
    if (missing.length > 0) {
      throw new Error(
        `ALLOW_LIVE_SENDS=true requires ${missing.join(", ")}.`,
      );
    }
  }

  return config;
}
