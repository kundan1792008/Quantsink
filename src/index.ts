import app from './app';
import logger from './lib/logger';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Quantsink server started');
});
