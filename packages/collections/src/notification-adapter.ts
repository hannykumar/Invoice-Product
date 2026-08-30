import type { ActorContext } from '@invoice/ledger';
import { NotificationService, type Notification, type RequestContext } from '../../platform/src/index.ts';
import type { ReminderDeliveryInput, ReminderDeliveryResult, ReminderNotificationPort } from './ports.ts';

const contextFrom = (actor: ActorContext): RequestContext => ({
  companyId: actor.companyId,
  branchId: actor.branchId ?? 'all',
  actorId: actor.userId,
  sessionId: `collections:${actor.userId}`,
  permissions: new Set(actor.permissions.filter((permission) => permission === 'notification.send' || permission === 'notification.sensitive.send')) as RequestContext['permissions'],
});

export class PlatformReminderNotificationAdapter implements ReminderNotificationPort {
  private readonly notifications: NotificationService;
  private readonly now: () => number;

  constructor(notifications: NotificationService, now: () => number = Date.now) {
    this.notifications = notifications;
    this.now = now;
  }

  async deliver(actor: ActorContext, input: ReminderDeliveryInput): Promise<ReminderDeliveryResult> {
    const context = contextFrom(actor);
    let notification = this.notifications.schedule(context, {
      recipientId: input.recipientId,
      recipientRole: 'customer',
      channel: input.channel,
      template: 'payment_reminder',
      locale: input.locale,
      sensitivity: 'public',
      payload: { subject: input.subject, message: input.message, reminderId: input.reminderId },
      deduplicationKey: input.deduplicationKey,
      scheduledAt: this.now(),
    });
    if (notification.status === 'failed') notification = this.notifications.retry(context, notification.id);
    if (notification.status === 'scheduled') await this.notifications.deliverDue(context);
    const final: Notification = this.notifications.get(context, notification.id);
    return {
      notificationId: final.id,
      status: final.status,
      detail: final.lastError ?? (final.status === 'suppressed' ? 'Customer notification preference or quiet hours suppressed delivery.' : null),
    };
  }
}
