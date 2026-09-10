import type { Prisma, PrismaClient } from '@prisma/client';
import { BASE_CURRENCY } from '../../shared/currency.js';

export const TRANSFER_SETTINGS_ID = 'default';
type TransferSettingsDb = PrismaClient | Prisma.TransactionClient;

export type TransferSettingsRecord = {
  id: string;
  enabled: boolean;
  bankName: string;
  accountHolder: string;
  cbu: string | null;
  alias: string | null;
  version: number;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const emptySettings = (): TransferSettingsRecord => ({
  id: TRANSFER_SETTINGS_ID,
  enabled: false,
  bankName: '',
  accountHolder: '',
  cbu: null,
  alias: null,
  version: 1,
  updatedById: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

export async function getTransferSettings(db: TransferSettingsDb): Promise<TransferSettingsRecord> {
  const settings = await db.transferSettings.findUnique({ where: { id: TRANSFER_SETTINGS_ID } });
  return settings ? { ...settings, cbu: settings.cbu ?? null, alias: settings.alias ?? null } : emptySettings();
}

export function transferSettingsConfigured(settings: Pick<TransferSettingsRecord, 'enabled' | 'bankName' | 'accountHolder' | 'cbu' | 'alias'>) {
  return settings.enabled
    && Boolean(settings.bankName.trim())
    && Boolean(settings.accountHolder.trim())
    && Boolean(settings.cbu?.trim() || settings.alias?.trim());
}

export function mapTransferSettings(settings: TransferSettingsRecord) {
  return {
    enabled: settings.enabled,
    bankName: settings.bankName,
    accountHolder: settings.accountHolder,
    cbu: settings.cbu,
    alias: settings.alias,
    version: settings.version,
    updatedAt: settings.updatedAt,
    currency: BASE_CURRENCY,
  };
}

export function mapTransferInstructions(settings: Pick<TransferSettingsRecord, 'bankName' | 'accountHolder' | 'cbu' | 'alias'>) {
  return {
    bankName: settings.bankName,
    accountHolder: settings.accountHolder,
    cbu: settings.cbu,
    alias: settings.alias,
  };
}
