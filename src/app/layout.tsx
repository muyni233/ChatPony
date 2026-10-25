import type { Metadata, Viewport } from 'next';
import { AppProvider } from '@/components/app-provider';
import { Shell } from '@/components/shell';
import './tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ChatPony', template: '%s · ChatPony' },
  description: 'MLP 主题的 AI 角色对话平台，支持私聊、群聊与长期记忆。',
  icons: { icon: '/icon.svg' },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f8fa' },
    { media: '(prefers-color-scheme: dark)', color: '#101013' },
  ],
};

/** Applies the saved theme and motion preference before the first paint. */
const preferenceScript = `(function(){try{var d=document.documentElement,t=localStorage.getItem("chatpony-theme");if(t==="light"||t==="dark")d.setAttribute("data-theme",t);if(localStorage.getItem("chatpony-reduced-motion")==="true")d.setAttribute("data-reduce-motion","true")}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: preferenceScript }} />
      </head>
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
