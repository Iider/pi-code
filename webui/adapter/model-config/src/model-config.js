// Extend the official Settings > Providers UI with pi agent configuration flows.

const TEXT = {
  onboardingNative: /(配置 pi agent 模型服务|configure pi agent model service)/i,
  onboardingCustom: /(添加自定义供应商|add a custom provider)/i,
  redundantConfigure: /^(配置|configure)$/i,
  settings: /^(设置|settings)$/i,
  account: /^(账户|account)$/i,
  providers: /^(供应商|providers)$/i,
  addProvider: /^(添加供应商|add provider)$/i,
  catalog: /^(从目录添加|from directory)$/i,
  registry: /^(注册表|registry)$/i,
  manual: /^(手动添加|manual)$/i,
};

const OFFICIAL_SURFACE = '#app, [role="dialog"], [role="menu"]';
const IS_TAURI_DESKTOP = window.__PI_CODE_DESKTOP__ === true
  || new URLSearchParams(location.search).get('desktop') === '1'
  || typeof window.__TAURI_INTERNALS__?.invoke === 'function';
let forwardingOnboarding = false;
let oauthProviders = new Map();
let oauthDialog = null;
let oauthFlow = null;
let oauthPollTimer = null;
let adapterRefreshQueued = false;
let archivedSessions = null;
let archivedSessionsLoading = null;
const deletedArchivedSessionIds = new Set();

if (IS_TAURI_DESKTOP) document.documentElement.classList.add('pi-code-desktop');

void loadOAuthProviders();

new MutationObserver(queueAdapterRefresh).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
queueAdapterRefresh();

document.addEventListener('click', (event) => {
  const target = event.target.closest?.('button, a, [role="menuitem"]');
  if (!target?.closest(OFFICIAL_SURFACE) || forwardingOnboarding) return;
  const text = target.textContent.trim();

  const oauthProviderId = target.dataset.piOauthProvider;
  if (oauthProviderId) {
    event.preventDefault();
    event.stopImmediatePropagation();
    openOAuthDialog(oauthProviderId);
    return;
  }

  if (TEXT.settings.test(text) || TEXT.addProvider.test(text)) {
    defer(hideUnsupportedProviderControls);
  }

  if (TEXT.onboardingNative.test(text)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const customEntry = visibleControls().find((control) => TEXT.onboardingCustom.test(control.textContent.trim()));
    if (!customEntry) return;
    forwardingOnboarding = true;
    customEntry.click();
    forwardingOnboarding = false;
    openAddProvider('catalog');
    return;
  }

  if (TEXT.onboardingCustom.test(text)) {
    openAddProvider('manual');
    return;
  }

}, true);

window.addEventListener('pi-code-open-provider-settings', () => openProviderSettings());

async function loadOAuthProviders() {
  try {
    const data = await apiRequest('/api/v1/catalog/providers');
    oauthProviders = new Map(
      (data.items ?? [])
        .filter((provider) => provider.supports_oauth)
        .map((provider) => [provider.id, provider]),
    );
    queueAdapterRefresh();
  } catch {
    // The settings page still works for API-key providers when the catalog
    // endpoint is unavailable. OAuth entries simply keep their native state.
  }
}

function queueAdapterRefresh() {
  if (adapterRefreshQueued) return;
  adapterRefreshQueued = true;
  requestAnimationFrame(() => {
    adapterRefreshQueued = false;
    normalizeAgentSettingsEntry();
    normalizePermissionLabels();
    normalizeDesktopNotificationCopy();
    removeUnsupportedAgentDefaults();
    simplifyAdvancedSettings();
    removePrivacySettings();
    hideRedundantConfigureEntry();
    enhanceOAuthEntries();
    enhanceMessageForkActions();
    enhanceArchivedSessionActions();
    enhanceDesktopWindowChrome();
  });
}

