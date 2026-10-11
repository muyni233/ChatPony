'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, AlertCircle, X } from 'lucide-react';
import { api } from '@/lib/client';
import type { Bootstrap } from '@/lib/types';

type AppContextType = {
  data: Bootstrap | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: 'success' | 'error') => void;
  openAuth: (mode?: 'login' | 'register') => void;
  authMode: 'login' | 'register' | null;
  closeAuth: () => void;
};
const AppContext = createContext<AppContextType | null>(null);
export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: string; id: number } | null>(null);
  const refreshSequence = useRef(0);
  const lastRefresh = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    lastRefresh.current = Date.now();
    try {
      const result = await api<Bootstrap>('/bootstrap');
      if (sequence === refreshSequence.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (sequence === refreshSequence.current) setError((e as Error).message);
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const updateVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh.current > 5000)
        void refresh();
    };
    window.addEventListener('focus', updateVisible);
    document.addEventListener('visibilitychange', updateVisible);
    const timer = setInterval(updateVisible, 60000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', updateVisible);
      document.removeEventListener('visibilitychange', updateVisible);
    };
  }, [refresh]);
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(
      localStorage.getItem('chatpony-reduced-motion') === 'true',
    );
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 6500 : 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const notify = useCallback(
    (message: string, kind: 'success' | 'error' = 'success') =>
      setToast({ message, kind, id: Date.now() }),
    [],
  );
  return (
    <AppContext.Provider
      value={{
        data,
        loading,
        error,
        refresh,
        notify,
        openAuth: (mode = 'login') => setAuthMode(mode),
        authMode,
        closeAuth: () => setAuthMode(null),
      }}
    >
      {children}
      <div
        className={`toast ${toast ? 'toast-visible' : ''} ${toast?.kind === 'error' ? 'toast-error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {toast?.kind === 'error' ? <AlertCircle size={19} /> : <Check size={19} />}
        <span>{toast?.message}</span>
        <button aria-label="关闭通知" className="icon-button" onClick={() => setToast(null)}>
          <X size={16} />
        </button>
      </div>
    </AppContext.Provider>
  );
}
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppProvider is required');
  return value;
}
