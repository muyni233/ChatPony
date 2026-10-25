'use client';
import { TriangleAlert } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="card status-page" role="alert">
      <EmptyState
        icon={<TriangleAlert size={22} strokeWidth={1.7} />}
        title="页面加载失败"
        description="已保存的对话不受影响。"
        action={<Button onClick={reset}>重新加载</Button>}
      />
    </div>
  );
}