function enhanceArchivedSessionActions() {
  const panel = document.querySelector('.archive-list')?.closest('.panel');
  if (!panel) return;
  if (!archivedSessions) {
    void loadArchivedSessions().then(queueAdapterRefresh);
    return;
  }

  const sortMode = archivedSortMode(panel);
  for (const card of panel.querySelectorAll('.archive-card')) {
    const workspace = card.querySelector('.archive-workspace .path')?.textContent?.trim();
    const workspaceRow = card.querySelector('.archive-workspace');
    if (!workspace || !workspaceRow) continue;

    const allWorkspaceSessions = archivedSessions
      .filter((session) => session.metadata?.cwd === workspace && !deletedArchivedSessionIds.has(session.id));
    const visibleCandidates = sortArchivedSessions(allWorkspaceSessions, sortMode);
    const matchedIds = new Set();

    for (const row of card.querySelectorAll('.archive-row')) {
      const title = row.querySelector('.archive-name')?.textContent?.trim();
      if (!title) continue;
      const session = visibleCandidates.find((candidate) => (
        candidate.title === title && !matchedIds.has(candidate.id)
      ));
      if (!session || deletedArchivedSessionIds.has(session.id)) {
        row.remove();
        continue;
      }
      matchedIds.add(session.id);
      row.dataset.piArchivedSessionId = session.id;
      if (!row.querySelector('.pi-archive-delete')) {
        const button = archiveDeleteButton(localeText(`删除会话“${title}”`, `Delete session “${title}”`));
        button.classList.add('pi-archive-delete');
        button.addEventListener('click', () => void deleteArchivedRows([session], workspace));
        const restore = row.querySelector('button');
        row.insertBefore(button, restore ?? null);
      }
    }

    if (!workspaceRow.querySelector('.pi-archive-delete-all')) {
      const button = archiveDeleteButton(localeText('全部删除', 'Delete all'), true);
      button.classList.add('pi-archive-delete-all');
      button.addEventListener('click', () => {
        const sessions = archivedSessions.filter((session) => (
          session.metadata?.cwd === workspace && !deletedArchivedSessionIds.has(session.id)
        ));
        void deleteArchivedRows(sessions, workspace);
      });
      workspaceRow.appendChild(button);
    }
  }
}

async function loadArchivedSessions() {
  if (archivedSessionsLoading) return archivedSessionsLoading;
  archivedSessionsLoading = (async () => {
    const sessions = [];
    let beforeId;
    for (;;) {
      const query = new URLSearchParams({ archived_only: 'true', page_size: '100' });
      if (beforeId) query.set('before_id', beforeId);
      const page = await apiRequest(`/api/v1/sessions?${query}`);
      sessions.push(...(page.items ?? []));
      if (!page.has_more || page.items?.length === 0) break;
      beforeId = page.items.at(-1)?.id;
      if (!beforeId) break;
    }
    archivedSessions = sessions;
  })().catch((error) => {
    showArchiveDeleteError(error instanceof Error ? error.message : String(error));
  }).finally(() => {
    archivedSessionsLoading = null;
  });
  return archivedSessionsLoading;
}

function archivedSortMode(panel) {
  const selected = [...panel.querySelectorAll('.archive-toolbar button')]
    .find((button) => button.getAttribute('aria-pressed') === 'true' || button.classList.contains('on'))
    ?.textContent?.trim() ?? '';
  if (/^(创建时间|created time)$/i.test(selected)) return 'created';
  if (/^(按字母顺序|name)$/i.test(selected)) return 'name';
  return 'archived';
}

function sortArchivedSessions(sessions, mode) {
  const sorted = [...sessions];
  if (mode === 'created') sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
  else if (mode === 'name') sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  else sorted.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return sorted;
}

function archiveDeleteButton(label, withText = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = withText ? 'pi-archive-button pi-archive-button--all' : 'pi-archive-button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = `${trashIcon()}${withText ? `<span>${escapeHtml(label)}</span>` : ''}`;
  return button;
}

