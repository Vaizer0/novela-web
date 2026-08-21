import { NavLink, Route, Routes } from "react-router-dom";
import Extensions from "./pages/Extensions";

function Home() {
  return (
    <div className="page">
      <h1>NoveLA Web</h1>
      <p className="muted">Novel reader — web port.</p>
    </div>
  );
}

function Browse() {
  return (
    <div className="page">
      <h1>Browse</h1>
      <p className="muted">Coming next.</p>
    </div>
  );
}

export default function App() {
  return (
    <>
      <nav className="topnav">
        <NavLink to="/" end>
          Library
        </NavLink>
        <NavLink to="/browse">Browse</NavLink>
        <NavLink to="/extensions">Extensions</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/browse" element={<Browse />} />
        <Route path="/extensions" element={<Extensions />} />
        <Route path="*" element={<div className="page">Not found</div>} />
      </Routes>
    </>
  );
}
