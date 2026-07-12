/**
 * Smart Travel & Route Optimization Agent — Express Backend
 *
 * Designed for deployment on Firebase Cloud Functions. All route handlers
 * are async; Firestore is the single source of truth for agent state.
 *
 * Required environment variables:
 *   GEMINI_API_KEY          — Google Gemini API key
 *   GEMINI_ENABLED          — set to "false" to disable LLM calls (default: true)
 *   GEMINI_MODEL            — defaults to gemini-2.0-flash-lite (higher free-tier headroom)
 *   GOOGLE_APPLICATION_CREDENTIALS (local dev) — path to service-account JSON
 *   PORT                    — optional, defaults to 3001
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleGenAI } = require('@google/genai');

// ---------------------------------------------------------------------------
// 1. Setup & Ingestion
// ---------------------------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Firebase Admin — on Cloud Functions, credentials are injected automatically.
if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();

// Google Gen AI (Gemini) — only used once per session on /respond to enrich the final plan.
const GEMINI_ENABLED = process.env.GEMINI_ENABLED !== 'false';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
const GEMINI_MAX_OUTPUT_TOKENS = 200;
const GEMINI_COOLDOWN_MS = 5 * 60 * 1000; // pause calls for 5 min after quota errors

const genAI =
  GEMINI_ENABLED && process.env.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : null;

/** @type {Map<string, object>} In-memory cache: "goal|choice" → enrichment */
const geminiPlanCache = new Map();
let geminiCooldownUntil = 0;

// Firestore collection / field conventions
const SESSIONS_COLLECTION = 'sessions';

/** @typedef {'RUNNING' | 'AWAITING_USER_INPUT' | 'COMPLETED' | 'ERROR'} SessionStatus */

/**
 * @typedef {object} AgentLogEntry
 * @property {string} timestamp
 * @property {'thought' | 'action' | 'observation' | 'user_input' | 'system'} type
 * @property {string} message
 */

/**
 * @typedef {object} PendingOption
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * @typedef {object} SessionState
 * @property {string} sessionId
 * @property {string} userId
 * @property {string} userGoal
 * @property {SessionStatus} status
 * @property {AgentLogEntry[]} logs
 * @property {AgentLogEntry[]} history
 * @property {PendingOption[] | null} pendingOptions
 * @property {string | null} conflictReason
 * @property {object | null} finalPlan
 * @property {FirebaseFirestore.Timestamp} createdAt
 * @property {FirebaseFirestore.Timestamp} updatedAt
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/**
 * Append a log entry and mirror it into history for audit/resume.
 * @param {SessionState} state
 * @param {AgentLogEntry['type']} type
 * @param {string} message
 */
function appendLog(state, type, message) {
  const entry = { timestamp: nowIso(), type, message };
  state.logs.push(entry);
  state.history.push(entry);
}

/**
 * Persist the full session document to Firestore.
 * State transitions are always written here before responding to the client.
 *
 * @param {string} sessionId
 * @param {Partial<SessionState>} patch
 */
