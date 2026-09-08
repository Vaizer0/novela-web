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

function Navigation({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav className={mobile ? "mobile-nav" : "side-nav"} aria-label={mobile ? "Mobile navigation" : "Primary navigation"}>
      {navItems.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === "/"}>
          <span className="nav-icon" aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export default function App() {
  return (
    <div className="app-shell">
      <aside className="desktop-sidebar">
        <Brand />
        <Navigation />
        <div className="sidebar-footer">
          <span className="small">Read. Discover. Remember.</span>
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
