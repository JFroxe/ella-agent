/**
 * ELLA - Background Service Worker
 * Multi-tab autonomous agent: Think→Act loop across the full browser.
 * Supports OpenAI, Groq and Google Gemini as LLM providers.
 */

import { PROVIDERS, DEFAULT_PROVIDER } from './config.js';

// ─── State ─────────────────────────────────────────────────────────────────

let agentState = {
  isRunning: false,
  currentGoal: null,
  history: [],
  stepCount: 0,
  maxSteps: 20,
  currentTabId: null
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

// ─── Content Script Management ─────────────────────────────────────────────

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

// ─── Tab Helpers ────────────────────────────────────────────────────────────

/**
 * Returns a list of all non-restricted tabs in the current window.
 */
async function getAllTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.filter(t => !isRestrictedUrl(t.url)).map(t => ({
    tabId: t.id,
    url: t.url,
    title: t.title || '(sin título)',
    active: t.active
  }));
}

/**
 * Waits for a tab to finish loading.
 */
function waitForTabLoad(tabId, timeout = 20000) {
  return new Promise(resolve => {
    const listener = (id, _info, tab) => {
      if (id === tabId && tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeout);
  });
}

// ─── Page State ────────────────────────────────────────────────────────────

async function getPageState(tabId) {
  const loaded = await ensureContentScript(tabId);
  if (!loaded) return null;

  const [pageState, tabs] = await Promise.all([
    new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { type: 'ELLA_GET_PAGE_STATE' }, response => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response?.state ?? null);
      });
    }),
    getAllTabs()
  ]);

  if (!pageState) return null;
  return { ...pageState, tabs };
}

// ─── Action Executor ───────────────────────────────────────────────────────

/**
 * Executes an action and returns the new currentTabId (may change on tab actions).
 */
async function executeAction(tabId, action) {
  let newTabId = tabId;

  switch (action.type) {

    case 'navigate': {
      const target = /^https?:\/\//i.test(action.url) ? action.url : `https://${action.url}`;
      await chrome.tabs.update(tabId, { url: target });
      await waitForTabLoad(tabId);
      await ensureContentScript(tabId);
      broadcastToPanel({ type: 'ELLA_TAB_EVENT', event: 'navigate', tabId, url: target });
      return { result: { success: true, action: 'navigate', url: target }, newTabId };
    }

    case 'new_tab': {
      const target = /^https?:\/\//i.test(action.url) ? action.url : `https://${action.url}`;
      const background = action.background === true;
      const tab = await chrome.tabs.create({ url: target, active: !background });
      await waitForTabLoad(tab.id);
      await ensureContentScript(tab.id);
      if (!background) newTabId = tab.id;
      broadcastToPanel({ type: 'ELLA_TAB_EVENT', event: 'new_tab', tabId: tab.id, url: target, background });
      return {
        result: { success: true, action: 'new_tab', tabId: tab.id, url: target },
        newTabId
      };
    }

    case 'switch_tab': {
      const targetId = action.tabId;
      try {
        await chrome.tabs.update(targetId, { active: true });
        await ensureContentScript(targetId);
        newTabId = targetId;
        broadcastToPanel({ type: 'ELLA_TAB_EVENT', event: 'switch_tab', tabId: targetId });
        return { result: { success: true, action: 'switch_tab', tabId: targetId }, newTabId };
      } catch (e) {
        return { result: { success: false, error: `No se pudo cambiar a la pestaña ${targetId}: ${e.message}` }, newTabId };
      }
    }

    case 'close_tab': {
      const closeId = action.tabId ?? tabId;
      try {
        await chrome.tabs.remove(closeId);
        broadcastToPanel({ type: 'ELLA_TAB_EVENT', event: 'close_tab', tabId: closeId });

        if (closeId === tabId) {
          const remaining = await getAllTabs();
          if (remaining.length > 0) {
            newTabId = remaining[remaining.length - 1].tabId;
            await chrome.tabs.update(newTabId, { active: true });
            await ensureContentScript(newTabId);
          }
        }
        return { result: { success: true, action: 'close_tab', tabId: closeId }, newTabId };
      } catch (e) {
        return { result: { success: false, error: e.message }, newTabId };
      }
    }

    default: {
      const result = await new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, { type: 'ELLA_EXECUTE_ACTION', action }, response => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response ?? { success: false, error: 'Sin respuesta del content script' });
        });
      });
      return { result, newTabId };
    }
  }
}

// ─── LLM Communication ────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are Ella, an autonomous web agent with full browser control. Accomplish the user's goal by interacting with web pages step by step. You can work across multiple tabs.

Respond ONLY with a JSON object in this exact format:
{
  "thought": "Your brief reasoning (1-2 sentences max)",
  "action": {
    "type": "click" | "type" | "navigate" | "scroll" | "new_tab" | "switch_tab" | "close_tab" | "done" | "error",
    "ellaId": <number>,
    "text": "<string>",
    "url": "<string>",
    "background": false,
    "tabId": <number>,
    "direction": "up" | "down",
    "amount": <number>,
    "message": "<string>"
  }
}

