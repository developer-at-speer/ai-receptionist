export class BookingError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number) {
    super(code);
    this.name = "BookingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class SchedulingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SchedulingError";
    this.code = code;
  }
}

export class DeliveryError extends Error {
  readonly code: string;
  readonly permanent: boolean;

  constructor(code: string, permanent: boolean) {
    super(code);
    this.name = "DeliveryError";
    this.code = code;
    this.permanent = permanent;
  }
}

export function asDeliveryError(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  return new DeliveryError("delivery_failed", false);
}

export function isUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE");
}
