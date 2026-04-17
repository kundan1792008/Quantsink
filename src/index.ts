import app from './app';
import logger from './lib/logger';
import { attachWebSocketServer } from './services/BroadcastWebSocket';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Quantsink server started');
});

attachWebSocketServer(server);
