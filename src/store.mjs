import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMain(moduleUrl) {
  try { return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}

export const configDirectory = () => process.env.GOTO_CONFIG_DIR || path.join(os.homedir(), '.config', 'goto-mcp');

export class GoToError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
  publicResult() {
    return { code: this.code, message: this.message, http_status: this.status };
  }
}

export class PrivateStore {
  constructor(directory = configDirectory()) { this.directory = directory; }
  async read(name) {
    try { return JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new GoToError('LOCAL_STATE_ERROR', `Cannot read private ${name}; no credentials were printed.`);
    }
  }
  async write(name, value) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const target = path.join(this.directory, name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async withTokenLock(callback) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, 'token-refresh.lock');
    const start = Date.now();
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(lock, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: Date.now() }));
      } catch (error) {
        if (error.code !== 'EEXIST') {
          if (handle) { await handle.close(); handle = null; await fs.unlink(lock).catch(() => {}); }
          throw error;
        }
        // Only remove this connector's abandoned lock, never another live process's lock.
        try {
          const record = JSON.parse(await fs.readFile(lock, 'utf8'));
          if (Number.isInteger(record.pid) && record.pid > 0 && Date.now() - record.created_at > 30_000) {
            try { process.kill(record.pid, 0); }
            catch (probe) { if (probe.code === 'ESRCH') { await fs.unlink(lock); continue; } }
          }
        } catch { /* A live writer may still be filling the lock. */ }
        if (Date.now() - start > 10_000) throw new GoToError('AUTH_BUSY', 'Another GoTo authorization refresh is running. Retry this read later.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try { return await callback(); }
    finally { await handle.close(); await fs.unlink(lock); }
  }
}
