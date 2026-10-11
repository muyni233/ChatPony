'use client';
import { Button, EmptyState } from '@/components/ui';
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <EmptyState
      title="页面暂时没有打开"
      description="出现了意外问题，你可以重试。已保存的对话不会丢失。"
      action={<Button onClick={reset}>重新加载</Button>}
    />
  );
}
