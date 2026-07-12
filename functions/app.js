/**
 * Smart Travel Agent — Agentic Express Backend
 * Gemini structured outputs + native function calling + Firestore state machine
 */
'use strict';

const express = require('express');
const cors = require('cors');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleGenAI, FunctionCallingConfigMode } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

if (!getApps().length) initializeApp();
const db = getFirestore();

const GEMINI_ENABLED = process.env.GEMINI_ENABLED !== 'false';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const SESSIONS_COLLECTION = 'sessions';

const genAI =
  GEMINI_ENABLED && process.env.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : null;

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------

const TRIP_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    origin: { type: 'string', description: 'Departure city' },
    destination: { type: 'string', description: 'Arrival city' },
    budget: { type: 'number', description: 'Total budget in INR' },
    durationDays: { type: 'number', description: 'Trip length in days' },
  },
  required: ['origin', 'destination', 'budget', 'durationDays'],
};

const FINAL_ITINERARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    origin: { type: 'string' },
    destination: { type: 'string' },
    estimatedCostINR: { type: 'number' },
    durationDays: { type: 'number' },
    transitLogistics: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        route: { type: 'string' },
        distanceKm: { type: 'number' },
        durationHours: { type: 'number' },
        estimatedCostINR: { type: 'number' },
        details: { type: 'string' },
      },
      required: ['mode', 'route', 'distanceKm', 'durationHours', 'estimatedCostINR', 'details'],
    },
    dailyItinerary: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'number' },
          morning: { type: 'array', items: { type: 'string' } },
          afternoon: { type: 'array', items: { type: 'string' } },
          evening: { type: 'array', items: { type: 'string' } },
        },
        required: ['day', 'morning', 'afternoon', 'evening'],
      },
    },
    localTransport: { type: 'array', items: { type: 'string' } },
    weatherPackingList: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'summary', 'origin', 'destination', 'estimatedCostINR', 'durationDays',
    'transitLogistics', 'dailyItinerary', 'localTransport', 'weatherPackingList',
  ],
};

