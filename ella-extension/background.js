/**
 * ELLA - Background Service Worker
 * Manages the autonomous Think→Act loop.
 * Supports OpenAI, Groq and Google Gemini as LLM providers.
 */

import { PROVIDERS, DEFAULT_PROVIDER } from './config.js';

// ─── State ─────────────────────────────────────────────────────────────────

let agentState = {
  isRunning: false,
  currentGoal: null,
  history: [],
  stepCount: 0,
  maxSteps: 15
};

// ─── URL Restriction Check ─────────────────────────────────────────────────

function isRestrictedUrl(url) {
  if (!url) return true;
  const restricted = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'data:'];
  return restricted.some(prefix => url.startsWith(prefix));
}

// ─── Side Panel Communication ──────────────────────────────────────────────

function broadcastToPanel(event) {
  chrome.runtime.sendMessage({ target: 'panel', ...event }).catch(() => {});
}

// ─── Content Script Injection ──────────────────────────────────────────────

async function ensureContentScript(tabId) {
  try {
    await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: 'ELLA_PING' }, res => {
        if (chrome.runtime.lastError || !res?.alive) reject(); else resolve();
      });
    });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 700));
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Page State ────────────────────────────────────────────────────────────

async function getPageState(tabId) {
  const loaded = await ensureContentScript(tabId);
  if (!loaded) return null;

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'ELLA_GET_PAGE_STATE' }, response => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(response?.state ?? null);
    });
  });
}

// ─── Action Executor ───────────────────────────────────────────────────────

async function executeActionInTab(tabId, action) {
  if (action.type === 'navigate') {
    const target = /^https?:\/\//i.test(action.url) ? action.url : `https://${action.url}`;
    await chrome.tabs.update(tabId, { url: target });
    await waitForTabLoad(tabId);
    await ensureContentScript(tabId);
    return { success: true, action: 'navigate', url: target };
  }

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'ELLA_EXECUTE_ACTION', action }, response => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { success: false, error: 'Sin respuesta del content script' });
    });
  });
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const listener = (id, _info, tab) => {
      if (id === tabId && tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 20000);
  });
}

// ─── LLM Communication ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Ella, an autonomous web agent. Accomplish the user's goal by interacting with web pages step by step.

Respond ONLY with a JSON object in this exact format:
{
  "thought": "Your brief reasoning (1-2 sentences max)",
  "action": {
    "type": "click" | "type" | "navigate" | "scroll" | "done" | "error",
    "ellaId": <number>,
    "text": "<string>",
    "url": "<string>",
    "direction": "up" | "down",
    "amount": <number>,
    "message": "<string>"
  }
}

Rules:
- "done": goal fully accomplished. "error": goal is impossible or stuck.
- Prefer existing page elements over navigation.
- Only respond with the JSON — no markdown, no explanation.`;

function buildUserMessage(goal, pageState, history) {
  return `GOAL: ${goal}

PAGE STATE:
URL: ${pageState.url}
Title: ${pageState.title}
Interactive Elements:
${pageState.elements.slice(0, 60).map(el =>
  `[${el.id}] ${el.tag}${el.type ? `[type=${el.type}]` : ''}${el.role ? `[role=${el.role}]` : ''} — "${el.text || el.placeholder || '(sin etiqueta)'}"`
).join('\n')}

ACTION HISTORY (last ${Math.min(history.length, 5)} steps):
${history.slice(-5).map((h, i) =>
  `Step ${i + 1}: thought="${h.thought}" → action=${JSON.stringify(h.action)} → result=${JSON.stringify(h.result)}`
).join('\n') || 'None yet.'}`;
}

/**
 * Calls an OpenAI-compatible API (works for OpenAI and Groq).
 */
async function callOpenAIFormat(provider, apiKey, userMessage) {
  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage }
    ],
    temperature: 0.2
  };

  if (provider.name !== 'Groq') {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(err.error?.message || `HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Calls the Google Gemini API.
 */
