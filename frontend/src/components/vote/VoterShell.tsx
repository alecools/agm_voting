import { Outlet } from "react-router-dom";

export function VoterShell() {
  return (
    <div className="voter-layout">
      <header className="app-header">
        <img src="/logo.png" alt="General Meeting Vote" className="app-header__logo" />
      </header>
      <Outlet />
    </div>
  );
}