Action rules:
- "navigate": loads a URL in the CURRENT tab.
- "new_tab": opens a URL in a NEW tab and switches to it (unless background: true).
- "switch_tab": switches the active tab using tabId from the OPEN TABS list.
- "close_tab": closes a tab by tabId. Omit tabId to close the current tab.
- "done": goal fully accomplished.
- "error": goal is impossible or you are stuck after multiple attempts.
- Only respond with the JSON — no markdown, no explanation.`;

// ─── Knowledge Base Helpers ────────────────────────────────────────────────

async function loadKnowledge() {
  return new Promise(resolve => {
    chrome.storage.local.get(['ella_global_instructions', 'ella_platform_knowledge'], data => {
      resolve({
        global: data.ella_global_instructions || '',
        platforms: data.ella_platform_knowledge || {}
      });
    });
  });
}

/**
 * Finds platform knowledge entries that match the current URL.
 */
function matchingPlatforms(url, platforms) {
  try {
    const hostname = new URL(url).hostname;
    return Object.values(platforms).filter(entry => {
      const pattern = entry.pattern.toLowerCase().replace(/^https?:\/\//, '');
      return hostname.includes(pattern) || pattern.includes(hostname);
    });
  } catch {
    return [];
  }
}

/**
 * Builds the full system prompt including any active knowledge.
 */
function buildSystemPrompt(globalInstructions, matchedPlatforms) {
  let prompt = BASE_SYSTEM_PROMPT;

  if (globalInstructions) {
    prompt += `\n\n--- GLOBAL INSTRUCTIONS (always follow these) ---\n${globalInstructions}`;
  }

  if (matchedPlatforms.length > 0) {
    const sections = matchedPlatforms.map(p =>
      `[${p.name} — ${p.pattern}]\n${p.instructions}`
    ).join('\n\n');
    prompt += `\n\n--- PLATFORM KNOWLEDGE (you are on a known platform — use this) ---\n${sections}`;
  }

  return prompt;
}

function buildUserMessage(goal, pageState, history) {
  const tabsList = pageState.tabs && pageState.tabs.length > 0
    ? `\nOPEN TABS:\n${pageState.tabs.map(t =>
        `  [tabId: ${t.tabId}]${t.tabId === pageState.currentTabId ? ' (ACTIVE)' : ''} ${new URL(t.url).hostname || t.url} — "${t.title.slice(0, 60)}"`
      ).join('\n')}`
    : '';

  return `GOAL: ${goal}

CURRENT PAGE:
URL: ${pageState.url}
Title: ${pageState.title}${tabsList}

INTERACTIVE ELEMENTS on current page:
${pageState.elements.slice(0, 60).map(el =>
  `[${el.id}] ${el.tag}${el.type ? `[type=${el.type}]` : ''}${el.role ? `[role=${el.role}]` : ''} — "${el.text || el.placeholder || '(sin etiqueta)'}"`
).join('\n')}

ACTION HISTORY (last ${Math.min(history.length, 5)} steps):
${history.slice(-5).map((h, i) =>
  `Step ${i + 1}: thought="${h.thought}" → action=${JSON.stringify(h.action)} → result=${JSON.stringify(h.result)}`
).join('\n') || 'None yet.'}`;
}

async function callOpenAIFormat(provider, apiKey, systemPrompt, userMessage) {
  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
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

async function callGeminiFormat(provider, apiKey, systemPrompt, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

function extractJSON(raw) {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

async function queryLLM(providerKey, systemPrompt, goal, pageState, history) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`Proveedor desconocido: ${providerKey}`);

  const apiKey = await getStoredApiKey(providerKey);
  if (!apiKey) throw new Error(`No tienes API Key de ${provider.name} guardada. Haz clic en ⚙ para añadirla.`);

  const userMessage = buildUserMessage(goal, pageState, history);

  let rawText;
  if (provider.format === 'gemini') {
    rawText = await callGeminiFormat(provider, apiKey, systemPrompt, userMessage);
  } else {
    rawText = await callOpenAIFormat(provider, apiKey, systemPrompt, userMessage);
  }

  if (!rawText) throw new Error('Respuesta vacía del LLM');
  return extractJSON(rawText);
}

// ─── Think→Act Loop ────────────────────────────────────────────────────────

async function runAgentLoop(goal, startTabId, providerKey) {
  const startTab = await chrome.tabs.get(startTabId);

  if (isRestrictedUrl(startTab.url)) {
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
  agentState.currentTabId = startTabId;

  // Load knowledge base once at the start of the session
  const knowledge = await loadKnowledge();

  broadcastToPanel({ type: 'ELLA_AGENT_STARTED', goal, provider: PROVIDERS[providerKey]?.name });

  try {
    while (agentState.isRunning && agentState.stepCount < agentState.maxSteps) {
      agentState.stepCount++;
      broadcastToPanel({ type: 'ELLA_STEP_START', step: agentState.stepCount });

      const pageState = await getPageState(agentState.currentTabId);
      if (!pageState) {
        throw new Error('No se pudo leer el estado de la página. Asegúrate de estar en un sitio web normal.');
      }

      pageState.currentTabId = agentState.currentTabId;

      // Build system prompt with knowledge relevant to the current page URL
      const matched = matchingPlatforms(pageState.url, knowledge.platforms);
      const systemPrompt = buildSystemPrompt(knowledge.global, matched);

      // On step 1, tell the panel which knowledge is active
      if (agentState.stepCount === 1) {
        const hints = [];
        if (knowledge.global) hints.push('instrucciones globales');
        if (matched.length > 0) hints.push(...matched.map(p => p.name));
        if (hints.length > 0) {
          broadcastToPanel({ type: 'ELLA_KNOWLEDGE_ACTIVE', hints });
        }
      }

      const llmResponse = await queryLLM(providerKey, systemPrompt, goal, pageState, agentState.history);
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

      const { result, newTabId } = await executeAction(agentState.currentTabId, action);

      if (newTabId !== agentState.currentTabId) {
        agentState.currentTabId = newTabId;
        broadcastToPanel({ type: 'ELLA_TAB_SWITCHED', tabId: newTabId });
      }

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

console.log('[Ella] Background service worker started (multi-tab mode).');
