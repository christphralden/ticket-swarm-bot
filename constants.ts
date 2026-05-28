export const DASHBOARD_PORT = 3000;
export const WS_PORT = 3001;

export const PRE_NAVIGATE_MS = 30_000;
export const PRECISION_POLL_MS = 100;
export const DEFAULT_REFRESH_MS = 2_000;
export const SESSION_DIR = "./sessions";

export const QUEUE_PATTERNS = [
  "queue-it.net",
  "waiting-room",
  "waitingroom",
  "virtual-queue",
];

export const QUEUE_TEXT_PATTERNS =
  /your position|queue number|antrian|waiting in line|you are in queue|posisi anda/i;

export const SOLD_OUT_PATTERNS =
  /sold out|habis|terjual|unavailable|tidak tersedia|tiket habis/i;

export const CHECKOUT_URL_PATTERNS =
  /checkout|payment|pembayaran|cart|keranjang/i;

export const CHECKOUT_TEXT_PATTERNS =
  /checkout|payment|pembayaran|order summary/i;

export const BUY_BUTTON_TEXT =
  /click|buy|purchase|proceed|checkout|add to cart|beli|pesan|book now|get tickets/i;

export const COMMON_PRIMARY_SELECTORS = [
  "button.primary",
  "button.btn-primary",
  "button.btn--primary",
  "[class*='primary-btn']",
  "[class*='btn-primary']",
  "button[type='submit']",
  "input[type='submit']",
];

export const BUY_DATA_ATTRS = [
  "[data-testid*='buy']",
  "[data-testid*='checkout']",
  "[data-testid*='purchase']",
  "[data-action*='buy']",
  "[data-cy*='buy']",
];

export const WORKER_COMMANDS = {
  START: "START",
  STOP: "STOP",
  REFRESH: "REFRESH",
  CLICK_PRIMARY: "CLICK_PRIMARY",
  NAVIGATE: "NAVIGATE",
  FOCUS: "FOCUS",
} as const;

export const WORKER_STATES = {
  UNSPAWNED: "UNSPAWNED",
  IDLE: "IDLE",
  NAVIGATING: "NAVIGATING",
  RELOADING: "RELOADING",
  PRE_QUEUE: "PRE_QUEUE",
  WAITING_ROOM: "WAITING_ROOM",
  IN_QUEUE: "IN_QUEUE",
  ACTIVE_SALE: "ACTIVE_SALE",
  CHECKOUT: "CHECKOUT",
  DONE: "DONE",
  SOLD_OUT: "SOLD_OUT",
  ERROR: "ERROR",
} as const;

export const STATE_COLORS: Record<string, string> = {
  UNSPAWNED: "#444",
  IDLE: "#888",
  NAVIGATING: "#aaa",
  RELOADING: "#4db8ff",
  PRE_QUEUE: "#f0a500",
  WAITING_ROOM: "#f0a500",
  IN_QUEUE: "#f0a500",
  ACTIVE_SALE: "#00cc66",
  CHECKOUT: "#00ff88",
  DONE: "#00ff88",
  SOLD_OUT: "#ff4444",
  ERROR: "#ff4444",
};

export const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  window.chrome = {
    runtime: {},
    loadTimes: function() {},
    csi: function() {},
    app: {},
  };

  const _originalQuery = window.navigator.permissions.query.bind(navigator.permissions);
  window.navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission, onchange: null })
      : _originalQuery(params);

  Object.defineProperty(navigator, 'plugins', {
    get: () => ({ length: 5, 0: {}, 1: {}, 2: {}, 3: {}, 4: {} }),
  });

  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => ({ length: 4 }),
  });

  const _getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return _getParameter.call(this, parameter);
  };
`;
