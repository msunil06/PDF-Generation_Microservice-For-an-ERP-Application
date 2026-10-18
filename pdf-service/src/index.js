require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const path = require('path');
const logger = require('./utils/logger');
const { singleQueue, bulkQueue } = require('./queues');
const pdfRoutes = require('./routes/pdf');
const healthRoutes = require('./routes/health');
const webRoutes = require('./routes/web');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:8000'],
  credentials: true,
}));

app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) }
}));

const limiter = rateLimit({
  windowMs: 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' },
});
app.use('/api/', limiter);

app.use(express.json({ limit: '10mb' }));

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
  queues: [new BullAdapter(singleQueue), new BullAdapter(bulkQueue)],
  serverAdapter,
});
if (process.env.NODE_ENV === 'production') {
  const basicAuth = require('express-basic-auth');
  app.use('/admin/queues', basicAuth({
    users: { [process.env.BULL_BOARD_USER]: process.env.BULL_BOARD_PASS },
    challenge: true,
  }), serverAdapter.getRouter());
} else {
  app.use('/admin/queues', serverAdapter.getRouter());
}

app.use(express.static(path.join(__dirname, '../public')));
app.use('/health', healthRoutes);
app.use('/api/web', webRoutes);
app.use('/api/pdf', pdfRoutes);

app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

if (process.env.NODE_ENV !== 'test') {
  require('./workers/pdfWorker');
}

let server;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    logger.info(`PDF Microservice running on port ${PORT}`);
    logger.info(`Bull Board available at http://localhost:${PORT}/admin/queues`);
  });
}

const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await Promise.allSettled([
    singleQueue.close(),
    bulkQueue.close(),
  ]);
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
