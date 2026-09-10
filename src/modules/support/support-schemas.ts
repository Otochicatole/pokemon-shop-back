import { z } from 'zod';

export const supportStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
export const supportActorTypeSchema = z.enum(['USER', 'ADMIN']);

export const supportConversationParamsSchema = z.object({
  id: z.string().uuid(),
});

export const supportConversationListSchema = z.object({
  status: supportStatusSchema.optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const supportMessageListSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createUserSupportConversationSchema = z.object({
  subject: z.string().trim().min(3).max(120),
  message: z.string().trim().min(1).max(4_000),
  clientMessageId: z.string().uuid().optional(),
});

export const createAdminSupportConversationSchema = createUserSupportConversationSchema.extend({
  userId: z.string().uuid(),
});

export const createSupportMessageSchema = z.object({
  content: z.string().trim().min(1).max(4_000),
  clientMessageId: z.string().uuid().optional(),
});

export const markSupportReadSchema = z.object({
  messageId: z.string().uuid().optional(),
}).default({});

export const updateSupportStatusSchema = z.object({
  status: supportStatusSchema,
});

export type SupportStatus = z.infer<typeof supportStatusSchema>;
export type SupportActorType = z.infer<typeof supportActorTypeSchema>;