async function callGeminiFormat(provider, apiKey, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || `HTTP ${response.status}: ${response.statusText}`;
    throw new Error(msg);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

/**
 * Extracts JSON from a raw string, tolerating markdown code fences.
 */
function extractJSON(raw) {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

/**
 * Main LLM query — dispatches to the right provider format.
 */
async function queryLLM(providerKey, goal, pageState, history) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`Proveedor desconocido: ${providerKey}`);

  const apiKey = await getStoredApiKey(providerKey);
  if (!apiKey) throw new Error(`No tienes API Key de ${provider.name} guardada. Haz clic en ⚙ para añadirla.`);

  const userMessage = buildUserMessage(goal, pageState, history);

  let rawText;
  if (provider.format === 'gemini') {
    rawText = await callGeminiFormat(provider, apiKey, userMessage);
  } else {
    rawText = await callOpenAIFormat(provider, apiKey, userMessage);
  }

  if (!rawText) throw new Error('Respuesta vacía del LLM');
  return extractJSON(rawText);
}

// ─── Think→Act Loop ────────────────────────────────────────────────────────

async function runAgentLoop(goal, tabId, providerKey) {
  const tab = await chrome.tabs.get(tabId);

  if (isRestrictedUrl(tab.url)) {
    broadcastToPanel({
      type: 'ELLA_ERROR',
      message: 'Ella no puede operar en páginas del sistema (chrome://, extensiones, etc.). Navega a un sitio web normal primero.'
    });
    return;
  }

  agentState.isRunning = true;
  agentState.currentGoal = goal;
  agentState.history = [];
  agentState.stepCount = 0;

  broadcastToPanel({ type: 'ELLA_AGENT_STARTED', goal, provider: PROVIDERS[providerKey]?.name });

  try {
    while (agentState.isRunning && agentState.stepCount < agentState.maxSteps) {
      agentState.stepCount++;
      broadcastToPanel({ type: 'ELLA_STEP_START', step: agentState.stepCount });

      const pageState = await getPageState(tabId);
      if (!pageState) {
        throw new Error('No se pudo leer el estado de la página. Asegúrate de estar en un sitio web normal.');
      }

      const llmResponse = await queryLLM(providerKey, goal, pageState, agentState.history);
      const { thought, action } = llmResponse;

      broadcastToPanel({ type: 'ELLA_THOUGHT', thought, step: agentState.stepCount });

      if (action.type === 'done') {
        broadcastToPanel({ type: 'ELLA_DONE', message: action.message, history: agentState.history });
        agentState.isRunning = false;
        break;
      }

      if (action.type === 'error') {
        broadcastToPanel({ type: 'ELLA_ERROR', message: action.message });
        agentState.isRunning = false;
        break;
      }

      const result = await executeActionInTab(tabId, action);
      broadcastToPanel({ type: 'ELLA_ACTION_RESULT', action, result, step: agentState.stepCount });

      agentState.history.push({ thought, action, result });

      await new Promise(r => setTimeout(r, 1200));
    }

    if (agentState.isRunning && agentState.stepCount >= agentState.maxSteps) {
      broadcastToPanel({
        type: 'ELLA_ERROR',
        message: `Límite de ${agentState.maxSteps} pasos alcanzado sin completar el objetivo.`
      });
    }
  } catch (err) {
    broadcastToPanel({ type: 'ELLA_ERROR', message: err.message });
  } finally {
    agentState.isRunning = false;
    broadcastToPanel({ type: 'ELLA_AGENT_STOPPED' });
  }
}

// ─── Storage Helpers ───────────────────────────────────────────────────────

async function getStoredApiKey(providerKey) {
  return new Promise(resolve => {
    chrome.storage.local.get(`ella_api_key_${providerKey}`, data => {
      resolve(data[`ella_api_key_${providerKey}`] || null);
    });
  });
}

// ─── Message Listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === 'panel') return false;

  switch (message.type) {
    case 'ELLA_START_AGENT':
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab) return sendResponse({ success: false, error: 'No se encontró pestaña activa' });
        runAgentLoop(message.goal, tab.id, message.provider || DEFAULT_PROVIDER);
        sendResponse({ success: true });
      });
      return true;

    case 'ELLA_STOP_AGENT':
      agentState.isRunning = false;
      sendResponse({ success: true });
      break;

    case 'ELLA_SAVE_API_KEY':
      chrome.storage.local.set({ [`ella_api_key_${message.provider}`]: message.apiKey }, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'ELLA_GET_STATUS':
      sendResponse({
        isRunning: agentState.isRunning,
        stepCount: agentState.stepCount,
        goal: agentState.currentGoal
      });
      break;

    default:
      break;
  }

  return false;
});

// ─── Side Panel Toggle ─────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

console.log('[Ella] Background service worker started.');