async function deleteArchivedRows(sessions, workspace) {
  if (sessions.length === 0) return;
  const confirmed = await confirmArchivedDelete(sessions, workspace);
  if (!confirmed) return;
  try {
    for (const session of sessions) {
      await apiRequest(`/api/v1/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      deletedArchivedSessionIds.add(session.id);
    }
    archivedSessions = archivedSessions.filter((session) => !deletedArchivedSessionIds.has(session.id));
    for (const row of document.querySelectorAll('.archive-row[data-pi-archived-session-id]')) {
      if (deletedArchivedSessionIds.has(row.dataset.piArchivedSessionId)) row.remove();
    }
    for (const card of document.querySelectorAll('.archive-card')) {
      const rows = card.querySelectorAll('.archive-row');
      const count = card.querySelector('.archive-workspace .count');
      if (count) count.textContent = localeText(`${rows.length} 个会话`, `${rows.length} sessions`);
      if (rows.length === 0) card.remove();
    }
  } catch (error) {
    showArchiveDeleteError(error instanceof Error ? error.message : String(error));
  }
}

function confirmArchivedDelete(sessions, workspace) {
  return new Promise((resolve) => {
    const single = sessions.length === 1;
    const overlay = document.createElement('div');
    overlay.className = 'pi-delete-overlay';
    const title = single
      ? localeText('永久删除这个会话？', 'Permanently delete this session?')
      : localeText('永久删除这个工作区的全部归档会话？', 'Permanently delete all archived sessions in this workspace?');
    const message = single
      ? localeText(`“${sessions[0].title}”及其全部消息将被永久删除，无法恢复。`, `“${sessions[0].title}” and all of its messages will be permanently deleted. This cannot be undone.`)
      : localeText(`将永久删除工作区“${workspace}”中的 ${sessions.length} 个归档会话及其全部消息，无法恢复。`, `${sessions.length} archived sessions in “${workspace}” and all of their messages will be permanently deleted. This cannot be undone.`);
    overlay.innerHTML = `<section class="pi-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="pi-delete-title">
      <header class="pi-delete-head"><h3 id="pi-delete-title">${escapeHtml(title)}</h3></header>
      <div class="pi-delete-body"><p>${escapeHtml(message)}</p></div>
      <footer class="pi-delete-foot">
        <button type="button" class="pi-delete-cancel">${escapeHtml(localeText('取消', 'Cancel'))}</button>
        <button type="button" class="pi-delete-confirm">${escapeHtml(localeText('删除', 'Delete'))}</button>
      </footer>
    </section>`;
    const finish = (result) => {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(result);
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') finish(false);
    };
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(false);
    });
    overlay.querySelector('.pi-delete-cancel').addEventListener('click', () => finish(false));
    overlay.querySelector('.pi-delete-confirm').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
    overlay.querySelector('.pi-delete-confirm').focus();
  });
}

function showArchiveDeleteError(message) {
  document.querySelector('.pi-archive-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'pi-archive-toast';
  toast.setAttribute('role', 'alert');
  toast.textContent = localeText(`删除失败：${message}`, `Delete failed: ${message}`);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function trashIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-3h4l1 3m3 0-1 14H7L6 7"/></svg>';
}

function enhanceMessageForkActions() {
  // Forking continues from a completed agent reply, so the action lives on the
  // assistant message footer (rendered only once streaming has finished).
  for (const msg of document.querySelectorAll('.a-msg[data-turn-id]')) {
    const meta = msg.querySelector(':scope > .a-msg-ft');
    if (!meta || meta.querySelector('.pi-fork-from-message')) continue;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pi-fork-from-message';
    button.dataset.entryId = msg.dataset.turnId;
    button.setAttribute('aria-label', localeText('从此处分叉', 'Fork from here'));
    button.title = localeText('从此处分叉', 'Fork from here');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 0c7 0 12-3 12-9m0 0-3 3m3-3 3 3"/></svg>';
    button.addEventListener('click', () => void forkFromMessage(button));
    const copyButton = meta.querySelector('.a-cpbtn');
    const copySlot = copyButton
      ? [...meta.children].find((child) => child === copyButton || child.contains(copyButton))
      : null;
    meta.insertBefore(button, copySlot ?? null);
  }
}

async function forkFromMessage(button) {
  if (button.disabled) return;
  const match = location.pathname.match(/^\/sessions\/([^/]+)/);
  const sessionId = match?.[1];
  const entryId = button.dataset.entryId;
  if (!sessionId || !entryId) return;

  button.disabled = true;
  button.classList.add('is-loading');
  try {
    const session = await apiRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}:fork`, {
      method: 'POST',
      body: JSON.stringify({ entry_id: entryId }),
    });
    location.assign(`/sessions/${encodeURIComponent(session.id)}`);
  } catch (error) {
    button.disabled = false;
    button.classList.remove('is-loading');
    showForkError(error instanceof Error ? error.message : String(error));
  }
}

function showForkError(message) {
  document.querySelector('.pi-fork-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'pi-fork-toast';
  toast.setAttribute('role', 'alert');
  toast.textContent = localeText(`无法从此处分叉：${message}`, `Could not fork from here: ${message}`);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function enhanceDesktopWindowChrome() {
  if (!IS_TAURI_DESKTOP) return;
  for (const region of document.querySelectorAll('.side .ch, .chat-header')) {
    region.setAttribute('data-tauri-drag-region', 'deep');
  }
}

function normalizeDesktopNotificationCopy() {
  if (!IS_TAURI_DESKTOP) return;
  replaceVisibleText('已在浏览器设置中被阻止', '已在系统通知设置中被阻止');
  replaceVisibleText('Blocked in browser settings', 'Blocked in system notification settings');
}

function replaceVisibleText(source, replacement) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.nodeValue?.trim() === source) node.nodeValue = node.nodeValue.replace(source, replacement);
  }
}

