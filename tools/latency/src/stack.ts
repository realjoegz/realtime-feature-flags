import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { Colima, LatencyResults, Machine } from './results.ts';

// What the tool reads from the machine and the compose stack: the conditions that
// the results file records, and the replicas' logs.

const exec = promisify(execFile);

async function output(command: string, args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await exec(command, args, {
    cwd,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return stdout.trim();
}

/** The logs of the compose services, without the service prefix. */
export function composeLogs(root: string, services: readonly string[]): Promise<string> {
  return output('docker', ['compose', 'logs', '--no-color', '--no-log-prefix', ...services], root);
}

function composeExec(root: string, service: string, args: readonly string[]): Promise<string> {
  return output('docker', ['compose', 'exec', '-T', service, ...args], root);
}

/** RFF_SAFETY_POLL_MS in the environment of a running replica. */
export async function safetyPollMs(root: string, service: string): Promise<number> {
  const value = await composeExec(root, service, ['printenv', 'RFF_SAFETY_POLL_MS']);
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`${service} has RFF_SAFETY_POLL_MS ${JSON.stringify(value)}`);
  }
  return ms;
}

export async function stackVersions(root: string): Promise<LatencyResults['versions']> {
  const [postgres, redis, docker] = await Promise.all([
    composeExec(root, 'postgres', ['postgres', '--version']),
    composeExec(root, 'redis', ['redis-server', '--version']),
    output('docker', ['version', '--format', '{{.Server.Version}}']),
  ]);
  return {
    node: process.versions.node,
    postgres: matched(/\(PostgreSQL\)\s+(\S+)/, postgres, 'postgres --version'),
    redis: matched(/\bv=(\S+)/, redis, 'redis-server --version'),
    docker,
  };
}

function matched(pattern: RegExp, text: string, what: string): string {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) throw new Error(`no version in the output of ${what}: ${text}`);
  return value;
}

/**
 * ulimit -n and -Hn in a shell this process starts, which inherits its limits. Node
 * raises its own soft limit towards the hard one at start-up, so these are the
 * process's limits, not those of the shell that started it (256 under launchctl's
 * default on macOS). On macOS, kern.maxfilesperproc caps every process whatever its
 * limits.
 */
export async function openFileLimit(): Promise<LatencyResults['openFileLimit']> {
  const [soft, hard] = (await output('sh', ['-c', 'ulimit -n; ulimit -Hn'])).split('\n');
  if (soft === undefined || hard === undefined) throw new Error('ulimit printed nothing');
  const maxFilesPerProc =
    process.platform === 'darwin' ? await output('sysctl', ['-n', 'kern.maxfilesperproc']) : null;
  return { soft: soft.trim(), hard: hard.trim(), maxFilesPerProc };
}

/** HEAD, and whether the work tree has changes outside bench/results. */
export async function commit(root: string): Promise<LatencyResults['commit']> {
  const sha = await output('git', ['rev-parse', 'HEAD'], root);
  const status = await output(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)bench/results'],
    root,
  );
  return { sha, clean: status === '' };
}

export async function machine(): Promise<Machine> {
  if (process.platform !== 'darwin') {
    return {
      name: null,
      model: null,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.availableParallelism(),
      memoryBytes: os.totalmem(),
      os: `${os.type()} ${os.release()}`,
    };
  }
  const [model, cpu, cores, memory] = (
    await output('sysctl', ['-n', 'hw.model', 'machdep.cpu.brand_string', 'hw.ncpu', 'hw.memsize'])
  ).split('\n');
  const version = await output('sw_vers', ['-productVersion']);
  // Only the marketing name is read from the hardware overview.
  const hardware = JSON.parse(await output('system_profiler', ['SPHardwareDataType', '-json'])) as {
    SPHardwareDataType?: { machine_name?: string }[];
  };
  return {
    name: hardware.SPHardwareDataType?.[0]?.machine_name ?? null,
    model: model ?? null,
    cpu: cpu ?? 'unknown',
    cores: Number(cores),
    memoryBytes: Number(memory),
    os: `macOS ${version}`,
  };
}

/** The running Colima instance's allocation, or null without Colima. */
export async function colima(): Promise<Colima | null> {
  let list: string;
  let version: string;
  try {
    [list, version] = await Promise.all([
      output('colima', ['list', '--json']),
      output('colima', ['version']),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const instances = list
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(
      (line) =>
        JSON.parse(line) as {
          status: string;
          cpus: number;
          memory: number;
          disk: number;
          arch: string;
        },
    )
    .filter((instance) => instance.status === 'Running');
  const [running] = instances;
  if (running === undefined || instances.length > 1) {
    throw new Error(`expected one running Colima instance, found ${instances.length}`);
  }
  return {
    version: matched(/colima version (\S+)/, version, 'colima version'),
    cpus: running.cpus,
    memoryBytes: running.memory,
    diskBytes: running.disk,
    arch: running.arch,
  };
}
