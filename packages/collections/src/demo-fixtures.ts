/**
 * Issue #23 [E23] — a small business with five customers, built from the real services.
 *
 * The ledger, the receivables service and GPT 2's notification service are the real ones. Only the
 * open invoices are supplied directly (the sales module supplies them in the running app) and the
 * message provider is a recorder, so the demo can make a send fail on purpose.
 */
import {
  asId,
  isoDate,
  rupees,
  type CompanyId,
  type IsoDate,
  type Money,
  type PartyId,
} from '@invoice/kernel';
import {
  buildDefaultChart,
  defaultChartIdFactory,
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  permissionPortFromActor,
  type Account,
  type ActorContext,
} from '@invoice/ledger';
import {
  InMemoryPaymentRepository,
  ReceivablesService,
  type DocumentLedgerPort,
  type OpenDocument,
} from '@invoice/receivables';
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
import { notificationReminderTransport, receivablesPositions, registerReminderTemplates } from './adapters.ts';
import { InMemoryReminderRepository } from './repository.ts';
import { CollectionsService } from './service.ts';
import type { PartyContactPort, ReminderChannel } from './index.ts';

export const DEMO_COMPANY: CompanyId = asId<'Company'>('demo-collections');

export interface DemoCustomer {
  readonly partyId: PartyId;
  readonly name: string;
  readonly code: string;
  readonly channels: readonly ReminderChannel[];
}

export const CUSTOMERS: readonly DemoCustomer[] = [
  { partyId: asId<'Party'>('abc'), name: 'ABC Traders', code: '1201', channels: ['whatsapp', 'email'] },
  { partyId: asId<'Party'>('mapusa'), name: 'Mapusa Family Stores', code: '1202', channels: ['sms', 'whatsapp'] },
  { partyId: asId<'Party'>('deccan'), name: 'Deccan Hardware', code: '1203', channels: ['whatsapp'] },
  { partyId: asId<'Party'>('konkan'), name: 'Konkan Bakers', code: '1204', channels: ['whatsapp', 'sms'] },
  { partyId: asId<'Party'>('sunrise'), name: 'Sunrise Distributors', code: '1205', channels: ['email'] },
];

class DemoDocuments implements DocumentLedgerPort {
  #documents: OpenDocument[] = [];
  set(documents: readonly OpenDocument[]): void {
    this.#documents = [...documents];
  }
  async openDocuments(_companyId: CompanyId, partyId: PartyId): Promise<readonly OpenDocument[]> {
    return this.#documents.filter((d) => d.partyId === partyId);
  }
  async parties(): Promise<readonly PartyId[]> {
    return CUSTOMERS.map((c) => c.partyId);
  }
  async nameOf(_companyId: CompanyId, partyId: PartyId): Promise<string> {
    return CUSTOMERS.find((c) => c.partyId === partyId)?.name ?? String(partyId);
  }
}

class RecordingProvider implements NotificationTransport {
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

const customerAccount = (companyId: CompanyId, customer: DemoCustomer): Account => ({
  id: asId<'Account'>(`${companyId}:acc:${customer.code}`),
  companyId,
  code: customer.code,
  name: customer.name,
  type: 'ASSET',
  parentId: asId<'Account'>(`${companyId}:acc:1200`),
  isGroup: false,
  active: true,
  partyId: customer.partyId,
  systemRole: null,
});

export const invoice = (number: string, partyId: PartyId, value: Money, date: string, due: string): OpenDocument => ({
  documentId: number,
  kind: 'SALES_INVOICE',
  number,
  partyId,
  date: isoDate(date),
  dueDate: isoDate(due),
  value,
  side: 'RECEIVABLE',
});

export const makeDemoDesk = async (startingAt = '2026-08-29T10:00:00.000Z') => {
  let current = new Date(startingAt);
  const store = new InMemoryLedgerStore();
  const repository = new InMemoryPaymentRepository();
  store.join(repository);
  const audit = new InMemoryAuditPort();
  const clock = { now: () => current };
  const actor: ActorContext = {
    companyId: DEMO_COMPANY,
    branchId: asId<'Branch'>('demo-branch'),
    userId: asId<'User'>('demo-priya'),
    permissions: [
      'ledger.setup', 'ledger.post.receipt', 'ledger.post.payment', 'ledger.post.journal', 'ledger.reverse',
      'payments.record', 'payments.allocate',
      'collections.reminders.view', 'collections.reminders.send',
      'collections.promise.record', 'collections.dispute.manage',
    ],
  };

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
  await ledger.initialiseCompany(actor, {
    booksStartDate: isoDate('2026-04-01'),
    accounts: [
      ...buildDefaultChart(DEMO_COMPANY, defaultChartIdFactory(DEMO_COMPANY)),
      {
        id: asId<'Account'>(`${DEMO_COMPANY}:acc:1121`), companyId: DEMO_COMPANY, code: '1121',
        name: 'HDFC Current Account', type: 'ASSET', parentId: asId<'Account'>(`${DEMO_COMPANY}:acc:1120`),
        isGroup: false, active: true, partyId: null, systemRole: null,
      },
      ...CUSTOMERS.map((customer) => customerAccount(DEMO_COMPANY, customer)),
    ],
  });

  const documents = new DemoDocuments();
  const receivables = new ReceivablesService({
    store, ledger, repository, documents, permissions: permissionPortFromActor, audit, clock,
  });

  const provider = new RecordingProvider();
  const templates = new NotificationTemplateRegistry();
  registerReminderTemplates(templates);
  const notifications = new NotificationService(
    new ChannelNotificationTransport({
      in_app: new InAppNotificationAdapter(), email: provider, whatsapp: provider, sms: provider,
    }),
    () => current.getTime(),
    { maxPerWindow: 100, windowMs: 60_000 },
  );
  const contextFor = (from: ActorContext): RequestContext => ({
    companyId: from.companyId,
    branchId: from.branchId ?? 'demo-branch',
    actorId: from.userId,
    permissions: new Set<Permission>(['notification.send', 'notification.sensitive.send']),
    sessionId: 'demo-session',
  });

  const contacts: PartyContactPort = {
    async contact(_companyId, partyId) {
      const customer = CUSTOMERS.find((c) => c.partyId === partyId);
      return customer === undefined ? null : { recipientId: `${customer.code}@example.invalid`, channels: customer.channels };
    },
    async owner() {
      return { recipientId: 'owner@example.invalid', channels: ['in_app', 'email'] };
    },
  };

  const collections = new CollectionsService({
    businessName: 'Sampoorna Traders',
    receivables: receivablesPositions(receivables, documents),
    contacts,
    transport: notificationReminderTransport(notifications, contextFor, () => current.getTime()),
    repository: new InMemoryReminderRepository(),
    permissions: permissionPortFromActor,
    audit,
    clock,
  });

  return {
    actor, collections, receivables, documents, provider, notifications, audit,
    setNow(iso: string) { current = new Date(iso); },
  };
};

export const rupee = (whole: number): Money => rupees(whole);
export const day = (date: string): IsoDate => isoDate(date);
