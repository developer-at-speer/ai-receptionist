import type { AppConfig } from "../config.js";
import { SchedulingError } from "../errors.js";
import { MockSchedulingService } from "./mockSchedulingService.js";
import type {
  ScheduleRequest,
  ScheduleResult,
  SchedulingService,
} from "./schedulingService.js";

export class JunoSchedulingService implements SchedulingService {
  readonly provider = "juno" as const;

  constructor(private readonly config: AppConfig) {}

  async book(_request: ScheduleRequest): Promise<ScheduleResult> {
    const configured = Boolean(
      this.config.junoBaseUrl && this.config.junoApiToken,
    );
    throw new SchedulingError(
      configured ? "juno_adapter_not_implemented" : "juno_not_connected",
      "Juno EMR scheduling is not connected. No appointment was created.",
    );
  }
}

export function createSchedulingService(config: AppConfig): SchedulingService {
  if (config.demoMode) return new MockSchedulingService();
  return new JunoSchedulingService(config);
}
