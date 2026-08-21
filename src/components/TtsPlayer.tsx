import { useEffect, useRef, useState } from "react";

export interface TtsWordPos {
  para: number;
  /** char offset of the current word within the spoken paragraph */
  start: number;
  end: number;
}

interface TtsPlayerProps {
  /** paragraphs as displayed (used for counting) */
  paragraphs: string[];
  /** text actually spoken — differs when translation is on */
  speakTexts: string[];
  /** BCP-47 language of speakTexts, e.g. "en" */
  lang: string;
  /** reports the currently spoken word for in-text highlighting */
  onWord?: (pos: TtsWordPos | null) => void;
  /** called when the last paragraph finishes — reader may navigate next */
  onAdvance?: () => void;
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const base = lang.split("-")[0].toLowerCase();
  return (
    voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(base)) ??
    null
  );
}

/** Char offsets of every whitespace-delimited word in `text`. */
function wordOffsets(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export interface TtsChunk {
  text: string;
  /** char offset of this chunk within its source paragraph */
  offset: number;
}

const MAX_CHUNK = 300;

/**
 * Split text into sentence-sized chunks, keeping each chunk's char offset in
 * the source. Mirrors NoveLA Android's slice-and-anchor strategy: short
 * utterances bound highlight drift. Chunks longer than MAX_CHUNK are split
 * at the nearest space so no single utterance is very long.
 */
export function splitChunks(text: string): Array<TtsChunk> {
  const out: Array<TtsChunk> = [];
  const re = /[^.!?\n]+[.!?]*\s*/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let index = m.index;
    let piece = m[0];
    while (piece.length > MAX_CHUNK) {
      let cut = piece.lastIndexOf(" ", MAX_CHUNK);
      if (cut <= 0) cut = MAX_CHUNK;
      out.push({ text: piece.slice(0, cut), offset: index });
      index += cut;
      piece = piece.slice(cut);
    }
    if (piece.length > 0) out.push({ text: piece, offset: index });
  }
  return out;
}

/**
 * EMA-blend the measured ms-per-word of a finished utterance into the running
 * pace estimate. Degenerate samples (too short, no words) are ignored.
 */
export function calibratePace(prevMsPerWord: number, elapsedMs: number, wordCount: number): number {
  if (elapsedMs < 500 || wordCount === 0) return prevMsPerWord;
  const actual = elapsedMs / Math.max(wordCount, 1);
  return prevMsPerWord * 0.6 + actual * 0.4;
}

/**
 * Web Speech API mini-player. Speaks paragraphs in order with word-level
 * highlighting and continuous auto-scroll, then stops (or advances chapter).
 * Browser limitation vs Android: no background playback with screen off.
 */
