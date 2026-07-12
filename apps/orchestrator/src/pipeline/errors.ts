export interface AbortReason {
  type: 'cancel' | 'deadline';
  message: string;
}

export class PipelineAbort extends Error {
  constructor(
    readonly reason: AbortReason,
    options?: ErrorOptions,
  ) {
    super(reason.message, options);
    this.name = 'PipelineAbort';
  }
}

export function abortReasonOf(signal: AbortSignal): AbortReason {
  const reason = signal.reason as AbortReason | undefined;
  if (reason && typeof reason === 'object' && 'type' in reason) return reason;
  return { type: 'cancel', message: 'Abgebrochen' };
}
