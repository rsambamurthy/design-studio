import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { revisionLetter } from '@ds/core';
import SharedView from '@/components/SharedView';
import { getShared } from '@/lib/designs';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const shared = await getShared((await params).token);
  if (!shared) return { title: 'Link not available · Design Studio', robots: { index: false } };
  const title = `${shared.name} · Rev ${revisionLetter(shared.revision)}`;
  return {
    title,
    description: 'View-only floor plan shared from Design Studio by Integrata.',
    robots: { index: false, follow: false },
    openGraph: { title, description: 'View-only floor plan shared from Design Studio.' },
  };
}

export default async function SharedPage({ params }: Props) {
  const shared = await getShared((await params).token);
  if (!shared) notFound();
  return <SharedView name={shared.name} revision={shared.revision} pinned={shared.pinned} model={shared.model} />;
}