export function TtsPlayer({ paragraphs, speakTexts, lang, onWord, onAdvance }: TtsPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [current, setCurrent] = useState(-1);
  const stoppedRef = useRef(false);
  // interval driving estimated word highlight when boundary events don't fire
  const wordTimerRef = useRef<number | null>(null);
  // latest values for async utterance callbacks
  const rateRef = useRef(rate);
  const textsRef = useRef(speakTexts);
  textsRef.current = speakTexts;
  // self-calibrating ms-per-word estimate (~165 wpm at rate 1)
  const paceRef = useRef(60000 / 165);

  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      window.speechSynthesis.cancel();
      onWord?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function stop(): void {
    stoppedRef.current = true;
    window.speechSynthesis.cancel();
    if (wordTimerRef.current !== null) {
      window.clearInterval(wordTimerRef.current);
      wordTimerRef.current = null;
    }
    setPlaying(false);
    setCurrent(-1);
    onWord?.(null);

  }
  function speakFrom(startPara: number, atRate?: number): void {
    window.speechSynthesis.cancel();
    stoppedRef.current = false;
    setPlaying(true);

    const r = atRate ?? rateRef.current;
    // Sentence-chunked queue (NoveLA-style slicing): short utterances bound
    // highlight drift, and per-chunk onend samples recalibrate the pace.
    const queue = textsRef.current.flatMap((t, para) =>
      splitChunks(t).map((c) => ({ para, ...c })),
    );
    let first = queue.findIndex((c) => c.para >= startPara);
    if (first < 0) first = queue.length;

    const speakNext = (qi: number): void => {
      if (stoppedRef.current || qi >= queue.length) {
        setPlaying(false);
        setCurrent(-1);
        onWord?.(null);
        if (!stoppedRef.current && qi >= queue.length) onAdvance?.();
        return;
      }
      const chunk = queue[qi];
      const prev = qi > 0 ? queue[qi - 1] : null;
      const paraChanged = !prev || prev.para !== chunk.para;
      if (paraChanged) {
        setCurrent(chunk.para);
        // activate the paragraph immediately; start:-1 = "no word mark yet"
        onWord?.({ para: chunk.para, start: -1, end: -1 });
        document
          .getElementById(`para-${chunk.para}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      // Word highlight: many engines (notably Android Chrome) never fire
      // boundary events, so drive highlighting from a timing estimate and
      // switch to precise events when the engine does send them. Chunk-local
      // offsets map back into paragraph coordinates for Reader's highlight().
      const words = wordOffsets(chunk.text);
      let wi = 0;
      let boundarySeen = false;
      if (wordTimerRef.current !== null) window.clearInterval(wordTimerRef.current);
      const t0 = performance.now();
      wordTimerRef.current = window.setInterval(() => {
        // don't run ahead while the engine is paused
        if (window.speechSynthesis.paused) return;
        if (stoppedRef.current || boundarySeen) {
          if (wordTimerRef.current !== null) window.clearInterval(wordTimerRef.current);
          wordTimerRef.current = null;
          return;
        }
        if (wi < words.length) {
          onWord?.({
            para: chunk.para,
            start: words[wi].start + chunk.offset,
            end: words[wi].end + chunk.offset,
          });
          document
            .getElementById(`para-${chunk.para}`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
          wi++;
        }
      }, paceRef.current / r);

      const u = new SpeechSynthesisUtterance(chunk.text);
      u.rate = r;
      u.lang = lang;
      const voice = pickVoice(lang);
      if (voice) u.voice = voice;
      u.onboundary = (ev: SpeechSynthesisEvent) => {
        if (stoppedRef.current) return;
        if (ev.name && ev.name !== "word") return;
        boundarySeen = true;
        if (wordTimerRef.current !== null) {
          window.clearInterval(wordTimerRef.current);
          wordTimerRef.current = null;
        }
        let start = ev.charIndex;
        if (start > 0 && !/\s/.test(chunk.text[start - 1])) {
          while (start > 0 && !/\s/.test(chunk.text[start - 1])) start--;
        }
        let end = start;
        while (end < chunk.text.length && !/\s/.test(chunk.text[end])) end++;
        onWord?.({ para: chunk.para, start: start + chunk.offset, end: end + chunk.offset });
        document
          .getElementById(`para-${chunk.para}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      };
      u.onend = () => {
        if (wordTimerRef.current !== null) {
          window.clearInterval(wordTimerRef.current);
          wordTimerRef.current = null;
        }
        if (stoppedRef.current) return;
        paceRef.current = calibratePace(paceRef.current, performance.now() - t0, words.length);
        const next = queue[qi + 1];
        if (!next || next.para !== chunk.para) onWord?.(null);
        speakNext(qi + 1);
      };
      u.onerror = () => {
        if (wordTimerRef.current !== null) {
          window.clearInterval(wordTimerRef.current);
          wordTimerRef.current = null;
        }
        setPlaying(false);
        setCurrent(-1);
        onWord?.(null);
      };
      window.speechSynthesis.speak(u);
    };
    speakNext(first);
  }

  function pauseOrResume(): void {
    if (window.speechSynthesis.speaking) {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
        setPlaying(true);
      } else {
        window.speechSynthesis.pause();
        setPlaying(false);
      }
    }
  }

  if (paragraphs.length === 0) return null;

  return (
    <div className="tts-bar card">
      {!playing ? (
        <button onClick={() => (current >= 0 ? pauseOrResume() : speakFrom(0))}>
          ▶ TTS
        </button>
      ) : (
        <button onClick={pauseOrResume}>⏸</button>
      )}
      <button onClick={stop}>⏹</button>
      <label className="inline">
        speed
        <select
          value={rate}
          onChange={(e) => {
            const r = Number(e.target.value);
            setRate(r);
            // restart current paragraph at the new rate
            if (current >= 0) speakFrom(current, r);
          }}
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
      </label>
      {current >= 0 && (
        <span className="muted small">
          {current + 1}/{paragraphs.length}
        </span>
      )}
    </div>
  );
}
