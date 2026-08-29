/**
 * Issue #36 [E36] — the progress checklist, and a screen you can look at.
 *
 * The checklist is the whole interface for someone who is going to do this in six sittings. It has
 * to answer three questions at a glance: what is done, what is left, and what is stopping me.
 */
import { formatINR } from '@invoice/kernel';
import { escapeHtml } from '@invoice/invoice-templates';
import { checkOpeningBalances } from './opening-balances.ts';
import { STEP_ORDER, type OnboardingSession, type StepId, type StepState } from './model.ts';

export type Locale = 'en-IN' | 'hi-IN';

const STEP_TEXT: Record<StepId, { title: Record<Locale, string>; why: Record<Locale, string> }> = {
  business: {
    title: { 'en-IN': 'About your business', 'hi-IN': 'Aapke business ke baare mein' },
    why: { 'en-IN': 'The name and place that go on every bill.', 'hi-IN': 'Naam aur jagah, jo har bill par aate hain.' },
  },
  tax_profile: {
    title: { 'en-IN': 'GST details', 'hi-IN': 'GST ki jaankari' },
    why: { 'en-IN': 'Whether you are registered, and from when we keep your books.', 'hi-IN': 'Aap registered hain ya nahin, aur kab se hisaab rakhein.' },
  },
  branding: {
    title: { 'en-IN': 'How your bill looks', 'hi-IN': 'Aapka bill kaisa dikhe' },
    why: { 'en-IN': 'Pick a design and add your logo. You can change this later.', 'hi-IN': 'Design chunein aur logo lagayein. Baad mein badal sakte hain.' },
  },
  items: {
    title: { 'en-IN': 'What you sell', 'hi-IN': 'Aap kya bechte hain' },
    why: { 'en-IN': 'Add a few things to start with. More can be added any time.', 'hi-IN': 'Shuruaat ke liye kuch cheezein jodein. Aur kabhi bhi jod sakte hain.' },
  },
  rates: {
    title: { 'en-IN': 'The GST you charge', 'hi-IN': 'Aap jo GST lagate hain' },
    why: {
      'en-IN': 'Tell us the rates you charge today. We record them as yours, and we do not claim to have checked them.',
      'hi-IN': 'Aaj aap jo rate lagate hain woh batayein. Hum unhe aapke rate ki tarah rakhenge, jaanchne ka daawa nahin karenge.',
    },
  },
  opening_balances: {
    title: { 'en-IN': 'What you already had', 'hi-IN': 'Jo pehle se tha' },
    why: { 'en-IN': 'Cash, bank, who owes you and whom you owe, on the day you start here.', 'hi-IN': 'Nakad, bank, kisse lena aur kisko dena — shuru karne ke din.' },
  },
  ready: {
    title: { 'en-IN': 'Ready to bill', 'hi-IN': 'Bill banane ke liye taiyaar' },
    why: { 'en-IN': 'Everything is in place. Make your first bill.', 'hi-IN': 'Sab taiyaar hai. Apna pehla bill banayein.' },
  },
};

const STATE_TEXT: Record<StepState, Record<Locale, string>> = {
  NOT_STARTED: { 'en-IN': 'Not started', 'hi-IN': 'Shuru nahin hua' },
  IN_PROGRESS: { 'en-IN': 'In progress', 'hi-IN': 'Chal raha hai' },
  NEEDS_ATTENTION: { 'en-IN': 'Needs your attention', 'hi-IN': 'Aapke dhyaan ki zaroorat' },
  DONE: { 'en-IN': 'Done', 'hi-IN': 'Ho gaya' },
  SKIPPED: { 'en-IN': 'Skipped for now', 'hi-IN': 'Abhi ke liye chhoda' },
};

export interface ChecklistItem {
  readonly step: StepId;
  readonly title: string;
  readonly why: string;
  readonly state: StepState;
  readonly stateLabel: string;
  readonly problems: readonly string[];
}

export interface ChecklistView {
  readonly items: readonly ChecklistItem[];
  readonly doneCount: number;
  readonly totalCount: number;
  /** One sentence for the top of the screen. */
  readonly summary: string;
  /** The step to take them to when they tap "continue". */
  readonly nextStep: StepId | null;
  readonly canFinish: boolean;
}

