const { SpikeWorker, connectSpike, closeSpike } = require('../src/job-worker');

const worker = new SpikeWorker({
  connectionString: process.env.DATABASE_URL,
  workerId: 'worker-crash-child',
  crashAfterProgress: 20,
});

connectSpike(process.env.DATABASE_URL)
  .then(() => worker.start())
  .then(() => worker.enqueue(process.env.SPIKE_JOB_ID))
  .catch(async (error) => {
    console.error(error);
    await closeSpike();
    process.exitCode = 1;
  });
