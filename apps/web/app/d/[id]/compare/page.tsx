import { notFound, redirect } from 'next/navigation';
import CompareView from '@/components/CompareView';
import { AuthError, currentUser } from '@/lib/auth';
import { getDesign, getRevisionModel } from '@/lib/designs';

export const dynamic = 'force-dynamic';

export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');
  const { id } = await params;
  const sp = await searchParams;
  const na = Number(sp.a);
  const nb = Number(sp.b);
  if (!Number.isInteger(na) || !Number.isInteger(nb)) redirect(`/d/${id}`);
  try {
    const design = await getDesign(user.id, id);
    const meta = (n: number) => design.revisions.find((r) => r.number === n);
    const [ma, mb] = await Promise.all([getRevisionModel(user.id, id, na), getRevisionModel(user.id, id, nb)]);
    const side = (n: number, model: typeof ma) => ({ number: n, label: meta(n)?.label ?? null, summary: meta(n)?.summary ?? '', model });
    return <CompareView email={user.email} designId={id} name={design.name} a={side(na, ma)} b={side(nb, mb)} />;
  } catch (err) {
    if (err instanceof AuthError && err.status === 404) notFound();
    throw err;
  }
}
