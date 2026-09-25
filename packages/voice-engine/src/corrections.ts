/**
 * WHAT CHANGED BETWEEN A DRAFT AND THE MESSAGE THE PERSON SENT.
 *
 * Not how much (that is the edit ratio) but what kind of change: shorter or
 * longer, a different greeting, a different sign-off, the pleasantries at the
 * top dropped. Each finding is a plain signal the inference can count across
 * drafts, and a summary of forms and numbers. Neither carries the text.
 * Deterministic, no model.
 */

export type TextCorrection = {
  signals: string[];
  summary: {
    words_proposed: number;
    words_actual: number;
    greeting_proposed: string | null;
    greeting_actual: string | null;
    signoff_proposed: string | null;
    signoff_actual: string | null;
    opener_dropped: boolean;
  };
};

const GREETING =
  /^(hi|hello|hey|dear|good (?:morning|afternoon|evening))\b\s*([^,:\n-]*)\s*[,:-]?\s*$/i;
const CLOSING =
  /^(best|best regards|kind regards|warm regards|regards|thanks|thank you|many thanks|cheers|talk soon|all the best|speak soon|sincerely)[,.!]?$/i;
const PLEASANTRY =
  /\b(hope (you(?:'re| are)|this (?:finds|email finds)|all is)|trust (?:you|this)|how are you)/i;

const lines = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** "Hi Sarah," → "Hi {name},". The form, without the person. */
export function greetingOf(text: string): string | null {
  const first = lines(text)[0];
  if (!first) return null;
  const m = GREETING.exec(first);
  if (!m) return null;
  const word = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  return m[2]?.trim() ? `${word} {name},` : `${word},`;
}

/** "Best,\nAlex" → "Best, Alex". The last one to three lines, when they close. */
export function signoffOf(text: string): string | null {
  const ls = lines(text);
  for (let i = ls.length - 1; i >= Math.max(0, ls.length - 3); i -= 1) {
    const l = ls[i]!;
    if (CLOSING.test(l)) {
      const name = ls[i + 1];
      const word = l.replace(/[,.!]$/, "");
      return name && !CLOSING.test(name) && wordCount(name) <= 3 ? `${word}, ${name}` : word;
    }
  }
  return null;
}

function hasOpener(text: string): boolean {
  const ls = lines(text);
  const body = (greetingOf(text) ? ls.slice(1) : ls).slice(0, 2).join(" ");
  return PLEASANTRY.test(body);
}

export function compareText(proposed: string, actual: string): TextCorrection {
  const signals: string[] = [];
  const wp = wordCount(proposed);
  const wa = wordCount(actual);
  if (wp > 0 && wa <= wp * 0.67) signals.push("shorter");
  if (wp > 0 && wa >= wp * 1.5) signals.push("longer");
  const gp = greetingOf(proposed);
  const ga = greetingOf(actual);
  if (gp !== ga) signals.push(`greeting:${ga ?? "none"}`);
  const sp = signoffOf(proposed);
  const sa = signoffOf(actual);
  if (sp !== sa) signals.push(`signoff:${sa ?? "none"}`);
  const openerDropped = hasOpener(proposed) && !hasOpener(actual);
  if (openerDropped) signals.push("no_opener");
  return {
    signals,
    summary: {
      words_proposed: wp,
      words_actual: wa,
      greeting_proposed: gp,
      greeting_actual: ga,
      signoff_proposed: sp,
      signoff_actual: sa,
      opener_dropped: openerDropped,
    },
  };
}
