/**
 * Issue #54 [X06] — the register itself: lookup, approval checks, the review queue and the audit
 * that finds stale or broken entries.
 */
import { compareDates, notFound, type IsoDate } from '@invoice/kernel';
import { LEGAL_AUTHORITIES, type ComplianceSource, type DecisionLogEntry, type ReviewTask, type RuleSourceLink } from './types.ts';
import { SOURCES } from './sources.ts';
import { DECISION_LOG } from './decision-log.ts';
import { RULE_SOURCE_LINKS } from './rule-links.ts';

/** Domains whose documents we accept as published by the authority itself. */
export const OFFICIAL_DOMAINS: readonly string[] = [
  'cbic-gst.gov.in',
  'cbic.gov.in',
  'taxinformation.cbic.gov.in',
  'gst.gov.in',
  'einvoice1.gst.gov.in',
  'indiacode.nic.in',
  'egazette.gov.in',
  'gstcouncil.gov.in',
];

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
};

export const isOfficiallyPublished = (url: string): boolean => {
  const host = hostOf(url);
  return OFFICIAL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
};

export interface ApprovalVerdict {
  readonly approved: boolean;
  readonly reasons: readonly string[];
}

export class ComplianceRegister {
  readonly #sources: Map<string, ComplianceSource>;
  readonly #links: RuleSourceLink[];
  readonly #decisions: DecisionLogEntry[];

  constructor(
    sources: readonly ComplianceSource[] = SOURCES,
    links: readonly RuleSourceLink[] = RULE_SOURCE_LINKS,
    decisions: readonly DecisionLogEntry[] = DECISION_LOG,
  ) {
    this.#sources = new Map(sources.map((s) => [s.id, s]));
    this.#links = [...links];
    this.#decisions = [...decisions];
  }

  source(id: string): ComplianceSource {
    const found = this.#sources.get(id);
    if (found === undefined) {
      throw notFound('REGISTER_SOURCE_NOT_FOUND', `No source is registered under "${id}".`);
    }
    return found;
  }

  has(id: string): boolean {
    return this.#sources.has(id);
  }

