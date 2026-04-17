import { createServer } from 'http';
import app from './app';
import logger from './lib/logger';
import { attachWebSocketServer } from './lib/wsServer';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const httpServer = createServer(app);
attachWebSocketServer(httpServer);

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'Quantsink server started');
});
