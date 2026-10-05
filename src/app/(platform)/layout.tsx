import { AppShell } from '@/components/app-shell';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/server/auth';

export const runtime = 'nodejs';
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const request = new Request('http://chatpony.internal/', { headers: await headers() });
  if (!currentUser(request)) redirect('/login');
  return <AppShell>{children}</AppShell>;
}
