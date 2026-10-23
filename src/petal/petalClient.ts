import type { AppConfig } from "../config.js";
import { logEvent } from "../log.js";

export type PetalBookingCard = {
  appointment_id: string;
  patient_reference: string;
  physician: string;
  date: string;
  time: string;
  timezone: string;
  demo: boolean;
  scheduling_provider: string;
  clinic_name: string;
};

export type PetalPublisher = (card: PetalBookingCard) => Promise<void>;

export async function publishPetalBookingCard(
  config: AppConfig,
  card: PetalBookingCard,
): Promise<void> {
  if (!config.petalApiUrl || !config.petalBookingSecret) {
    logEvent("petal_card_skipped", { code: "not_configured" });
    return;
  }
  const url = `${config.petalApiUrl}/api/integrations/receptionist/bookings`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.petalBookingSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      logEvent("petal_card_failed", { code: `http_${response.status}` });
      return;
    }
    logEvent("petal_card_sent", { code: "ok" });
  } catch {
    logEvent("petal_card_failed", { code: "unreachable" });
  }
}
