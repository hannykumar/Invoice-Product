/**
 * Issue #23 [E23] — a real desk to chase money from.
 *
 * The receivables service, the ledger underneath it and GPT 2's notification service are all the
 * real thing here. Only two things are stood in for: the sales module that would supply the open
 * invoices (receivables' own `FakeDocuments`, which exists for exactly this and is replaced by the
 * real `SalesService` in the web app), and the message provider, which is a recording adapter so
 * a test can make delivery fail on purpose.
 */
import { asId, isoDate, rupees, type CompanyId, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { ABC, ALL_PERMISSIONS, COMPANY, FakeDocuments, bill, makeDesk } from '../../receivables/test/fixtures.ts';
import {
  ChannelNotificationTransport,
  InAppNotificationAdapter,
  NotificationService,
  NotificationTemplateRegistry,
  type Notification,
  type NotificationTransport,
  type Permission,
  type RequestContext,
} from '../../platform/src/index.ts';
import {
  CollectionsService,
  InMemoryReminderRepository,
  notificationReminderTransport,
  receivablesPositions,
  registerReminderTemplates,
  type PartyContactPort,
  type ReminderPolicy,
} from '../src/index.ts';
import { DEFAULT_REMINDER_POLICY } from '../src/policy.ts';

export const COLLECTIONS_PERMISSION_LIST = [
  'collections.reminders.view',
  'collections.reminders.send',
  'collections.promise.record',
  'collections.dispute.manage',
] as const;

export const EVERY_PERMISSION = [...ALL_PERMISSIONS, ...COLLECTIONS_PERMISSION_LIST];

/** A provider that remembers what it was asked to send, and can be told to fail. */
export class RecordingAdapter implements NotificationTransport {
  readonly sent: Notification[] = [];
  failNext = false;
  async send(notification: Notification): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('The provider is unavailable.');
    }
    this.sent.push(notification);
  }
}

export interface Desk {
  readonly actor: ActorContext;
  readonly collections: CollectionsService;
  readonly receivables: Awaited<ReturnType<typeof makeDesk>>['service'];
  readonly documents: FakeDocuments;
  readonly notifications: NotificationService;
  readonly provider: RecordingAdapter;
  readonly repository: InMemoryReminderRepository;
  readonly audit: Awaited<ReturnType<typeof makeDesk>>['audit'];
  readonly contextFor: (actor: ActorContext) => RequestContext;
  setNow(iso: string): void;
}

export const CUSTOMER_CONTACT = 'abc-traders@example.invalid';
export const OWNER_CONTACT = 'owner@sampoorna.example.invalid';

const contacts = (channelsByParty: ReadonlyMap<string, readonly ('in_app' | 'email' | 'whatsapp' | 'sms')[]>): PartyContactPort => ({
  async contact(_companyId: CompanyId, partyId: PartyId) {
    const channels = channelsByParty.get(partyId);
    return channels === undefined ? null : { recipientId: CUSTOMER_CONTACT, channels };
  },
  async owner() {
    return { recipientId: OWNER_CONTACT, channels: ['in_app', 'email'] as const };
  },
});

export const makeCollectionsDesk = async (options: {
  now?: string;
  policy?: ReminderPolicy;
  channels?: ReadonlyMap<string, readonly ('in_app' | 'email' | 'whatsapp' | 'sms')[]>;
  companyId?: CompanyId;
} = {}): Promise<Desk> => {
  const companyId = options.companyId ?? COMPANY;
  const desk = await makeDesk(companyId);
  let current = new Date(options.now ?? '2026-08-29T10:00:00.000Z');
  const clock = { now: () => current };

  const provider = new RecordingAdapter();
  const templates = new NotificationTemplateRegistry();
  registerReminderTemplates(templates);
  const transport = new ChannelNotificationTransport({
    in_app: new InAppNotificationAdapter(),
    email: provider,
    whatsapp: provider,
    sms: provider,
  });
  const notifications = new NotificationService(transport, () => current.getTime(), { maxPerWindow: 50, windowMs: 60_000 });

  const contextFor = (actor: ActorContext): RequestContext => ({
    companyId: actor.companyId,
    branchId: actor.branchId ?? 'branch',
    actorId: actor.userId,
    permissions: new Set<Permission>(['notification.send', 'notification.sensitive.send']),
    sessionId: 'test-session',
  });

  const repository = new InMemoryReminderRepository();
  const channels = options.channels ?? new Map([[ABC as string, ['whatsapp', 'email', 'in_app'] as const]]);
  const collections = new CollectionsService({
    businessName: 'Sampoorna Traders',
    receivables: receivablesPositions(desk.service, desk.documents),
    contacts: contacts(channels),
    transport: notificationReminderTransport(notifications, contextFor, () => current.getTime()),
    repository,
    permissions: permissionPortFromActor,
    audit: desk.audit,
    clock,
    policies: [options.policy ?? DEFAULT_REMINDER_POLICY],
    idFactory: (() => {
      let n = 0;
      return () => `col-${String((n += 1)).padStart(4, '0')}`;
    })(),
  });

  return {
    actor: { companyId, branchId: asId<'Branch'>('kb'), userId: asId<'User'>('rec-priya'), permissions: EVERY_PERMISSION },
    collections,
    receivables: desk.service,
    documents: desk.documents,
    notifications,
    provider,
    repository,
    audit: desk.audit,
    contextFor,
    setNow(iso: string) {
      current = new Date(iso);
    },
  };
};

export const on = (date: string): IsoDate => isoDate(date);
export const inr = (whole: number, paise = 0): Money => rupees(whole, paise);
export { ABC, bill };
