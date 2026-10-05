import type { Metadata, Viewport } from 'next';
import { SessionProvider } from '@/components/session-provider';
import './globals.css';
import '@/styles/account.css';
import '@/styles/polish.css';
import '@/styles/select.css';
import '@/styles/quota.css';

export const metadata: Metadata = {
  title: { default: 'ChatPony — 每一次相遇，都是故事的开始', template: '%s · ChatPony' },
  description:
    '一个以小马宝莉为主题的角色对话空间。与喜欢的角色聊天，开启多角色故事，保存属于你们的记忆。',
  robots: { index: false, follow: false },
  icons: { icon: '/icon.svg' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f6f5ef' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
