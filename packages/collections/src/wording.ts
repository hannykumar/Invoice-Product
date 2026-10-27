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
        'hi-IN': `नमस्ते ${name}, ${shop} से एक याद-दिलाव: बिल ${bill} का ${amount} ${-late} दिन में देना है. अगर आप पहले ही भेज चुके हैं तो इस मैसेज को छोड़ दीजिए.`,
      });
    case 'GENTLE':
      return safeBoth({
        'en-IN': late <= 0
          ? `Hello ${name}, bill ${bill} for ${amount} from ${shop} is due today. Please ignore this if you have already paid.`
          : `Hello ${name}, bill ${bill} for ${amount} from ${shop} became due ${late} days ago. Could you let us know when it will be paid? Please ignore this if you have already paid.`,
        'hi-IN': late <= 0
          ? `नमस्ते ${name}, ${shop} का बिल ${bill} — ${amount} — आज देना है. अगर आप पहले ही भेज चुके हैं तो इस मैसेज को छोड़ दीजिए.`
          : `नमस्ते ${name}, ${shop} का बिल ${bill} — ${amount} — ${late} दिन पहले देना था. कृपया बता दीजिए कब भेज पाएंगे. अगर आप पहले ही भेज चुके हैं तो इस मैसेज को छोड़ दीजिए.`,
      });
    case 'FIRM':
      return safeBoth({
        'en-IN': `Hello ${name}, bill ${bill} for ${amount} from ${shop} is now ${late} days past its due date. Please arrange the payment, or tell us if something about this bill is wrong so we can look at it.`,
        'hi-IN': `नमस्ते ${name}, ${shop} का बिल ${bill} — ${amount} — अब ${late} दिन देर से बाक़ी है. कृपया भुगतान करा दीजिए, या अगर बिल में कोई ग़लती है तो बता दीजिए, हम देख लेंगे.`,
      });
    case 'FINAL':
      return safeBoth({
        'en-IN': `Hello ${name}, this is the last automatic reminder for bill ${bill} for ${amount} from ${shop}, now ${late} days past its due date. Someone from ${shop} will call you next. If the payment is on its way, a quick reply saves that call.`,
        'hi-IN': `नमस्ते ${name}, ${shop} के बिल ${bill} — ${amount} — के लिए यह आख़िरी ऑटोमैटिक मैसेज है; यह ${late} दिन देर से बाक़ी है. अब ${shop} से कोई आपको फ़ोन करेगा. अगर पैसा भेज दिया है तो जवाब दे दीजिए, फ़ोन की ज़रूरत नहीं पड़ेगी.`,
      });
    case 'ESCALATE':
      return safeBoth({
        'en-IN': `${name} owes ${amount} on bill ${bill}, ${late} days past its due date. The automatic reminders have finished, so this one needs you to decide what happens next.`,
        'hi-IN': `${name} से बिल ${bill} का ${amount} लेना बाक़ी है, जो ${late} दिन देर से बाक़ी है. ऑटोमैटिक रिमाइंडर ख़त्म हो चुके हैं — अब आगे क्या करना है, यह आपको तय करना होगा.`,
      });
  }
};

const plural = (days: number): string => (days === 1 ? 'day' : 'days');

