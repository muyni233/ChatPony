import { AppShell } from '@/components/app-shell';
import { Discover } from '@/components/discover';

export default function PreviewPage() {
  return (
    <AppShell preview>
      <Discover />
    </AppShell>
  );
}