function removeUnsupportedAgentDefaults() {
  for (const row of document.querySelectorAll('.settings-region .row, .settings-region .srow')) {
    const label = row.querySelector('.rlabel, .srow-label')?.textContent?.trim() ?? '';
    if (/^(默认计划模式|plan mode by default)(?:\s|$)/i.test(label)) row.remove();
  }
}

function normalizePermissionLabels() {
  const replacements = new Map([
    ['逐条确认', '逐项确认'],
    ['自动通过', '风险确认'],
    ['完全自主', '无需确认'],
  ]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue ?? '';
    const replacement = replacements.get(text.trim());
    if (replacement) node.nodeValue = text.replace(text.trim(), replacement);
  }
}

function simplifyAdvancedSettings() {
  for (const section of document.querySelectorAll('.settings-region .sec')) {
    const heading = section.querySelector('.sec-title');
    const title = heading?.textContent?.trim() ?? '';

    if (/^(版本与更新|version and updates)$/i.test(title)) {
      const connectionTitle = localeText('连接信息', 'Connection');
      if (heading.textContent !== connectionTitle) heading.textContent = connectionTitle;
      for (const row of section.querySelectorAll('.row, .srow')) {
        const label = row.querySelector('.rlabel, .srow-label')?.textContent?.trim() ?? '';
        if (/^(应用版本|app version)$/i.test(label)) row.remove();
      }
    }

    if (/^(诊断|diagnostics)$/i.test(title)) section.remove();
  }
}

function removePrivacySettings() {
  for (const section of document.querySelectorAll('.settings-region .sec')) {
    const heading = section.querySelector('.sec-title')?.textContent?.trim() ?? '';
    if (!/^(数据与隐私|data (?:and|&) privacy)$/i.test(heading)) continue;
    section.remove();
  }
}

function normalizeAgentSettingsEntry() {
  const trigger = document.querySelector('.side-footer .user-menu-trigger');
  const label = trigger?.querySelector(':scope > span');
  if (!trigger || !label) return;
  if (label.textContent.trim() !== 'Pi Agent') label.textContent = 'Pi Agent';
  const accessibleLabel = localeText('打开模型与服务设置', 'Open model and provider settings');
  if (trigger.getAttribute('aria-label') !== accessibleLabel) {
    trigger.setAttribute('aria-label', accessibleLabel);
  }
}

function hideRedundantConfigureEntry() {
  for (const entry of document.querySelectorAll('.ui-menu.user-menu [role="menuitem"]')) {
    if (!TEXT.redundantConfigure.test(entry.textContent.trim())) continue;
    const separator = entry.nextElementSibling;
    entry.hidden = true;
    entry.style.display = 'none';
    entry.tabIndex = -1;
    if (separator?.matches('.ui-menu-sep, [role="separator"]')) {
      separator.hidden = true;
      separator.style.display = 'none';
    }
  }
}

function enhanceOAuthEntries() {
  if (oauthProviders.size === 0) return;
  const providersByName = new Map(
    [...oauthProviders.values()].map((provider) => [provider.name, provider]),
  );
  for (const entry of document.querySelectorAll('button.af-entry')) {
    const name = entry.querySelector('.af-entry-name')?.textContent?.trim();
    const provider = providersByName.get(name);
    if (!provider) continue;
    entry.disabled = false;
    entry.removeAttribute('aria-disabled');
    entry.dataset.piOauthProvider = provider.id;
    const reason = entry.querySelector('.af-entry-reason');
    if (reason) reason.textContent = localeText('OAuth 登录', 'OAuth login');
  }
}