const TOOL_DECLARATIONS = [
  {
    name: 'get_transit_route',
    description: 'Returns point-to-point transit logistics between origin and destination.',
    parameters: {
      type: 'OBJECT',
      properties: {
        origin: { type: 'STRING', description: 'Departure city' },
        destination: { type: 'STRING', description: 'Arrival city' },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'get_attractions',
    description: 'Returns local points of interest for a city.',
    parameters: {
      type: 'OBJECT',
      properties: {
        city: { type: 'STRING', description: 'City name' },
      },
      required: ['city'],
    },
  },
  {
    name: 'calculate_total_cost',
    description: 'Evaluates combined transit, lodging, food, and activity costs.',
    parameters: {
      type: 'OBJECT',
      properties: {
        tier: {
          type: 'STRING',
          description: 'Cost tier: budget, balanced, or premium',
          enum: ['budget', 'balanced', 'premium'],
        },
      },
      required: ['tier'],
    },
  },
];

// ---------------------------------------------------------------------------
// Travel knowledge base (tool backends)
// ---------------------------------------------------------------------------

const CITY_COORDS = {
  delhi: [28.6139, 77.209],
  mumbai: [19.076, 72.8777],
  jaipur: [26.9124, 75.7873],
  udaipur: [24.5854, 73.7125],
  goa: [15.2993, 74.124],
  manali: [32.2432, 77.1892],
  bangalore: [12.9716, 77.5946],
  chennai: [13.0827, 80.2707],
  kolkata: [22.5726, 88.3639],
  hyderabad: [17.385, 78.4867],
  agra: [27.1767, 78.0081],
  amritsar: [31.634, 74.8723],
};

const ATTRACTIONS_DB = {
  jaipur: ['Amber Fort', 'City Palace', 'Hawa Mahal', 'Jantar Mantar', 'Nahargarh Fort'],
  udaipur: ['City Palace', 'Lake Pichola', 'Jagdish Temple', 'Monsoon Palace', 'Fateh Sagar'],
  delhi: ['Red Fort', 'India Gate', 'Qutub Minar', 'Humayun Tomb', 'Chandni Chowk'],
  mumbai: ['Gateway of India', 'Marine Drive', 'Elephanta Caves', 'Colaba Causeway'],
  goa: ['Baga Beach', 'Fort Aguada', 'Basilica of Bom Jesus', 'Dudhsagar Falls'],
  manali: ['Solang Valley', 'Hadimba Temple', 'Rohtang Pass', 'Old Manali'],
  agra: ['Taj Mahal', 'Agra Fort', 'Mehtab Bagh'],
  bangalore: ['Lalbagh', 'Cubbon Park', 'Bangalore Palace', 'ISKCON Temple'],
};

function normalizeCity(name) {
  return String(name || '').toLowerCase().trim().replace(/,.*/, '');
}

function haversineKm(a, b) {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function estimateDistanceKm(origin, destination) {
  const o = normalizeCity(origin);
  const d = normalizeCity(destination);
  if (CITY_COORDS[o] && CITY_COORDS[d]) return haversineKm(CITY_COORDS[o], CITY_COORDS[d]);
  if (o === d) return 25;
  return 450;
}

function toolGetTransitRoute(origin, destination) {
  const distanceKm = Math.round(estimateDistanceKm(origin, destination));
  let mode, route, durationHours, estimatedCostINR, details;

  if (distanceKm <= 350) {
    mode = 'Road';
    route = distanceKm > 200 ? 'NH48 / NH52 expressway corridor' : 'State highway + ring road';
    durationHours = Math.round((distanceKm / 65) * 10) / 10;
    estimatedCostINR = Math.round(distanceKm * 4 + 600);
    details = `Drive or AC Volvo bus from ${origin} to ${destination} via ${route}. Approx ${distanceKm} km, ${durationHours}h.`;
  } else if (distanceKm <= 900) {
    mode = 'Train';
    route = 'Vande Bharat Express / Rajdhani';
    durationHours = Math.round((distanceKm / 85 + 2) * 10) / 10;
    estimatedCostINR = Math.round(1800 + distanceKm * 2.2);
    details = `Board Vande Bharat Express from ${origin} to ${destination}. Scenic rail corridor, ${durationHours}h journey.`;
  } else {
    mode = 'Flight';
    route = `Direct or 1-stop flight ${origin} → ${destination}`;
    durationHours = Math.round((2.5 + distanceKm / 600) * 10) / 10;
    estimatedCostINR = Math.round(5000 + distanceKm * 1.8);
    details = `Fly from ${origin} airport to ${destination} airport. Check-in 2h before departure.`;
  }

  return { origin, destination, mode, route, distanceKm, durationHours, estimatedCostINR, details };
}

function toolGetAttractions(city) {
  const key = normalizeCity(city);
  const attractions = ATTRACTIONS_DB[key] || [
    `${city} heritage walk`,
    `${city} central market`,
    `${city} viewpoint`,
    `${city} local museum`,
  ];
  return { city, attractions, count: attractions.length };
}

function toolCalculateTotalCost(agentContext, tripParams, tier = 'balanced') {
  const transit = agentContext.transitRoute?.estimatedCostINR || 0;
  const mult = tier === 'budget' ? 0.75 : tier === 'premium' ? 1.35 : 1;
  const lodging = Math.round(tripParams.durationDays * 2800 * mult);
  const activities = Math.round(tripParams.durationDays * 1800 * mult);
  const food = Math.round(tripParams.durationDays * 900 * mult);
  const total = Math.round(transit + lodging + activities + food);

  agentContext.costBreakdown = { tier, transit, lodging, activities, food, total };
  agentContext.totalCost = total;
  agentContext.tier = tier;
  return agentContext.costBreakdown;
}

function executeTool(name, args, agentContext, tripParams) {
  if (name === 'get_transit_route') {
    const result = toolGetTransitRoute(args.origin, args.destination);
    agentContext.transitRoute = result;
    agentContext.transitHours = result.durationHours;
    return result;
  }
  if (name === 'get_attractions') {
    const result = toolGetAttractions(args.city);
    agentContext.attractions[args.city] = result.attractions;
    return result;
  }
  if (name === 'calculate_total_cost') {
    return toolCalculateTotalCost(agentContext, tripParams, args.tier || 'balanced');
  }
  return { error: `Unknown tool: ${name}` };
}

// ---------------------------------------------------------------------------
// Firestore helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function appendLog(state, type, message) {
  const entry = { timestamp: nowIso(), type, message };
  state.logs.push(entry);
  state.history.push(entry);
}

async function saveSession(sessionId, patch) {
  await db.collection(SESSIONS_COLLECTION).doc(sessionId).set(
    { ...patch, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function loadSession(sessionId) {
  const snap = await db.collection(SESSIONS_COLLECTION).doc(sessionId).get();
  return snap.exists ? snap.data() : null;
}

// ---------------------------------------------------------------------------
// Gemini: structured extraction
// ---------------------------------------------------------------------------

async function extractTripParams(userGoal) {
  if (!genAI) throw new Error('Gemini API not configured');

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: `Extract trip parameters from this travel goal. Infer reasonable defaults if missing.\n\nGoal: "${userGoal}"`,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: TRIP_PARAMS_SCHEMA,
      temperature: 0.1,
    },
  });

  return JSON.parse(response.text);
}

// ---------------------------------------------------------------------------
// Gemini: agentic tool-calling loop
// ---------------------------------------------------------------------------

async function runAgenticToolLoop(state, tripParams) {
  const agentContext = {
    transitRoute: null,
    transitHours: 0,
    attractions: {},
    costBreakdown: null,
    totalCost: 0,
    tier: 'balanced',
  };

  const systemInstruction = `You are a travel routing agent. Plan point-to-point travel from ${tripParams.origin} to ${tripParams.destination}.
Budget: ₹${tripParams.budget} INR. Duration: ${tripParams.durationDays} days.
You MUST call tools in this order: get_transit_route → get_attractions (destination) → calculate_total_cost.
Try calculate_total_cost with tier "balanced" first. Log reasoning briefly.`;

  const contents = [
    {
      role: 'user',
      parts: [{
        text: `Plan transit and costs for: ${tripParams.origin} → ${tripParams.destination}, ₹${tripParams.budget}, ${tripParams.durationDays} days.`,
      }],
    },
  ];

  appendLog(state, 'thought', `Routing agent started: ${tripParams.origin} → ${tripParams.destination}`);

  for (let step = 0; step < 8; step++) {
    const response = await genAI.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
        },
        temperature: 0.2,
      },
    });

    if (response.text) {
      appendLog(state, 'thought', response.text.slice(0, 300));
    }

    const calls = response.functionCalls;
    if (!calls?.length) break;

    const modelParts = calls.map((fc) => ({ functionCall: fc }));
    contents.push({ role: 'model', parts: modelParts });

    const responseParts = [];
    for (const fc of calls) {
      const args = fc.args || {};
      appendLog(state, 'action', `Tool: ${fc.name}(${JSON.stringify(args)})`);

      const result = executeTool(fc.name, args, agentContext, tripParams);
      appendLog(state, 'observation', `${fc.name} → ${JSON.stringify(result).slice(0, 250)}`);

      responseParts.push({
        functionResponse: { name: fc.name, response: { output: result } },
      });
    }

    contents.push({ role: 'user', parts: responseParts });
  }

  if (!agentContext.costBreakdown) {
    toolCalculateTotalCost(agentContext, tripParams, 'balanced');
  }

  state.agentContext = agentContext;
  state.tripParams = tripParams;
  return agentContext;
}

