import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { DataProvider } from "./lib/data";
import { WalletProvider } from "./lib/connect";
import { AccountProvider } from "./lib/account";
import { PairingModal } from "./components/wallet-ui";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider><DataProvider><AccountProvider><App /><PairingModal /></AccountProvider></DataProvider></WalletProvider>
  </StrictMode>,
);
