/**
 * Local development entry point.
 * Loads .env and starts the Express app from functions/app.js.
 * In production, Firebase Cloud Functions uses functions/index.js instead.
 */
'use strict';

require('dotenv').config();

const app = require('./functions/app');
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Smart Travel Agent API listening on port ${PORT}`);
});
