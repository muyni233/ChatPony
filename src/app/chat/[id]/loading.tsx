import { ChatSkeleton } from '@/components/chat-view';

/** Shown instantly while the dynamic route segment resolves, so a click never feels frozen. */
export default function Loading() {
  return <ChatSkeleton />;
}
