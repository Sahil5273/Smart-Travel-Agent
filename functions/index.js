const { onRequest } = require('firebase-functions/v2/https');
const app = require('./app');

exports.api = onRequest(
  {
    secrets: ['GEMINI_API_KEY'],
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true,
  },
  app
);
