const { Worker, NativeConnection } = require('@temporalio/worker');
const activities = require('./activities');

(async () => {
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDR || '127.0.0.1:19010' });
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'spike-payments',
    workflowsPath: require.resolve('./workflows'),
    activities,
  });
  console.log('WORKER_READY pid=' + process.pid);
  await worker.run();
})().catch((e) => { console.error('WORKER_ERROR', e); process.exit(1); });
