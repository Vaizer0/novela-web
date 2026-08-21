import { useEffect, useRef, useState } from "react";

/**
 * Web Speech API mini-player. Speaks the given paragraphs in order,
 * highlights the current one (scrolls it into view), and stops at the end.
 * Browser limitation vs Android: no background playback with screen off.
 */
export function TtsPlayer({
  paragraphs,
  onAdvance,
}: {
  paragraphs: string[];
  /** called when the last paragraph finishes — reader may navigate next */
  onAdvance?: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [current, setCurrent] = useState(-1);
  const stoppedRef = useRef(false);

  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      window.speechSynthesis.cancel();
    };
  }, []);

  // Speak from `startIdx` when play is pressed.
  function speakFrom(startIdx: number): void {
    window.speechSynthesis.cancel();
    stoppedRef.current = false;
    setPlaying(true);

    const speakNext = (i: number): void => {
      if (stoppedRef.current || i >= paragraphs.length) {
        setPlaying(false);
        setCurrent(-1);
        if (!stoppedRef.current && i >= paragraphs.length) onAdvance?.();
        return;
      }
      setCurrent(i);
      const el = document.getElementById(`para-${i}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      const u = new SpeechSynthesisUtterance(paragraphs[i]);
      u.rate = rate;
      u.onend = () => speakNext(i + 1);
      u.onerror = () => {
        setPlaying(false);
        setCurrent(-1);
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

  function stop(): void {
    stoppedRef.current = true;
    window.speechSynthesis.cancel();
    setPlaying(false);
    setCurrent(-1);
  }

  if (paragraphs.length === 0) return null;

  return (
    <div className="tts-bar card">
      {!playing ? (
        <button
          onClick={() =>
            current >= 0 ? (pauseOrResume(), setPlaying(true)) : speakFrom(0)
          }
        >
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
            // restart current paragraph at new rate
            if (current >= 0) speakFrom(current);
            void r;
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
