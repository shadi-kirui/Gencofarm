import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const redirectedPath = sessionStorage.getItem("genco:spa-redirect");
if (redirectedPath) {
  sessionStorage.removeItem("genco:spa-redirect");
  if (redirectedPath !== window.location.pathname + window.location.search + window.location.hash) {
    window.history.replaceState(null, "", redirectedPath);
  }
}

createRoot(document.getElementById("root")!).render(<App />);
