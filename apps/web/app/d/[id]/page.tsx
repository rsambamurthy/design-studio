import { notFound, redirect } from 'next/navigation';
import Studio from '@/components/Studio';
import { AuthError, currentUser } from '@/lib/auth';
import { getDesign } from '@/lib/designs';

export const dynamic = 'force-dynamic';

export default async function DesignPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  const { id } = await params;
  try {
    const design = await getDesign(user.id, id);
    return <Studio email={user.email} initial={design} />;
  } catch (err) {
    if (err instanceof AuthError && err.status === 404) notFound();
    throw err;
  }
}