async function openOAuthDialog(providerId) {
  const provider = oauthProviders.get(providerId);
  if (!provider || oauthDialog) return;

  oauthFlow = {
    provider,
    flowId: null,
    status: 'starting',
    events: [],
    prompt: null,
    error: null,
    lastRenderKey: '',
  };
  const flowState = oauthFlow;
  oauthDialog = createOAuthDialog(provider.name);
  renderOAuthDialog();

  try {
    const view = await apiRequest('/api/v1/oauth/login', {
      method: 'POST',
      body: JSON.stringify({ provider: providerId }),
    });
    if (oauthFlow !== flowState) {
      if (view.status === 'pending') {
        await apiRequest(`/api/v1/oauth/login?flow_id=${encodeURIComponent(view.flow_id)}`, {
          method: 'DELETE',
        }).catch(() => undefined);
      }
      return;
    }
    flowState.flowId = view.flow_id;
    applyOAuthView(view);
    scheduleOAuthPoll();
  } catch (error) {
    if (oauthFlow === flowState) failOAuthFlow(error);
  }
}

function createOAuthDialog(providerName) {
  const overlay = document.createElement('div');
  overlay.className = 'pi-oauth-overlay';
  overlay.innerHTML = `
    <section class="pi-oauth-dialog" role="dialog" aria-modal="true" aria-labelledby="pi-oauth-title">
      <header class="pi-oauth-head">
        <div>
          <h3 id="pi-oauth-title"></h3>
          <p>${escapeHtml(localeText('使用 pi agent 原生 OAuth 完成授权', 'Authorize with pi agent native OAuth'))}</p>
        </div>
        <button class="pi-oauth-close" type="button" data-oauth-action="cancel" aria-label="${escapeHtml(localeText('关闭', 'Close'))}"><span></span></button>
      </header>
      <div class="pi-oauth-body" aria-live="polite"></div>
      <footer class="pi-oauth-foot">
        <button class="pi-oauth-button pi-oauth-button--secondary" type="button" data-oauth-action="cancel">${escapeHtml(localeText('取消', 'Cancel'))}</button>
      </footer>
    </section>`;
  overlay.querySelector('#pi-oauth-title').textContent = localeText(
    `登录 ${providerName}`,
    `Sign in to ${providerName}`,
  );
  overlay.addEventListener('click', handleOAuthDialogClick);
  document.addEventListener('keydown', handleOAuthKeydown);
  document.body.appendChild(overlay);
  overlay.querySelector('.pi-oauth-close').focus();
  return overlay;
}

