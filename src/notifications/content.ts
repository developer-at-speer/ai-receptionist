export function renderAdminEmail(input: {
  clinicName: string;
  reference: string;
  date: string;
  time: string;
  physician: string;
  demo: boolean;
}): { subject: string; text: string } {
  const lines = [
    "A new appointment was booked by the AI receptionist.",
    `Booking Reference: ${input.reference}`,
    `Date: ${input.date}`,
    `Time: ${input.time}`,
    `Physician: ${input.physician}`,
    "Booking Status: Confirmed",
  ];
  if (input.demo) {
    lines.push(
      "",
      "Scheduling source: synthetic demo. This is not a Juno EMR appointment.",
    );
  }
  return {
    subject: `New AI Receptionist Appointment — ${input.clinicName}`,
    text: lines.join("\n"),
  };
}

export function renderSms(input: {
  clinicName: string;
  date: string;
  time: string;
  demo: boolean;
}): string {
  const confirmation = `Your appointment at ${input.clinicName} is confirmed for ${input.date} at ${input.time}. If you need to make changes, please contact the clinic.`;
  if (!input.demo) return confirmation;
  return `DEMO, not a Juno appointment. ${confirmation}`;
}
