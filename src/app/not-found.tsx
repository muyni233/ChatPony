import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="empty-state">
      <span className="error-number">404</span>
      <h2>这一页还没有故事</h2>
      <p>页面不存在，或链接已经失效。</p>
      <Link href="/" className="button button-primary">
        回到概览
      </Link>
    </div>
  );
}
