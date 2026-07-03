import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as Record<string, any>;
const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

describe('pi package manifest', () => {
  it('is a public pi package named after the project directory', () => {
    expect(packageJson.name).toBe(path.basename(process.cwd()));
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.license).toBe('MIT');
    expect(packageJson.keywords).toEqual(expect.arrayContaining(['pi-package', 'pi-extension', 'subagents']));
  });

  it('declares pi resources for install and gallery discovery', () => {
    expect(packageJson.pi).toMatchObject({
      extensions: ['./index.ts'],
      skills: ['./skills'],
    });
    expect(packageJson.description).toMatch(/subagents/i);
  });

  it('does not bundle pi core runtime packages', () => {
    expect(packageJson.peerDependencies).toMatchObject({
      '@earendil-works/pi-coding-agent': '*',
      typebox: '*',
    });
    expect(packageJson.peerDependenciesMeta).toMatchObject({
      '@earendil-works/pi-coding-agent': { optional: true },
      typebox: { optional: true },
    });
    expect(packageJson.dependencies?.typebox).toBeUndefined();
  });

  it('limits the npm package to runtime resources and docs', () => {
    expect(packageJson.files).toEqual(expect.arrayContaining([
      'index.ts',
      'src',
      'bin',
      'skills',
      'scripts/verify-package-files.mjs',
      '.releaserc.json',
      'README.md',
      'LICENSE',
    ]));
    expect(packageJson.bin).toMatchObject({ 'subagents-terminal-viewer': './bin/subagents-terminal-viewer.mjs' });
    expect(packageJson.files).not.toContain('node_modules');
    expect(packageJson.files).not.toContain('test');
  });

  it('documents the PR1 terminal viewer as an honest shell/bootstrap only', () => {
    const externalViewerSection = readme.slice(readme.indexOf('### External terminal history viewer'));

    expect(externalViewerSection).toContain('PR 1 opens the read-only terminal viewer shell/bootstrap');
    expect(externalViewerSection).toContain('current-session history rendering/querying lands in PR 2/PR 3');
    expect(externalViewerSection).not.toMatch(/PR 1[^\n.]*displays[^\n.]*prompts/i);
    expect(externalViewerSection).not.toMatch(/The external viewer may display persisted prompts, transcripts, results, errors, and tool output in a separate OS window\./);
  });
});
