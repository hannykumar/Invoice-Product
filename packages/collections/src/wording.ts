/**
 * Issue #23 [E23] — what the customer actually reads.
 *
 * A reminder goes to somebody the business wants to keep trading with, and it is written by a
 * machine that has no idea why the money is late. So the wording states a fact — this bill, this
 * amount, this many days — and asks. It never says the customer is dishonest, defaulting,
 * blacklisted or a risk, and `safeReminder()` throws if one of those words ever reaches it. A
 * defamation-safe tone that depends on everybody remembering to be polite is not safe.
 */
import { formatINR, formatDate, type IsoDate, type Money } from '@invoice/kernel';
import type { Bilingual, BalanceSnapshot, ReminderLevel, SkipReason } from './model.ts';

/** Words that assert something about the person rather than the bill. */
const ACCUSATIONS =
  /\b(fraud|fraudulent|cheat|cheater|dishonest|defaulter|defaulting|blacklist|blacklisted|liar|thief|steal|stolen|criminal|scam|absconding|chor|beimaan)\b/i;

/** Threats the business is not in a position to make from an automated message. */
const THREATS = /\b(legal action|court|police|recovery agent|seize|confiscat|arrest|sue|prosecut)/i;

export const safeReminder = (text: string): string => {
  if (ACCUSATIONS.test(text)) {
    throw new Error(`A reminder may state what is owed, never what the customer is: "${text}"`);
  }
  if (THREATS.test(text)) {
    throw new Error(`A reminder may not threaten a consequence the product cannot carry out: "${text}"`);
  }
  return text;
};

const safeBoth = (message: Bilingual): Bilingual => {
  safeReminder(message['en-IN']);
  safeReminder(message['hi-IN']);
  return message;
};

export interface ReminderWordingInput {
  readonly businessName: string;
  readonly partyName: string;
  readonly level: ReminderLevel;
  readonly snapshot: BalanceSnapshot;
}

/**
 * The message, by rung.
 *
 * Only the tone moves between rungs. The facts — bill number, amount, due date, days late — are
 * the same in all of them, because they are the only things we actually know.
 */
export const reminderMessage = (input: ReminderWordingInput): Bilingual => {
  const amount = formatINR(input.snapshot.outstanding);
  const bill = input.snapshot.documentNumber;
  const late = input.snapshot.daysOverdue;
  const shop = input.businessName;
  const name = input.partyName;

  switch (input.level) {
    case 'ADVANCE':
      return safeBoth({
        'en-IN': `Hello ${name}, a friendly note from ${shop}: bill ${bill} for ${amount} is due in ${-late} day${late === -1 ? '' : 's'}. Please ignore this if you have already paid.`,
        'hi-IN': `Namaste ${name}, ${shop} se ek yaad-dilava: bill ${bill} ka ${amount} ${-late} din mein dena hai. Agar aap pehle hi bhej chuke hain to is message ko chhod dein.`,
      });
    case 'GENTLE':
      return safeBoth({
        'en-IN': late <= 0
          ? `Hello ${name}, bill ${bill} for ${amount} from ${shop} is due today. Please ignore this if you have already paid.`
          : `Hello ${name}, bill ${bill} for ${amount} from ${shop} became due ${late} days ago. Could you let us know when it will be paid? Please ignore this if you have already paid.`,
        'hi-IN': late <= 0
          ? `Namaste ${name}, ${shop} ka bill ${bill} — ${amount} — aaj dena hai. Agar aap pehle hi bhej chuke hain to is message ko chhod dein.`
          : `Namaste ${name}, ${shop} ka bill ${bill} — ${amount} — ${late} din pehle dena tha. Kripya bata dein kab bhej payenge. Agar aap pehle hi bhej chuke hain to is message ko chhod dein.`,
      });
    case 'FIRM':
      return safeBoth({
        'en-IN': `Hello ${name}, bill ${bill} for ${amount} from ${shop} is now ${late} days past its due date. Please arrange the payment, or tell us if something about this bill is wrong so we can look at it.`,
        'hi-IN': `Namaste ${name}, ${shop} ka bill ${bill} — ${amount} — ab ${late} din late hai. Kripya bhugtan kara dein, ya agar bill mein koi galti hai to bata dein, hum dekh lenge.`,
      });
    case 'FINAL':
      return safeBoth({
        'en-IN': `Hello ${name}, this is the last automatic reminder for bill ${bill} for ${amount} from ${shop}, now ${late} days past its due date. Someone from ${shop} will call you next. If the payment is on its way, a quick reply saves that call.`,
        'hi-IN': `Namaste ${name}, ${shop} ke bill ${bill} — ${amount} — ke liye yeh aakhri automatic message hai; yeh ${late} din late hai. Ab ${shop} se koi aapko phone karega. Agar paisa bhej diya hai to jawab de dein, phone ki zaroorat nahi padegi.`,
      });
    case 'ESCALATE':
      return safeBoth({
        'en-IN': `${name} owes ${amount} on bill ${bill}, ${late} days past its due date. The automatic reminders have finished, so this one needs you to decide what happens next.`,
        'hi-IN': `${name} se bill ${bill} ka ${amount} lena baaki hai, jo ${late} din late hai. Automatic reminder khatam ho chuke hain — ab aage kya karna hai, yeh aapko tay karna hoga.`,
      });
  }
};

