const fillers = new Set(['um', 'uh', 'hmm', 'mm', 'mmm', 'эм', 'мм', 'хм']);
function words(text: string) {
  return (text.normalize('NFKC').toLocaleLowerCase()
    .replace(/\[[^\]]*\]|<[^>]*>/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu) ?? [])
    .filter(word => !fillers.has(word));
}
export function meaningfulSpeech(text: string, echo = '') {
  const tokens = words(text);
  if (!tokens.length) return false;
  // A complete run of Mia's own words is echo, not a new command. Single-word
  // interruptions remain possible; the native AEC is the primary echo guard.
  const own = words(echo).join(' ');
  if (tokens.length >= 3 && (` ${own} `).includes(` ${tokens.join(' ')} `)) return false;
  return true;
}

export class WordBargeInGate {
  private turns = new Map<number, { firstWord?: string; stableAt: number; confirmed: boolean; echo: string }>();
  start(id: number, echo = '') { this.turns.set(id, { stableAt: 0, confirmed: false, echo }); }
  observe(id: number, text: string, final: boolean, now: number) {
    const turn = this.turns.get(id);
    if (!turn || turn.confirmed) return false;
    if (!meaningfulSpeech(text, turn.echo)) { turn.firstWord = undefined; turn.stableAt = 0; return false; }
    const firstWord = words(text)[0];
    if (turn.firstWord !== firstWord) { turn.firstWord = firstWord; turn.stableAt = now; }
    if (!final && now - turn.stableAt < 180) return false;
    turn.confirmed = true;
    return true;
  }
  meaningful(id: number, text: string) { return meaningfulSpeech(text, this.turns.get(id)?.echo); }
  finish(id: number) { this.turns.delete(id); }
  clear() { this.turns.clear(); }
}
