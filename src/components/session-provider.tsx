'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/client';
import type { User } from '@/lib/types';

interface SessionData {
  user: User | null;
  bootstrapRequired?: boolean;
  site?: {
    name: string;
    description: string;
    registrationEnabled: boolean;
    requireEmailVerification: boolean;
    bubbleSeparator: string;
    hiddenOutputMarkers: string[];
    allowedEmailDomains: string[];
  };
}
const SessionContext = createContext<
  SessionData & { loading: boolean; refresh: () => Promise<void> }
>({ user: null, loading: true, refresh: async () => {} });
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionData>({ user: null });
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();
  const refresh = useCallback(async () => {
    try {
      const data = await api<SessionData>('/api/session');
      setSession(data);
    } catch {
      /* A temporary network failure must not discard an already verified session. */
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<SessionData>('/api/session', { signal: controller.signal })
      .then(setSession)
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [pathname]);
  useEffect(() => {
    const handler = () => {
      void refresh();
    };
    window.addEventListener('chatpony:session', handler);
    return () => window.removeEventListener('chatpony:session', handler);
  }, [refresh]);
  useEffect(() => {
    const expired = () => setSession((value) => ({ ...value, user: null }));
    const resume = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void refresh();
    };
    window.addEventListener('chatpony:unauthorized', expired);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', restored);
    return () => {
      window.removeEventListener('chatpony:unauthorized', expired);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', restored);
    };
  }, [refresh]);
  useEffect(() => {
    if (session.site)
      document.title = `${session.site.name} — ${session.site.description || '每一次相遇，都是故事的开始'}`;
  }, [session.site]);
  return (
    <SessionContext.Provider value={{ ...session, loading, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}
export const useSession = () => useContext(SessionContext);
