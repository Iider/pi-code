import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const adapterRoot = resolve(projectRoot, 'webui', 'adapter', 'model-config');

describe('model config WebUI adapter contract', () => {
  for (const file of ['model-config.js']) {
    it(`keeps ${file} source and generated snapshots synchronized`, async () => {
      const source = await readFile(resolve(adapterRoot, 'src', file), 'utf8');
      expect(await readFile(resolve(adapterRoot, 'dist', file), 'utf8')).toBe(source);
      expect(await readFile(resolve(projectRoot, 'webui', 'dist', file), 'utf8')).toBe(source);
    });
  }

  it('builds both adapter and served snapshots from the same sources', async () => {
    const build = await readFile(resolve(adapterRoot, 'build.mjs'), 'utf8');
    expect(build).toContain("new URL('./dist/', import.meta.url)");
    expect(build).toContain("new URL('../../dist/', import.meta.url)");
    expect(build).toContain("new URL('../pi-code-brand.css', import.meta.url)");
  });

  it('keeps the served desktop brand stylesheet synchronized', async () => {
    const source = await readFile(resolve(projectRoot, 'webui', 'adapter', 'pi-code-brand.css'), 'utf8');
    expect(await readFile(resolve(projectRoot, 'webui', 'dist', 'pi-code-brand.css'), 'utf8')).toBe(source);
  });

  it('bridges model configuration and pi-native OAuth into the official settings UI', async () => {
    const script = await readFile(resolve(adapterRoot, 'src', 'model-config.js'), 'utf8');
    expect(script).toContain("onboardingNative");
    expect(script).toContain("openProviderSettings");
    expect(script).toContain("#app, [role=\"dialog\"], [role=\"menu\"]");
    expect(script).toContain('document.querySelectorAll(selector)');
    expect(script).toContain('hideUnsupportedProviderControls');
    expect(script).toContain('hideRedundantConfigureEntry');
    expect(script).toContain('.ui-menu.user-menu [role="menuitem"]');
    expect(script).toContain("separator?.matches('.ui-menu-sep, [role=\"separator\"]')");
    expect(script).toContain('TEXT.registry.test(text)');
    expect(script).toContain('TEXT.account.test(text)');
    expect(script).toContain('dataset.piOauthProvider');
    expect(script).toContain("'/api/v1/oauth/login'");
    expect(script).toContain('supports_oauth');
    expect(script).not.toContain('pcmc-launch');
    expect(script).not.toContain('piModelBridge');
    expect(script).not.toContain('document.documentElement.append');
    expect(script).not.toMatch(/window\.fetch\s*=/);
  });

  it('injects the adapter assets exactly once', async () => {
    const index = await readFile(resolve(projectRoot, 'webui', 'dist', 'index.html'), 'utf8');
    expect(index.match(/src="\/model-config\.js"/g)).toHaveLength(1);
  });

  it('marks native desktop drag regions without relying only on the routed URL', async () => {
    const script = await readFile(resolve(adapterRoot, 'src', 'model-config.js'), 'utf8');
    expect(script).toContain('window.__PI_CODE_DESKTOP__ === true');
    expect(script).toContain("document.querySelectorAll('.side .ch, .chat-header')");
    expect(script).toContain("setAttribute('data-tauri-drag-region', 'deep')");
  });

  it('keeps the accepted macOS titlebar geometry and browser branding boundary', async () => {
    const css = await readFile(resolve(projectRoot, 'webui', 'adapter', 'pi-code-brand.css'), 'utf8');
    const desktopMain = await readFile(resolve(projectRoot, 'desktop', 'src-tauri', 'src', 'main.rs'), 'utf8');
    expect(css).toContain('--panel-head-h: 42px');
    expect(css).toMatch(/html\.pi-code-desktop \.side \.ch-brand \{\s*display: none;/);
    expect(css).toMatch(/\.ch-brand::before \{/);
    expect(css).toMatch(/\.sidebar-toggle-btn \{\s*top: 8px;\s*left: 84px;/);
    expect(css).toMatch(/\.new-chat-btn \{\s*top: 8px;\s*left: 112px;/);
    expect(desktopMain).toContain('traffic_light_position(tauri::LogicalPosition::new(13.0, 23.0))');
    expect(desktopMain).toContain('.title("")');
  });
});
