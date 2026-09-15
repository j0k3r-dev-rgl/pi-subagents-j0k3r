import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createJiti } from 'jiti';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
// Windows: npm is an npm.cmd shim, so spawn it through the shell.
const shellOption = process.platform === 'win32' ? { shell: true } : {};

// VAL-008: prove the public API resolves from a packed/installed separate
// consumer via the package name. Plain node cannot strip types under
// node_modules, so the consumer loads through jiti — the same class of
// TS-capable loader Pi itself uses for TypeScript extensions.
describe('packed package consumer (IMPL-005)', () => {
  it('exposes the V1 service API from an installed tarball', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-pack-'));
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
      const tarball = path.join(tmp, `pi-subagents-j0k3r-${packageJson.version}.tgz`);
      await execFileAsync('npm', ['pack', '--pack-destination', tmp], { cwd: repoRoot, ...shellOption });
      expect(fs.existsSync(tarball)).toBe(true);

      const consumerDir = path.join(tmp, 'consumer');
      fs.mkdirSync(consumerDir, { recursive: true });
      fs.writeFileSync(
        path.join(consumerDir, 'package.json'),
        JSON.stringify({ name: 'pack-consumer-fixture', version: '0.0.0', type: 'module' }),
      );
      await execFileAsync('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: consumerDir, ...shellOption });
      // Mirror the Pi extension host: peers exist at runtime. typebox is a
      // runtime import of the tool chain, so stage it offline from this repo.
      fs.cpSync(path.join(repoRoot, 'node_modules', 'typebox'), path.join(consumerDir, 'node_modules', 'typebox'), {
        recursive: true,
      });

      const jiti = createJiti(path.join(consumerDir, 'package.json'));
      const j0k3r = jiti('pi-subagents-j0k3r') as Record<string, any>;
      expect(j0k3r.SUBAGENTS_SERVICE_API_VERSION).toBe(1);
      expect(typeof j0k3r.getSubagentsService).toBe('function');
      expect(typeof j0k3r.publishSubagentsService).toBe('function');
      expect(typeof j0k3r.unpublishSubagentsService).toBe('function');
      expect(typeof j0k3r.createSubagentsService).toBe('function');
      // Fresh process, j0k3r extension inactive: absence is undefined, not a throw.
      expect(j0k3r.getSubagentsService()).toBeUndefined();
      // Packed service modules are present in the tarball.
      expect(fs.existsSync(path.join(consumerDir, 'node_modules', 'pi-subagents-j0k3r', 'src', 'service.ts'))).toBe(true);
      expect(fs.existsSync(path.join(consumerDir, 'node_modules', 'pi-subagents-j0k3r', 'src', 'capabilities.ts'))).toBe(true);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }, 180_000);

  it('fails the consumer contract when the root service export is missing (negative control)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-pack-negative-'));
    try {
      const stubDir = path.join(tmp, 'node_modules', 'pi-subagents-j0k3r');
      fs.mkdirSync(stubDir, { recursive: true });
      fs.writeFileSync(
        path.join(stubDir, 'package.json'),
        JSON.stringify({ name: 'pi-subagents-j0k3r', version: '0.0.0', main: 'index.js' }),
      );
      fs.writeFileSync(path.join(stubDir, 'index.js'), 'export default function subagentsExtension() {}\n');
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'negative-fixture', type: 'module' }));
      const jiti = createJiti(path.join(tmp, 'package.json'));
      const stub = jiti('pi-subagents-j0k3r') as Record<string, any>;
      // The consumer check genuinely gates on these: a build that drops the
      // export cannot pass the positive test above.
      expect(stub.SUBAGENTS_SERVICE_API_VERSION).toBeUndefined();
      expect(typeof stub.getSubagentsService).not.toBe('function');
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }, 60_000);
});
