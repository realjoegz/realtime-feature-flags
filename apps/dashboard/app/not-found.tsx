import Link from 'next/link';

/** A tenant that does not exist and a tenant the user is not in look the same. */
export default function NotFound() {
  return (
    <main className="narrow">
      <h1>Not found</h1>
      <p>
        <Link href="/">Back to your tenants</Link>
      </p>
    </main>
  );
}
