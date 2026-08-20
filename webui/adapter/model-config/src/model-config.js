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
const QUOTE_STORAGE_KEY = 'pi-code.message-quote-drafts.v1';
const QUOTE_HOT_LIMIT = 48;
const QUOTE_COLD_LIMIT = 256;
const quoteDrafts = loadQuoteDrafts();
let preparedQuoteSubmission = null;
let quoteRestoreTimer = null;
let contextMaskSessionId = null;
let contextMaskTurns = new Map();
let draftSessionId = null;
let draftEnabled = false;
let draftSettingsLoading = null;
let draftCardsLoading = null;
let draftCardsSessionId = null;
let draftCardsLastLoadAt = 0;
let draftCardsTurnCount = -1;
let draftCardsAttempts = 0;

if (IS_TAURI_DESKTOP) document.documentElement.classList.add('pi-code-desktop');

void loadOAuthProviders();

new MutationObserver(queueAdapterRefresh).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
queueAdapterRefresh();

document.addEventListener('click', (event) => {
  const draftToggle = event.target.closest?.('[data-pi-draft-toggle]');
  if (draftToggle) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void setDraftEnabled(draftToggle.dataset.piDraftToggle === 'on');
    return;
  }
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

// The upstream bundle owns submission. Capture its two send affordances just
// before Vue handles them, then let the normal composer path continue. This
// keeps attachments, queues, authentication and optimistic rendering native.
document.addEventListener('click', (event) => {
  const remove = event.target.closest?.('.pi-quote-chip-remove');
  if (remove) {
    event.preventDefault();
    event.stopImmediatePropagation();
    removeQuoteDraft(currentSessionId());
    queueAdapterRefresh();
    return;
  }
  const send = event.target.closest?.('.composer .send');
  if (send && !send.disabled) prepareQuoteSubmission(send.closest('.composer'));
}, true);

document.addEventListener('keydown', (event) => {
  const textarea = event.target.closest?.('.composer textarea.ph');
  if (!textarea || event.isComposing || event.keyCode === 229) return;
  const composer = textarea.closest('.composer');
  if (!composer || composerHasOpenPicker(composer)) return;
  const normalEnter = event.key === 'Enter' && !event.shiftKey
    && (!composer.classList.contains('expanded') || event.metaKey || event.ctrlKey);
  const steer = event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)
    && !event.shiftKey && !event.altKey;
  if (normalEnter || steer) prepareQuoteSubmission(composer);
}, true);

document.addEventListener('input', (event) => {
  const textarea = event.target.closest?.('.composer textarea.ph');
  if (!textarea || preparedQuoteSubmission?.textarea === textarea) return;
  const parsed = parseQuoteEnvelope(textarea.value);
  if (!parsed) return;
  // Undo/edit may refill the composer with a stored plain-text quote envelope.
  // Restore the chip immediately after Vue has observed the input event.
  requestAnimationFrame(() => restoreQuoteDraftFromComposer(textarea, parsed));
}, true);

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
    enhanceMessageQuoteActions();
    enhanceContextMaskActions();
    enhanceSessionDrafts();
    enhanceQuoteComposer();
    enhanceQuotedUserMessages();
    enhanceArchivedSessionActions();
    enhanceDesktopWindowChrome();
  });
}