  sources(): readonly ComplianceSource[] {
    return [...this.#sources.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  decisions(): readonly DecisionLogEntry[] {
    return this.#decisions;
  }

  linksFor(ruleId: string): readonly RuleSourceLink[] {
    return this.#links.filter((l) => l.ruleId === ruleId);
  }

  /**
   * Whether a compliance rule may be APPROVED.
   *
   * This is the gate the whole issue exists for. Every reason it returns is a sentence a person
   * can act on, not a boolean.
   */
  mayApprove(ruleId: string, ruleVersion: string, on: IsoDate): ApprovalVerdict {
    const reasons: string[] = [];
    const links = this.#links.filter((l) => l.ruleId === ruleId && l.ruleVersion === ruleVersion);
    if (links.length === 0) {
      return { approved: false, reasons: [`${ruleId}@${ruleVersion} is not linked to any source in the register.`] };
    }
    const ids = links.flatMap((l) => l.sourceIds);
    const resolved: ComplianceSource[] = [];
    for (const id of ids) {
      const found = this.#sources.get(id);
      if (found === undefined) {
        reasons.push(`${ruleId}@${ruleVersion} cites "${id}", which is not in the register.`);
        continue;
      }
      resolved.push(found);
    }

    const legal = resolved.filter((s) => LEGAL_AUTHORITIES.includes(s.authority));
    if (legal.length === 0) {
      reasons.push(
        `${ruleId}@${ruleVersion} rests only on commentary or guidance. A rule that states the law needs a statute, rule, notification or order behind it.`,
      );
    }
    for (const s of resolved) {
      if (!isOfficiallyPublished(s.url)) {
        reasons.push(`Source "${s.id}" is not hosted by the authority that issued it, so it cannot be treated as law.`);
      }
      if (s.verification !== 'FIRST_HAND') {
        reasons.push(`Source "${s.id}" was not read first-hand, so it cannot approve a rule.`);
      }
      if (s.reviewedBy === null) {
        reasons.push(`Source "${s.id}" has no reviewer.`);
      }
      if (s.state === 'WITHDRAWN') {
        reasons.push(`Source "${s.id}" has been withdrawn.`);
      }
      if (s.state === 'SUPERSEDED') {
        reasons.push(`Source "${s.id}" has been superseded by "${s.supersededBy ?? 'an unrecorded entry'}".`);
      }
      if (s.state === 'NEEDS_REVIEW') {
        reasons.push(`Source "${s.id}" is flagged as needing review, so it cannot approve a rule until someone looks at it.`);
      }
      if (compareDates(on, s.effectiveFrom) < 0) {
        reasons.push(`Source "${s.id}" does not apply before ${s.effectiveFrom}.`);
      }
      if (s.effectiveTo !== null && compareDates(on, s.effectiveTo) > 0) {
        reasons.push(`Source "${s.id}" stopped applying on ${s.effectiveTo}.`);
      }
    }

    const withTests = links.filter((l) => l.tests.length > 0);
    if (withTests.length === 0) {
      reasons.push(`${ruleId}@${ruleVersion} names no test, so nothing proves it behaves as its source says.`);
    }

    return { approved: reasons.length === 0, reasons };
  }

  /**
   * Everything a person needs to look at, as work rather than as a report.
   *
   * "Changes generate actionable review tasks" is an acceptance criterion of this issue, so a
   * superseded, withdrawn or stale source becomes a task with a severity, not a log line.
   */
  reviewQueue(today: IsoDate): readonly ReviewTask[] {
    const tasks: ReviewTask[] = [];
    for (const s of this.sources()) {
      if (s.state === 'WITHDRAWN') {
        tasks.push({
          kind: 'WITHDRAWN_SOURCE',
          subject: s.id,
          summary: `${s.title} (${s.provision}) has been withdrawn. Every rule citing it must be re-sourced or turned off.`,
          severity: 'BLOCKING',
        });
      }
      if (s.state === 'SUPERSEDED') {
        tasks.push({
          kind: 'SUPERSEDED_SOURCE',
          subject: s.id,
          summary: `${s.title} (${s.provision}) was replaced by ${s.supersededBy ?? 'a source that is not recorded'}. Move the rules across.`,
          severity: 'BLOCKING',
        });
      }
      if (s.state === 'NEEDS_REVIEW') {
        tasks.push({
          kind: 'UNREVIEWED_SOURCE',
          subject: s.id,
          summary: `${s.title} (${s.provision}) is flagged for review: ${s.notes ?? 'no reason recorded'}`,
          severity: 'ACTION_REQUIRED',
        });
      }
      if (compareDates(today, s.reviewDue) > 0 && s.state === 'ACTIVE') {
        tasks.push({
          kind: 'STALE_SOURCE',
          subject: s.id,
          summary: `${s.title} (${s.provision}) was last read on ${s.retrievedOn} and was due for review on ${s.reviewDue}.`,
          severity: 'ACTION_REQUIRED',
        });
      }
      if (!isOfficiallyPublished(s.url)) {
        tasks.push({
          kind: 'BROKEN_LINK',
          subject: s.id,
          summary: `${s.id} points at ${hostOf(s.url) || 'an unreadable address'}, which is not the publisher's own site.`,
          severity: 'BLOCKING',
        });
      }
    }
    for (const link of this.#links) {
      const cited = link.sourceIds.map((id) => this.#sources.get(id)).filter((s): s is ComplianceSource => s !== undefined);
      if (!cited.some((s) => LEGAL_AUTHORITIES.includes(s.authority))) {
        tasks.push({
          kind: 'RULE_WITHOUT_LEGAL_SOURCE',
          subject: `${link.ruleId}@${link.ruleVersion}`,
          summary: `${link.ruleId} cites no statute, rule, notification or order.`,
          severity: 'BLOCKING',
        });
      }
      if (link.tests.length === 0) {
        tasks.push({
          kind: 'RULE_WITHOUT_TESTS',
          subject: `${link.ruleId}@${link.ruleVersion}`,
          summary: `${link.ruleId} names no test that proves it behaves as its source says.`,
          severity: 'ACTION_REQUIRED',
        });
      }
    }
    return tasks;
  }

  /**
   * The trace an auditor asks for: from a decision, to the rule, to the source, to the test.
   */
  trace(ruleId: string, ruleVersion: string): {
    rule: string;
    sources: readonly { id: string; provision: string; authority: string; url: string; quotedText: string }[];
    tests: readonly string[];
    decisions: readonly DecisionLogEntry[];
  } {
    const links = this.#links.filter((l) => l.ruleId === ruleId && l.ruleVersion === ruleVersion);
    const sourceIds = [...new Set(links.flatMap((l) => l.sourceIds))];
    return {
      rule: `${ruleId}@${ruleVersion}`,
      sources: sourceIds
        .map((id) => this.#sources.get(id))
        .filter((s): s is ComplianceSource => s !== undefined)
        .map((s) => ({ id: s.id, provision: s.provision, authority: s.authority, url: s.url, quotedText: s.quotedText })),
      tests: [...new Set(links.flatMap((l) => l.tests))],
      decisions: this.#decisions.filter((d) => d.affectedRules.includes(ruleId)),
    };
  }
}

export const defaultRegister = (): ComplianceRegister => new ComplianceRegister();