function handleOAuthKeydown(event) {
  if (event.key === 'Escape') {
    closeOAuthDialog();
    return;
  }
  if (event.key === 'Enter' && event.target.matches?.('[data-oauth-input]')) {
    event.preventDefault();
    void answerOAuthPrompt();
    return;
  }
  if (event.key === 'Tab' && oauthDialog) {
    const controls = [...oauthDialog.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')];
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

function handleOAuthDialogClick(event) {
  const action = event.target.closest('[data-oauth-action]')?.dataset.oauthAction;
  if (!action) return;
  if (action === 'cancel' || action === 'close') {
    closeOAuthDialog();
    return;
  }
  if (action === 'retry') {
    const providerId = oauthFlow?.provider.id;
    destroyOAuthDialog();
    if (providerId) void openOAuthDialog(providerId);
    return;
  }
  if (action === 'copy-code') {
    const code = oauthFlow?.deviceCode?.userCode;
    if (code) void navigator.clipboard.writeText(code);
    return;
  }
  if (action === 'answer') {
    const option = event.target.closest('[data-oauth-value]')?.dataset.oauthValue;
    void answerOAuthPrompt(option);
  }
}

async function answerOAuthPrompt(selectedValue) {
  if (!oauthFlow?.flowId || !oauthFlow.prompt) return;
  const flowState = oauthFlow;
  const flowId = flowState.flowId;
  const prompt = flowState.prompt;
  const input = oauthDialog?.querySelector('[data-oauth-input]');
  const value = selectedValue ?? input?.value ?? '';
  setOAuthControlsDisabled(true);
  try {
    const view = await apiRequest(`/api/v1/oauth/login/${encodeURIComponent(flowId)}/respond`, {
      method: 'POST',
      body: JSON.stringify({ prompt_id: prompt.id, value }),
    });
    if (oauthFlow !== flowState) return;
    flowState.prompt = null;
    applyOAuthView(view);
    scheduleOAuthPoll(0);
  } catch (error) {
    if (oauthFlow === flowState) failOAuthFlow(error);
  }
}

function applyOAuthView(view) {
  if (!oauthFlow) return;
  oauthFlow.status = view.status;
  oauthFlow.prompt = view.prompt ?? null;
  oauthFlow.error = view.error ?? null;
  for (const event of [...(view.context_events ?? []), ...(view.events ?? [])]) {
    const signature = JSON.stringify(event);
    if (oauthFlow.events.some((item) => JSON.stringify(item) === signature)) continue;
    oauthFlow.events.push(event);
    if (event.type === 'auth_url') oauthFlow.authUrl = event;
    if (event.type === 'device_code') oauthFlow.deviceCode = event;
  }
  renderOAuthDialog();

  if (view.status === 'authenticated') {
    clearOAuthPoll();
    setTimeout(async () => {
      try {
        await apiRequest('/api/v1/providers:refresh_oauth', { method: 'POST' });
      } catch {
        // Authentication is already stored; a refresh failure must not turn a
        // successful login into a failed one.
      }
      window.location.reload();
    }, 900);
  } else if (view.status === 'failed' || view.status === 'cancelled') {
    clearOAuthPoll();
  }
}

function scheduleOAuthPoll(delay = 500) {
  clearOAuthPoll();
  if (!oauthFlow?.flowId || oauthFlow.status !== 'pending') return;
  oauthPollTimer = setTimeout(async () => {
    try {
      const view = await apiRequest(`/api/v1/oauth/login?flow_id=${encodeURIComponent(oauthFlow.flowId)}`);
      applyOAuthView(view);
      scheduleOAuthPoll();
    } catch (error) {
      failOAuthFlow(error);
    }
  }, delay);
}

function clearOAuthPoll() {
  if (oauthPollTimer) clearTimeout(oauthPollTimer);
  oauthPollTimer = null;
}

async function closeOAuthDialog() {
  const flowId = oauthFlow?.flowId;
  destroyOAuthDialog();
  if (!flowId) return;
  try {
    await apiRequest(`/api/v1/oauth/login?flow_id=${encodeURIComponent(flowId)}`, { method: 'DELETE' });
  } catch {
    // Closing the UI is always allowed; the server expires abandoned flows.
  }
}

function destroyOAuthDialog() {
  clearOAuthPoll();
  document.removeEventListener('keydown', handleOAuthKeydown);
  oauthDialog?.remove();
  oauthDialog = null;
  oauthFlow = null;
}

function failOAuthFlow(error) {
  if (!oauthFlow) return;
  oauthFlow.status = 'failed';
  oauthFlow.error = error instanceof Error ? error.message : String(error);
  clearOAuthPoll();
  renderOAuthDialog();
}

function renderOAuthDialog() {
  const body = oauthDialog?.querySelector('.pi-oauth-body');
  const footer = oauthDialog?.querySelector('.pi-oauth-foot');
  if (!body || !footer || !oauthFlow) return;

  setOAuthControlsDisabled(false);

  const renderKey = JSON.stringify({
    status: oauthFlow.status,
    promptId: oauthFlow.prompt?.id,
    events: oauthFlow.events.length,
    error: oauthFlow.error,
  });
  if (renderKey === oauthFlow.lastRenderKey) return;
  oauthFlow.lastRenderKey = renderKey;

  if (oauthFlow.status === 'starting') {
    body.innerHTML = `<div class="pi-oauth-state"><span class="pi-oauth-spinner"></span><p>${escapeHtml(localeText('正在准备授权…', 'Preparing authorization…'))}</p></div>`;
  } else if (oauthFlow.status === 'authenticated') {
    body.innerHTML = `<div class="pi-oauth-state pi-oauth-state--success"><span class="pi-oauth-status-icon">✓</span><h4>${escapeHtml(localeText('授权成功', 'Authorization complete'))}</h4><p>${escapeHtml(localeText('正在刷新供应商和模型列表…', 'Refreshing providers and models…'))}</p></div>`;
  } else if (oauthFlow.status === 'failed' || oauthFlow.status === 'cancelled') {
    body.innerHTML = `<div class="pi-oauth-state pi-oauth-state--error"><span class="pi-oauth-status-icon">!</span><h4>${escapeHtml(localeText('授权未完成', 'Authorization did not complete'))}</h4><p>${escapeHtml(oauthFlow.error || localeText('授权已取消', 'Authorization was cancelled'))}</p></div>`;
  } else {
    body.innerHTML = pendingOAuthMarkup();
  }

  footer.innerHTML = oauthFlow.status === 'failed'
    ? `<button class="pi-oauth-button pi-oauth-button--secondary" type="button" data-oauth-action="cancel">${escapeHtml(localeText('关闭', 'Close'))}</button><button class="pi-oauth-button pi-oauth-button--primary" type="button" data-oauth-action="retry">${escapeHtml(localeText('重试', 'Retry'))}</button>`
    : oauthFlow.status === 'authenticated'
      ? ''
      : `<button class="pi-oauth-button pi-oauth-button--secondary" type="button" data-oauth-action="cancel">${escapeHtml(localeText('取消', 'Cancel'))}</button>`;

  if (oauthFlow.prompt) {
    requestAnimationFrame(() => {
      oauthDialog?.querySelector('.pi-oauth-option, [data-oauth-input]')?.focus();
    });
  }
}

function pendingOAuthMarkup() {
  const prompt = oauthFlow.prompt;
  const latestProgress = [...oauthFlow.events]
    .reverse()
    .find((event) => event.type === 'progress' || event.type === 'info');
  const context = oauthContextMarkup(latestProgress);

  if (!prompt) {
    return `${context}<div class="pi-oauth-wait"><span class="pi-oauth-spinner"></span><span>${escapeHtml(latestProgress?.message || localeText('等待供应商响应…', 'Waiting for the provider…'))}</span></div>`;
  }

  if (prompt.type === 'select') {
    return `${context}<div class="pi-oauth-prompt"><h4>${escapeHtml(prompt.message)}</h4><div class="pi-oauth-options">${prompt.options.map((option) => `
      <button class="pi-oauth-option" type="button" data-oauth-action="answer" data-oauth-value="${escapeHtml(option.id)}">
        <span>${escapeHtml(option.label)}</span>
        ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}
      </button>`).join('')}</div></div>`;
  }

  const inputType = prompt.type === 'secret' ? 'password' : 'text';
  return `${context}<div class="pi-oauth-prompt">
    <label for="pi-oauth-input">${escapeHtml(prompt.message)}</label>
    <div class="pi-oauth-input-row">
      <input id="pi-oauth-input" data-oauth-input type="${inputType}" placeholder="${escapeHtml(prompt.placeholder || '')}" autocomplete="off" spellcheck="false">
      <button class="pi-oauth-button pi-oauth-button--primary" type="button" data-oauth-action="answer">${escapeHtml(localeText('继续', 'Continue'))}</button>
    </div>
  </div>`;
}

function oauthContextMarkup(latestProgress) {
  if (oauthFlow.deviceCode) {
    const event = oauthFlow.deviceCode;
    return `<div class="pi-oauth-context">
      <p>${escapeHtml(localeText('在授权页面输入以下设备码：', 'Enter this device code on the authorization page:'))}</p>
      <div class="pi-oauth-code-row"><code>${escapeHtml(event.userCode)}</code><button class="pi-oauth-button pi-oauth-button--secondary" type="button" data-oauth-action="copy-code">${escapeHtml(localeText('复制', 'Copy'))}</button></div>
      <a class="pi-oauth-link" href="${escapeHtml(safeUrl(event.verificationUri))}" target="_blank" rel="noopener noreferrer">${escapeHtml(localeText('打开授权页面', 'Open authorization page'))}</a>
    </div>`;
  }
  if (oauthFlow.authUrl) {
    const event = oauthFlow.authUrl;
    return `<div class="pi-oauth-context">
      <p>${escapeHtml(event.instructions || localeText('在浏览器中完成授权，然后返回此页面。', 'Complete authorization in your browser, then return here.'))}</p>
      <a class="pi-oauth-button pi-oauth-button--primary" href="${escapeHtml(safeUrl(event.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(localeText('打开授权页面', 'Open authorization page'))}</a>
    </div>`;
  }
  return latestProgress?.message
    ? `<p class="pi-oauth-progress">${escapeHtml(latestProgress.message)}</p>`
    : '';
}

function setOAuthControlsDisabled(disabled) {
  for (const control of oauthDialog?.querySelectorAll('button, input') ?? []) {
    control.disabled = disabled;
  }
}

async function apiRequest(url, init = {}) {
  const authorization = serverAuthorization();
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authorization ? { authorization } : {}),
      ...(init.headers ?? {}),
    },
  });
  const envelope = await response.json().catch(() => null);
  if (!response.ok || !envelope || envelope.code !== 0) {
    throw new Error(envelope?.msg || `${response.status} ${response.statusText}`);
  }
  return envelope.data;
}

