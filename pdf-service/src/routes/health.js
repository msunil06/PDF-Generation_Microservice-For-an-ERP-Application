const express = require('express');
const { singleQueue, bulkQueue } = require('../queues');

const router = express.Router();

router.get('/', async (req, res) => {
  const startTime = Date.now();

  try {
    const [singleCounts, bulkCounts] = await Promise.all([
      singleQueue.getJobCounts(),
      bulkQueue.getJobCounts(),
    ]);

    const responseTime = Date.now() - startTime;

    return res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      responseTimeMs: responseTime,
      version: process.env.npm_package_version || '1.0.0',
      queues: {
        single: {
          waiting: singleCounts.waiting,
          active: singleCounts.active,
          completed: singleCounts.completed,
          failed: singleCounts.failed,
        },
        bulk: {
          waiting: bulkCounts.waiting,
          active: bulkCounts.active,
          completed: bulkCounts.completed,
          failed: bulkCounts.failed,
        },
      },
      memory: {
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rssM: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      uptime: Math.round(process.uptime()),
    });

  } catch (error) {
    return res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

module.exports = router;
