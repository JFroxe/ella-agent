# Ella — Autonomous AI Agent Chrome Extension

Ella es una extensión de Chrome (Manifest V3) que actúa como un agente de IA autónomo capaz de interactuar con cualquier página web mediante un bucle de **Pensamiento → Acción**.

---

## Estructura del Proyecto

```
ella-extension/
├── manifest.json          ← Manifest V3 con permisos
├── background.js          ← Service Worker: bucle Think→Act + comunicación LLM
├── content.js             ← Content Script: extracción DOM + controlador de acciones
├── config.js              ← Configuración del proveedor LLM (intercambiable)
├── sidepanel/
│   ├── panel.html         ← Interfaz del panel lateral
│   ├── panel.js           ← Lógica del panel: eventos, stream de pensamientos
│   └── panel.css          ← Estilos del panel
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Instalación en Chrome

1. Abre Chrome y ve a `chrome://extensions/`
2. Activa **Modo desarrollador** (interruptor en la esquina superior derecha)
3. Haz clic en **"Cargar descomprimida"**
4. Selecciona la carpeta `ella-extension/`
5. Ella aparecerá en tu barra de extensiones

---

## Configuración Inicial

1. Haz clic en el icono de Ella en la barra de herramientas para abrir el **Panel Lateral**
2. Haz clic en ⚙ (Configuración)
3. Pega tu **API Key** (OpenAI u otro proveedor compatible)
4. Haz clic en **Guardar** — la clave se almacena localmente en tu navegador

---

## Cambiar el Proveedor LLM

Edita `config.js` para usar otro proveedor:

```js
// OpenAI (por defecto)
LLM_API_URL: 'https://api.openai.com/v1/chat/completions'
LLM_MODEL: 'gpt-4o-mini'

// Groq (rápido y gratuito)
LLM_API_URL: 'https://api.groq.com/openai/v1/chat/completions'
LLM_MODEL: 'llama-3.3-70b-versatile'

// OpenRouter (multi-modelo)
LLM_API_URL: 'https://openrouter.ai/api/v1/chat/completions'
LLM_MODEL: 'openai/gpt-4o-mini'
```

---

## Cómo Funciona

### 1. Content Script (`content.js`)
- Se inyecta en todas las páginas automáticamente
- **`extractPageState()`** — recorre el DOM y extrae todos los elementos interactivos visibles (`button`, `input`, `textarea`, `select`, `a`, elementos con `role`) con sus posiciones y textos
- Cada elemento recibe un `data-ella-id` único para que el agente pueda referenciarlo
- **Action Controller** integrado: `executeClick`, `executeType`, `executeNavigate`, `executeScroll`

### 2. Background Service Worker (`background.js`)
- Implementa el bucle **Think→Act**:
  1. Obtiene el estado de la página actual via el content script
  2. Envía el estado + historial al LLM
  3. El LLM devuelve `{ thought, action }` en JSON
  4. Ejecuta la acción en la pestaña activa
  5. Repite hasta completar el objetivo o alcanzar el máximo de pasos (15)
- Transmite el "pensamiento" de Ella al panel lateral en tiempo real

### 3. Side Panel (`sidepanel/`)
- Interfaz lateral de una sola página
- El usuario escribe su objetivo en lenguaje natural
- Muestra el **stream de pensamientos** de Ella: cada paso con su razonamiento y acción ejecutada
- Indicador de estado animado (inactiva / pensando / completado / error)
- Botón de **Detener** para interrumpir el agente en cualquier momento

### 4. Acciones Disponibles

| Tipo       | Parámetros              | Descripción                                  |
|------------|-------------------------|----------------------------------------------|
| `click`    | `ellaId`                | Hace clic en el elemento con ese ID          |
| `type`     | `ellaId`, `text`        | Escribe texto en el campo                    |
| `navigate` | `url`                   | Navega a una URL (absoluta o relativa)       |
| `scroll`   | `direction`, `amount`   | Desplaza la página (up/down)                 |
| `done`     | `message`               | Indica que el objetivo fue completado        |
| `error`    | `message`               | Indica que el objetivo no es alcanzable      |

---

## Ejemplo de Uso

1. Ve a cualquier página web (e.g., Google, un formulario, una tienda online)
2. Abre el panel de Ella
3. Escribe: *"Busca 'laptops gaming' y abre el primer resultado"*
4. Haz clic en **Iniciar**
5. Ella leerá la página, pensará, y ejecutará las acciones una a una

---

## Notas de Seguridad

- La API Key se guarda solo en `chrome.storage.local` — nunca sale del navegador
- Ella no puede acceder a extensiones privadas ni URLs de `chrome://`
- El agente se detiene automáticamente tras 15 pasos como límite de seguridad
