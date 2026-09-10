export { createSupportRouters, getSupportUnreadCount } from './support.js';
export {
  attachSupportWebSocketServer,
  MAX_SUPPORT_SOCKETS_PER_ACTOR,
  SUPPORT_SESSION_REVOKED_CLOSE_CODE,
  SUPPORT_SOCKET_LIMIT_CLOSE_CODE,
  SupportRealtimeHub,
} from './support-realtime.js';
export type { SupportRealtimeActor, SupportRealtimeEvent } from './support-realtime.js';
export {
  supportActorTypeSchema,
  supportStatusSchema,
  createUserSupportConversationSchema,
  createAdminSupportConversationSchema,
  createSupportMessageSchema,
  markSupportReadSchema,
  updateSupportStatusSchema,
} from './support-schemas.js';
