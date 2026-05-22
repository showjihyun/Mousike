import type { Usage } from "../api";
import type { AuthUser } from "../auth";
import type { Page } from "../types";
import { Icon } from "./Icon";

interface TopbarProps {
  page: Page;
  onPage: (page: Page) => void;
  usage: Usage;
  onHome?: () => void;
  user: AuthUser | null;
  onLogin: () => void;
  onLogout: () => void;
  onUpgrade: () => void;
  onAdvanced: () => void;
}

function UsageChip({ usage }: { usage: Usage }) {
  if (usage.limit === null) {
    return (
      <div className="credit-pill" title="무제한">
        <Icon name="sparkles" size={12} />
        {usage.periodLabel}
      </div>
    );
  }
  return (
    <div
      className="credit-pill"
      title={`${usage.periodLabel} ${usage.used}회 사용 (${Math.max(0, usage.limit - usage.used)}회 남음)`}
    >
      <Icon name="sparkles" size={12} />
      {usage.periodLabel} <b>{Math.max(0, usage.limit - usage.used)}/{usage.limit}</b>
    </div>
  );
}

export function Topbar({ page, onPage, usage, onHome, user, onLogin, onLogout, onUpgrade, onAdvanced }: TopbarProps) {
  return (
    <div className="topbar">
      <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
        <button
          className="brand"
          onClick={() => { onPage("home"); onHome?.(); }}
          style={{ padding: 0 }}
        >
          <span className="brand-mark">M</span>
          Mousike
        </button>
        <div className="topnav">
          <button className={page === "home" ? "active" : ""} onClick={() => onPage("home")}>탐험</button>
          <button className={page === "create" ? "active" : ""} onClick={() => onPage("create")}>🎹 커스텀</button>
          <button className={page === "library" ? "active" : ""} onClick={() => onPage("library")}>내 라이브러리</button>
        </div>
      </div>
      <div className="topright">
        <UsageChip usage={usage} />
        {user ? (
          <>
            <span className="user-chip" title={user.email}>
              {user.picture && <img src={user.picture} alt="" className="user-avatar" />}
              {user.name ?? user.email}
            </span>
            <button className="btn-ghost" onClick={onLogout}>로그아웃</button>
          </>
        ) : (
          <button className="btn-ghost" onClick={onLogin}>로그인</button>
        )}
        <button className="btn-advanced-top" onClick={onAdvanced} title="고급 설정">고급</button>
        <button className="btn-upgrade-top" onClick={onUpgrade}>업그레이드</button>
      </div>
    </div>
  );
}
