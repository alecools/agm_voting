import { Outlet } from "react-router-dom";

export function VoterShell() {
  return (
    <div className="voter-layout">
      <header className="app-header">
        <picture>
          <source srcSet="/logo.webp" type="image/webp" />
          <img src="/logo.png" alt="General Meeting Vote" className="app-header__logo" />
        </picture>
      </header>
      <Outlet />
    </div>
  );
}
