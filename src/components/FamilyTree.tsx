import { Fragment } from "react";
import { daysAgoLabel, VARIATION_LABELS } from "../data";
import type { Generation } from "../types";
import { Icon } from "./Icon";

interface FamilyTreeProps {
  generations: Generation[];
  onJumpToGen: (genId: string) => void;
}

function collectSubtree(root: Generation, byParent: Map<string, Generation[]>): Generation[] {
  const out: Generation[] = [root];
  const children = byParent.get(root.id) || [];
  for (const c of children) out.push(...collectSubtree(c, byParent));
  return out;
}

export function FamilyTree({ generations, onJumpToGen }: FamilyTreeProps) {
  const byParent = new Map<string, Generation[]>();
  for (const g of generations) {
    const key = g.parentGenId || "_root";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(g);
  }
  const roots = byParent.get("_root") || [];

  function renderNode(gen: Generation, depth: number) {
    const likeCount = gen.songs.filter((s) => s.liked).length;
    const children = byParent.get(gen.id) || [];
    return (
      <Fragment key={gen.id}>
        <div className={`tree-row ${depth === 0 ? "root" : ""}`}>
          {depth > 0 && <span className="tree-indent" />}
          <div className="tree-gen-card" onClick={() => onJumpToGen(gen.id)}>
            <div
              className="tg-art"
              style={{
                background: depth === 0
                  ? "linear-gradient(135deg, #c8efb5 0%, #3eaa78 100%)"
                  : `linear-gradient(135deg, ${gen.palette[0]} 0%, ${gen.palette[1]} 100%)`,
              }}
            />
            <div className="tg-text">
              <h5 className="tg-title">{gen.prompt}</h5>
              <p className="tg-sub">
                {depth === 0 ? "🌱 씨앗곡" : `↳ ${gen.variationType ? VARIATION_LABELS[gen.variationType] : "변형"}`}
                {" · "}{gen.songs.length}곡
                {gen.daysAgo != null && ` · ${daysAgoLabel(gen.daysAgo)}`}
              </p>
            </div>
            {likeCount > 0 && (
              <span className="tg-likes">
                <Icon name="heart" size={11} /> {likeCount}
              </span>
            )}
          </div>
        </div>
        {children.map((c) => renderNode(c, depth + 1))}
      </Fragment>
    );
  }

  return (
    <div>
      {roots.map((root) => {
        const subtree = collectSubtree(root, byParent);
        const totalSongs = subtree.reduce((acc, g) => acc + g.songs.length, 0);
        const totalLikes = subtree.reduce(
          (acc, g) => acc + g.songs.filter((s) => s.liked).length,
          0,
        );
        return (
          <div key={root.id} className="tree-family">
            <div className="tree-family-head">
              <div
                className="seed"
                style={{
                  background: "linear-gradient(135deg, #c8efb5 0%, #3eaa78 100%)",
                }}
              >
                🌱
              </div>
              <div className="info">
                <h4 className="title">{root.prompt}</h4>
                <p className="sub">
                  {subtree.length}개 세대 · 총 {totalSongs}곡 · {totalLikes}곡 좋아함
                </p>
              </div>
            </div>
            {renderNode(root, 0)}
          </div>
        );
      })}
    </div>
  );
}
