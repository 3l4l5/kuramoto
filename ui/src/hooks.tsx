import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type DbStatusView, type HqView, type ProjectView, type StudioView } from "./api";

/**
 * データは TanStack Query で 3 秒ごとに取り直す。前と同じ部分は同じ値のまま返る(structural sharing)ので、
 * 変わっていないところは描き直されない。操作のあとは useAct がすべて取り直す。
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 3000, refetchOnWindowFocus: true, retry: 1 } },
});

/** DB(MySQL)に繋がっているか。DB を読まない軽い問い合わせなので、切れている間も返る。 */
export const useDbStatus = () => useQuery({ queryKey: ["db-status"], queryFn: () => api<DbStatusView>("GET", "/db") });
export const useHq = () => useQuery({ queryKey: ["hq"], queryFn: () => api<HqView>("GET", "/hq") });
export const useProject = (id: number) => useQuery({ queryKey: ["project", id], queryFn: () => api<ProjectView>("GET", `/projects/${id}`) });
export const useStudio = (id: number) => useQuery({ queryKey: ["studio", id], queryFn: () => api<StudioView>("GET", `/projects/${id}/studio`) });

/** 1 秒ごとに進む今の時刻(経過時間の表示に使う)。 */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function duration(sec: number): string {
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

// ---- 知らせ(トースト)と、操作のまとめ ----

type Toast = { text: string; bad: boolean } | null;
const ToastCtx = createContext<{ toast: (text: string, bad?: boolean) => void }>({ toast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Toast>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast = useCallback((text: string, bad = false) => {
    setT({ text, bad });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setT(null), bad ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      {t && (
        <div className={`toast${t.bad ? " bad" : ""}`} role="status" aria-label="お知らせ">
          {t.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/**
 * 操作を 1 つ行い、成功したら知らせて取り直す。失敗したら理由を知らせる。
 * 戻り値は操作の結果(失敗なら undefined)。
 */
export function useAct() {
  const { toast } = useContext(ToastCtx);
  const qc = useQueryClient();
  return useCallback(
    async <R,>(fn: () => Promise<R>, ok?: string | ((r: R) => string)): Promise<R | undefined> => {
      try {
        const r = await fn();
        if (ok) toast(typeof ok === "function" ? ok(r) : ok);
        await qc.invalidateQueries();
        return r;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
        return undefined;
      }
    },
    [toast, qc],
  );
}

export function useToast() {
  return useContext(ToastCtx).toast;
}

// ---- 画面の切り替え(#/ · #/new · #/p/<id> · #/p/<id>/studio · #/p/<id>/t/<チケット>) ----

export type Route = { name: "home" } | { name: "new" } | { name: "project"; id: number } | { name: "studio"; id: number } | { name: "metrics"; id: number } | { name: "settings"; id: number } | { name: "ticket"; id: number; ticketId: number };

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "new") return { name: "new" };
  const tk = h.match(/^p\/(\d+)\/t\/(\d+)$/);
  if (tk) return { name: "ticket", id: Number(tk[1]), ticketId: Number(tk[2]) };
  const se = h.match(/^p\/(\d+)\/settings$/);
  if (se) return { name: "settings", id: Number(se[1]) };
  const mt = h.match(/^p\/(\d+)\/metrics$/);
  if (mt) return { name: "metrics", id: Number(mt[1]) };
  const st = h.match(/^p\/(\d+)\/studio$/);
  if (st) return { name: "studio", id: Number(st[1]) };
  const m = h.match(/^p\/(\d+)$/);
  if (m) return { name: "project", id: Number(m[1]) };
  return { name: "home" };
}

export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => {
      setR(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const go = (hash: string) => {
  location.hash = hash;
};
