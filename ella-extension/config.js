/**
 * ELLA - Provider Configuration
 * Supports OpenAI, Groq (OpenAI-compatible) and Google Gemini.
 */

export const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    format: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyPlaceholder: 'sk-...'
  },
  groq: {
    name: 'Groq',
    format: 'openai',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    keyPlaceholder: 'gsk_...'
  },
  gemini: {
    name: 'Google Gemini',
    format: 'gemini',
    model: 'gemini-2.0-flash',
    keyPlaceholder: 'AIza...'
  }
};

export const DEFAULT_PROVIDER = 'groq';