function enhanceSessionDrafts() {
  const sessionId = currentSessionId();
  if (!sessionId) return;
  if (draftSessionId !== sessionId) {
    draftSessionId = sessionId;
    draftEnabled = false;
    draftSettingsLoading = apiRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}/draft-settings`)
      .then((settings) => { draftEnabled = settings.enabled === true; })
      .catch(() => {})
      .finally(() => { draftSettingsLoading = null; queueAdapterRefresh(); });
  }

  const swarmMenuItem = visibleControls('button, [role="menuitem"]').find((item) => /swarm/i.test(item.textContent));
  if (swarmMenuItem && !swarmMenuItem.parentElement.querySelector('[data-pi-draft-toggle]')) {
    const item = swarmMenuItem.cloneNode(true);
    item.dataset.piDraftToggle = 'on';
    item.removeAttribute('aria-describedby');
    const textNodes = [...item.querySelectorAll('*')].filter((node) => node.children.length === 0 && /swarm/i.test(node.textContent));
    (textNodes[0] ?? item).textContent = localeText('草稿', 'Draft');
    const description = [...item.querySelectorAll('*')].find((node) => /agent|模式|mode|协作/i.test(node.textContent) && node !== textNodes[0]);
    if (description) description.textContent = localeText('让 Agent 暂存未落地的方案和文稿', 'Let Agent keep provisional documents');
    item.setAttribute('aria-checked', String(draftEnabled));
    swarmMenuItem.insertAdjacentElement('afterend', item);
  }

  const toolbar = activeComposer()?.querySelector('.toolbar-left');
  let chip = toolbar?.querySelector('.pi-draft-chip');
  if (draftEnabled && toolbar && !chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'swarm-chip pi-draft-chip';
    chip.dataset.piDraftToggle = 'off';
    chip.setAttribute('aria-label', localeText('关闭草稿', 'Disable drafts'));
    chip.innerHTML = `${draftIcon()}<span class="swarm-label">${escapeHtml(localeText('草稿', 'Draft'))}</span><span class="pi-draft-close">×</span>`;
    toolbar.appendChild(chip);
  } else if (!draftEnabled) chip?.remove();

  enhanceDraftCards(sessionId);
}

async function setDraftEnabled(enabled) {
  const sessionId = currentSessionId();
  if (!sessionId || draftSettingsLoading) return;
  try {
    const settings = await apiRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}/draft-settings`, {
      method: 'PUT', body: JSON.stringify({ enabled }),
    });
    draftEnabled = settings.enabled === true;
    document.querySelectorAll('[data-pi-draft-toggle="on"]').forEach((item) => item.closest('[role="menu"]')?.remove());
    queueAdapterRefresh();
  } catch (error) { showContextMaskToast(error instanceof Error ? error.message : String(error)); }
}

function enhanceDraftCards(sessionId) {
  if (draftCardsSessionId !== sessionId) {
    draftCardsSessionId = sessionId;
    draftCardsLoading = null;
    draftCardsLastLoadAt = 0;
    draftCardsTurnCount = -1;
    draftCardsAttempts = 0;
  }
  for (const node of document.querySelectorAll('.chat pre, .chat code, .chat .tool-result, .chat [class*="tool"]')) {
    if (node.closest('.pi-draft-card')) continue;
    const text = node.textContent?.trim();
    if (!text?.includes('"draftId"') || !text.includes('"revision"')) continue;
    let metadata;
    try { metadata = JSON.parse(text); } catch { continue; }
    if (!metadata.draftId || !['created', 'updated', 'read'].includes(metadata.status)) continue;
    const host = node.closest('.p-tool-row, .tool-call, .tool, [class*="tool-call"]') ?? node;
    host.classList.add('pi-draft-card');
    host.innerHTML = `<div class="pi-draft-head"><span>${draftIcon()} ${escapeHtml(localeText('草稿', 'Draft'))} · ${escapeHtml(metadata.title)}</span><span>r${metadata.revision}</span></div>
      <p>${escapeHtml(metadata.excerpt ?? '')}</p><div class="pi-draft-actions"><button type="button" data-pi-draft-view>${escapeHtml(localeText('查看', 'View'))}</button><button type="button" data-pi-draft-quote>${escapeHtml(localeText('引用', 'Quote'))}</button><button type="button" data-pi-draft-copy>${escapeHtml(localeText('复制', 'Copy'))}</button></div>`;
    host.querySelector('[data-pi-draft-view]').addEventListener('click', () => void openDraftDialog(sessionId, metadata.draftId, metadata.revision));
    host.querySelector('[data-pi-draft-quote]').addEventListener('click', () => selectDraftQuote(sessionId, metadata));
    host.querySelector('[data-pi-draft-copy]').addEventListener('click', async () => {
      const draft = await apiRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}/drafts/${encodeURIComponent(metadata.draftId)}?revision=${metadata.revision}`);
      await navigator.clipboard.writeText(draft.content);
    });
  }
  const turnCount = document.querySelectorAll('.a-msg.turn-anchor').length;
  if (turnCount !== draftCardsTurnCount) {
    draftCardsTurnCount = turnCount;
    draftCardsAttempts = 0;
  }
  if (!draftCardsLoading && draftCardsAttempts < 4 && Date.now() - draftCardsLastLoadAt > 1000) {
    draftCardsLastLoadAt = Date.now();
    draftCardsAttempts += 1;
    draftCardsLoading = apiRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`)
      .then((page) => renderProjectedDraftCards(sessionId, page.items ?? []))
      .catch(() => {})
      .finally(() => {
        draftCardsLoading = null;
        if (draftCardsAttempts < 4) setTimeout(queueAdapterRefresh, 1100);
      });
  }
}

