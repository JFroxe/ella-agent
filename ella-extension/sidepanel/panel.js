/**
 * ELLA - Side Panel Script
 * Multi-provider + Knowledge Base (global instructions + per-platform knowledge).
 */

// ─── Provider Config ───────────────────────────────────────────────────────

const PROVIDERS = {
  openai: { name: 'OpenAI',        placeholder: 'sk-...' },
  groq:   { name: 'Groq',          placeholder: 'gsk_...' },
  gemini: { name: 'Google Gemini', placeholder: 'AIza...' }
};
const DEFAULT_PROVIDER = 'groq';

// ─── Element References ────────────────────────────────────────────────────

const goalInput          = document.getElementById('goal-input');
const btnStart           = document.getElementById('btn-start');
const btnStop            = document.getElementById('btn-stop');
const btnSettings        = document.getElementById('btn-settings');
const btnSaveKey         = document.getElementById('btn-save-key');
const btnClear           = document.getElementById('btn-clear');
const apiKeyInput        = document.getElementById('api-key-input');
const keyLabel           = document.getElementById('key-label');
const keyStatus          = document.getElementById('key-status');
const settingsPanel      = document.getElementById('settings-panel');
const thoughtStream      = document.getElementById('thought-stream');
const statusBar          = document.getElementById('status-bar');
const statusText         = document.getElementById('status-text');
const stepCounter        = document.getElementById('step-counter');
const stepNum            = document.getElementById('step-num');
const providerBadge      = document.getElementById('active-provider-badge');
const providerTabs       = document.querySelectorAll('.provider-tab');
const mainTabs           = document.querySelectorAll('.main-tab');

// Knowledge elements
const globalInstructions  = document.getElementById('global-instructions');
const btnSaveGlobal       = document.getElementById('btn-save-global');
const platformName        = document.getElementById('platform-name');
const platformPattern     = document.getElementById('platform-pattern');
const platformInstructions = document.getElementById('platform-instructions');
const btnSavePlatform     = document.getElementById('btn-save-platform');
const platformSaveLabel   = document.getElementById('platform-save-label');
const btnCancelEdit       = document.getElementById('btn-cancel-edit');
const platformList        = document.getElementById('platform-list');

// ─── State ─────────────────────────────────────────────────────────────────

let activeProvider = DEFAULT_PROVIDER;
let isRunning = false;
let editingPlatformKey = null;
let platformKnowledge = {};

// ─── Tab Navigation ────────────────────────────────────────────────────────

mainTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    mainTabs.forEach(t => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', t === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('hidden', panel.id !== `tab-${tab.dataset.tab}`);
    });
  });
});

// ─── Provider Selection ────────────────────────────────────────────────────

function selectProvider(key) {
  activeProvider = key;
  const info = PROVIDERS[key];
  providerTabs.forEach(t => t.classList.toggle('active', t.dataset.provider === key));
  keyLabel.textContent = `API Key de ${info.name}`;
  apiKeyInput.placeholder = info.placeholder;
  apiKeyInput.value = '';
  keyStatus.classList.add('hidden');
  providerBadge.textContent = info.name;

  chrome.storage.local.get(`ella_api_key_${key}`, data => {
    const hasKey = !!data[`ella_api_key_${key}`];
    showKeyStatus(hasKey ? '✓ API Key guardada' : '✗ Sin API Key', hasKey ? 'ok' : 'warn');
  });

  chrome.storage.local.set({ ella_active_provider: key });
}

function showKeyStatus(msg, type) {
  keyStatus.textContent = msg;
  keyStatus.className = `key-status key-status-${type}`;
  keyStatus.classList.remove('hidden');
}

providerTabs.forEach(tab => tab.addEventListener('click', () => selectProvider(tab.dataset.provider)));

// ─── Status Helpers ────────────────────────────────────────────────────────

function setStatus(state, text) { statusBar.className = `status-bar status-${state}`; statusText.textContent = text; }
function showStep(n) { stepCounter.classList.remove('hidden'); stepNum.textContent = n; }
function hideStep()  { stepCounter.classList.add('hidden'); }

// ─── Thought Stream ────────────────────────────────────────────────────────

function clearStream() {
  thoughtStream.innerHTML = '<div class="thought-empty">Los pensamientos de Ella aparecerán aquí cuando esté activa.</div>';
}

