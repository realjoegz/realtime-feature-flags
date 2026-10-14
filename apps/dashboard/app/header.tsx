import Link from 'next/link';
import type { Session } from '../lib/cookies';

/** The bar above every signed-in page: the tenant list, the user and sign-out. */
export function Header({ session }: { session: Session }) {
  return (
    <header className="bar">
      <Link href="/" className="brand">
        Feature flags
      </Link>
      <div className="who">
        <span>
          {session.name || session.email}
          {session.name && session.email ? <span className="muted"> {session.email}</span> : null}
        </span>
        <form method="post" action="/auth/logout">
          <button type="submit" className="link">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
