import { PrismaClient } from '@prisma/client';
import logger from './logger';

const prisma = new PrismaClient({
  log: [
    { level: 'query', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

prisma.$on('query' as never, (e: { query: string; duration: number }) => {
  logger.debug({ query: e.query, duration: e.duration }, 'prisma query');
});

prisma.$on('error' as never, (e: { message: string }) => {
  logger.error({ msg: e.message }, 'prisma error');
});

export default prisma;
