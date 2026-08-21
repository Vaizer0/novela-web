import { NavLink, Route, Routes } from "react-router-dom";
import Extensions from "./pages/Extensions";
import Browse from "./pages/Browse";
import Novel from "./pages/Novel";
import Reader from "./pages/Reader";
import Library from "./pages/Library";
import Settings from "./pages/Settings";

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
        <Route path="/" element={<Library />} />
        <Route path="/browse" element={<Browse />} />
        <Route path="/novel" element={<Novel />} />
        <Route path="/reader" element={<Reader />} />
        <Route path="/extensions" element={<Extensions />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<div className="page">Not found</div>} />
      </Routes>
    </>
  );
}
