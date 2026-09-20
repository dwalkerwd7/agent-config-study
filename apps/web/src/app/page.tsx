import { auth, signIn, signOut } from '@/auth';

export default async function Home() {
  const session = await auth();

  return (
    <main>
      <h1>driftwood</h1>
      <p style={{ color: 'var(--muted)' }}>Scaffold is up. Nothing is built on it yet.</p>

      {session?.user ? (
        <form
          action={async () => {
            'use server';
            await signOut();
          }}
        >
          <p>
            Signed in as <strong>{session.user.name ?? session.user.email}</strong>
          </p>
          <button type="submit">Sign out</button>
        </form>
      ) : (
        <form
          action={async () => {
            'use server';
            await signIn('github');
          }}
        >
          <button type="submit">Sign in with GitHub</button>
        </form>
      )}
    </main>
  );
}
