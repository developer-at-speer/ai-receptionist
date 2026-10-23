type LogValue = string | number | boolean | null;

export function logEvent(
  event: string,
  fields: Record<string, LogValue> = {},
): void {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      ...fields,
    }),
  );
}