export const checklistFor = (session: OnboardingSession, locale: Locale): ChecklistView => {
  const items: ChecklistItem[] = STEP_ORDER.map((step) => {
    const status = session.steps[step];
    return {
      step,
      title: STEP_TEXT[step].title[locale],
      why: STEP_TEXT[step].why[locale],
      state: status.state,
      stateLabel: STATE_TEXT[status.state][locale],
      problems: status.problems.map((p) => p.message[locale]),
    };
  });

  const needed = items.filter((i) => i.step !== 'ready');
  const doneCount = needed.filter((i) => i.state === 'DONE' || i.state === 'SKIPPED').length;
  const nextStep = needed.find((i) => i.state !== 'DONE' && i.state !== 'SKIPPED')?.step ?? null;
  const canFinish = nextStep === null && session.state === 'IN_PROGRESS';

  const summary =
    session.state === 'COMPLETED'
      ? locale === 'hi-IN'
        ? 'Setup poora ho gaya. Ab bill bana sakte hain.'
        : 'Setup is finished. You can start billing.'
      : locale === 'hi-IN'
        ? `${doneCount} of ${needed.length} ho gaya.`
        : `${doneCount} of ${needed.length} done.`;

  return { items, doneCount, totalCount: needed.length, summary, nextStep, canFinish };
};

/**
 * A standalone screen, so the checklist can be looked at before it is built into the app.
 *
 * Issue #38 owns the real interface; this exists so the wording, the states and the ordering can
 * be reviewed by a person now rather than described in a document.
 */
