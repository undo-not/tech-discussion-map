export type ConsentRecord = {
  version: 1;
  confirmed: true;
  confirmedAt: string;
  scope: 'all-participants';
};

export function createConsentRecord(now = new Date()): ConsentRecord {
  return { version: 1, confirmed: true, confirmedAt: now.toISOString(), scope: 'all-participants' };
}

export function isConsentRecord(value: unknown): value is ConsentRecord {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && item.confirmed === true && item.scope === 'all-participants' &&
    typeof item.confirmedAt === 'string' && Number.isFinite(Date.parse(item.confirmedAt));
}
