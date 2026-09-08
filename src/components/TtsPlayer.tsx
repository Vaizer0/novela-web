import { useEffect, useRef, useState } from "react";

export interface TtsWordPos {
  para: number;
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
  return voices.find((v) => v.lang.toLowerCase() === requested) ?? voices.find((v) => v.lang.toLowerCase().startsWith(base)) ?? null;
}

export function wordOffsets(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

export function boundaryToWordIndex(text: string, charIndex: number): number {
  const words = wordOffsets(text);
  if (!words.length) return -1;
  let i = words.findIndex((w) => charIndex >= w.start && charIndex < w.end);
  if (i >= 0) return i;
  if (charIndex < words[0].start) return 0;
  for (let n = 0; n < words.length - 1; n++) if (charIndex >= words[n].end && charIndex < words[n + 1].start) return n + 1;
  return words.length - 1;
}

export interface TtsChunk { text: string; offset: number }
const MAX_CHUNK = 300;

export function splitChunks(text: string): TtsChunk[] {
  const out: TtsChunk[] = [];
  const re = /[^.!?\n]+[.!?]*\s*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let offset = m.index;
    let piece = m[0];
    while (piece.length > MAX_CHUNK) {
      let cut = piece.lastIndexOf(" ", MAX_CHUNK);
      if (cut <= 0) cut = MAX_CHUNK;
      out.push({ text: piece.slice(0, cut), offset });
      offset += cut;
      piece = piece.slice(cut);
    }
    if (piece) out.push({ text: piece, offset });
  }
  return out;
}

export function calibratePace(prevMsPerWord: number, elapsedMs: number, wordCount: number): number {
  if (elapsedMs < 500 || wordCount === 0) return prevMsPerWord;
  const actual = elapsedMs / wordCount;
  return prevMsPerWord * 0.65 + actual * 0.35;
}

export function TtsPlayer({ paragraphs, speakTexts, lang, onWord, onAdvance }: TtsPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [current, setCurrent] = useState(-1);
  const stoppedRef = useRef(true);
  const runIdRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const rateRef = useRef(rate);
  const textsRef = useRef(speakTexts);
  const onWordRef = useRef(onWord);
  const paceRef = useRef(60000 / 165);

  rateRef.current = rate;
  textsRef.current = speakTexts;
  onWordRef.current = onWord;

  useEffect(() => () => {
    stoppedRef.current = true;
    runIdRef.current++;
    window.speechSynthesis.cancel();
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    onWordRef.current?.(null);
  }, []);

  function clearTimer(): void {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function stop(): void {
    stoppedRef.current = true;
    runIdRef.current++;
    window.speechSynthesis.cancel();
    clearTimer();
    setPlaying(false);
    setCurrent(-1);
    onWordRef.current?.(null);
  }

  function speakFrom(startPara: number, atRate = rateRef.current): void {
    const runId = ++runIdRef.current;
    stoppedRef.current = false;
    window.speechSynthesis.cancel();
    clearTimer();
    setPlaying(true);

    const queue = textsRef.current.flatMap((text, para) => splitChunks(text).map((chunk) => ({ para, ...chunk })));
    let qi = queue.findIndex((item) => item.para >= startPara);
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
      const words = wordOffsets(chunk.text);
      const startedAt = performance.now();
      let lastWordIndex = -1;
      let lastSyncTime = startedAt;
      let lastBoundary = false;
      setCurrent(chunk.para);
      onWordRef.current?.({ para: chunk.para, start: -1, end: -1 });

      if (index === 0 || queue[index - 1].para !== chunk.para) {
        document.getElementById(`para-${chunk.para}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      const emitWord = (wordIndex: number): void => {
        if (wordIndex < 0 || wordIndex >= words.length) return;
        if (wordIndex === lastWordIndex) return;
        const word = words[wordIndex];
        lastWordIndex = wordIndex;
        onWordRef.current?.({
          para: chunk.para,
          start: word.start + chunk.offset,
          end: word.end + chunk.offset,
        });
      };

      // Keep a 50 ms estimator alive even when the browser supplies boundary
      // events. Android Chrome/WebView engines may emit only a subset of them.
      clearTimer();
      timerRef.current = window.setInterval(() => {
        if (runId !== runIdRef.current || stoppedRef.current) return;
        if (window.speechSynthesis.paused || !words.length) return;
        const elapsedSinceSync = Math.max(0, performance.now() - lastSyncTime);
        const estimated = lastBoundary ? Math.max(lastWordIndex, Math.floor(elapsedSinceSync / (paceRef.current / atRate)) + lastWordIndex) : Math.floor(elapsedSinceSync / (paceRef.current / atRate));
        emitWord(Math.min(words.length - 1, estimated));
      }, 50);

      emitWord(0);

      const utterance = new SpeechSynthesisUtterance(chunk.text);
      utterance.rate = atRate;
      utterance.lang = lang || navigator.language || "en-US";
      const voice = pickVoice(utterance.lang);
      if (voice) utterance.voice = voice;

      utterance.onstart = () => {
        if (runId !== runIdRef.current || stoppedRef.current) return;
        lastSyncTime = performance.now();
        lastBoundary = false;
        emitWord(0);
      };

      utterance.onboundary = (event) => {
        if (runId !== runIdRef.current || stoppedRef.current) return;
        if (event.name && event.name !== "word") return;
        const indexFromBoundary = boundaryToWordIndex(chunk.text, event.charIndex);
        if (indexFromBoundary < 0) return;
        lastBoundary = true;
        lastWordIndex = indexFromBoundary - 1;
        lastSyncTime = performance.now();
        emitWord(indexFromBoundary);
      };

      utterance.onend = () => {
        if (runId !== runIdRef.current || stoppedRef.current) return;
        clearTimer();
        if (words.length) emitWord(words.length - 1);
        paceRef.current = calibratePace(paceRef.current, performance.now() - startedAt, words.length);
        onWordRef.current?.(null);
        speakNext(index + 1);
      };

      utterance.onerror = (event) => {
        if (runId !== runIdRef.current || stoppedRef.current) return;
        // cancelled/interrupted is normal during restart/stop; other errors stop cleanly.
        if (event.error === "canceled" || event.error === "interrupted") return;
        clearTimer();
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
      {!playing ? <button onClick={() => (current >= 0 ? pauseOrResume() : speakFrom(0))}>▶ TTS</button> : <button onClick={pauseOrResume}>⏸</button>}
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
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
        </select>
      </label>
      {current >= 0 && <span className="muted small">{current + 1}/{paragraphs.length}</span>}
    </div>
  );
}
