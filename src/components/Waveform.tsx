interface WaveformProps {
  bars: number[];
  progress?: number;
  playing?: boolean;
}

export function Waveform({ bars, progress = 0, playing = false }: WaveformProps) {
  const total = bars.length;
  const playedIdx = Math.floor(progress * total);
  return (
    <div className="waveform" aria-hidden="true">
      {bars.map((h, i) => {
        const cls = playing && i < playedIdx ? "played" : playing && i === playedIdx ? "now" : "";
        return (
          <span
            key={i}
            className={`wave-bar ${cls}`}
            style={{ height: `${Math.max(8, h * 40)}px` }}
          />
        );
      })}
    </div>
  );
}
