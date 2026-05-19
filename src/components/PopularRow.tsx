import type { PopularItem } from "../types";
import { Icon } from "./Icon";

interface PopularRowProps {
  items: PopularItem[];
  onPlay: (item: PopularItem) => void;
}

export function PopularRow({ items, onPlay }: PopularRowProps) {
  return (
    <div className="popular-section">
      <div className="popular-head">
        <h3>오늘 가장 많이 들은 음악</h3>
        <button className="popular-link" type="button">전체 보기 →</button>
      </div>
      <div className="popular-row">
        {items.map((item) => (
          <button key={item.id} className="popular-card" onClick={() => onPlay(item)}>
            <div
              className="popular-art"
              style={{
                background: `linear-gradient(135deg, ${item.color1} 0%, ${item.color2} 100%)`,
              }}
            >
              <div className="play-mini"><Icon name="play" size={14} /></div>
            </div>
            <div className="popular-meta">
              <div className="popular-title">{item.title}</div>
              <div className="popular-sub">{item.user} · {item.plays}회 재생</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
