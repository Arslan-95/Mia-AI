const fillers = new Set(['um', 'uh', 'hmm', 'mm', 'mmm', 'эм', 'мм', 'хм']);
const echoTailMs = 1500;
type Token = { word: string; at: number };
function tokens(text: string) {
  const source = text.normalize('NFKC').replace(/\[[^\]]*\]|<[^>]*>/g, match => ' '.repeat(match.length));
  const list: Token[] = [...source.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu)]
    .map(match => ({ word: match[0].toLocaleLowerCase().replace(/ё/g, 'е').replace(/’/g, "'"), at: match.index }))
    .filter(token => !fillers.has(token.word));
  return { source, list };
}
export function meaningfulSpeech(text: string) {
  return tokens(text).list.length > 0;
}

function distance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}
const digits = /\p{N}/u;
// Number words, as recognition writes the digits Mia reads out.
const numberWord = /^(zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thir|fif|twent|fort|eight|nint|hundred|thousand|first|second|third|o'clock|нол|нул|один|одн|два|две|двух|двад|двен|три|тре|четыр|сорок|пят|шест|сем|восем|девя|десят|сто|двест|трист|тысяч|полтор)/;
// Recognition of Mia's own echo is accurate but not exact, and a cumulative
// partial may still end in a truncated word. A digit in her text matches only
// a number word, never different digits the person said.
function similar(heard: string, spoken: string | undefined, partial: boolean) {
  if (spoken === undefined) return false;
  if (digits.test(spoken) && !digits.test(heard)) return numberWord.test(heard);
  if (heard === spoken || partial && heard.length >= 3 && spoken.startsWith(heard)) return true;
  const shorter = Math.min(heard.length, spoken.length);
  const allowed = shorter >= 7 ? 2 : shorter >= 4 ? 1 : 0;
  return allowed > 0 && heard[0] === spoken[0] && Math.abs(heard.length - spoken.length) <= allowed && distance(heard, spoken) <= allowed;
}
// Residual echo after iOS AEC is recognised as runs of Mia's words in her
// order. Recognition may skip a word, merge two ("на завтра" → "назавтра"),
// split one, or spell a number as several words. A run is echo only if it is
// at least three words, or two with a long word: an isolated repeated word
// (an answer naming an option Mia offered) or a common short pair ("я не")
// remains the person's.
function echoRun(list: Token[], words: string[], i: number, j: number, final: boolean) {
  const partial = (index: number) => !final && index === list.length - 1;
  const heard = (index: number) => list[index]?.word;
  let end = i, at = j;
  for (;;) {
    const next = heard(end + 1);
    if (next === undefined) break;
    if (digits.test(words[at] ?? '') && numberWord.test(next)) { end++; continue; }
    if (similar(next, words[at + 1], partial(end + 1)) || similar(next, words[at + 2], partial(end + 1))) {
      at += similar(next, words[at + 1], partial(end + 1)) ? 1 : 2; end++; continue;
    }
    if (words[at + 2] !== undefined && similar(next, words[at + 1]! + words[at + 2], partial(end + 1))) { at += 2; end++; continue; }
    const after = heard(end + 2);
    if (after !== undefined && similar(next + after, words[at + 1], partial(end + 2))) { at += 1; end += 2; continue; }
    break;
  }
  return end;
}
function foreignTokens(list: Token[], references: string[][], final: boolean) {
  if (!references.length) return list;
  const echo = list.map(() => false);
  for (const words of references) {
    for (let i = 0; i + 1 < list.length; i++) {
      // A run through this word was already found from an earlier start.
      if (echo[i]) continue;
      const word = list[i]!.word, next = list[i + 1]!.word;
      for (let j = 0; j < words.length; j++) {
        // A run may also start with a merged or split word.
        const spoken = words[j]!, following = words[j + 1];
        let start: [number, number] | undefined;
        if (similar(word, spoken, false)) start = [i, j];
        else if (word.length > spoken.length && word[0] === spoken[0]) {
          if (following !== undefined && similar(word, spoken + following, false)) start = [i, j + 1];
        } else if (word.length < spoken.length && word[0] === spoken[0] && similar(word + next, spoken, !final && i + 1 === list.length - 1)) start = [i + 1, j];
        if (!start) continue;
        const end = echoRun(list, words, start[0], start[1], final), run = list.slice(i, end + 1);
        if (run.length >= 3 || run.length === 2 && run.some(token => token.word.length >= 4)) for (let k = i; k <= end; k++) echo[k] = true;
      }
    }
  }
  return list.filter((_, i) => !echo[i]);
}

export type EchoSnapshot = { playing: boolean; references: { id: string; words: string[] }[] };
// What the device reports it is playing, as text. The audio itself is never
// available here; only the words of the response being spoken.
export class PlaybackEcho {
  private texts = new Map<string, string[]>();
  private playing: { id: string; words: string[]; end: number }[] = [];
  remember(turnId: string, text: string) {
    this.texts.delete(turnId); this.texts.set(turnId, tokens(text).list.map(token => token.word));
    while (this.texts.size > 8) this.texts.delete(this.texts.keys().next().value!);
  }
  start(turnId: string, now: number) {
    const words = this.texts.get(turnId);
    if (!words) return;
    // A device that never reports the end cannot hold Mia in playback forever.
    this.playing = [...this.playing.filter(ref => ref.id !== turnId && now <= ref.end + echoTailMs), { id: turnId, words, end: now + 300_000 }].slice(-2);
  }
  stop(turnId: string, now: number) {
    for (const ref of this.playing) if (ref.id === turnId) ref.end = Math.min(ref.end, now);
  }
  // After playback only its last words can still be in flight as echo.
  at(now: number): EchoSnapshot {
    this.playing = this.playing.filter(ref => now <= ref.end + echoTailMs);
    return { playing: this.playing.some(ref => now <= ref.end),
      references: this.playing.map(({ id, words, end }) => ({ id, words: now <= end ? words : words.slice(-10) })) };
  }
}

export class WordBargeInGate {
  private turns = new Map<number, { firstWord?: string; text: string; stableAt: number; confirmed: boolean; audioRequired: boolean; audioSeen: boolean;
    overlapped: boolean; references: Map<string, string[]> }>();
  start(id: number, audioRequired = false, audible = false) {
    this.turns.set(id, { text: '', stableAt: 0, confirmed: false, audioRequired, audioSeen: audible, overlapped: false, references: new Map() });
  }
  // Attach Mia's speech heard during this utterance. It stays attached, so a
  // late final transcript is still compared with what was playing. The
  // stricter rule applies only while she is still playing: an answer that
  // finishes after her is the person's turn.
  hear(id: number, echo: EchoSnapshot) {
    const turn = this.turns.get(id);
    if (!turn) return;
    turn.overlapped = echo.playing;
    for (const ref of echo.references) if (!turn.references.has(ref.id)) turn.references.set(ref.id, ref.words);
  }
  private heard(id: number, text: string, final: boolean) {
    const turn = this.turns.get(id);
    const { source, list } = tokens(text);
    return { turn, source, all: list, list: turn ? foreignTokens(list, [...turn.references.values()], final) : list };
  }
  observe(id: number, text: string, final: boolean, now: number, audible = true) {
    const { turn, list } = this.heard(id, text, final);
    if (!turn || turn.confirmed) return false;
    turn.audioSeen ||= audible;
    if (!list.length || turn.audioRequired && !turn.audioSeen) { turn.firstWord = undefined; turn.text = ''; turn.stableAt = 0; return false; }
    const firstWord = list[0]!.word;
    if (turn.firstWord !== firstWord) { turn.firstWord = firstWord; turn.stableAt = now; }
    turn.text = text;
    // While Mia is audible, one stray word is as likely a misrecognised echo
    // as a person. Require two words of the person's own.
    if (turn.overlapped && list.length < 2) return false;
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
  // The person's words to submit, or '' for noise and Mia's own echo. Speech
  // over Mia counts only once it interrupted her; echo before and after the
  // person's words is dropped.
  userText(id: number, text: string) {
    const { turn, source, all, list } = this.heard(id, text, true);
    if (!list.length || (turn?.audioRequired || turn?.overlapped) && !turn.confirmed) return '';
    if (!turn?.references.size) return text.trim();
    // Keep the person's punctuation; cut where trailing echo begins.
    const after = all[all.indexOf(list.at(-1)!) + 1];
    return source.slice(list[0]!.at, after?.at ?? source.length).trim();
  }
  finish(id: number) { this.turns.delete(id); }
  clear() { this.turns.clear(); }
}
