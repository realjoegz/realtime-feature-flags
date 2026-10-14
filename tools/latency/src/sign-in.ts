import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * An access token for the API, from Dex's authorization code flow with PKCE, driven
 * with curl by api_token in scripts/lib/dex-sign-in.sh, the function that
 * scripts/demo.sh uses. The login and password reach the shell in its environment.
 */
export async function accessToken(root: string, login: string, password: string): Promise<string> {
  const work = await mkdtemp(path.join(tmpdir(), 'rff-latency-'));
  try {
    const { stdout } = await run(
      'bash',
      [
        '-c',
        'set -euo pipefail; source "$1"; api_token "$RFF_LOGIN" "$RFF_PASSWORD" "$2"',
        'dex-sign-in',
        path.join(root, 'scripts/lib/dex-sign-in.sh'),
        path.join(work, 'dex.jar'),
      ],
      { env: { ...process.env, RFF_LOGIN: login, RFF_PASSWORD: password } },
    );
    const token = stdout.trim();
    if (token === '') throw new Error(`Dex gave ${login} no access token`);
    return token;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(
      `signing in ${login} through Dex failed: ${stderr || (error as Error).message}`,
      {
        cause: error,
      },
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
