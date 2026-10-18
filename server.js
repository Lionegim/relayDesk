import { createApp } from './src/http/app.js';
import { createStore } from './src/store.js';
import { createMistralClient } from './src/ai/mistral.js';

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 4310,
  ownerName: process.env.OWNER_NAME || 'Jean-Hugues',
  mistral: {
    apiKey: process.env.MISTRAL_API_KEY || '',
    model: process.env.MISTRAL_MODEL || 'mistral-small-latest',
  },
};

const store = createStore();
const ai = createMistralClient(config.mistral);
const server = createApp({ store, ai, ownerName: config.ownerName });

server.listen(config.port, config.host, () => {
  console.log(`Relay Desk sur http://${config.host}:${config.port}`);
  if (!config.mistral.apiKey) console.warn('MISTRAL_API_KEY absente : l’assistant renverra une erreur.');
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
