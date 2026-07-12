/**
 * Local development entry point.
 * Production: Firebase Cloud Functions (functions/index.js)
 */
'use strict';

require('dotenv').config();

const app = require('./functions/app');
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Smart Travel Agent API listening on port ${PORT}`);
});
