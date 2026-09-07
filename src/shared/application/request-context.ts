export interface RequestContext {
  requestId: string;
  userId?: string;
  adminId?: string;
  ip?: string;
  userAgent?: string;
}