// ---------------------------------------------------------------------------
// Conflict detection & options
// ---------------------------------------------------------------------------

function detectAgentConflict(tripParams, agentContext) {
  const reasons = [];
  const budget = tripParams.budget;
  const total = agentContext.totalCost;
  const transitHours = agentContext.transitHours || 0;
  const tripHours = tripParams.durationDays * 10;

  if (total > budget) {
    reasons.push(`Estimated cost ₹${total.toLocaleString('en-IN')} exceeds budget ₹${budget.toLocaleString('en-IN')}.`);
  }
  if (transitHours > tripHours * 0.35) {
    reasons.push(`Transit time (${transitHours}h) consumes too much of the ${tripParams.durationDays}-day trip.`);
  }

  return { trigger: reasons.length > 0, reason: reasons.join(' ') };
}

function buildConflictOptions(tripParams, agentContext) {
  const budget = tripParams.budget;
  const premium = agentContext.totalCost;
  const budgetCost = Math.round(premium * 0.82);
  const overrun = premium - budget;

  return [
    {
      id: 'option_a',
      label: 'Option A — Stay within budget',
      description: `Use budget transit tier and fewer paid activities. Target ~₹${budgetCost.toLocaleString('en-IN')} (under ₹${budget.toLocaleString('en-IN')}).`,
      metadata: { tier: 'budget', estimatedCost: budgetCost },
    },
    {
      id: 'option_b',
      label: 'Option B — Full route experience',
      description: `Keep ${agentContext.transitRoute?.mode || 'transit'} route and all attractions. Accept ~₹${overrun.toLocaleString('en-IN')} overrun.`,
      metadata: { tier: 'premium', estimatedCost: premium, overrun },
    },
  ];
}

