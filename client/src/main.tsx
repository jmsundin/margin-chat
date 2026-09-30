import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "katex/dist/katex.min.css";
import "./components/MathEquation.css";
import { Analytics } from "@vercel/analytics/react"
import AppUpdateNotice from "./components/AppUpdateNotice";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Analytics />
    <App />
    {import.meta.env.PROD && <AppUpdateNotice commit={import.meta.env.VITE_APP_COMMIT} />}
  </React.StrictMode>,
);
