/**
 * ELLA - Content Script
 * Runs in the context of every web page.
 * Responsible for: DOM inspection, element extraction, and action execution.
 */

// ─── DOM State Extractor ───────────────────────────────────────────────────

/**
 * Extracts all interactive elements from the current DOM.
 * Returns a structured snapshot of the page state.
 */
function extractPageState() {
  const interactiveSelectors = [
    'button',
    'input',
    'textarea',
    'select',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'
  ];

  const elements = [];
  const seen = new Set();

  document.querySelectorAll(interactiveSelectors.join(',')).forEach((el, index) => {
    if (seen.has(el)) return;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    const isVisible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      getComputedStyle(el).visibility !== 'hidden' &&
      getComputedStyle(el).display !== 'none';

    if (!isVisible) return;

    const elData = {
      id: index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      role: el.getAttribute('role') || null,
      text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 120),
      name: el.getAttribute('name') || null,
      href: el.getAttribute('href') || null,
      placeholder: el.getAttribute('placeholder') || null,
      disabled: el.disabled || false,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };

    el.dataset.ellaId = index;
    elements.push(elData);
  });

  return {
    url: window.location.href,
    title: document.title,
    elements,
    timestamp: Date.now()
  };
}

// ─── Action Controller ─────────────────────────────────────────────────────

/**
 * Finds an element by its ella-assigned ID.
 */
function findElement(ellaId) {
  return document.querySelector(`[data-ella-id="${ellaId}"]`);
}

/**
 * Simulates a click on an element.
 */
function executeClick(ellaId) {
  const el = findElement(ellaId);
  if (!el) return { success: false, error: `Element with ella-id ${ellaId} not found` };
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus();
  el.click();
  return { success: true, action: 'click', ellaId };
}

/**
 * Types text into an input or contenteditable element.
 */
function executeType(ellaId, text) {
  const el = findElement(ellaId);
  if (!el) return { success: false, error: `Element with ella-id ${ellaId} not found` };

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus();

  if (el.isContentEditable) {
    el.innerText = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, text);
    } else {
      el.value = text;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return { success: true, action: 'type', ellaId, text };
}

/**
 * Navigates the current tab to a new URL.
 */
function executeNavigate(url) {
  try {
    const target = new URL(url, window.location.href).href;
    window.location.href = target;
    return { success: true, action: 'navigate', url: target };
  } catch (e) {
    return { success: false, error: `Invalid URL: ${url}` };
  }
}

/**
 * Scrolls the page by a given amount.
 */
function executeScroll(direction = 'down', amount = 400) {
  const delta = direction === 'up' ? -amount : amount;
  window.scrollBy({ top: delta, behavior: 'smooth' });
  return { success: true, action: 'scroll', direction, amount };
}

// ─── Message Listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'ELLA_PING':
      sendResponse({ alive: true });
      break;

    case 'ELLA_GET_PAGE_STATE':
      sendResponse({ success: true, state: extractPageState() });
      break;

    case 'ELLA_EXECUTE_ACTION': {
      const { action } = message;
      let result;

      switch (action.type) {
        case 'click':
          result = executeClick(action.ellaId);
          break;
        case 'type':
          result = executeType(action.ellaId, action.text);
          break;
        case 'navigate':
          result = executeNavigate(action.url);
          break;
        case 'scroll':
          result = executeScroll(action.direction, action.amount);
          break;
        default:
          result = { success: false, error: `Unknown action type: ${action.type}` };
      }

      sendResponse(result);
      break;
    }

    default:
      sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
  }

  return true;
});

console.log('[Ella] Content script loaded on:', window.location.href);
