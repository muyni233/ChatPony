'use client';
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="standalone-state" role="alert">
      <span className="eyebrow">A LITTLE PAUSE</span>
      <h1>故事暂时停顿了一下</h1>
      <p>页面遇到了一点问题，请重新加载。</p>
      <button onClick={reset} className="button button-primary">
        重试
      </button>
    </div>
  );
}
