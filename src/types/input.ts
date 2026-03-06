export interface EvaluationInput {
  readonly data: Record<string, unknown>;
  readonly requestId: string;
  readonly meta: {
    readonly tenantId: string;
    readonly userId?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly context?: Record<string, unknown> | undefined;
    readonly effectiveDate?: Date | undefined;
  };
}
