import { redirect } from 'next/navigation';
import DesignsHome from '@/components/DesignsHome';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <DesignsHome email={user.email} />;
}
