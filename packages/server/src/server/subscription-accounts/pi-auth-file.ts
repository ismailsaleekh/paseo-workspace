import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";

interface LockedResult<T> {
  result: T;
  next?: string;
}
interface PiAuthBackend {
  withLockAsync<T>(change: (current: string | undefined) => Promise<LockedResult<T>>): Promise<T>;
}
interface PiAuthModule {
  FileAuthStorageBackend: new (path: string) => PiAuthBackend;
}

function isAuthModule(value: unknown): value is PiAuthModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "FileAuthStorageBackend" in value &&
    typeof value.FileAuthStorageBackend === "function" &&
    typeof value.FileAuthStorageBackend.prototype?.withLockAsync === "function"
  );
}

/** Pi owns the lock convention. Import only its file-storage backend, never its agent runtime. */
async function loadBackend(path: string, binary: string): Promise<PiAuthBackend> {
  const executable = await findExecutable(binary);
  if (!executable) throw new Error("Install Pi 1.x to manage its subscription logins");
  const root = await piPackageRoot(await realpath(executable));
  const manifest = z
    .object({ name: z.literal("@earendil-works/pi-coding-agent"), version: z.string() })
    .parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  if (!/^1\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version))
    throw new Error("Account storage requires the standard Pi 1.x executable");
  const imported: unknown = await import(
    pathToFileURL(join(root, "dist/core/auth-storage.js")).href
  );
  if (!isAuthModule(imported))
    throw new Error("Installed Pi does not expose its expected auth-file backend");
  return new imported.FileAuthStorageBackend(path);
}

async function piPackageRoot(executable: string): Promise<string> {
  let directory = dirname(executable);
  for (let level = 0; level < 5; level += 1) {
    try {
      await lstat(join(directory, "package.json"));
      return directory;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      directory = dirname(directory);
    }
  }
  throw new Error("Cannot locate the standard Pi package beside its executable");
}

const AuthFileSchema = z.record(z.string(), z.unknown());
export type PiAuthRecords = z.infer<typeof AuthFileSchema>;

/** Account writes share Pi's refresh lock and preserve every unrelated credential entry. */
export class PiAuthFile {
  readonly path: string;
  private backend: Promise<PiAuthBackend> | null = null;
  constructor(
    path: string,
    private readonly binary = "pi",
  ) {
    this.path = resolve(path);
  }

  async ready(): Promise<void> {
    await this.storage();
  }

  async read<T>(inspect: (records: PiAuthRecords) => T | Promise<T>): Promise<T> {
    if (!(await this.exists())) return inspect({});
    return (await this.storage()).withLockAsync(async (current) => ({
      result: await inspect(this.parse(current)),
    }));
  }

  async change<T>(change: (records: PiAuthRecords) => T | Promise<T>): Promise<T> {
    await this.exists();
    return (await this.storage()).withLockAsync(async (current) => {
      const records = this.parse(current);
      const before = JSON.stringify(records);
      const result = await change(records);
      if (JSON.stringify(records) === before) return { result };
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          await handle.writeFile(JSON.stringify(records, null, 2));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
      return { result };
    });
  }

  private async storage(): Promise<PiAuthBackend> {
    this.backend ??= loadBackend(this.path, this.binary);
    try {
      return await this.backend;
    } catch (error) {
      this.backend = null;
      throw error;
    }
  }

  private parse(current: string | undefined): PiAuthRecords {
    try {
      return AuthFileSchema.parse(JSON.parse(current ?? "{}"));
    } catch {
      throw new Error("Pi's login file is invalid; it was not changed");
    }
  }

  private async exists(): Promise<boolean> {
    try {
      const stat = await lstat(this.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("Pi's login file must be a private regular file owned by this user");
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
}