async function saveSession(sessionId, patch) {
  const ref = db.collection(SESSIONS_COLLECTION).doc(sessionId);
  await ref.set(
    {
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Load session or return null.
 * @param {string} sessionId
 * @returns {Promise<SessionState | null>}
 */
async function loadSession(sessionId) {
  const snap = await db.collection(SESSIONS_COLLECTION).doc(sessionId).get();
  if (!snap.exists) return null;
  return /** @type {SessionState} */ (snap.data());
}

// ---------------------------------------------------------------------------
// Destination knowledge (mock travel DB — replace with real APIs in production)
// ---------------------------------------------------------------------------

const DESTINATIONS = {
  jaipur: {
    name: 'Jaipur',
    state: 'Rajasthan',
    highlights: '3 heritage forts and the Pink City old quarter',
    premiumAttraction: 'Amber Fort',
    budgetAttractions: ['City Palace', 'Hawa Mahal', 'Jantar Mantar'],
    fullAttractions: ['Amber Fort', 'Nahargarh Fort', 'Jaigarh Fort', 'Hawa Mahal'],
    museum: 'Albert Hall Museum',
    optional: 'Chokhi Dhani (optional)',
    bazaar: 'Johari Bazaar',
    conflictTemplate:
      'Visiting all major forts (Amber, Nahargarh, Jaigarh) plus accommodation exceeds the stated budget.',
    budgetCost: 14800,
    fullCost: 16500,
    autoCost: 15000,
    overrun: 1500,
  },
  udaipur: {
    name: 'Udaipur',
    state: 'Rajasthan',
    highlights: 'lakeside palaces and the Venice of the East',
    premiumAttraction: 'Monsoon Palace (Sajjangarh)',
    budgetAttractions: ['City Palace', 'Lake Pichola boat ride', 'Jagdish Temple'],
    fullAttractions: ['City Palace', 'Lake Pichola', 'Monsoon Palace', 'Fateh Sagar Lake'],
    museum: 'Bagore Ki Haveli',
    optional: 'Sunset at Ambrai Ghat',
    bazaar: 'Hathi Pol Bazaar',
    conflictTemplate:
      'A lake cruise plus Monsoon Palace sunset visit pushes the trip over the stated budget.',
    budgetCost: 14200,
    fullCost: 15800,
    autoCost: 14500,
    overrun: 1200,
  },
  goa: {
    name: 'Goa',
    state: 'Goa',
    highlights: 'beaches, Portuguese heritage, and coastal cuisine',
    premiumAttraction: 'Scuba diving at Grande Island',
    budgetAttractions: ['Baga Beach', 'Fort Aguada', 'Anjuna flea market'],
    fullAttractions: ['Baga Beach', 'Fort Aguada', 'Scuba diving', 'Dudhsagar Falls day trip'],
    museum: 'Museum of Christian Art, Old Goa',
    optional: 'Sunset cruise on Mandovi River',
    bazaar: 'Mapusa Market',
    conflictTemplate:
      'Adding a Dudhsagar Falls day trip and scuba session exceeds the stated budget.',
    budgetCost: 13500,
    fullCost: 17200,
    autoCost: 14000,
    overrun: 2000,
  },
  manali: {
    name: 'Manali',
    state: 'Himachal Pradesh',
    highlights: 'Himalayan valleys, adventure sports, and snow views',
    premiumAttraction: 'Solang Valley paragliding',
    budgetAttractions: ['Hadimba Temple', 'Old Manali cafés', 'Mall Road'],
    fullAttractions: ['Solang Valley', 'Rohtang Pass', 'Hadimba Temple', 'Vashisht hot springs'],
    museum: 'Nicholas Roerich Art Gallery',
    optional: 'River rafting on Beas',
    bazaar: 'Manali Market',
    conflictTemplate:
      'Rohtang Pass excursion plus paragliding pushes the trip beyond the stated budget.',
    budgetCost: 14000,
    fullCost: 16800,
    autoCost: 14500,
    overrun: 1800,
  },
};

/** @param {string} userGoal */
function parseBudget(userGoal) {
  const goal = userGoal.toLowerCase();
  const budgetMatch =
    goal.match(/₹\s*([\d,]+)/) ||
    goal.match(/rs\.?\s*([\d,]+)/i) ||
    goal.match(/under\s*([\d,]+)/i);
  return budgetMatch ? parseInt(budgetMatch[1].replace(/,/g, ''), 10) : null;
}

/**
 * Extract destination from the user goal.
 * @param {string} userGoal
 */
function parseDestination(userGoal) {
  const goal = userGoal.toLowerCase();

  for (const [key, dest] of Object.entries(DESTINATIONS)) {
    if (goal.includes(key)) return { key, ...dest };
  }

  const tripMatch = goal.match(/(?:trip to|visit|explore|go to)\s+([a-z][a-z\s]{1,20})/i);
  if (tripMatch) {
    const cityName = tripMatch[1].trim().replace(/\s+/g, ' ');
    const titleCase = cityName.charAt(0).toUpperCase() + cityName.slice(1);
    return {
      key: 'generic',
      name: titleCase,
      state: 'India',
      highlights: 'local landmarks and cultural experiences',
      premiumAttraction: 'Premium guided heritage tour',
      budgetAttractions: [`${titleCase} city centre`, 'Local market', 'Main cultural site'],
      fullAttractions: [`${titleCase} city centre`, 'Premium guided heritage tour', 'Scenic viewpoint'],
      museum: 'Local history museum',
      optional: 'Evening food walk',
      bazaar: 'Local bazaar',
      conflictTemplate: `Covering all major attractions in ${titleCase} exceeds the stated budget.`,
      budgetCost: 14000,
      fullCost: 16000,
      autoCost: 14500,
      overrun: 1500,
    };
  }

  return { key: 'jaipur', ...DESTINATIONS.jaipur };
}

/**
 * Detect whether the travel goal should trigger a budget/schedule conflict.
 * In production this would come from real tool calls (pricing APIs, calendars).
 *
 * @param {string} userGoal
 * @returns {{ trigger: boolean; reason: string }}
 */
function detectConflict(userGoal) {
  const goal = userGoal.toLowerCase();
  const budget = parseBudget(userGoal);
  const dest = parseDestination(userGoal);
  const tightBudget = budget !== null && budget <= 15000;

  if (tightBudget) {
    return { trigger: true, reason: dest.conflictTemplate };
  }

  if (goal.includes('simulate-conflict')) {
    return { trigger: true, reason: 'Simulated schedule conflict for demonstration.' };
  }

  return { trigger: false, reason: '' };
}

/**
 * Build the two-option payload presented when execution pauses.
 * @param {string} userGoal
 * @returns {PendingOption[]}
 */
function buildConflictOptions(userGoal) {
  const dest = parseDestination(userGoal);
  const budget = parseBudget(userGoal);
  const budgetLabel = budget ? budget.toLocaleString('en-IN') : '15,000';

  return [
    {
      id: 'option_a',
      label: 'Option A — Stay within budget',
      description: `Keep total cost at or below ₹${budgetLabel} by skipping ${dest.premiumAttraction} and prioritizing ${dest.budgetAttractions.slice(0, 2).join(' + ')}.`,
      metadata: { estimatedCost: budgetLabel, skipped: [dest.premiumAttraction] },
    },
    {
      id: 'option_b',
      label: 'Option B — Full experience',
      description: `Include ${dest.premiumAttraction} and all major sights; accept a budget overrun of approximately ₹${dest.overrun.toLocaleString('en-IN')}.`,
      metadata: { estimatedOverrun: dest.overrun, includes: dest.fullAttractions },
    },
  ];
}

/**
 * Mock ReAct steps: Thought → Action → Observation cycles.
 * @param {SessionState} state
 */
async function runReActSteps(state) {
  const dest = parseDestination(state.userGoal);
  const steps = [
    { type: 'thought', message: `Decomposing goal: "${state.userGoal}"` },
    { type: 'action', message: 'Searching destinations and seasonal pricing…' },
    {
      type: 'observation',
      message: `Identified ${dest.name}, ${dest.state} — known for ${dest.highlights}.`,
    },
    { type: 'thought', message: 'Estimating transport, lodging, and attraction costs.' },
    { type: 'action', message: 'Querying attraction schedules and opening hours…' },
    {
      type: 'observation',
      message: `${dest.premiumAttraction} requires extra time and cost; may overlap with budget constraints.`,
    },
  ];

  for (const step of steps) {
    appendLog(state, step.type, step.message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Deterministic local enrichment — no API call, keeps responses polished.
 * @param {object} basePlan
 * @param {string} userChoice
 */
function buildLocalEnrichment(basePlan, userChoice) {
  const budgetFriendly = userChoice === 'option_a' || userChoice === 'auto';
  return {
    summary: budgetFriendly
      ? `A ${basePlan.durationDays}-day ${basePlan.destination} trip tuned to stay within budget.`
      : `A ${basePlan.durationDays}-day ${basePlan.destination} trip covering all major heritage sites.`,
    highlights: basePlan.itinerary
      .flatMap((d) => d.activities)
      .filter((a) => !['Arrival', 'Departure'].includes(a))
      .slice(0, 4),
    packingTips: ['Comfortable walking shoes', 'Sun protection', 'Reusable water bottle'],
  };
}

/**
 * Build the structured itinerary locally (zero LLM tokens).
 * @param {string} userGoal
 * @param {string} userChoice
 */
function buildBasePlan(userGoal, userChoice) {
  const dest = parseDestination(userGoal);
  const basePlan = {
    destination: `${dest.name}, ${dest.state}`,
    durationDays: 3,
    userChoice,
    itinerary: [],
    estimatedCostINR: 0,
    notes: [],
  };

  if (userChoice === 'option_a') {
    basePlan.itinerary = [
      { day: 1, activities: ['Arrival', ...dest.budgetAttractions.slice(0, 2)] },
      { day: 2, activities: [dest.budgetAttractions[2] || dest.bazaar, dest.bazaar, dest.optional] },
      { day: 3, activities: [dest.museum, 'Departure'] },
    ];
    basePlan.estimatedCostINR = dest.budgetCost;
    basePlan.notes.push(`${dest.premiumAttraction} omitted to honor budget cap.`);
  } else {
    const [a, b, c, d] = dest.fullAttractions;
    basePlan.itinerary = [
      { day: 1, activities: ['Arrival', a, b].filter(Boolean) },
      { day: 2, activities: [c, d, dest.bazaar].filter(Boolean) },
      { day: 3, activities: [dest.museum, 'Departure'] },
    ];
    basePlan.estimatedCostINR = userChoice === 'auto' ? dest.autoCost : dest.fullCost;
    basePlan.notes.push(
      userChoice === 'auto'
        ? `Balanced ${dest.name} itinerary with no conflicts detected.`
        : `Full experience included; budget exceeded by ₹${dest.overrun.toLocaleString('en-IN')}.`
    );
  }

  return basePlan;
}

/**
 * Returns true when the error is a quota / rate-limit response.
 * @param {Error} err
 */
function isQuotaError(err) {
  const msg = String(err?.message ?? err);
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
}

/**
 * Single Gemini call with cache, cooldown, and minimal token usage.
 * Only invoked from /respond — never during the ReAct loop or conflict pause.
 *
 * @param {string} userGoal
 * @param {string} userChoice
 * @param {object} basePlan
 * @returns {Promise<object | null>}
 */
async function enrichPlanWithGemini(userGoal, userChoice, basePlan) {
  if (!genAI || Date.now() < geminiCooldownUntil) return null;

  const cacheKey = `${userGoal}|${userChoice}`;
  if (geminiPlanCache.has(cacheKey)) {
    return geminiPlanCache.get(cacheKey);
  }

  // Compact prompt — only essential context, strict JSON output
  const prompt = `Goal: ${userGoal.slice(0, 120)}
Choice: ${userChoice}
Days: ${basePlan.durationDays}, Cost: ₹${basePlan.estimatedCostINR}
Return JSON only: {"summary":"<1 sentence>","highlights":["..."],"packingTips":["..."]}`;

  try {
    const response = await genAI.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        temperature: 0.3,
        responseMimeType: 'application/json',
      },
    });

    const text = response?.text ?? '';
    const enrichment = JSON.parse(text);
    geminiPlanCache.set(cacheKey, enrichment);
    return enrichment;
  } catch (err) {
    if (isQuotaError(err)) {
      geminiCooldownUntil = Date.now() + GEMINI_COOLDOWN_MS;
      console.warn(`[Gemini] Quota hit — pausing API calls for ${GEMINI_COOLDOWN_MS / 60000} min`);
    } else {
      console.error('[Gemini] enrichment failed:', err.message);
    }
    return null;
  }
}

/**
 * Build the final travel plan. Gemini is optional and off by default on /run.
 *
 * @param {string} userGoal
 * @param {string} userChoice
 * @param {{ useGemini?: boolean }} [options]
 * @returns {Promise<object>}
 */
async function buildFinalPlan(userGoal, userChoice, options = {}) {
  const { useGemini = false } = options;
  const basePlan = buildBasePlan(userGoal, userChoice);
  const localEnrichment = buildLocalEnrichment(basePlan, userChoice);

  if (!useGemini) {
    return { ...basePlan, ...localEnrichment, generatedBy: 'local' };
  }

  const geminiEnrichment = await enrichPlanWithGemini(userGoal, userChoice, basePlan);
  if (geminiEnrichment) {
    return { ...basePlan, ...geminiEnrichment, generatedBy: 'gemini' };
  }

  return { ...basePlan, ...localEnrichment, generatedBy: 'local' };
}

// ---------------------------------------------------------------------------
// 2. State-Managed Execution Route — POST /api/agent/run
// ---------------------------------------------------------------------------

/**
 * Firestore state transitions on /run:
 *
 *   NEW SESSION:
 *     (no doc) → CREATE { status: RUNNING, logs: [], history: [] }
 *
 *   RESUME (status === AWAITING_USER_INPUT):
 *     → 409 response; client must call /respond first
 *
 *   RESUME (status === COMPLETED):
 *     → 200 with existing finalPlan (idempotent read)
 *
 *   RUN ReAct loop:
 *     RUNNING → (conflict) → AWAITING_USER_INPUT + pendingOptions
 *              → (no conflict) → COMPLETED + finalPlan
 */
app.post('/api/agent/run', async (req, res) => {
  try {
    const { userId, sessionId, userGoal } = req.body;

    if (!userId || !sessionId || !userGoal) {
      return res.status(400).json({
        error: 'Missing required fields: userId, sessionId, userGoal',
      });
    }

    let state = await loadSession(sessionId);

    // --- Resume or create ---------------------------------------------------
    if (state) {
      // Already waiting for human input — do not continue autonomously
      if (state.status === 'AWAITING_USER_INPUT') {
        return res.status(409).json({
          error: 'Session is awaiting user input. Call /api/agent/respond first.',
          sessionId,
          status: state.status,
          pendingOptions: state.pendingOptions,
          conflictReason: state.conflictReason,
        });
      }

      // Idempotent: return completed plan without re-running
      if (state.status === 'COMPLETED') {
        return res.status(200).json({
          sessionId,
          status: state.status,
          finalPlan: state.finalPlan,
          logs: state.logs,
          resumed: true,
        });
      }

      // Resume RUNNING or ERROR sessions — append a resume marker
      appendLog(state, 'system', `Resuming session for userId=${userId}`);
      state.userGoal = userGoal;
      state.status = 'RUNNING';
    } else {
      // CREATE: brand-new session document
      state = {
        sessionId,
        userId,
        userGoal,
        status: 'RUNNING',
        logs: [],
        history: [],
        pendingOptions: null,
        conflictReason: null,
        finalPlan: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      appendLog(state, 'system', `New session created for goal: "${userGoal}"`);
    }

    await saveSession(sessionId, state);

    // --- ReAct mock execution loop ------------------------------------------
    await runReActSteps(state);

    const { trigger, reason } = detectConflict(userGoal);

    // --- Option interruption (key conditional) ------------------------------
    if (trigger) {
      const options = buildConflictOptions(userGoal);

      appendLog(
        state,
        'observation',
        `Conflict detected: ${reason}. Pausing for user decision.`
      );

      /**
       * STATE TRANSITION: RUNNING → AWAITING_USER_INPUT
       * We persist pendingOptions and halt — no further autonomous steps run.
       */
      state.status = 'AWAITING_USER_INPUT';
      state.pendingOptions = options;
      state.conflictReason = reason;

      await saveSession(sessionId, state);

      // Instant response — execution pauses here
      return res.status(200).json({
        sessionId,
        status: state.status,
        conflictReason: reason,
        pendingOptions: options,
        logs: state.logs,
        message: 'Agent paused. Please select an option via /api/agent/respond.',
      });
    }

    // No conflict: complete locally — skip Gemini to save quota
    const finalPlan = await buildFinalPlan(userGoal, 'auto', { useGemini: false });

    appendLog(state, 'observation', 'No conflicts found. Itinerary optimized.');

    /**
     * STATE TRANSITION: RUNNING → COMPLETED
     */
    state.status = 'COMPLETED';
    state.finalPlan = finalPlan;
    state.pendingOptions = null;

    await saveSession(sessionId, state);

    return res.status(200).json({
      sessionId,
      status: state.status,
      finalPlan,
      logs: state.logs,
    });
  } catch (err) {
    console.error('[/api/agent/run]', err);
    return res.status(500).json({ error: 'Agent run failed', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// 4. User Choice Feedback Route — POST /api/agent/respond
// ---------------------------------------------------------------------------

/**
 * Firestore state transitions on /respond:
 *
 *   AWAITING_USER_INPUT → (record userChoice in logs)
 *                       → RUNNING (brief, while finishing plan)
 *                       → COMPLETED + finalPlan
 */
app.post('/api/agent/respond', async (req, res) => {
  try {
    const { sessionId, userChoice } = req.body;

    if (!sessionId || !userChoice) {
      return res.status(400).json({
        error: 'Missing required fields: sessionId, userChoice',
      });
    }

    const state = await loadSession(sessionId);

    if (!state) {
      return res.status(404).json({ error: `Session "${sessionId}" not found` });
    }

    if (state.status !== 'AWAITING_USER_INPUT') {
      return res.status(409).json({
        error: `Session is not awaiting input (current status: ${state.status})`,
        sessionId,
        status: state.status,
      });
    }

    const validIds = (state.pendingOptions ?? []).map((o) => o.id);
    if (validIds.length && !validIds.includes(userChoice)) {
      return res.status(400).json({
        error: `Invalid userChoice. Expected one of: ${validIds.join(', ')}`,
      });
    }

    // Record human feedback in logs / history
    const selected = state.pendingOptions?.find((o) => o.id === userChoice);
    appendLog(
      state,
      'user_input',
      `User selected: ${selected?.label ?? userChoice}`
    );

    /**
     * STATE TRANSITION: AWAITING_USER_INPUT → RUNNING
     * Signals the agent is actively completing the plan with the chosen branch.
     */
    state.status = 'RUNNING';
    state.pendingOptions = null;

    await saveSession(sessionId, state);

    // Single Gemini call per session — only after the user picks an option
    const finalPlan = await buildFinalPlan(state.userGoal, userChoice, { useGemini: true });

    appendLog(state, 'observation', 'Final itinerary generated from user choice.');

    /**
     * STATE TRANSITION: RUNNING → COMPLETED
     */
    state.status = 'COMPLETED';
    state.finalPlan = finalPlan;
    state.conflictReason = null;

    await saveSession(sessionId, state);

    return res.status(200).json({
      sessionId,
      status: state.status,
      userChoice,
      finalPlan,
      logs: state.logs,
    });
  } catch (err) {
    console.error('[/api/agent/respond]', err);
    return res.status(500).json({ error: 'Agent respond failed', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Health check (useful for Cloud Functions / load balancers)
// ---------------------------------------------------------------------------

app.get('/health', async (_req, res) => {
  res.status(200).json({ ok: true, timestamp: nowIso() });
});

// ---------------------------------------------------------------------------
// Start server (local dev). For Firebase Cloud Functions, export `app` instead.
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Smart Travel Agent API listening on port ${PORT}`);
  });
}

module.exports = app;
