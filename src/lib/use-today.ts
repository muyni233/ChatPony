'use client';

import { useEffect, useState } from 'react';

/** Resolve the local date after hydration, so prerendered pages never show the build date. */
export function useToday() {
  const [date, setDate] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => setDate(new Date());
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, []);
  return date;
}
