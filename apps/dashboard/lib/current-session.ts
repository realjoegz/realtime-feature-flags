import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ApiError } from './api';
import { loadConfig } from './config';
import { openSession, SESSION_COOKIE, type Session } from './cookies';

// The session of the request being served, for pages and server actions.

/** The request's session, or null when it has none, or one that is altered or expired. */
export async function currentSession(): Promise<Session | null> {
  const store = await cookies();
  return openSession(store.get(SESSION_COOKIE)?.value, loadConfig().sessionSecret);
}

/** The request's session; without a valid one, the browser goes through sign-in. */
export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (session === null) redirect('/auth/login');
  return session;
}

/**
 * Runs a page's API calls. A 404 renders the not-found page, which is also what a
 * tenant the user is not in gets. A 401 means the API no longer accepts the session's
 * token (the user erased itself, or the identity provider's keys changed), so the
 * page explains that instead of starting a sign-in that would end the same way.
 */
export async function fromApi<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    if (error instanceof ApiError && error.status === 401) redirect('/signed-out?reason=refused');
    throw error;
  }
}