// ---------------------------------------------------------------------------
// Gemini: detailed final itinerary
// ---------------------------------------------------------------------------

async function generateDetailedItinerary(tripParams, agentContext, userChoice) {
  const tier = userChoice === 'option_a' ? 'budget' : userChoice === 'option_b' ? 'premium' : 'balanced';
  if (userChoice === 'option_a') toolCalculateTotalCost(agentContext, tripParams, 'budget');
  else if (userChoice === 'option_b') toolCalculateTotalCost(agentContext, tripParams, 'premium');

  const prompt = `Generate a detailed travel itinerary.
Origin: ${tripParams.origin}
Destination: ${tripParams.destination}
Budget: ₹${tripParams.budget}
Duration: ${tripParams.durationDays} days
User choice: ${userChoice} (tier: ${tier})
Transit data: ${JSON.stringify(agentContext.transitRoute)}
Attractions: ${JSON.stringify(agentContext.attractions)}
Cost breakdown: ${JSON.stringify(agentContext.costBreakdown)}

Include specific transit logistics (highway names, train names, etc.), morning/afternoon/evening slots per day, local transport tips, and weather-aware packing.`;

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: FINAL_ITINERARY_SCHEMA,
      temperature: 0.4,
      maxOutputTokens: 4096,
    },
  });

  const plan = JSON.parse(response.text);
  return { ...plan, userChoice, generatedBy: 'gemini' };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.post('/api/agent/run', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ error: 'Gemini API not configured' });

    const { userId, sessionId, userGoal } = req.body;
    if (!userId || !sessionId || !userGoal) {
      return res.status(400).json({ error: 'Missing required fields: userId, sessionId, userGoal' });
    }

    let state = await loadSession(sessionId);

    if (state?.status === 'AWAITING_USER_INPUT') {
      return res.status(409).json({
        error: 'Session awaiting user input. Call /api/agent/respond first.',
        sessionId, status: state.status,
        pendingOptions: state.pendingOptions, conflictReason: state.conflictReason,
      });
    }

    if (state?.status === 'COMPLETED') {
      return res.status(200).json({
        sessionId, status: state.status, finalPlan: state.finalPlan, logs: state.logs, resumed: true,
      });
    }

    state = state || {
      sessionId, userId, userGoal, status: 'RUNNING',
      logs: [], history: [], pendingOptions: null, conflictReason: null,
      finalPlan: null, tripParams: null, agentContext: null,
      createdAt: FieldValue.serverTimestamp(),
    };

    state.userGoal = userGoal;
    state.status = 'RUNNING';
    appendLog(state, 'system', `Session started: "${userGoal}"`);

    // Step 1: Gemini structured extraction
    appendLog(state, 'action', 'Extracting trip parameters via Gemini JSON schema…');
    const tripParams = await extractTripParams(userGoal);
    state.tripParams = tripParams;
    appendLog(state, 'observation', `${tripParams.origin} → ${tripParams.destination} | ₹${tripParams.budget} | ${tripParams.durationDays} days`);

    await saveSession(sessionId, state);

    // Step 2: Agentic tool-calling loop
    const agentContext = await runAgenticToolLoop(state, tripParams);

    // Step 3: Conflict check
    const { trigger, reason } = detectAgentConflict(tripParams, agentContext);

    if (trigger) {
      const options = buildConflictOptions(tripParams, agentContext);
      appendLog(state, 'observation', `Conflict: ${reason} — awaiting user input.`);

      state.status = 'AWAITING_USER_INPUT';
      state.pendingOptions = options;
      state.conflictReason = reason;
      state.agentContext = agentContext;

      await saveSession(sessionId, state);

      return res.status(200).json({
        sessionId, status: state.status, tripParams,
        conflictReason: reason, pendingOptions: options, logs: state.logs,
        agentContext: { transitRoute: agentContext.transitRoute, costBreakdown: agentContext.costBreakdown },
        message: 'Agent paused. Select an option via /api/agent/respond.',
      });
    }

    // No conflict — generate full itinerary immediately
    appendLog(state, 'action', 'No conflicts. Generating detailed itinerary…');
    const finalPlan = await generateDetailedItinerary(tripParams, agentContext, 'auto');
    appendLog(state, 'observation', 'Itinerary complete.');

    state.status = 'COMPLETED';
    state.finalPlan = finalPlan;
    state.agentContext = agentContext;

    await saveSession(sessionId, state);

    return res.status(200).json({
      sessionId, status: state.status, tripParams, finalPlan, logs: state.logs,
    });
  } catch (err) {
    console.error('[/api/agent/run]', err);
    return res.status(500).json({ error: 'Agent run failed', details: err.message });
  }
});