const plural = (days: number): string => (days === 1 ? 'day' : 'days');

export const skipExplanation = (reason: SkipReason, detail: Readonly<Record<string, string>> = {}): Bilingual => {
  switch (reason) {
    case 'SETTLED':
      return { 'en-IN': 'This bill is fully paid, so there is nothing to remind about.', 'hi-IN': 'Yeh bill pura chuk gaya hai, isliye koi reminder nahi jayega.' };
    case 'NOT_YET_DUE':
      return { 'en-IN': `This bill is not due yet — it is due on ${detail.dueDate ?? 'its due date'}.`, 'hi-IN': `Is bill ka samay abhi nahi aaya — yeh ${detail.dueDate ?? 'apni tarikh'} ko dena hai.` };
    case 'NO_STEP_DUE':
      return { 'en-IN': 'No reminder is due for this bill today.', 'hi-IN': 'Aaj is bill ke liye koi reminder nahi banta.' };
    case 'ALREADY_SENT':
      return { 'en-IN': `This reminder was already sent${detail.sentOn ? ` on ${detail.sentOn}` : ''}, so it will not be sent twice.`, 'hi-IN': `Yeh reminder${detail.sentOn ? ` ${detail.sentOn} ko` : ''} bhej diya gaya tha, dobara nahi jayega.` };
    case 'DISPUTED':
      return { 'en-IN': `This bill is under dispute (${detail.reason ?? 'a query was raised'}), so it is not being chased until that is settled.`, 'hi-IN': `Is bill par sawaal uthaya gaya hai (${detail.reason ?? 'ek shikayat darj hai'}), isliye jab tak woh hal nahi hota, reminder nahi jayega.` };
    case 'PROMISED':
      return { 'en-IN': `${detail.partyName ?? 'The customer'} promised to pay by ${detail.promisedOn ?? 'an agreed date'}, so no reminder goes out before then.`, 'hi-IN': `${detail.partyName ?? 'Grahak'} ne ${detail.promisedOn ?? 'ek tarikh'} tak dene ka vaada kiya hai, isliye us se pehle reminder nahi jayega.` };
    case 'OPTED_OUT':
      return { 'en-IN': `${detail.partyName ?? 'This customer'} asked not to receive reminders.`, 'hi-IN': `${detail.partyName ?? 'Is grahak'} ne reminder na bhejne ko kaha hai.` };
    case 'QUIET_PERIOD':
      return { 'en-IN': 'It is night where the customer is. This will go out in the morning.', 'hi-IN': 'Grahak ke yahan raat hai. Yeh subah bheja jayega.' };
    case 'TOO_SOON':
      return detail.sameRun === 'yes'
        ? { 'en-IN': `${detail.partyName ?? 'This customer'} is already being reminded about another bill today, so this one waits its turn.`, 'hi-IN': `${detail.partyName ?? 'Is grahak'} ko aaj doosre bill ka reminder ja raha hai, isliye yeh apni baari ka intezar karega.` }
        : Number(detail.daysAgo ?? 0) === 0
          ? { 'en-IN': 'A reminder already went to this customer today. The next one waits.', 'hi-IN': 'Is grahak ko aaj hi ek reminder ja chuka hai. Agla thoda ruk kar jayega.' }
          : { 'en-IN': `A reminder went to this customer ${detail.daysAgo} ${plural(Number(detail.daysAgo))} ago. The next one waits.`, 'hi-IN': `Is grahak ko ${detail.daysAgo} din pehle reminder gaya tha. Agla thoda ruk kar jayega.` };
    case 'BELOW_MINIMUM':
      return { 'en-IN': `${detail.outstanding ?? 'This amount'} is below the amount you chase for.`, 'hi-IN': `${detail.outstanding ?? 'Yeh rakam'} itni choti hai ki aap iske liye reminder nahi bhejte.` };
    case 'NO_CHANNEL':
      return { 'en-IN': `There is no way to reach ${detail.partyName ?? 'this customer'} — no phone number or email is saved.`, 'hi-IN': `${detail.partyName ?? 'Is grahak'} tak pahunchne ka koi zariya nahi hai — na phone number hai na email.` };
    case 'LADDER_EXHAUSTED':
      return { 'en-IN': 'Every automatic reminder for this bill has been sent. It is with you now.', 'hi-IN': 'Is bill ke saare automatic reminder ja chuke hain. Ab yeh aapke haath mein hai.' };
  }
};

export const dueDateWords = (date: IsoDate | null): string => (date === null ? 'no due date' : formatDate(date));

export const amountWords = (amount: Money): string => formatINR(amount);
