import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { DataProvider } from "./lib/data";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DataProvider><App /></DataProvider>
  </StrictMode>,
);