app.post('/api/agent/respond', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ error: 'Gemini API not configured' });

    const { sessionId, userChoice } = req.body;
    if (!sessionId || !userChoice) {
      return res.status(400).json({ error: 'Missing required fields: sessionId, userChoice' });
    }

    const state = await loadSession(sessionId);
    if (!state) return res.status(404).json({ error: `Session "${sessionId}" not found` });

    if (state.status !== 'AWAITING_USER_INPUT') {
      return res.status(409).json({
        error: `Session not awaiting input (status: ${state.status})`,
        sessionId, status: state.status,
      });
    }

    const validIds = (state.pendingOptions ?? []).map((o) => o.id);
    if (validIds.length && !validIds.includes(userChoice)) {
      return res.status(400).json({ error: `Invalid userChoice. Expected: ${validIds.join(', ')}` });
    }

    const selected = state.pendingOptions?.find((o) => o.id === userChoice);
    appendLog(state, 'user_input', `Selected: ${selected?.label ?? userChoice}`);

    state.status = 'RUNNING';
    state.pendingOptions = null;
    await saveSession(sessionId, state);

    appendLog(state, 'action', 'Generating detailed itinerary from user choice…');
    const finalPlan = await generateDetailedItinerary(
      state.tripParams, state.agentContext, userChoice
    );
    appendLog(state, 'observation', 'Final plan ready.');

    state.status = 'COMPLETED';
    state.finalPlan = finalPlan;
    state.conflictReason = null;

    await saveSession(sessionId, state);

    return res.status(200).json({
      sessionId, status: state.status, userChoice, finalPlan, logs: state.logs,
    });
  } catch (err) {
    console.error('[/api/agent/respond]', err);
    return res.status(500).json({ error: 'Agent respond failed', details: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, timestamp: nowIso(), gemini: !!genAI });
});

module.exports = app;
