<!-- Full-screen first-run setup. Preferences apply immediately and remain available from Settings. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { setLocale, type LocaleCode } from '../../i18n';
import { useAppearance, type ColorScheme } from '../../composables/client/useAppearance';

const emit = defineEmits<{ complete: []; skip: [] }>();
const { t, locale } = useI18n();
const { colorScheme, setColorScheme } = useAppearance();
const localeOptions: Array<{ value: LocaleCode; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '简体中文' },
];
const schemeOptions: ColorScheme[] = ['system', 'light', 'dark'];

function chooseLocale(code: LocaleCode): void {
  if (locale.value !== code) setLocale(code);
}
</script>

<template>
  <Teleport to="body">
    <div class="ob-page" role="dialog" aria-modal="true" :aria-label="t('onboarding.title')">
      <main class="ob-panel">
        <header class="ob-head">
          <div class="ob-logo" aria-hidden="true"><i></i><i></i></div>
          <h1>{{ t('onboarding.title') }}</h1>
          <p>{{ t('onboarding.subtitle') }}</p>
        </header>

        <section class="ob-section">
          <h2>{{ t('onboarding.languageLabel') }}</h2>
          <div class="ob-language-grid">
            <button v-for="option in localeOptions" :key="option.value" type="button"
              class="ob-choice ob-language" :class="{ selected: locale === option.value }"
              :aria-pressed="locale === option.value" @click="chooseLocale(option.value)">
              <span class="ob-radio" aria-hidden="true"></span><span>{{ option.label }}</span>
            </button>
          </div>
        </section>

        <section class="ob-section">
          <h2>{{ t('theme.colorSchemeLabel') }}</h2>
          <div class="ob-theme-grid">
            <button v-for="scheme in schemeOptions" :key="scheme" type="button"
              class="ob-choice ob-theme" :class="{ selected: colorScheme === scheme }"
              :aria-pressed="colorScheme === scheme" @click="setColorScheme(scheme)">
              <span class="ob-theme-preview" :class="`is-${scheme}`" aria-hidden="true">
                <span class="preview-sidebar"><i></i><i></i><i></i></span>
                <span class="preview-content"><i></i><i></i><i></i></span>
              </span>
              <span>{{ t(`theme.${scheme}`) }}</span>
            </button>
          </div>
        </section>

        <footer class="ob-actions">
          <button type="button" class="ob-continue" @click="emit('complete')">{{ t('onboarding.continue') }}</button>
          <button type="button" class="ob-skip" @click="emit('skip')">{{ t('onboarding.skip') }}</button>
        </footer>
      </main>
    </div>
  </Teleport>
</template>

<style scoped>
.ob-page {
  position: fixed; inset: 0; z-index: var(--z-modal); overflow: auto;
  background: var(--color-surface-sunken); color: var(--color-text);
}
.ob-panel {
  box-sizing: border-box; width: min(560px, 100%); min-height: 100%; margin: 0 auto;
  padding: 110px 20px 32px; display: flex; flex-direction: column;
}
.ob-head { text-align: center; }
.ob-logo {
  width: 68px; height: 46px; margin: 0 auto 18px; border-radius: var(--radius-lg);
  background: var(--color-accent); display: flex; align-items: center; justify-content: center; gap: 7px;
}
.ob-logo i {
  width: 6px; height: 18px; border-radius: var(--radius-full); background: var(--color-text-on-accent);
}
.ob-head h1 { margin: 0; font-size: 21px; line-height: 1.4; font-weight: var(--weight-semibold); }
.ob-head p { margin: 5px 0 0; color: var(--color-text-muted); font-size: var(--text-base); }
.ob-section { margin-top: 30px; }
.ob-section h2 { margin: 0 0 10px; font-size: var(--text-sm); font-weight: var(--weight-medium); }
.ob-language-grid, .ob-theme-grid { display: grid; gap: 12px; }
.ob-language-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.ob-theme-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ob-choice {
  appearance: none; border: 1px solid var(--color-line-strong); background: var(--color-surface-raised);
  color: var(--color-text); cursor: pointer; font: inherit;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.ob-choice:hover { border-color: var(--color-accent); }
.ob-choice:focus-visible { outline: none; box-shadow: var(--p-focus-ring-strong); }
.ob-choice.selected { border-color: var(--color-accent); background: var(--color-accent-soft); }
.ob-language {
  height: 58px; padding: 0 16px; border-radius: var(--radius-lg); display: flex;
  align-items: center; gap: 12px; text-align: left;
}
.ob-radio {
  width: 18px; height: 18px; box-sizing: border-box; border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-full); background: var(--color-surface-raised);
}
.selected .ob-radio { border: 5px solid var(--color-accent); }
.ob-theme { padding: 12px 12px 14px; border-radius: var(--radius-lg); font-weight: var(--weight-medium); }
.ob-theme-preview {
  height: 86px; margin-bottom: 11px; overflow: hidden; display: grid; grid-template-columns: 34% 66%;
  border: 1px solid var(--color-line); border-radius: var(--radius-md); text-align: left;
}
.preview-sidebar, .preview-content { display: flex; flex-direction: column; gap: 7px; padding: 15px 10px; }
.preview-sidebar i, .preview-content i { display: block; height: 6px; border-radius: var(--radius-full); }
.preview-sidebar i { background: color-mix(in srgb, black 20%, white); }
.preview-content i { background: color-mix(in srgb, black 15%, white); }
.preview-content i:nth-child(1) { width: 65%; }
.preview-content i:nth-child(2) { width: 85%; }
.preview-content i:nth-child(3) { width: 48%; }
.is-light .preview-sidebar { background: color-mix(in srgb, black 7%, white); }
.is-light .preview-content { background: white; }
.is-dark .preview-sidebar { background: color-mix(in srgb, white 12%, black); }
.is-dark .preview-content { background: color-mix(in srgb, white 7%, black); }
.is-dark .preview-sidebar i, .is-dark .preview-content i { background: color-mix(in srgb, white 28%, black); }
.is-system .preview-sidebar, .is-system .preview-content { position: relative; background: white; }
.is-system .preview-sidebar::after, .is-system .preview-content::after {
  content: ''; position: absolute; inset: 0 0 0 50%; background: color-mix(in srgb, white 9%, black);
}
.is-system .preview-sidebar i, .is-system .preview-content i { position: relative; z-index: var(--z-base); }
.ob-actions {
  margin-top: auto; padding-top: 64px; display: flex; flex-direction: column; align-items: center;
}
.ob-continue, .ob-skip { border: 0; font: inherit; cursor: pointer; }
.ob-continue {
  width: 140px; height: 42px; border-radius: var(--radius-lg); background: var(--color-accent);
  color: var(--color-text-on-accent); font-weight: var(--weight-medium);
}
.ob-continue:hover { background: var(--color-accent-hover); }
.ob-continue:focus-visible, .ob-skip:focus-visible { outline: none; box-shadow: var(--p-focus-ring-strong); }
.ob-skip { margin-top: 12px; padding: 5px 12px; background: transparent; color: var(--color-text-muted); }
.ob-skip:hover { color: var(--color-text); }
@media (max-width: 600px) {
  .ob-panel { padding: 48px 16px 24px; }
  .ob-theme-grid { grid-template-columns: 1fr; }
  .ob-theme { display: grid; grid-template-columns: 128px 1fr; align-items: center; gap: 16px; text-align: left; }
  .ob-theme-preview { height: 66px; margin: 0; }
  .ob-actions { padding-top: 40px; }
}
@media (prefers-reduced-motion: reduce) { .ob-choice { transition: none; } }
</style>
