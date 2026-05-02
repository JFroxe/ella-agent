/**
 * ELLA - Side Panel Script
 * Multi-provider: Groq, Gemini, OpenAI.
 */

// ─── Provider Config (mirrors config.js for the panel context) ─────────────

const PROVIDERS = {
  openai: { name: 'OpenAI',         placeholder: 'sk-...' },
  groq:   { name: 'Groq',           placeholder: 'gsk_...' },
  gemini: { name: 'Google Gemini',  placeholder: 'AIza...' }
};

const DEFAULT_PROVIDER = 'groq';

// ─── Element References ────────────────────────────────────────────────────

const goalInput         = document.getElementById('goal-input');
const btnStart          = document.getElementById('btn-start');
const btnStop           = document.getElementById('btn-stop');
const btnSettings       = document.getElementById('btn-settings');
const btnSaveKey        = document.getElementById('btn-save-key');
const btnClear          = document.getElementById('btn-clear');
const apiKeyInput       = document.getElementById('api-key-input');
const keyLabel          = document.getElementById('key-label');
const keyStatus         = document.getElementById('key-status');
const settingsPanel     = document.getElementById('settings-panel');
const thoughtStream     = document.getElementById('thought-stream');
const statusBar         = document.getElementById('status-bar');
const statusText        = document.getElementById('status-text');
const stepCounter       = document.getElementById('step-counter');
const stepNum           = document.getElementById('step-num');
const providerBadge     = document.getElementById('active-provider-badge');
const providerTabs      = document.querySelectorAll('.provider-tab');

// ─── State ─────────────────────────────────────────────────────────────────

let activeProvider = DEFAULT_PROVIDER;
let isRunning = false;

// ─── Provider Selection ────────────────────────────────────────────────────

function selectProvider(key) {
  activeProvider = key;
  const info = PROVIDERS[key];

  providerTabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.provider === key);
  });

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

providerTabs.forEach(tab => {
  tab.addEventListener('click', () => selectProvider(tab.dataset.provider));
});

// ─── Status Helpers ────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusBar.className = `status-bar status-${state}`;
  statusText.textContent = text;
}

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

// ─── UI Running State ──────────────────────────────────────────────────────

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
    case 'click':    return `click [${action.ellaId}]`;
    case 'type':     return `type [${action.ellaId}] "${(action.text ?? '').slice(0, 40)}"`;
    case 'navigate': return `navigate → ${action.url}`;
    case 'scroll':   return `scroll ${action.direction ?? 'down'}`;
    case 'done':     return 'done';
    case 'error':    return 'error';
    default:         return JSON.stringify(action);
  }
}

// ─── Message Handler (from Background) ────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'panel') return;

  switch (message.type) {
    case 'ELLA_AGENT_STARTED':
      setRunningState(true);
      setStatus('running', 'Ella está pensando...');
      showStep(0);
      appendCard({
        thought: `Iniciando con el objetivo: "${message.goal}"${message.provider ? ` [${message.provider}]` : ''}`,
        type: 'start'
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
        setStatus('idle', 'Detenida');
        hideStep();
      }
      break;
  }
});

// ─── Event Listeners ───────────────────────────────────────────────────────

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

btnClear.addEventListener('click', () => {
  clearStream();
  setStatus('idle', 'Lista');
  hideStep();
});

goalInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !isRunning) {
    e.preventDefault();
    btnStart.click();
  }
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

setStatus('idle', 'Lista');
