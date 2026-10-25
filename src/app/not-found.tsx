import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="card status-page">
      <div className="empty-state">
        <span className="error-number">404</span>
        <h2>页面不存在</h2>
        <p>链接可能已失效。</p>
        <div className="empty-actions">
          <Link href="/" className="button button-primary">
            返回首页
          </Link>
          <Link href="/characters" className="button button-secondary">
            角色广场
          </Link>
        </div>
      </div>
    </div>
  );
}
