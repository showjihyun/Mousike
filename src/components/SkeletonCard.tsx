interface SkeletonCardProps {
  delay?: number;
}

export function SkeletonCard({ delay = 0 }: SkeletonCardProps) {
  return (
    <div className="song-card loading" style={{ animationDelay: `${delay}s` }}>
      <div className="song-card-head">
        <div style={{ height: 16, width: "70%", background: "rgba(0,0,0,0.06)", borderRadius: 4 }} />
        <div style={{ height: 16, width: 50, background: "rgba(0,0,0,0.06)", borderRadius: 999 }} />
      </div>
      <div className="player-block">
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(0,0,0,0.06)" }} />
        <div className="waveform">
          {Array.from({ length: 40 }).map((_, i) => (
            <span
              key={i}
              className="wave-bar"
              style={{
                height: `${10 + (Math.sin(i + delay * 10) * 0.5 + 0.5) * 28}px`,
                background: "rgba(0,0,0,0.08)",
                animation: "skel-pulse 1.4s ease-in-out infinite",
                animationDelay: `${(i % 8) * 0.05}s`,
              }}
            />
          ))}
        </div>
      </div>
      <div style={{ height: 12, width: "40%", background: "rgba(0,0,0,0.05)", borderRadius: 4 }} />
      <div style={{ height: 24, width: "100%", background: "rgba(0,0,0,0.03)", borderRadius: 6 }} />
    </div>
  );
}
