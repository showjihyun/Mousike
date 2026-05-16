import { VARIATION_LABELS } from "../data";
import type { Generation } from "../types";
import { Icon } from "./Icon";

interface LineageStripProps {
  chain: Generation[];
  currentGenId: string | null;
  onJump: (genId: string) => void;
}

export function LineageStrip({ chain, currentGenId, onJump }: LineageStripProps) {
  if (chain.length === 0) return null;
  return (
    <div className="lineage-strip">
      {chain.map((gen, i) => {
        const isCurrent = gen.id === currentGenId;
        const isRoot = !gen.parentGenId;
        return (
          <div key={gen.id} className="lineage-node">
            {i > 0 && (
              <div className="lineage-connector">
                <Icon name="chevron-right" size={14} />
                {gen.variationType && (
                  <span className="vtag">{VARIATION_LABELS[gen.variationType] || "변형"}</span>
                )}
              </div>
            )}
            <button
              className={`lineage-card ${isCurrent ? "current" : ""}`}
              onClick={() => onJump(gen.id)}
              title={gen.prompt}
            >
              <div
                className="lineage-art"
                style={{
                  background: isRoot
                    ? "linear-gradient(135deg, #c8efb5 0%, #3eaa78 100%)"
                    : `linear-gradient(135deg, ${gen.palette[0]} 0%, ${gen.palette[1]} 100%)`,
                }}
              >
                {isRoot ? <span style={{ fontSize: 14 }}>🌱</span> : <Icon name="music-2" size={12} />}
              </div>
              <div className="lineage-text">
                <span className="lineage-prompt">{gen.prompt}</span>
                <span className="lineage-meta">
                  {isRoot ? "씨앗곡" : "변형 #" + i}
                  <span>· {gen.songs.length}곡</span>
                </span>
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}