export const renderChecklist = (session: OnboardingSession, locale: Locale): string => {
  const view = checklistFor(session, locale);
  const opening = checkOpeningBalances(session.answers.openingBalances);
  const business = session.answers.business.tradeName ?? session.answers.business.legalName ?? '—';

  const rows = view.items
    .map((item) => {
      const tone =
        item.state === 'DONE' ? 'done' : item.state === 'NEEDS_ATTENTION' ? 'attention' : item.state === 'SKIPPED' ? 'skipped' : 'todo';
      const mark = item.state === 'DONE' ? '✓' : item.state === 'SKIPPED' ? '–' : item.state === 'NEEDS_ATTENTION' ? '!' : '';
      return `<li class="step ${tone}">
        <span class="mark" aria-hidden="true">${mark}</span>
        <div>
          <div class="step-title">${escapeHtml(item.title)}</div>
          <div class="step-why">${escapeHtml(item.why)}</div>
          ${item.problems.length === 0 ? '' : `<ul class="problems">${item.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`}
        </div>
        <span class="state">${escapeHtml(item.stateLabel)}</span>
      </li>`;
    })
    .join('');

  const openingPanel =
    session.answers.openingBalances.length === 0
      ? ''
      : `<section class="panel">
          <h2>${escapeHtml(locale === 'hi-IN' ? 'Jo pehle se tha' : 'What you already had')}</h2>
          <table>
            ${session.answers.openingBalances
              .map(
                (e) =>
                  `<tr><td>${escapeHtml(e.label)}</td><td class="num">${escapeHtml(e.debit.minor === 0n ? '' : formatINR(e.debit))}</td><td class="num">${escapeHtml(e.credit.minor === 0n ? '' : formatINR(e.credit))}</td></tr>`,
              )
              .join('')}
            <tr class="total"><td>${escapeHtml(locale === 'hi-IN' ? 'Kul' : 'Total')}</td><td class="num">${escapeHtml(formatINR(opening.totalDebit))}</td><td class="num">${escapeHtml(formatINR(opening.totalCredit))}</td></tr>
          </table>
          ${
            opening.balanced
              ? `<p class="ok">${escapeHtml(locale === 'hi-IN' ? 'Dono taraf barabar hain.' : 'Both sides match.')}</p>`
              : `<p class="warn">${escapeHtml(opening.problems.find((p) => p.code === 'OPENING_UNBALANCED')?.message[locale] ?? '')}</p>`
          }
        </section>`;

  const ratesPanel =
    session.answers.rates.length === 0
      ? ''
      : `<section class="panel">
          <h2>${escapeHtml(locale === 'hi-IN' ? 'Aap jo GST lagate hain' : 'The GST you charge')}</h2>
          <table>
            ${session.answers.rates
              .map(
                (r) =>
                  `<tr><td>${escapeHtml(r.code)}</td><td class="num">${Number(r.ratePercentTimes100) / 100}%</td><td>${escapeHtml(r.basis)}</td></tr>`,
              )
              .join('')}
          </table>
          <p class="warn">${escapeHtml(
            locale === 'hi-IN'
              ? 'Yeh rate aapke bataye hue hain. Humne inhe sarkari notification se nahin jaancha.'
              : 'These are the rates you told us. We have not checked them against a government notification.',
          )}</p>
        </section>`;

  const percent = view.totalCount === 0 ? 0 : Math.round((view.doneCount / view.totalCount) * 100);

  return `<!doctype html>
<html lang="${locale === 'hi-IN' ? 'hi' : 'en'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(locale === 'hi-IN' ? 'Setup' : 'Setting up')} — ${escapeHtml(business)}</title>
<style>
  :root { color-scheme: light; --ink:#12211c; --muted:#5b6b65; --line:#d8e0dc; --accent:#1f4e40; --warn:#8a5a00; --warnbg:#fff8e5; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f4f6f5; color:var(--ink);
    font-family:'Noto Sans Devanagari','Nirmala UI',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; line-height:1.45; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 18px; }
  .bar { height: 8px; background: var(--line); border-radius: 999px; overflow: hidden; margin-bottom: 6px; }
  .bar span { display:block; height:100%; background: var(--accent); width: ${percent}%; }
  .count { color: var(--muted); font-size: .9rem; margin-bottom: 20px; }
  ul.steps { list-style:none; margin:0 0 20px; padding:0; }
  li.step { display:grid; grid-template-columns: 28px 1fr auto; gap:10px; align-items:start;
    background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:8px; }
  li.step.done { border-color:#bcd8cc; }
  li.step.attention { border-color:#e6c58a; background:var(--warnbg); }
  .mark { width:24px; height:24px; border-radius:999px; display:flex; align-items:center; justify-content:center;
    background:var(--line); color:#fff; font-weight:700; }
  li.done .mark { background: var(--accent); }
  li.attention .mark { background: var(--warn); }
  .step-title { font-weight:650; }
  .step-why { color: var(--muted); font-size:.92rem; }
  .state { color: var(--muted); font-size:.85rem; white-space:nowrap; }
  ul.problems { margin:8px 0 0; padding-left:18px; color:var(--warn); font-size:.92rem; }
  .panel { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:12px; }
  .panel h2 { font-size:1rem; margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; font-size:.94rem; }
  td { padding:4px 0; border-bottom:1px dotted var(--line); }
  .num { text-align:right; font-variant-numeric: tabular-nums; }
  tr.total td { font-weight:700; border-top:2px solid var(--accent); border-bottom:none; }
  .ok { color: var(--accent); margin:8px 0 0; }
  .warn { color: var(--warn); background: var(--warnbg); padding:8px; border-radius:6px; margin:8px 0 0; font-size:.92rem; }
  .cta { display:inline-block; background:var(--accent); color:#fff; padding:12px 20px; border-radius:8px;
    font-weight:650; text-decoration:none; margin-top:8px; }
  @media (max-width: 420px) { .state { display:none; } }
</style></head>
<body><div class="wrap">
  <h1>${escapeHtml(locale === 'hi-IN' ? 'Setup' : 'Setting up')} ${escapeHtml(business)}</h1>
  <p class="sub">${escapeHtml(
    session.state === 'COMPLETED'
      ? locale === 'hi-IN'
        ? 'Sab taiyaar hai.'
        : 'Everything is in place.'
      : locale === 'hi-IN'
        ? 'Jahan chhoda tha wahin se shuru karein. Har jawab turant save hota hai.'
        : 'Pick up where you left off. Every answer is saved as you give it.',
  )}</p>
  <div class="bar"><span></span></div>
  <div class="count">${escapeHtml(view.summary)}</div>
  <ul class="steps">${rows}</ul>
  ${ratesPanel}
  ${openingPanel}
  ${
    view.canFinish
      ? `<a class="cta" href="#">${escapeHtml(locale === 'hi-IN' ? 'Setup poora karein' : 'Finish setting up')}</a>`
      : view.nextStep === null
        ? ''
        : `<a class="cta" href="#">${escapeHtml(locale === 'hi-IN' ? 'Aage badhein' : 'Continue')} — ${escapeHtml(STEP_TEXT[view.nextStep].title[locale])}</a>`
  }
</div></body></html>`;
};
