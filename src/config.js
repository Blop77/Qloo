// Reads settings from the environment (and from a local .env file if present).

try {
  process.loadEnvFile();
} catch {
  // No .env file: fine, use the real environment.
}

const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,

  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  model: env.RIDETASTE_MODEL || 'claude-opus-5-5',

  // ChatGPT (OpenAI). When this key is set, the agent uses OpenAI instead of Claude.
  openaiApiKey: env.OPENAI_API_KEY || '',
  openaiModel: env.OPENAI_MODEL || 'gpt-4.1',
  openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),

  qlooApiKey: env.QLOO_API_KEY || '',
  // Qloo gives hackathon teams their own base URL with the API key.
  // Check the email or Devpost page that came with your key.
  qlooBaseUrl: (env.QLOO_BASE_URL || 'https://hackathon.api.qloo.com').replace(/\/+$/, ''),

  // Public OpenStreetMap services. Both have fair-use limits, so keep traffic low.
  routingUrl: (env.ROUTING_URL || 'https://routing.openstreetmap.de/routed-bike').replace(/\/+$/, ''),
  geocodeUrl: (env.GEOCODE_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, ''),
  contactEmail: env.CONTACT_EMAIL || '',
};

/** True when real Qloo data is available; otherwise the app runs on sample data. */
export function qlooIsLive() {
  return Boolean(config.qlooApiKey);
}

/** Which model runs the agent: 'openai' if its key is set, else 'anthropic' if its key is set, else null. */
export function agentProvider() {
  if (config.openaiApiKey) return 'openai';
  if (config.anthropicApiKey) return 'anthropic';
  return null;
}

/** True when the chat agent can run; otherwise only the quick-plan form works. */
export function agentIsAvailable() {
  return agentProvider() !== null;
}
