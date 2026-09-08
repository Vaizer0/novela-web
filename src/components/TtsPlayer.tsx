import { useEffect, useRef, useState } from "react";

export interface TtsWordPos {
  para: number;
  /** Exact character range supplied by the speech engine within the spoken paragraph. */
  start: number;
  end: number;
}

interface TtsPlayerProps {
  paragraphs: string[];
  speakTexts: string[];
  lang: string;
  onWord?: (pos: TtsWordPos | null) => void;
  onAdvance?: () => void;
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const requested = (lang || navigator.language || "en-US").toLowerCase();
  const base = requested.split("-")[0];
  return voices.find((v) => v.lang.toLowerCase() === requested) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(base)) ??
    null;
}

export interface TtsChunk {
  text: string;
  offset: number;
}

const MAX_CHUNK = 300;

/**
 * Keep utterances reasonably small while preserving the exact character offset
 * back to the source paragraph. Highlighting never estimates a word range.
 */
export function splitChunks(text: string): TtsChunk[] {
  if (!text) return [];
  const out: TtsChunk[] = [];
  let offset = 0;

  while (offset < text.length) {
    const remaining = text.slice(offset);
    if (remaining.length <= MAX_CHUNK) {
      out.push({ text: remaining, offset });
      break;
    }
    let cut = remaining.lastIndexOf(" ", MAX_CHUNK);
    if (cut <= 0) cut = MAX_CHUNK;
    out.push({ text: remaining.slice(0, cut), offset });
    offset += cut;
  }
  return out;
}

/**
 * Return the exact character range supplied by the speech engine.
 * No whitespace parsing, WPM calculation, elapsed-time estimation, or
 * inferred end position is used for highlighting.
 */
export function exactBoundaryRange(event: SpeechSynthesisEvent): { start: number; end: number } | null {
  const start = Number(event.charIndex);
  const length = Number(event.charLength);
  if (!Number.isFinite(start) || !Number.isFinite(length) || start < 0 || length <= 0) return null;
  return { start, end: start + length };
}

export function TtsPlayer({ paragraphs, speakTexts, lang, onWord, onAdvance }: TtsPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [current, setCurrent] = useState(-1);
  const stoppedRef = useRef(true);
  const runIdRef = useRef(0);
  const rateRef = useRef(rate);
  const textsRef = useRef(speakTexts);
  const onWordRef = useRef(onWord);

  rateRef.current = rate;
  textsRef.current = speakTexts;
  onWordRef.current = onWord;

  useEffect(() => () => {
    stoppedRef.current = true;
    runIdRef.current++;
    window.speechSynthesis.cancel();
    onWordRef.current?.(null);
  }, []);

  function stop(): void {
    stoppedRef.current = true;
    runIdRef.current++;
    window.speechSynthesis.cancel();
    setPlaying(false);
    setCurrent(-1);
    onWordRef.current?.(null);
  }

  function speakFrom(startPara: number, atRate = rateRef.current): void {
    const runId = ++runIdRef.current;
    stoppedRef.current = false;
    window.speechSynthesis.cancel();
    setPlaying(true);

    const queue = textsRef.current.flatMap((text, para) =>
      splitChunks(text).map((chunk) => ({ para, ...chunk })),
    );
    const qi = queue.findIndex((item) => item.para >= startPara);
    if (qi < 0) {
      setPlaying(false);
      return;
    }

    const speakNext = (index: number): void => {
      if (stoppedRef.current || runId !== runIdRef.current) return;
      if (index >= queue.length) {
        setPlaying(false);
        setCurrent(-1);
        onWordRef.current?.(null);
        if (!stoppedRef.current && runId === runIdRef.current) onAdvance?.();
        return;
      }

      const chunk = queue[index];
      const previous = queue[index - 1];
      setCurrent(chunk.para);
      if (!previous || previous.para !== chunk.para) {
        document.getElementById(`para-${chunk.para}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      const utterance = new SpeechSynthesisUtterance(chunk.text);
      utterance.rate = atRate;
      utterance.lang = lang || navigator.language || "en-US";
      const voice = pickVoice(utterance.lang);
      if (voice) utterance.voice = voice;

      utterance.onstart = () => {
        if (runId !== runIdRef.current || stoppedRef.current) return;
        onWordRef.current?.(null);
      };

      utterance.onboundary = (event: SpeechSynthesisEvent) => {
        if (runId !== runIdRef.current || stoppedRef.current) return;
        if (event.name && event.name !== "word") return;

        // Android NoveLA receives start/end from TextToSpeech.onRangeStart.
        // On the Web, use the browser's engine-provided charIndex/charLength
        // directly. Nothing is inferred from the text or from timing.
        const range = exactBoundaryRange(event);
        if (!range) return;

        const start = range.start + chunk.offset;
        const end = range.end + chunk.offset;
        if (start < chunk.offset || end > chunk.offset + chunk.text.length || end <= start) return;
        onWordRef.current?.({ para: chunk.para, start, end });
      };

      utterance.onend = () => {
        if (runId !== runIdRef.current || stoppedRef.current) return;
        onWordRef.current?.(null);
        speakNext(index + 1);
      };

      utterance.onerror = (event) => {
        if (runId !== runIdRef.current || stoppedRef.current) return;
        if (event.error === "canceled" || event.error === "interrupted") return;
        setPlaying(false);
        setCurrent(-1);
        onWordRef.current?.(null);
      };

      window.speechSynthesis.speak(utterance);
    };

    speakNext(qi);
  }

  function pauseOrResume(): void {
    if (!window.speechSynthesis.speaking) return;
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setPlaying(true);
    } else {
      window.speechSynthesis.pause();
      setPlaying(false);
    }
  }

  if (!paragraphs.length) return null;

  return (
    <div className="tts-bar card">
      {!playing ? (
        <button onClick={() => (current >= 0 ? pauseOrResume() : speakFrom(0))}>▶ TTS</button>
      ) : (
        <button onClick={pauseOrResume}>⏸</button>
      )}
      <button onClick={stop}>⏹</button>
      <label className="inline">
        speed
        <select
          value={rate}
          onChange={(e) => {
            const nextRate = Number(e.target.value);
            setRate(nextRate);
            if (current >= 0) speakFrom(current, nextRate);
          }}
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
            <option key={r} value={r}>{r}×</option>
          ))}
        </select>
      </label>
      {current >= 0 && <span className="muted small">{current + 1}/{paragraphs.length}</span>}
    </div>
  );
}
