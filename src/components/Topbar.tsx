import type { AuthUser } from "../auth";
import type { Page } from "../types";
import { Icon } from "./Icon";

interface TopbarProps {
  page: Page;
  onPage: (page: Page) => void;
  credits: number;
  onHome?: () => void;
  user: AuthUser | null;
  onLogin: () => void;
  onLogout: () => void;
}

export function Topbar({ page, onPage, credits, onHome, user, onLogin, onLogout }: TopbarProps) {
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
          <button className={page === "library" ? "active" : ""} onClick={() => onPage("library")}>내 라이브러리</button>
          <button onClick={() => alert("도움말은 아직 준비 중이에요!")}>도움말</button>
        </div>
      </div>
      <div className="topright">
        <div className="credit-pill" title="무료 사용자는 하루 3곡 생성">
          <Icon name="sparkles" size={12} />
          오늘 <b>{credits}/3</b>
        </div>
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
        <button className="btn-primary" onClick={() => alert("플랜 페이지는 별도 작업으로!")}>업그레이드</button>
      </div>
    </div>
  );
}
