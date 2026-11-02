import { queueClient, environment } from '../vercel/environment.js';
import { consumeNote } from '../vercel/consumer.js';

export default queueClient.handleNodeCallback(async (message) => {
  await consumeNote(environment(), message);
}, { visibilityTimeoutSeconds: 300, retry: () => ({ afterSeconds: 5 }) });
