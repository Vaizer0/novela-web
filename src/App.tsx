import { Routes, Route } from "react-router-dom";
import { Link } from "react-router-dom";

function Home() {
  return (
    <div style={{ maxWidth: 720, margin: "4rem auto", padding: "0 1rem", fontFamily: "system-ui" }}>
      <h1>NoveLA Web</h1>
      <p>Novel reader — web port. Under construction.</p>
      <nav>
        <Link to="/browse">Browse</Link>
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/browse" element={<div style={{ margin: "4rem auto" }}>Browse</div>} />
    </Routes>
  );
}
