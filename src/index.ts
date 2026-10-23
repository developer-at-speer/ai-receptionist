import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate, openDatabase } from "./db/database.js";
import { encryptString } from "./crypto/recipientCipher.js";
import { logEvent } from "./log.js";
import { createResendEmailSender } from "./notifications/emailService.js";
import { createTwilioSmsSender } from "./notifications/smsService.js";
import { processDueNotifications } from "./notifications/worker.js";
import { publishPetalBookingCard } from "./petal/petalClient.js";
import { savePatient } from "./patients/patientRepository.js";
import { createSchedulingService } from "./scheduling/junoSchedulingService.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await openDatabase(config.databaseUrl);
  migrate(db);
  if (config.demoMode && config.demoPatientReference && config.demoPatientDob) {
    savePatient(db, {
      reference: config.demoPatientReference,
      dateOfBirth: config.demoPatientDob,
      smsAuthorized: Boolean(config.demoAuthorizedSmsE164),
      smsCiphertext: config.demoAuthorizedSmsE164
        ? encryptString(config.recipientDataKey, config.demoAuthorizedSmsE164)
        : null,
      createdAt: new Date().toISOString(),
    });
    logEvent("demo_patient_ready", {
      smsAuthorized: Boolean(config.demoAuthorizedSmsE164),
    });
  }

  const deps = {
    config,
    db,
    scheduler: createSchedulingService(config),
    email: createResendEmailSender(config),
    sms: createTwilioSmsSender(config),
    sendsEnabled: config.allowLiveSends,
    now: () => new Date(),
    leaseMs: 120_000,
    petal: (card) => publishPetalBookingCard(config, card),
  };
  const app = createApp(deps);
  app.listen(config.port, () => {
    logEvent("server_started", {
      port: config.port,
      demoMode: config.demoMode,
      schedulingProvider: deps.scheduler.provider,
      liveSends: config.allowLiveSends,
    });
  });
  setInterval(() => {
    void processDueNotifications(deps).catch(() => {
      logEvent("notification_worker_failed", { code: "worker_error" });
    });
  }, config.workerIntervalMs);
  void processDueNotifications(deps);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "startup_failed";
    console.error(JSON.stringify({ level: "error", event: "startup_failed", message }));
    process.exit(1);
  });
}
