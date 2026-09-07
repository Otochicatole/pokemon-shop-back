export interface AuditModule {
  record(input: { action: string; entityType: string; entityId?: string; actorId?: string; metadata?: unknown }): Promise<void>;
}
