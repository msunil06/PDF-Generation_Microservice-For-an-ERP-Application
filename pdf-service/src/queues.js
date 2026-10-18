const Bull = require('bull');
const logger = require('./utils/logger');

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  keyPrefix: 'pdf-svc:',
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
};

const queueOptions = {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 86400,
      count: 10000,
    },
    removeOnFail: {
      age: 604800,
    },
    timeout: 30000,
  },
};

const singleQueue = new Bull('pdf-single', queueOptions);

const bulkQueue = new Bull('pdf-bulk', {
  ...queueOptions,
  defaultJobOptions: {
    ...queueOptions.defaultJobOptions,
    timeout: 300000,
  },
});

[singleQueue, bulkQueue].forEach((queue) => {
  queue.on('error', (error) => {
    logger.error(`Queue error [${queue.name}]`, { error: error.message });
  });

  queue.on('stalled', (jobId) => {
    logger.warn(`Job stalled [${queue.name}]`, { jobId });
  });

  queue.on('failed', (job, error) => {
    logger.error(`Job failed [${queue.name}]`, {
      jobId: job.id,
      documentId: job.data?.documentId,
      error: error.message,
      attemptsMade: job.attemptsMade,
    });
  });

  queue.on('completed', (job) => {
    logger.info(`Job completed [${queue.name}]`, {
      jobId: job.id,
      documentId: job.data?.documentId,
      processingTime: Date.now() - job.processedOn,
    });
  });
});

singleQueue.on('active', (job) => {
  logger.debug(`Job active [${singleQueue.name}]`, { jobId: job.id });
});

module.exports = { singleQueue, bulkQueue };
