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
  // latest values for async utterance callbacks
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const textsRef = useRef(speakTexts);
  textsRef.current = speakTexts;

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
    setPlaying(false);
    setCurrent(-1);
    onWord?.(null);
  }

  function speakFrom(startIdx: number, atRate?: number): void {
    window.speechSynthesis.cancel();
    stoppedRef.current = false;
    setPlaying(true);

    const speakNext = (i: number): void => {
      if (stoppedRef.current || i >= textsRef.current.length) {
        setPlaying(false);
        setCurrent(-1);
        onWord?.(null);
        if (!stoppedRef.current && i >= textsRef.current.length) onAdvance?.();
        return;
      }
      setCurrent(i);
      // activate the paragraph immediately (works even if the browser never
      // fires word-boundary events); start:-1 means "no word mark yet"
      onWord?.({ para: i, start: -1, end: -1 });
      const text = textsRef.current[i];
      document.getElementById(`para-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" });

      const u = new SpeechSynthesisUtterance(text);
      u.rate = atRate ?? rateRef.current;
      u.lang = lang;
      const voice = pickVoice(lang);
      if (voice) u.voice = voice;
      u.onboundary = (ev: SpeechSynthesisEvent) => {
        if (stoppedRef.current) return;
        if (ev.name && ev.name !== "word") return;
        let start = ev.charIndex;
        if (start > 0 && !/\s/.test(text[start - 1])) {
          while (start > 0 && !/\s/.test(text[start - 1])) start--;
        }
        let end = start;
        while (end < text.length && !/\s/.test(text[end])) end++;
        onWord?.({ para: i, start, end });
        document.getElementById(`para-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      };
      u.onend = () => {
        if (stoppedRef.current) return;
        onWord?.(null);
        speakNext(i + 1);
      };
      u.onerror = () => {
        setPlaying(false);
        setCurrent(-1);
        onWord?.(null);
      };
      window.speechSynthesis.speak(u);
    };
    speakNext(startIdx);
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