// The frozen WebUI persists the bearer token as JSON under this key in either
// storage area. Read it back so adapter calls authenticate like native ones.
function serverAuthorization() {
  const KEY = 'kimi-web.server-credential';
  for (const store of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      const raw = store?.getItem(KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.credential === 'string' && parsed.credential.length > 0) {
        return `Bearer ${parsed.credential}`;
      }
    } catch {
      // Malformed entry — fall through to the next storage area.
    }
  }
  return undefined;
}

function localeText(zh, en) {
  const controls = [...document.querySelectorAll('[role="tab"], button')]
    .map((element) => element.textContent?.trim())
    .filter(Boolean);
  if (controls.some((text) => /^(设置|供应商|通用|添加供应商)$/.test(text))) return zh;
  if (controls.some((text) => /^(Settings|Providers|General|Add provider)$/i.test(text))) return en;
  return navigator.language.toLowerCase().startsWith('zh') ? zh : en;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '#';
  } catch {
    return '#';
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function openProviderSettings(onReady) {
  hideUnsupportedProviderControls();
  const providerTab = findVisible(TEXT.providers, '[role="tab"], button');
  if (providerTab) {
    providerTab.click();
    if (onReady) defer(onReady);
    return;
  }

  const settings = findVisible(TEXT.settings, 'button, [role="menuitem"]');
  settings?.click();
  clickWhenVisible(TEXT.providers, '[role="tab"]', (tab) => {
    tab.click();
    if (onReady) defer(onReady);
  });
}

function openAddProvider(mode) {
  clickWhenVisible(TEXT.addProvider, 'button', (add) => {
    add.click();
    defer(hideUnsupportedProviderControls);
    if (mode === 'manual') clickWhenVisible(TEXT.manual, '[role="tab"]', (manual) => manual.click(), 120);
  }, 120);
  clickWhenVisible(TEXT.providers, '[role="tab"]', (providers) => {
    if (providers.getAttribute('aria-selected') !== 'true') providers.click();
  });
}

function hideUnsupportedProviderControls(attempts = 60) {
  const tabs = visibleControls('[role="tab"]');
  const providers = tabs.find((tab) => TEXT.providers.test(tab.textContent.trim()));
  const catalog = tabs.find((tab) => TEXT.catalog.test(tab.textContent.trim()));
  for (const tab of tabs) {
    const text = tab.textContent.trim();
    if (TEXT.account.test(text) || TEXT.registry.test(text)) {
      if (tab.getAttribute('aria-selected') === 'true') {
        (TEXT.account.test(text) ? providers : catalog)?.click();
      }
      tab.hidden = true;
      tab.style.display = 'none';
      tab.tabIndex = -1;
    }
  }
  if (attempts > 0) requestAnimationFrame(() => hideUnsupportedProviderControls(attempts - 1));
}

function clickWhenVisible(pattern, selector, operation, attempts = 30) {
  const control = findVisible(pattern, selector);
  if (control) {
    operation(control);
    return;
  }
  if (attempts > 0) requestAnimationFrame(() => clickWhenVisible(pattern, selector, operation, attempts - 1));
}

function findVisible(pattern, selector) {
  return visibleControls(selector).find((control) => pattern.test(control.textContent.trim()));
}

function visibleControls(selector = 'button, a, [role="tab"], [role="menuitem"]') {
  return [...document.querySelectorAll(selector)].filter((element) => {
    const rect = element.getBoundingClientRect();
    return element.closest(OFFICIAL_SURFACE)
      && !element.closest('[hidden], [aria-hidden="true"], [inert]')
      && !element.matches(':disabled, [aria-disabled="true"]')
      && rect.width > 0
      && rect.height > 0;
  });
}

function defer(operation) {
  requestAnimationFrame(() => requestAnimationFrame(operation));
}
