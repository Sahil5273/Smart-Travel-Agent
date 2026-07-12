/**
 * Local development entry point.
 * Agent logic + rate limits live in functions/app.js (shared with Cloud Functions).
 */
'use strict';

require('dotenv').config();

const app = require('./functions/app');
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Smart Travel Agent API listening on port ${PORT}`);
});
