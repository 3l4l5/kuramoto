import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { queryClient, ToastProvider } from "./hooks";
import "./style.css";
import "./ds/tokens.css";

// デザインシステムのカタログ(/_design)は開発のときだけ。本番のビルドでは import.meta.env.DEV が false になり、カタログのコードごと消える。
const Catalog = import.meta.env.DEV && location.pathname === "/_design"
  ? lazy(() => Promise.all([import("./ds/Catalog"), import("./ds/catalog.css")]).then(([m]) => ({ default: m.Catalog })))
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {Catalog ? (
      <Suspense fallback={null}><Catalog /></Suspense>
    ) : (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </QueryClientProvider>
    )}
  </StrictMode>,
);
