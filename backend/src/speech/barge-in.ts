const fillers = new Set(['um', 'uh', 'hmm', 'mm', 'mmm', 'эм', 'мм', 'хм']);
function words(text: string) {
  return (text.normalize('NFKC').toLocaleLowerCase()
    .replace(/\[[^\]]*\]|<[^>]*>/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu) ?? [])
    .filter(word => !fillers.has(word));
}
export function meaningfulSpeech(text: string) {
  const tokens = words(text);
  if (!tokens.length) return false;
  return true;
}

export class WordBargeInGate {
  private turns = new Map<number, { firstWord?: string; text: string; stableAt: number; confirmed: boolean; audioRequired: boolean; audioSeen: boolean }>();
  start(id: number, audioRequired = false, audible = false) { this.turns.set(id, { text: '', stableAt: 0, confirmed: false, audioRequired, audioSeen: audible }); }
  observe(id: number, text: string, final: boolean, now: number, audible = true) {
    const turn = this.turns.get(id);
    if (!turn || turn.confirmed) return false;
    turn.audioSeen ||= audible;
    if (!meaningfulSpeech(text) || turn.audioRequired && !turn.audioSeen) { turn.firstWord = undefined; turn.text = ''; turn.stableAt = 0; return false; }
    const firstWord = words(text)[0];
    if (turn.firstWord !== firstWord) { turn.firstWord = firstWord; turn.stableAt = now; }
    turn.text = text;
    if (!final && now - turn.stableAt < 180) return false;
    turn.confirmed = true;
    return true;
  }
  due(id: number) {
    const turn = this.turns.get(id);
    return turn?.firstWord && !turn.confirmed ? turn.stableAt + 180 : undefined;
  }
  confirmStable(id: number, now: number) {
    const text = this.turns.get(id)?.text;
    return text ? this.observe(id, text, false, now, false) : false;
  }
  meaningful(id: number, text: string) {
    const turn = this.turns.get(id);
    return meaningfulSpeech(text) && (!turn?.audioRequired || turn.confirmed);
  }
  finish(id: number) { this.turns.delete(id); }
  clear() { this.turns.clear(); }
}
