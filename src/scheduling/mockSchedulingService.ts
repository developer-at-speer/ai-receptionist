import { randomUUID } from "node:crypto";
import type {
  ScheduleRequest,
  ScheduleResult,
  SchedulingService,
} from "./schedulingService.js";

export class MockSchedulingService implements SchedulingService {
  readonly provider = "mock" as const;

  async book(request: ScheduleRequest): Promise<ScheduleResult> {
    if (!request.patientReference || Number.isNaN(request.startsAt.getTime())) {
      throw new Error("invalid schedule request");
    }
    return {
      appointmentId: `demo-${randomUUID()}`,
      provider: "mock",
      demo: true,
      status: "confirmed",
    };
  }
}