function renderProjectedDraftCards(sessionId, messages) {
  const assistantByPrompt = new Map();
  for (const message of messages) {
    if (message.role === 'assistant' && message.content?.some((item) => item.type === 'text')) {
      assistantByPrompt.set(message.prompt_id, message);
    }
  }
  const assistants = new Map([...assistantByPrompt.entries()].map(([promptId, message], index) => (
    [promptId, { message, index }]
  )));
  const turns = [...document.querySelectorAll('.a-msg.turn-anchor')];
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content ?? []) {
      if (part.type !== 'tool_result' || part.is_error) continue;
      let metadata;
      try { metadata = JSON.parse(part.output); } catch { continue; }
      if (!metadata.draftId || !['created', 'updated', 'read'].includes(metadata.status)) continue;
      if (document.querySelector(`.pi-draft-card[data-draft-id="${CSS.escape(metadata.draftId)}"][data-revision="${metadata.revision}"]`)) continue;
      const assistant = assistants.get(message.prompt_id);
      if (!assistant) continue;
      const turn = turns[assistant.index];
      const body = turn?.querySelector('.msg');
      if (!body) continue;
      body.insertAdjacentElement('beforebegin', createDraftCard(sessionId, metadata));
    }
  }
}

function createDraftCard(sessionId, metadata) {
  const card = document.createElement('section');
  card.className = 'pi-draft-card';
  card.dataset.draftId = metadata.draftId;
  card.dataset.revision = String(metadata.revision);
  card.innerHTML = `<div class="pi-draft-head"><span>${draftIcon()} ${escapeHtml(localeText('草稿', 'Draft'))} · ${escapeHtml(metadata.title)}</span><span>r${metadata.revision}</span></div>
    <p>${escapeHtml(metadata.excerpt ?? '')}</p><div class="pi-draft-actions"><button type="button" data-pi-draft-view>${escapeHtml(localeText('查看', 'View'))}</button><button type="button" data-pi-draft-quote>${escapeHtml(localeText('引用', 'Quote'))}</button><button type="button" data-pi-draft-copy>${escapeHtml(localeText('复制', 'Copy'))}</button></div>`;
  card.querySelector('[data-pi-draft-view]').addEventListener('click', () => void openDraftDialog(sessionId, metadata.draftId, metadata.revision));
  card.querySelector('[data-pi-draft-quote]').addEventListener('click', () => selectDraftQuote(sessionId, metadata));
  card.querySelector('[data-pi-draft-copy]').addEventListener('click', async () => {
    const draft = await apiRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}/drafts/${encodeURIComponent(metadata.draftId)}?revision=${metadata.revision}`);
    await navigator.clipboard.writeText(draft.content);
  });
  return card;
}

function selectDraftQuote(sessionId, metadata) {
  const reference = `draft:${metadata.draftId}@r${metadata.revision}`;
  const title = `${localeText('草稿', 'Draft')} · ${metadata.title} · r${metadata.revision}`;
  setQuoteDraft(sessionId, {
    turnId: reference,
    fingerprint: truncateGraphemes(title, QUOTE_HOT_LIMIT),
    fallbackExcerpt: quoteExcerpt(`${reference} ${metadata.excerpt ?? metadata.title}`),
    beforeCompaction: true,
  });
  queueAdapterRefresh();
  requestAnimationFrame(() => composerTextarea()?.focus({ preventScroll: true }));
}

async function openDraftDialog(sessionId, draftId, revision) {
  const draft = await apiRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}/drafts/${encodeURIComponent(draftId)}?revision=${revision}`);
  const overlay = document.createElement('div');
  overlay.className = 'pi-delete-overlay pi-draft-overlay';
  overlay.innerHTML = `<section class="pi-delete-dialog pi-draft-dialog" role="dialog" aria-modal="true"><header class="pi-delete-head"><h3>${escapeHtml(draft.draft.title)} · r${draft.revision}</h3><button type="button" aria-label="Close">×</button></header><div class="pi-draft-body"><pre></pre></div></section>`;
  overlay.querySelector('pre').textContent = draft.content;
  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('header button').addEventListener('click', close);
  document.body.appendChild(overlay);
}

function draftIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h8"/></svg>';
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

// ---------------------------------------------------------------------------
// Message quote adapter
// ---------------------------------------------------------------------------

function enhanceMessageQuoteActions() {
  for (const message of document.querySelectorAll('.a-msg[data-turn-id]')) {
    const footer = message.querySelector(':scope > .a-msg-ft');
    const copyButton = footer?.querySelector('.a-cpbtn');
    const text = assistantFinalText(message);
    const existing = footer?.querySelector('.pi-quote-from-message');
    if (!footer || !copyButton || !normalizeQuoteText(text)) {
      existing?.remove();
      continue;
    }
    if (existing) continue;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pi-quote-from-message';
    button.setAttribute('aria-label', localeText('引用这条回复', 'Quote this reply'));
    button.title = localeText('引用这条回复', 'Quote this reply');
    button.innerHTML = quoteIcon();
    button.addEventListener('click', () => selectMessageQuote(message));

    const copySlot = [...footer.children].find((child) => child === copyButton || child.contains(copyButton));
    footer.insertBefore(button, copySlot?.nextSibling ?? null);
  }
}

function assistantFinalText(message) {
  const run = [];
  let turn = message;
  while (turn?.matches?.('.a-msg[data-turn-id]')) {
    run.unshift(turn);
    turn = turn.previousElementSibling;
  }
  return run
    .flatMap((assistantTurn) => [...assistantTurn.querySelectorAll(':scope > .msg')])
    .map((block) => block.textContent?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function selectMessageQuote(message) {
  const sessionId = currentSessionId();
  const sourceText = assistantFinalText(message);
  if (!sessionId || !normalizeQuoteText(sourceText)) return;

  const draft = {
    turnId: message.dataset.turnId ?? '',
    fingerprint: quoteFingerprint(sourceText),
    fallbackExcerpt: quoteExcerpt(sourceText),
    beforeCompaction: quoteIsBeforeLatestCompaction(message),
  };
  setQuoteDraft(sessionId, draft);
  queueAdapterRefresh();
  requestAnimationFrame(() => composerTextarea()?.focus({ preventScroll: true }));
}

function quoteIsBeforeLatestCompaction(message) {
  const divider = [...document.querySelectorAll('.compact-divider')].at(-1);
  return !!divider && Boolean(message.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function enhanceQuoteComposer() {
  const sessionId = currentSessionId();
  const composer = activeComposer();
  if (!composer) return;
  const draft = sessionId ? quoteDrafts.get(sessionId) : null;
  const existingChip = composer.querySelector('.pi-quote-chip');
  const existingStrip = composer.querySelector('.pi-quote-strip');
  if (!draft) {
    existingChip?.remove();
    existingStrip?.remove();
    return;
  }
  const fileRow = composer.querySelector('.att-scroll-content > .att-row:not(.att-row-media)');
  const alreadyPlaced = fileRow
    ? existingChip?.parentElement === fileRow
    : existingStrip?.contains(existingChip) === true;
  if (alreadyPlaced && existingChip?.dataset.piQuoteFingerprint === draft.fingerprint) return;
  existingChip?.remove();
  existingStrip?.remove();

  const chip = document.createElement('span');
  chip.className = 'att-chip pi-quote-chip';
  chip.title = draft.fingerprint;
  chip.dataset.piQuoteFingerprint = draft.fingerprint;
  chip.innerHTML = `
    <span class="att-tile pi-quote-chip-icon">${quoteIcon()}</span>
    <span class="att-name">${escapeHtml(draft.fingerprint)}</span>
    <button type="button" class="att-rm pi-quote-chip-remove" aria-label="${escapeHtml(localeText('移除引用', 'Remove quote'))}">${closeIcon()}</button>
  `;
  if (fileRow) {
    fileRow.prepend(chip);
    return;
  }

  const strip = document.createElement('div');
  strip.className = 'att-strip pi-quote-strip';
  strip.appendChild(chip);
  const card = composer.querySelector(':scope > .composer-card');
  if (card) card.insertBefore(strip, card.firstChild);
}

function prepareQuoteSubmission(composer) {
  const sessionId = currentSessionId();
  const textarea = composer?.querySelector('textarea.ph');
  const draft = sessionId ? quoteDrafts.get(sessionId) : null;
  if (!sessionId || !textarea || !draft || preparedQuoteSubmission?.textarea === textarea) return;
  const existing = parseQuoteEnvelope(textarea.value);
  if (existing) return;

  preparedQuoteSubmission = {
    sessionId,
    textarea,
    originalText: textarea.value,
    draft,
    existingMessages: new Set(document.querySelectorAll('.u-turn')),
    messageElement: null,
    consumed: false,
  };
  setComposerText(textarea, serializeQuoteEnvelope(draft, textarea.value.trim()));

  clearTimeout(quoteRestoreTimer);
  quoteRestoreTimer = setTimeout(() => recoverUnsentQuoteSubmission(), 700);
}

function recoverUnsentQuoteSubmission() {
  const pending = preparedQuoteSubmission;
  if (!pending || pending.consumed) return;
  if (currentSessionId() === pending.sessionId) {
    setQuoteDraft(pending.sessionId, pending.draft);
    const textarea = composerTextarea();
    if (textarea) {
      setComposerText(textarea, pending.originalText);
      textarea.focus({ preventScroll: true });
    }
  }
  preparedQuoteSubmission = null;
  queueAdapterRefresh();
}

function consumePreparedQuoteSubmission(messageElement, parsed) {
  const pending = preparedQuoteSubmission;
  if (!pending || pending.sessionId !== currentSessionId() || pending.consumed) return;
  if (pending.existingMessages.has(messageElement)) return;
  const expectedText = pending.draft.beforeCompaction
    ? pending.draft.fallbackExcerpt
    : pending.draft.fingerprint;
  if (expectedText !== parsed.text) return;
  pending.consumed = true;
  pending.messageElement = messageElement;
  removeQuoteDraft(pending.sessionId);
  clearTimeout(quoteRestoreTimer);
  // A rejected prompt removes its optimistic user message. Restore only in
  // that case; a mounted message is the normal accepted/queued path.
  quoteRestoreTimer = setTimeout(() => {
    if (preparedQuoteSubmission !== pending) return;
    if (!pending.messageElement?.isConnected && currentSessionId() === pending.sessionId) {
      setQuoteDraft(pending.sessionId, pending.draft);
      const textarea = composerTextarea();
      if (textarea) setComposerText(textarea, pending.originalText);
      queueAdapterRefresh();
    }
    preparedQuoteSubmission = null;
  }, 15000);
  queueAdapterRefresh();
}

function restoreQuoteDraftFromComposer(textarea, parsed) {
  const sessionId = currentSessionId();
  if (!sessionId || preparedQuoteSubmission?.textarea === textarea) return;
  setQuoteDraft(sessionId, {
    turnId: '',
    fingerprint: parsed.kind === 'excerpt' ? quoteFingerprint(parsed.text) : parsed.text,
    fallbackExcerpt: parsed.text,
    beforeCompaction: parsed.kind === 'excerpt',
  });
  setComposerText(textarea, parsed.body);
  queueAdapterRefresh();
}

function enhanceQuotedUserMessages() {
  for (const textElement of document.querySelectorAll('.u-turn .u-text')) {
    const raw = textElement.dataset.piQuoteRaw ?? textElement.textContent ?? '';
    const parsed = parseQuoteEnvelope(raw);
    if (!parsed) continue;
    const message = textElement.closest('.u-turn');
    if (!message) continue;
    consumePreparedQuoteSubmission(message, parsed);
    if (textElement.dataset.piQuoteRendered === raw && textElement.querySelector('.pi-sent-quote')) continue;

    textElement.dataset.piQuoteRaw = raw;
    textElement.dataset.piQuoteRendered = raw;
    textElement.replaceChildren();
    const chip = document.createElement('span');
    chip.className = 'pi-sent-quote';
    chip.title = parsed.text;
    chip.innerHTML = `<span class="pi-sent-quote-icon">${quoteIcon()}</span><span class="pi-sent-quote-text"></span>`;
    chip.querySelector('.pi-sent-quote-text').textContent = parsed.text;
    textElement.appendChild(chip);
    if (parsed.body) {
      const body = document.createElement('span');
      body.className = 'pi-quoted-message-body';
      body.textContent = parsed.body;
      textElement.appendChild(body);
    }
  }
}

function composerHasOpenPicker(composer) {
  return Boolean(composer.querySelector('.slash-menu, .mention-menu, [role="listbox"]'));
}

function activeComposer() {
  return [...document.querySelectorAll('.composer')].find((composer) => {
    const rect = composer.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !composer.closest('[hidden], [inert]');
  }) ?? null;
}

function composerTextarea() {
  return activeComposer()?.querySelector('textarea.ph') ?? null;
}

function currentSessionId() {
  return location.pathname.match(/^\/sessions\/([^/]+)/)?.[1] ?? null;
}

function loadQuoteDrafts() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(QUOTE_STORAGE_KEY) ?? '{}');
    return new Map(Object.entries(stored).filter(([, draft]) => isQuoteDraft(draft)));
  } catch {
    return new Map();
  }
}

function isQuoteDraft(draft) {
  return draft && typeof draft === 'object'
    && typeof draft.fingerprint === 'string'
    && typeof draft.fallbackExcerpt === 'string'
    && typeof draft.beforeCompaction === 'boolean';
}

function setQuoteDraft(sessionId, draft) {
  quoteDrafts.set(sessionId, draft);
  persistQuoteDrafts();
}

function removeQuoteDraft(sessionId) {
  if (!sessionId) return;
  quoteDrafts.delete(sessionId);
  persistQuoteDrafts();
}

function persistQuoteDrafts() {
  try {
    sessionStorage.setItem(QUOTE_STORAGE_KEY, JSON.stringify(Object.fromEntries(quoteDrafts)));
  } catch {
    // Quoting still works for the current page when session storage is blocked.
  }
}

function normalizeQuoteText(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

function quoteFingerprint(text) {
  return truncateGraphemes(firstQuoteParagraph(text), QUOTE_HOT_LIMIT);
}

function quoteExcerpt(text) {
  const graphemes = quoteGraphemes(normalizeQuoteText(text));
  if (graphemes.length <= QUOTE_COLD_LIMIT) return graphemes.join('');
  return `${graphemes.slice(0, 159).join('')}…${graphemes.slice(-96).join('')}`;
}

function firstQuoteParagraph(text) {
  return normalizeQuoteText(String(text).split(/\n\s*\n/u, 1)[0] ?? text);
}

function truncateGraphemes(text, limit) {
  const graphemes = quoteGraphemes(normalizeQuoteText(text));
  return graphemes.length <= limit ? graphemes.join('') : `${graphemes.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

function quoteGraphemes(text) {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);
  }
  return Array.from(text);
}

function serializeQuoteEnvelope(draft, body) {
  const kind = draft.beforeCompaction ? 'excerpt' : 'fingerprint';
  const text = kind === 'excerpt' ? draft.fallbackExcerpt : draft.fingerprint;
  const tag = kind === 'excerpt' ? '[quote:excerpt]' : '[quote]';
  return body ? `${tag} ${text}\n${body}` : `${tag} ${text}`;
}

function parseQuoteEnvelope(value) {
  const match = String(value).match(/^\[quote(?::(excerpt))?\][ \t]*(.*?)(?:\r?\n([\s\S]*))?$/u);
  if (!match || !match[2]?.trim()) return null;
  return { kind: match[1] === 'excerpt' ? 'excerpt' : 'fingerprint', text: match[2].trim(), body: match[3] ?? '' };
}

function setComposerText(textarea, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function quoteIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7.5h10M7 12h7m-7 4.5h5M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z"/></svg>';
}

function closeIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
}

// ---------------------------------------------------------------------------
// Context turn masking
// ---------------------------------------------------------------------------

function enhanceContextMaskActions() {
  const sessionId = currentSessionId();
  if (!sessionId) return;
  if (contextMaskSessionId !== sessionId) {
    contextMaskSessionId = sessionId;
    contextMaskTurns = new Map();
    void loadContextMasks(sessionId);
  }

  for (const message of document.querySelectorAll('.a-msg[data-turn-id]')) {
    const footer = message.querySelector(':scope > .a-msg-ft');
    if (!footer) continue;
    const entryId = message.dataset.turnId;
    const turn = contextMaskTurns.get(entryId);
    let button = footer.querySelector('.pi-context-mask');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'pi-context-mask';
      button.dataset.entryId = entryId;
      button.innerHTML = eyeOffIcon();
      button.addEventListener('click', () => void toggleContextMask(button));
      footer.append(button);
    }
    updateContextMaskButton(button, turn);
    markContextMaskTurn(message, turn?.masked === true);
  }
}

async function loadContextMasks(sessionId) {
  try {
    const data = await apiRequest(`/api/v1/sessions/${encodeURIComponent(sessionId)}/context-masks`);
    if (contextMaskSessionId !== sessionId) return;
    contextMaskTurns = new Map((data.items ?? []).map((turn) => [turn.assistant_entry_id, turn]));
  } catch (error) {
    if (contextMaskSessionId === sessionId) showContextMaskError(error instanceof Error ? error.message : String(error));
  } finally {
    queueAdapterRefresh();
  }
}

function updateContextMaskButton(button, turn) {
  const unavailable = !turn || !turn.can_toggle;
  button.disabled = unavailable || button.classList.contains('is-loading');
  button.classList.toggle('is-active', turn?.masked === true);
  const label = !turn
    ? localeText('正在读取上下文状态', 'Loading context state')
    : !turn.can_toggle
    ? localeText('此轮已进入上下文摘要，暂不能切换状态', 'This turn is already in a context summary and cannot be changed yet')
    : turn.masked
      ? localeText('恢复此轮到后续上下文', 'Restore this turn to future context')
      : localeText('从后续上下文屏蔽此轮', 'Hide this turn from future context');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.setAttribute('aria-pressed', turn?.masked === true ? 'true' : 'false');
}

async function toggleContextMask(button) {
  const sessionId = currentSessionId();
  const entryId = button.dataset.entryId;
  const turn = contextMaskTurns.get(entryId);
  if (!sessionId || !entryId || !turn || button.disabled) return;
  if (!turn.masked && turn.has_tools && !confirm(localeText(
    '这只会从模型后续上下文移除此轮，不会撤销该轮产生的文件、命令或外部副作用。继续吗？',
    'This only removes the turn from future model context. It does not undo files, commands, or external side effects. Continue?',
  ))) return;

  button.classList.add('is-loading');
  button.disabled = true;
  try {
    const updated = await apiRequest(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/context-masks/${encodeURIComponent(entryId)}`,
      { method: 'PUT', body: JSON.stringify({ masked: !turn.masked }) },
    );
    contextMaskTurns.set(entryId, updated);
  } catch (error) {
    showContextMaskError(error instanceof Error ? error.message : String(error));
  } finally {
    button.classList.remove('is-loading');
    queueAdapterRefresh();
  }
}

function markContextMaskTurn(message, masked) {
  message.classList.toggle('pi-context-masked-turn', masked);
  let sibling = message.previousElementSibling;
  while (sibling && !sibling.matches('.a-msg[data-turn-id]')) {
    sibling.classList.toggle('pi-context-masked-turn', masked);
    sibling = sibling.previousElementSibling;
  }
}

function showContextMaskError(message) {
  document.querySelector('.pi-context-mask-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'pi-fork-toast pi-context-mask-toast';
  toast.setAttribute('role', 'alert');
  toast.textContent = localeText(`上下文屏蔽失败：${message}`, `Could not change context: ${message}`);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function eyeOffIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.3A10.8 10.8 0 0 1 12 4c5.5 0 9 6 9 6a16 16 0 0 1-2.1 2.8M6.5 6.5C4.3 8 3 10 3 10s3.5 6 9 6c1 0 2-.2 2.9-.5"/></svg>';
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
