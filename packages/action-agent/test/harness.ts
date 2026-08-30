/**
 * Issue #47 [E47] — a real business for the agent to act on.
 *
 * Everything under the agent is the real module: #35's own golden business (stock bought in, bills
 * issued through `SalesService`, money taken through `ReceivablesService`), #23's collections
 * service over that receivables position, #34's assistant over that report service, and GPT 2's
 * `PlatformCommandService` for the lifecycle, approval policy and audit. The message provider is
 * the only stand-in, and it is here so a test can make a send fail and time out on purpose.
 */
import { asId, isoDate, type CompanyId, type IsoDate } from '@invoice/kernel';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { ComplianceRegister } from '@invoice/compliance-register';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import {
  CollectionsService,
  InMemoryReminderRepository,
  notificationReminderTransport,
  receivablesPositions,
  registerReminderTemplates,
  type PartyContactPort,
} from '@invoice/collections';
import { AssistantService } from '../../assistant/src/service.ts';
import {
  AuditLog,
  ChannelNotificationTransport,
  InAppNotificationAdapter,
  NotificationService,
  NotificationTemplateRegistry,
  PlatformCommandService,
  type Notification,
  type NotificationTransport,
  type Permission,
  type RequestContext,
} from '../../platform/src/index.ts';
import { ABC, GURUGRAM, PARTY_NAMES, aBusyMonth, ALL_PERMISSIONS } from '../../reports/test/fixtures.ts';
import {
  ActionAgentService,
  InMemoryAgentPlanStore,
  ToolRegistry,
  cancelInvoiceTool,
  findUnpaidTool,
  sendReminderTool,
  stopRemindingTool,
} from '../src/index.ts';
import type { PartyDirectoryPort } from '../src/ports.ts';

export const AGENT_PERMISSION_LIST = [
  'agent.plan',
  'agent.approve',
  'agent.execute',
  'collections.reminders.view',
  'collections.reminders.send',
  'collections.promise.record',
  'collections.dispute.manage',
  'assistant.ask',
] as const;

export const EVERY_PERMISSION = [...ALL_PERMISSIONS, ...AGENT_PERMISSION_LIST];

/** The day the tests act on. Bill A is 22 days late by then and bill B is 17. */
export const TODAY: IsoDate = isoDate('2026-06-01');

export class ScriptedProvider implements NotificationTransport {
  readonly sent: Notification[] = [];
  failNext = false;
  /** Set to make the next send hang, so the deadline can be proved rather than described. */
  hangNext = false;

  async send(notification: Notification): Promise<void> {
    if (this.hangNext) {
      this.hangNext = false;
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error('The provider is unavailable.');
    }
    this.sent.push(notification);
  }
}

export const makeAgentDesk = async (options: { permissions?: readonly string[]; deadlineMs?: number } = {}) => {
  const business = await aBusyMonth();
  const actor: ActorContext = {
    ...business.actor,
    permissions: options.permissions ?? EVERY_PERMISSION,
  };

  const provider = new ScriptedProvider();
  const templates = new NotificationTemplateRegistry();
  registerReminderTemplates(templates);
  const notifications = new NotificationService(
    new ChannelNotificationTransport({ in_app: new InAppNotificationAdapter(), email: provider, whatsapp: provider, sms: provider }),
    () => Date.parse('2026-06-01T10:00:00.000Z'),
    { maxPerWindow: 100, windowMs: 60_000 },
  );
  const contextFor = (from: ActorContext): RequestContext => ({
    companyId: from.companyId,
    branchId: from.branchId ?? 'kb',
    actorId: from.userId,
    permissions: new Set<Permission>(['notification.send', 'approval.decide']),
    sessionId: 'agent-test',
  });
  const contacts: PartyContactPort = {
    async contact(_companyId, partyId) {
      const name = PARTY_NAMES[partyId];
      return name === undefined ? null : { recipientId: `${partyId}@example.invalid`, channels: ['whatsapp', 'email', 'in_app'] };
    },
    async owner() {
      return { recipientId: 'owner@example.invalid', channels: ['in_app', 'email'] };
    },
  };
  const collections = new CollectionsService({
    businessName: 'Sharma Trading Company',
    receivables: receivablesPositions(business.receivables, business.documents),
    contacts,
    transport: notificationReminderTransport(notifications, contextFor, () => Date.parse('2026-06-01T10:00:00.000Z')),
    repository: new InMemoryReminderRepository(),
    permissions: permissionPortFromActor,
    audit: business.audit,
    clock: { now: () => new Date('2026-06-01T10:00:00.000Z') },
  });

  const assistant = new AssistantService({
    reports: business.reports,
    permissions: permissionPortFromActor,
    audit: business.audit,
    clock: { now: () => new Date('2026-06-01T10:00:00.000Z') },
    rules: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
    register: new ComplianceRegister(),
  });

  const registry = new ToolRegistry()
    .register(findUnpaidTool(collections))
    .register(sendReminderTool(collections))
    .register(stopRemindingTool(collections))
    .register(cancelInvoiceTool());

  const parties: PartyDirectoryPort = {
    async resolve(_actor, text) {
      const needle = text.trim().toLowerCase();
      return Object.entries(PARTY_NAMES)
        .filter(([, name]) => name.toLowerCase().includes(needle) || needle.includes(name.toLowerCase()))
        .map(([partyId, name]) => ({ partyId, name }));
    },
    async nameOf(_actor, partyId) {
      return PARTY_NAMES[partyId] ?? partyId;
    },
  };

  const audit = new AuditLog();
  const commands = new PlatformCommandService(audit, [
    // Anything the agent does that changes something needs a person who may approve it.
    { action: 'agent.run', minimumRisk: 'medium', requiredPermission: 'approval.decide' },
  ]);

  const agent = new ActionAgentService({
    registry,
    commands,
    contextFor,
    parties,
    store: new InMemoryAgentPlanStore(),
    permissions: permissionPortFromActor,
    clock: { now: () => new Date('2026-06-01T10:00:00.000Z') },
    ...(options.deadlineMs === undefined ? {} : { toolDeadlineMs: options.deadlineMs }),
    idFactory: (() => {
      let n = 0;
      return () => `plan-${String((n += 1)).padStart(3, '0')}`;
    })(),
  });

  return { business, actor, agent, registry, collections, assistant, commands, audit, provider, parties, contextFor };
};

export { ABC, GURUGRAM, PARTY_NAMES };
export const OTHER_COMPANY: CompanyId = asId<'Company'>('reports-other');
