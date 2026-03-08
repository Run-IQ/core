export interface Expression {
  readonly dsl: string;
  readonly value: unknown;
}

export interface Rule {
  readonly id: string;
  readonly version: number;
  readonly model: string;
  readonly params: unknown;
  readonly condition?: Expression | undefined;
  readonly priority: number;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
  readonly tags: readonly string[];
  readonly checksum: string;
  readonly schemaVersion?: string | undefined;
  readonly dominanceGroup?: string | undefined;
}
