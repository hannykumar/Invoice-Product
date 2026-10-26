/**
 * Issue #350 — a call to a service that costs money: it counts against the company's daily allowance
 * and Karobar's daily spending cap for that service. At 80% of either, the log says so once (the
 * moment the count reaches it); past 100% the call is refused until the next day.
 */
import { companyQuota, globalCap, PAID_SERVICES, type PaidService, type RateLimiter } from '../../../packages/platform/src/rate-limits.ts';
import { log } from './log.ts';

const warnAt = (max: number) => Math.ceil(max * 0.8);

export const spend = async (limits: RateLimiter, service: PaidService, companyId: string | null): Promise<void> => {
  // The company's own allowance first: a business that has used its share is refused there, and its
  // refused calls never count towards Karobar's cap, so one business cannot switch a service off for all.
  if (companyId !== null) {
    const quota = companyQuota(service);
    const used = await limits.take(quota, companyId);
    if (used === warnAt(quota.max)) log.warn('A company has used 80% of its daily allowance for a paid service', { service, company_id: companyId, used, allowance: quota.max });
  }
  const cap = globalCap(service);
  const total = await limits.take(cap, 'all');
  if (total === warnAt(cap.max)) log.warn('A paid service has used 80% of its daily spending cap', { service, used: total, cap: cap.max });
};

/** The usage view (#350): each paid service, what this business used today and its allowance. */
export const usageToday = async (limits: RateLimiter, companyId: string) =>
  Promise.all(PAID_SERVICES.map(async (service) => {
    const quota = companyQuota(service);
    return { service, usedToday: await limits.used(quota, companyId), allowancePerDay: quota.max };
  }));
