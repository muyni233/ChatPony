import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="standalone-state">
      <span className="eyebrow">404 · LOST IN EQUESTRIA</span>
      <h1>这一页，还没有故事。</h1>
      <p>你访问的页面不存在，或已经被移走了。</p>
      <Link href="/" className="button button-primary">
        回到首页
      </Link>
    </div>
  );
}