function appendCard({ step, thought, action, type = 'default' }) {
  document.querySelector('.thought-empty')?.remove();
  const card = document.createElement('div');
  card.className = `thought-card card-${type}`;

  if (step != null) {
    const header = document.createElement('div');
    header.className = 'thought-card-header';
    const badge = document.createElement('span');
    badge.className = 'thought-card-step';
    badge.textContent = `Paso ${step}`;
    header.appendChild(badge);
    card.appendChild(header);
  }
  if (thought) {
    const el = document.createElement('div');
    el.className = 'thought-card-thought';
    el.textContent = thought;
    card.appendChild(el);
  }
  if (action) {
    const el = document.createElement('div');
    el.className = 'thought-card-action';
    el.textContent = typeof action === 'string' ? action : JSON.stringify(action);
    card.appendChild(el);
  }
  thoughtStream.appendChild(card);
  thoughtStream.scrollTop = thoughtStream.scrollHeight;
}

// ─── Running State ─────────────────────────────────────────────────────────

function setRunningState(running) {
  isRunning = running;
  btnStart.classList.toggle('hidden', running);
  btnStop.classList.toggle('hidden', !running);
  goalInput.disabled = running;
  btnStart.disabled = running;
}

// ─── Action Formatter ──────────────────────────────────────────────────────

function formatAction(action) {
  if (!action) return 'acción desconocida';
  switch (action.type) {
    case 'click':      return `click [${action.ellaId}]`;
    case 'type':       return `type [${action.ellaId}] "${(action.text ?? '').slice(0, 40)}"`;
    case 'navigate':   return `navigate → ${action.url}`;
    case 'scroll':     return `scroll ${action.direction ?? 'down'}`;
    case 'new_tab':    return `nueva pestaña → ${action.url}`;
    case 'switch_tab': return `cambiar a pestaña [${action.tabId}]`;
    case 'close_tab':  return `cerrar pestaña [${action.tabId ?? 'actual'}]`;
    default:           return JSON.stringify(action);
  }
}

// ─── Knowledge Base ────────────────────────────────────────────────────────

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function loadKnowledge() {
  chrome.storage.local.get(['ella_global_instructions', 'ella_platform_knowledge'], data => {
    globalInstructions.value = data.ella_global_instructions || '';
    platformKnowledge = data.ella_platform_knowledge || {};
    renderPlatformList();
  });
}

function renderPlatformList() {
  const keys = Object.keys(platformKnowledge);
  if (keys.length === 0) {
    platformList.innerHTML = '<div class="platform-empty">No hay plataformas guardadas todavía.</div>';
    return;
  }
  platformList.innerHTML = '';
  keys.forEach(key => {
    const entry = platformKnowledge[key];
    const card = document.createElement('div');
    card.className = 'platform-card';
    card.innerHTML = `
      <div class="platform-card-header">
        <div>
          <span class="platform-card-name">${entry.name}</span>
          <span class="platform-card-pattern">${entry.pattern}</span>
        </div>
        <div class="platform-card-actions">
          <button class="text-btn" data-action="edit" data-key="${key}">Editar</button>
          <button class="text-btn danger-btn" data-action="delete" data-key="${key}">Eliminar</button>
        </div>
      </div>
      <div class="platform-card-preview">${entry.instructions.slice(0, 100)}${entry.instructions.length > 100 ? '…' : ''}</div>
    `;
    platformList.appendChild(card);
  });

  platformList.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => editPlatform(btn.dataset.key));
  });
  platformList.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deletePlatform(btn.dataset.key));
  });
}

function editPlatform(key) {
  const entry = platformKnowledge[key];
  if (!entry) return;
  editingPlatformKey = key;
  platformName.value = entry.name;
  platformPattern.value = entry.pattern;
  platformInstructions.value = entry.instructions;
  platformSaveLabel.textContent = 'Guardar cambios';
  btnCancelEdit.classList.remove('hidden');
  platformName.focus();
  document.querySelector('[data-tab="knowledge"]').click();
  platformName.scrollIntoView({ behavior: 'smooth' });
}

function deletePlatform(key) {
  delete platformKnowledge[key];
  chrome.storage.local.set({ ella_platform_knowledge: platformKnowledge }, () => {
    renderPlatformList();
  });
}

function resetPlatformForm() {
  editingPlatformKey = null;
  platformName.value = '';
  platformPattern.value = '';
  platformInstructions.value = '';
  platformSaveLabel.textContent = 'Añadir plataforma';
  btnCancelEdit.classList.add('hidden');
}

btnSaveGlobal.addEventListener('click', () => {
  chrome.storage.local.set({ ella_global_instructions: globalInstructions.value.trim() }, () => {
    btnSaveGlobal.textContent = '✓ Guardado';
    setTimeout(() => (btnSaveGlobal.textContent = 'Guardar instrucciones globales'), 1500);
  });
});

