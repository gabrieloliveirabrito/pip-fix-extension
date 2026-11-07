import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isPackagedOptionsPage, waitForViteDevServer } from "./bridge-client";
import { ErrorBoundary, ErrorScreen } from "./components/ErrorScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import "./index.css";

function Bootstrap() {
  const [phase, setPhase] = useState<"vite" | "ready">(import.meta.env.DEV ? "vite" : "ready");
  const [bootError, setBootError] = useState<unknown>(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let active = true;
    waitForViteDevServer()
      .then(() => {
        if (active) setPhase("ready");
      })
      .catch((error) => {
        if (active) setBootError(error);
      });
    return () => {
      active = false;
    };
  }, []);

  if (bootError) {
    return (
      <ErrorScreen
        error={bootError}
        title="Servidor de desenvolvimento indisponível"
        hint="Rode npm run dev e abra http://127.0.0.1:5173 pelo ícone da extensão."
        onRetry={() => {
          setBootError(null);
          setPhase("vite");
          waitForViteDevServer()
            .then(() => setPhase("ready"))
            .catch(setBootError);
        }}
      />
    );
  }

  if (phase === "vite") {
    return <LoadingScreen label="Carregando…" detail="Conectando ao servidor Vite." />;
  }

  const mode = isPackagedOptionsPage() ? "packaged" : "dev";
  return <App mode={mode} />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <Bootstrap />
      </ErrorBoundary>
    </StrictMode>,
  );
}
