/**
 * Shown after sign-out, and when the API stops accepting a session's token. It reads
 * no session and calls nothing, so the compose healthcheck uses it.
 */
export default async function SignedOutPage({ searchParams }: PageProps<'/signed-out'>) {
  const { reason } = await searchParams;
  return (
    <main className="narrow">
      <h1>Feature flags</h1>
      {reason === 'refused' ? (
        <p>
          The API no longer accepts this sign-in. The session may have ended at the identity
          provider, or the account may have been removed.
        </p>
      ) : (
        <p>You are signed out.</p>
      )}
      <p>
        <a href="/auth/login" className="button">
          Sign in
        </a>
      </p>
    </main>
  );
}