btnSavePlatform.addEventListener('click', () => {
  const name = platformName.value.trim();
  const pattern = platformPattern.value.trim();
  const instructions = platformInstructions.value.trim();
  if (!name || !pattern || !instructions) {
    [platformName, platformPattern, platformInstructions].forEach(el => {
      if (!el.value.trim()) { el.style.borderColor = 'var(--danger)'; setTimeout(() => (el.style.borderColor = ''), 1500); }
    });
    return;
  }
  const key = editingPlatformKey || slugify(name);
  platformKnowledge[key] = { name, pattern, instructions };
  chrome.storage.local.set({ ella_platform_knowledge: platformKnowledge }, () => {
    renderPlatformList();
    resetPlatformForm();
  });
});

btnCancelEdit.addEventListener('click', resetPlatformForm);

// ─── Background Message Handler ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'panel') return;

  switch (message.type) {
    case 'ELLA_AGENT_STARTED':
      setRunningState(true);
      setStatus('running', 'Ella está pensando...');
      showStep(0);
      appendCard({
        thought: `Iniciando: "${message.goal}"${message.provider ? ` [${message.provider}]` : ''}`,
        type: 'start'
      });
      break;

    case 'ELLA_KNOWLEDGE_ACTIVE':
      appendCard({
        action: `📚 Conocimiento activo: ${message.hints.join(', ')}`,
        type: 'knowledge'
      });
      break;

    case 'ELLA_STEP_START':
      showStep(message.step);
      setStatus('running', `Pensando — paso ${message.step}`);
      break;

    case 'ELLA_THOUGHT':
      appendCard({ step: message.step, thought: message.thought });
      break;

    case 'ELLA_ACTION_RESULT': {
      const summary = formatAction(message.action);
      const result = message.result?.success ? '✓ OK' : `✗ ${message.result?.error || 'Error'}`;
      appendCard({ action: `${summary}  →  ${result}` });
      break;
    }

    case 'ELLA_TAB_EVENT': {
      const labels = { new_tab: '🗂 Nueva pestaña', switch_tab: '↔ Cambió a pestaña', close_tab: '✕ Cerró pestaña' };
      const label = labels[message.event];
      if (label) {
        const detail = message.url ? ` → ${message.url}` : ` [tabId: ${message.tabId}]`;
        appendCard({ action: `${label}${detail}`, type: 'tab' });
      }
      break;
    }

    case 'ELLA_TAB_SWITCHED':
      setStatus('running', `Pestaña activa: ${message.tabId}`);
      break;

    case 'ELLA_DONE':
      setStatus('done', 'Objetivo completado');
      hideStep();
      appendCard({ thought: message.message || 'Tarea completada con éxito.', type: 'done' });
      setRunningState(false);
      break;

    case 'ELLA_ERROR':
      setStatus('error', 'Error');
      hideStep();
      appendCard({ thought: message.message || 'Ocurrió un error inesperado.', type: 'error' });
      setRunningState(false);
      break;

    case 'ELLA_AGENT_STOPPED':
      setRunningState(false);
      if (!statusBar.classList.contains('status-done') && !statusBar.classList.contains('status-error')) {
        setStatus('idle', 'Detenida'); hideStep();
      }
      break;
  }
});

// ─── Task Controls ─────────────────────────────────────────────────────────

btnStart.addEventListener('click', () => {
  const goal = goalInput.value.trim();
  if (!goal) {
    goalInput.focus();
    goalInput.style.borderColor = 'var(--danger)';
    setTimeout(() => (goalInput.style.borderColor = ''), 1500);
    return;
  }
  chrome.runtime.sendMessage(
    { type: 'ELLA_START_AGENT', goal, provider: activeProvider },
    res => { if (!res?.success) appendCard({ thought: res?.error || 'No se pudo iniciar el agente.', type: 'error' }); }
  );
});

btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ELLA_STOP_AGENT' }, () => {
    appendCard({ thought: 'Agente detenido por el usuario.', type: 'error' });
  });
});

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) selectProvider(activeProvider);
});

btnSaveKey.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  chrome.runtime.sendMessage({ type: 'ELLA_SAVE_API_KEY', apiKey: key, provider: activeProvider }, () => {
    apiKeyInput.value = '';
    showKeyStatus('✓ API Key guardada', 'ok');
  });
});

btnClear.addEventListener('click', () => { clearStream(); setStatus('idle', 'Lista'); hideStep(); });

goalInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !isRunning) { e.preventDefault(); btnStart.click(); }
});

// ─── Init ──────────────────────────────────────────────────────────────────

chrome.storage.local.get('ella_active_provider', data => {
  selectProvider(data.ella_active_provider || DEFAULT_PROVIDER);
});

chrome.runtime.sendMessage({ type: 'ELLA_GET_STATUS' }, res => {
  if (res?.isRunning) {
    setRunningState(true);
    setStatus('running', `Ella está activa — paso ${res.stepCount}`);
    showStep(res.stepCount);
    appendCard({ thought: `Retomando tarea: "${res.goal}"`, type: 'start' });
  }
});

loadKnowledge();
setStatus('idle', 'Lista');
