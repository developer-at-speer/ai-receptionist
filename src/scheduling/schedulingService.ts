export type ScheduleRequest = {
  patientReference: string;
  physician: string;
  startsAt: Date;
  timeZone: string;
};

export type ScheduleResult = {
  appointmentId: string;
  provider: "mock" | "juno";
  demo: boolean;
  status: "confirmed";
};

export interface SchedulingService {
  readonly provider: "mock" | "juno";
  book(request: ScheduleRequest): Promise<ScheduleResult>;
}