export const skipExplanation = (reason: SkipReason, detail: Readonly<Record<string, string>> = {}): Bilingual => {
  switch (reason) {
    case 'SETTLED':
      return { 'en-IN': 'This bill is fully paid, so there is nothing to remind about.', 'hi-IN': 'यह बिल पूरा चुक गया है, इसलिए कोई रिमाइंडर नहीं जाएगा.' };
    case 'NOT_YET_DUE':
      return { 'en-IN': `This bill is not due yet — it is due on ${detail.dueDate ?? 'its due date'}.`, 'hi-IN': `इस बिल का समय अभी नहीं आया — यह ${detail.dueDate ?? 'अपनी तारीख़'} को देना है.` };
    case 'NO_STEP_DUE':
      return { 'en-IN': 'No reminder is due for this bill today.', 'hi-IN': 'आज इस बिल के लिए कोई रिमाइंडर नहीं बनता.' };
    case 'ALREADY_SENT':
      return { 'en-IN': `This reminder was already sent${detail.sentOn ? ` on ${detail.sentOn}` : ''}, so it will not be sent twice.`, 'hi-IN': `यह रिमाइंडर${detail.sentOn ? ` ${detail.sentOn} को` : ''} भेज दिया गया था, दोबारा नहीं जाएगा.` };
    case 'DISPUTED':
      return { 'en-IN': `This bill is under dispute (${detail.reason ?? 'a query was raised'}), so it is not being chased until that is settled.`, 'hi-IN': `इस बिल पर सवाल उठाया गया है (${detail.reason ?? 'एक शिकायत दर्ज है'}), इसलिए जब तक वह हल नहीं होता, रिमाइंडर नहीं जाएगा.` };
    case 'PROMISED':
      return { 'en-IN': `${detail.partyName ?? 'The customer'} promised to pay by ${detail.promisedOn ?? 'an agreed date'}, so no reminder goes out before then.`, 'hi-IN': `${detail.partyName ?? 'ग्राहक'} ने ${detail.promisedOn ?? 'एक तारीख़'} तक देने का वादा किया है, इसलिए उससे पहले रिमाइंडर नहीं जाएगा.` };
    case 'OPTED_OUT':
      return { 'en-IN': `${detail.partyName ?? 'This customer'} asked not to receive reminders.`, 'hi-IN': `${detail.partyName ?? 'इस ग्राहक'} ने रिमाइंडर न भेजने को कहा है.` };
    case 'QUIET_PERIOD':
      return { 'en-IN': 'It is night where the customer is. This will go out in the morning.', 'hi-IN': 'ग्राहक के यहां रात है. यह सुबह भेजा जाएगा.' };
    case 'TOO_SOON':
      return detail.sameRun === 'yes'
        ? { 'en-IN': `${detail.partyName ?? 'This customer'} is already being reminded about another bill today, so this one waits its turn.`, 'hi-IN': `${detail.partyName ?? 'इस ग्राहक'} को आज दूसरे बिल का रिमाइंडर जा रहा है, इसलिए यह अपनी बारी का इंतज़ार करेगा.` }
        : Number(detail.daysAgo ?? 0) === 0
          ? { 'en-IN': 'A reminder already went to this customer today. The next one waits.', 'hi-IN': 'इस ग्राहक को आज ही एक रिमाइंडर जा चुका है. अगला थोड़ा रुक कर जाएगा.' }
          : { 'en-IN': `A reminder went to this customer ${detail.daysAgo} ${plural(Number(detail.daysAgo))} ago. The next one waits.`, 'hi-IN': `इस ग्राहक को ${detail.daysAgo} दिन पहले रिमाइंडर गया था. अगला थोड़ा रुक कर जाएगा.` };
    case 'BELOW_MINIMUM':
      return { 'en-IN': `${detail.outstanding ?? 'This amount'} is below the amount you chase for.`, 'hi-IN': `${detail.outstanding ?? 'यह रकम'} इतनी छोटी है कि आप इसके लिए रिमाइंडर नहीं भेजते.` };
    case 'NO_CHANNEL':
      return { 'en-IN': `There is no way to reach ${detail.partyName ?? 'this customer'} — no phone number or email is saved.`, 'hi-IN': `${detail.partyName ?? 'इस ग्राहक'} तक पहुँचने का कोई ज़रिया नहीं है — न फ़ोन नंबर है न ईमेल.` };
    case 'LADDER_EXHAUSTED':
      return { 'en-IN': 'Every automatic reminder for this bill has been sent. It is with you now.', 'hi-IN': 'इस बिल के सारे ऑटोमैटिक रिमाइंडर जा चुके हैं. अब यह आपके हाथ में है.' };
  }
};

export const dueDateWords = (date: IsoDate | null): string => (date === null ? 'no due date' : formatDate(date));

export const amountWords = (amount: Money): string => formatINR(amount);
