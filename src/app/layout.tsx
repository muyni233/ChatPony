import type { Metadata, Viewport } from 'next';
import { AppProvider } from '@/components/app-provider';
import { Shell } from '@/components/shell';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ChatPony · 让友谊发生', template: '%s · ChatPony' },
  description:
    '一个以 MLP 为主题的角色对话平台。与你喜爱的角色相遇，让每一次对话成为友谊的新篇章。',
  icons: { icon: '/icon.svg' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f8f7f2' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">
          跳至主要内容
        </a>
        <AppProvider>
          <Shell>{children}</Shell>
        </AppProvider>
      </body>
    </html>
  );
}
