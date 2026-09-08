import { useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import Extensions from "./pages/Extensions";
import Browse from "./pages/Browse";
import Novel from "./pages/Novel";
import Reader from "./pages/Reader";
import Library from "./pages/Library";
import Settings from "./pages/Settings";

const navItems = [
  { to: "/", label: "Library", icon: "▦" },
  { to: "/browse", label: "Browse", icon: "⌕" },
  { to: "/extensions", label: "Sources", icon: "◇" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

function Brand() {
  return (
    <NavLink to="/" end className="brand">
      <span className="brand-mark">N</span>
      <span className="brand-copy">
        <strong>NoveLA</strong>
        <span>Web reader</span>
      </span>
    </NavLink>
  );
}

function Navigation({ mobile = false, collapsed = false }: { mobile?: boolean; collapsed?: boolean }) {
  return (
    <nav className={mobile ? "mobile-nav" : "side-nav"} aria-label={mobile ? "Mobile navigation" : "Primary navigation"}>
      {navItems.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === "/"} title={collapsed ? item.label : undefined}>
          <span className="nav-icon" aria-hidden="true">{item.icon}</span>
          <span className="nav-label">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("novelaSidebarCollapsed") === "1");

  function toggleSidebar(): void {
    setSidebarCollapsed((value) => {
      const next = !value;
      localStorage.setItem("novelaSidebarCollapsed", next ? "1" : "0");
      return next;
    });
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="desktop-sidebar">
        <div className="sidebar-top">
          <Brand />
          <button
            className="sidebar-toggle"
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "Expand NoveLA sidebar" : "Collapse NoveLA sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
        </div>
        <Navigation collapsed={sidebarCollapsed} />
        <div className="sidebar-footer">
          <span className="small">{sidebarCollapsed ? "NoveLA" : "Read. Discover. Remember."}</span>
        </div>
      </aside>

      <main className="app-main">
        <header className="mobile-header">
          <Brand />
          <NavLink to="/browse" className="header-search-link" aria-label="Browse and search">
            ⌕
          </NavLink>
        </header>
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/novel" element={<Novel />} />
          <Route path="/reader" element={<Reader />} />
          <Route path="/extensions" element={<Extensions />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<div className="page empty-state"><div className="empty-icon">404</div><h1>Page not found</h1><p className="muted">The page you requested doesn't exist.</p><NavLink className="button button-primary" to="/">Back to library</NavLink></div>} />
        </Routes>
      </main>

      <Navigation mobile />
    </div>
  );
}
