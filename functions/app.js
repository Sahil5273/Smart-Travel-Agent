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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
const MAX_AGENT_LOOP_ITERATIONS = 5;
const QUOTA_RETRY_MESSAGE = 'Agent is thinking too fast, please wait 15 seconds and try again.';
const SESSIONS_COLLECTION = 'sessions';

function getGeminiKeyInfo() {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return { configured: false, format: 'missing', hint: 'Set GEMINI_API_KEY in Firebase secrets or .env' };
  if (key.startsWith('AQ.')) return { configured: true, format: 'auth_key', hint: null };
  if (key.startsWith('AIza')) {
    return {
      configured: true,
      format: 'standard_key',
      hint: 'Legacy AIza keys are being phased out. Create a new auth key (AQ.) in Google AI Studio.',
    };
  }
  return { configured: true, format: 'unknown', hint: 'Use a Google AI Studio API key (AQ. or AIza format).' };
}

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
  jaipur: [
    'Amber Fort', 'City Palace', 'Hawa Mahal', 'Jantar Mantar', 'Nahargarh Fort',
    'Albert Hall Museum', 'Jal Mahal', 'Birla Mandir', 'Chokhi Dhani', 'Jaigarh Fort',
  ],
  udaipur: [
    'City Palace', 'Lake Pichola', 'Jagdish Temple', 'Monsoon Palace', 'Fateh Sagar Lake',
    'Saheliyon-ki-Bari', 'Bagore Ki Haveli', 'Sajjangarh Biological Park', 'Vintage Car Museum',
  ],
  delhi: [
    'Red Fort', 'India Gate', 'Qutub Minar', 'Humayun\'s Tomb', 'Chandni Chowk',
    'Lotus Temple', 'Akshardham', 'Lodhi Garden', 'National Museum', 'Connaught Place',
  ],
  mumbai: [
    'Gateway of India', 'Marine Drive', 'Elephanta Caves', 'Colaba Causeway',
    'Chhatrapati Shivaji Terminus', 'Haji Ali Dargah', 'Sanjay Gandhi National Park', 'Juhu Beach',
  ],
  goa: [
    'Baga Beach', 'Fort Aguada', 'Basilica of Bom Jesus', 'Dudhsagar Falls',
    'Calangute Beach', 'Anjuna Flea Market', 'Chapora Fort', 'Spice Plantations',
  ],
  manali: [
    'Solang Valley', 'Hadimba Temple', 'Rohtang Pass', 'Old Manali',
    'Vashisht Hot Springs', 'Manu Temple', 'Naggar Castle', 'Beas River Trail',
  ],
  agra: [
    'Taj Mahal', 'Agra Fort', 'Mehtab Bagh', 'Fatehpur Sikri',
    'Itimad-ud-Daulah', 'Akbar\'s Tomb', 'Jama Masjid', 'Kinari Bazaar',
  ],
  bangalore: [
    'Lalbagh Botanical Garden', 'Cubbon Park', 'Bangalore Palace', 'ISKCON Temple',
    'Tipu Sultan\'s Summer Palace', 'Nandi Hills', 'UB City', 'Commercial Street',
  ],
  chennai: [
    'Marina Beach', 'Kapaleeshwarar Temple', 'Fort St. George', 'San Thome Basilica',
    'Government Museum', 'Mahabalipuram Shore Temple', 'Valluvar Kottam', 'Phoenix Marketcity',
  ],
  kolkata: [
    'Victoria Memorial', 'Howrah Bridge', 'Dakshineswar Kali Temple', 'Indian Museum',
    'Park Street', 'Science City', 'Marble Palace', 'Kumartuli',
  ],
  hyderabad: [
    'Charminar', 'Golconda Fort', 'Ramoji Film City', 'Hussain Sagar Lake',
    'Salar Jung Museum', 'Chowmahalla Palace', 'Birla Mandir', 'Laad Bazaar',
  ],
  amritsar: [
    'Golden Temple', 'Wagah Border', 'Jallianwala Bagh', 'Partition Museum',
    'Gobindgarh Fort', 'Hall Bazaar', 'Durgiana Temple', 'Pul Kanjari',
  ],
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

function toolGetAllTransitOptions(origin, destination) {
  const distanceKm = Math.round(estimateDistanceKm(origin, destination));

  const car = {
    mode: 'Car / Road',
    icon: '🚗',
    route: distanceKm > 200 ? 'NH48 / NH52 expressway corridor' : 'State highway + ring road',
    durationHours: Math.max(1, Math.round((distanceKm / 65) * 10) / 10),
    estimatedCostINR: Math.round(distanceKm * 4 + 600),
    details: `Self-drive or AC Volvo bus from ${origin} to ${destination}. Fuel, tolls & parking included.`,
    recommended: distanceKm <= 350,
  };

  const train = {
    mode: 'Train',
    icon: '🚆',
    route: 'Vande Bharat Express / Rajdhani / Shatabdi',
    durationHours: Math.max(2, Math.round((distanceKm / 85 + 2) * 10) / 10),
    estimatedCostINR: Math.round(1200 + distanceKm * 2.2),
    details: `Rail from ${origin} to ${destination}. AC chair car / 2AC estimate for one person.`,
    recommended: distanceKm > 350 && distanceKm <= 900,
  };

  const flight = {
    mode: 'Flight',
    icon: '✈️',
    route: `Direct or 1-stop ${origin} → ${destination}`,
    durationHours: Math.max(2, Math.round((2.5 + distanceKm / 600) * 10) / 10),
    estimatedCostINR: Math.round(4500 + distanceKm * 1.8),
    details: `Commercial flight with airport transfer. Check-in 2h before departure.`,
    recommended: distanceKm > 900,
  };

  return { origin, destination, distanceKm, options: [car, train, flight] };
}

function toolGetTransitRoute(origin, destination) {
  const all = toolGetAllTransitOptions(origin, destination);
  const recommended = all.options.find((o) => o.recommended) || all.options[0];
  return {
    origin,
    destination,
    mode: recommended.mode,
    route: recommended.route,
    distanceKm: all.distanceKm,
    durationHours: recommended.durationHours,
    estimatedCostINR: recommended.estimatedCostINR,
    details: recommended.details,
  };
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

function toolCalculateTotalCost(agentContext, tripParams, tier = 'balanced', transitCostOverride) {
  const transit = transitCostOverride ?? agentContext.transitRoute?.estimatedCostINR ?? 0;
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

function computeCostByTransitMode(tripParams, transitOptions, tier = 'balanced') {
  const mult = tier === 'budget' ? 0.75 : tier === 'premium' ? 1.35 : 1;
  const lodging = Math.round(tripParams.durationDays * 2800 * mult);
  const food = Math.round(tripParams.durationDays * 900 * mult);
  const activities = Math.round(tripParams.durationDays * 1800 * mult);

  return transitOptions.options.map((opt) => ({
    mode: opt.mode,
    icon: opt.icon,
    route: opt.route,
    durationHours: opt.durationHours,
    transit: opt.estimatedCostINR,
    lodging,
    food,
    activities,
    total: Math.round(opt.estimatedCostINR + lodging + food + activities),
    recommended: opt.recommended,
    withinBudget: Math.round(opt.estimatedCostINR + lodging + food + activities) <= tripParams.budget,
  }));
}

function getDestinationAttractions(agentContext, destination) {
  const destKey = normalizeCity(destination);
  return (
    agentContext.attractions[destination] ||
    agentContext.attractions[destKey] ||
    toolGetAttractions(destination).attractions
  );
}

function buildPlanDetails(tripParams, agentContext, tier = 'balanced') {
  const transitOptions = agentContext.transitOptions || toolGetAllTransitOptions(tripParams.origin, tripParams.destination);
  const attractions = getDestinationAttractions(agentContext, tripParams.destination);
  const costByMode = computeCostByTransitMode(tripParams, transitOptions, tier);
  const costBreakdown = agentContext.costBreakdown || toolCalculateTotalCost(agentContext, tripParams, tier);

  return {
    transitOptions: transitOptions.options,
    distanceKm: transitOptions.distanceKm,
    attractions,
    costBreakdown,
    costByMode,
  };
}

function executeTool(name, args, agentContext, tripParams) {
  if (name === 'get_transit_route') {
    const all = toolGetAllTransitOptions(args.origin, args.destination);
    agentContext.transitOptions = all;
    const result = toolGetTransitRoute(args.origin, args.destination);
    agentContext.transitRoute = result;
    agentContext.transitHours = result.durationHours;
    return { ...result, allOptions: all.options };
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
// Gemini helpers — rate-limit safety
// ---------------------------------------------------------------------------

function isQuotaError(err) {
  const msg = String(err?.message ?? err);
  const status = err?.status || err?.statusCode;
  return status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
}

function parseGeminiErrorDetail(err) {
  const source = err?.cause || err;
  const raw = String(source?.message ?? source ?? err?.message ?? err);
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message || raw;
    const limitMatch = message.match(/limit:\s*(\d+)/);
    return {
      status: parsed?.error?.code || err?.status || err?.statusCode,
      message: message.split('\n')[0],
      freeTierLimit: limitMatch ? Number(limitMatch[1]) : null,
      zeroQuota: limitMatch ? Number(limitMatch[1]) === 0 : false,
    };
  } catch {
    return {
      status: err?.status || err?.statusCode,
      message: raw.slice(0, 200),
      freeTierLimit: null,
      zeroQuota: raw.includes('limit: 0'),
    };
  }
}

function geminiFallbackReason(err) {
  const detail = parseGeminiErrorDetail(err);
  if (detail.zeroQuota || detail.freeTierLimit === 0) {
    return `Gemini free-tier quota is 0 for ${GEMINI_MODEL} on this project. Enable billing in Google AI Studio or check usage at https://ai.dev/rate-limit`;
  }
  if (detail.status === 429) {
    return 'Gemini rate limit hit — using local planner until quota recovers.';
  }
  const keyInfo = getGeminiKeyInfo();
  if (keyInfo.hint) return keyInfo.hint;
  return detail.message || 'Gemini unavailable — using local planner.';
}

/** Wraps all Gemini calls; converts 429 into a typed error instead of crashing. */
async function callGemini(params) {
  try {
    return await genAI.models.generateContent(params);
  } catch (err) {
    if (isQuotaError(err)) {
      const quotaErr = new Error(QUOTA_RETRY_MESSAGE);
      quotaErr.status = 429;
      quotaErr.cause = err;
      throw quotaErr;
    }
    throw err;
  }
}

function handleRouteError(res, err, routeName) {
  console.error(`[${routeName}]`, err);
  const status = err.status || err.statusCode;

  if (status === 429 || isQuotaError(err)) {
    return res.status(429).json({ error: QUOTA_RETRY_MESSAGE });
  }
  if (status === 401 || String(err.message).includes('UNAUTHENTICATED')) {
    return res.status(503).json({
      error: 'Gemini API authentication failed. Verify GEMINI_API_KEY in Firebase secrets is a current Google AI Studio auth key (AQ. format).',
    });
  }
  return res.status(500).json({ error: `${routeName} failed`, details: err.message });
}

// ---------------------------------------------------------------------------
// Local fallbacks (zero Gemini calls — used when quota is exhausted)
// ---------------------------------------------------------------------------

function fallbackExtractTripParams(userGoal) {
  const fromTo = userGoal.match(/from\s+(.+?)\s+to\s+(.+?)(?:\s+under|\s+for|\s+in|\s*$)/i);
  const budgetMatch = userGoal.match(/(?:₹|rs\.?|under)\s*([\d,]+)/i);
  const daysMatch = userGoal.match(/(\d+)\s*-?\s*day/i);

  return {
    origin: fromTo ? fromTo[1].trim() : 'Delhi',
    destination: fromTo ? fromTo[2].trim().replace(/\s+under.*/i, '') : 'Jaipur',
    budget: budgetMatch ? parseInt(budgetMatch[1].replace(/,/g, ''), 10) : 20000,
    durationDays: daysMatch ? parseInt(daysMatch[1], 10) : 3,
  };
}

/** Runs tools directly without Gemini — 0 API calls, same agent log format. */
function runDeterministicToolPlan(state, tripParams) {
  const agentContext = {
    transitRoute: null,
    transitHours: 0,
    attractions: {},
    costBreakdown: null,
    totalCost: 0,
    tier: 'balanced',
  };

  appendLog(state, 'thought', `Planning route: ${tripParams.origin} → ${tripParams.destination}`);

  appendLog(state, 'action', `Tool: get_transit_route("${tripParams.origin}", "${tripParams.destination}")`);
  const transit = executeTool(
    'get_transit_route',
    { origin: tripParams.origin, destination: tripParams.destination },
    agentContext,
    tripParams
  );
  appendLog(
    state,
    'observation',
    `Transit options — Car: ₹${agentContext.transitOptions.options[0].estimatedCostINR.toLocaleString('en-IN')}, Train: ₹${agentContext.transitOptions.options[1].estimatedCostINR.toLocaleString('en-IN')}, Flight: ₹${agentContext.transitOptions.options[2].estimatedCostINR.toLocaleString('en-IN')}`
  );

  appendLog(state, 'action', `Tool: get_attractions("${tripParams.destination}")`);
  const att = executeTool('get_attractions', { city: tripParams.destination }, agentContext, tripParams);
  appendLog(state, 'observation', `Found ${att.count} attractions in ${att.city}`);

  appendLog(state, 'action', 'Tool: calculate_total_cost("balanced")');
  const costs = executeTool('calculate_total_cost', { tier: 'balanced' }, agentContext, tripParams);
  appendLog(state, 'observation', `Total estimated: ₹${costs.total.toLocaleString('en-IN')}`);

  state.agentContext = agentContext;
  state.tripParams = tripParams;
  return agentContext;
}

function buildLocalItinerary(tripParams, agentContext, userChoice, fallbackReason) {
  const tier = userChoice === 'option_a' ? 'budget' : userChoice === 'option_b' ? 'premium' : 'balanced';
  if (userChoice === 'option_a') toolCalculateTotalCost(agentContext, tripParams, 'budget');
  else if (userChoice === 'option_b') toolCalculateTotalCost(agentContext, tripParams, 'premium');
  else toolCalculateTotalCost(agentContext, tripParams, 'balanced');

  const transit = agentContext.transitRoute || toolGetTransitRoute(tripParams.origin, tripParams.destination);
  const details = buildPlanDetails(tripParams, agentContext, tier);
  const attractions = details.attractions;

  const dailyItinerary = [];
  for (let d = 1; d <= tripParams.durationDays; d++) {
    if (d === 1) {
      dailyItinerary.push({
        day: 1,
        morning: [`Depart from ${tripParams.origin}`, `Travel via ${transit.mode}: ${transit.route}`],
        afternoon: [`Arrive in ${tripParams.destination}`, 'Hotel check-in'],
        evening: ['Local market walk', 'Welcome dinner'],
      });
    } else if (d === tripParams.durationDays) {
      dailyItinerary.push({
        day: d,
        morning: ['Souvenir shopping', 'Pack and checkout'],
        afternoon: [`Return journey to ${tripParams.origin}`],
        evening: ['Arrive home'],
      });
    } else {
      const attr = attractions[(d - 2) % attractions.length];
      dailyItinerary.push({
        day: d,
        morning: [`Visit ${attr}`, 'Breakfast at local café'],
        afternoon: ['Explore nearby sights', 'Rest break'],
        evening: ['Cultural experience / local cuisine'],
      });
    }
  }

  return {
    summary: `A ${tripParams.durationDays}-day ${tier} trip from ${tripParams.origin} to ${tripParams.destination} via ${transit.mode}.`,
    origin: tripParams.origin,
    destination: tripParams.destination,
    estimatedCostINR: agentContext.totalCost,
    durationDays: tripParams.durationDays,
    transitLogistics: {
      mode: transit.mode,
      route: transit.route,
      distanceKm: transit.distanceKm,
      durationHours: transit.durationHours,
      estimatedCostINR: transit.estimatedCostINR,
      details: transit.details,
    },
    transitOptions: details.transitOptions,
    distanceKm: details.distanceKm,
    attractions,
    costBreakdown: details.costBreakdown,
    costByMode: details.costByMode,
    dailyItinerary,
    localTransport: [
      'Use app-based cabs (Uber/Ola) for city commutes',
      'Auto-rickshaws for short distances in old city areas',
      'Consider day-pass for hop-on-hop-off buses if available',
    ],
    weatherPackingList: [
      'Comfortable walking shoes',
      'Sun protection (hat, sunscreen)',
      'Light cotton clothing',
      'Reusable water bottle',
      'Light jacket for evening travel',
    ],
    userChoice,
    generatedBy: 'local',
    geminiFallbackReason: fallbackReason || 'Gemini unavailable — using local planner.',
  };
}

function enrichPlanWithDetails(plan, tripParams, agentContext, tier = 'balanced') {
  const details = buildPlanDetails(tripParams, agentContext, tier);
  return {
    ...plan,
    transitOptions: plan.transitOptions?.length ? plan.transitOptions : details.transitOptions,
    distanceKm: plan.distanceKm ?? details.distanceKm,
    attractions: plan.attractions?.length ? plan.attractions : details.attractions,
    costBreakdown: plan.costBreakdown || details.costBreakdown,
    costByMode: plan.costByMode?.length ? plan.costByMode : details.costByMode,
  };
}

// ---------------------------------------------------------------------------
// Gemini: structured extraction
// ---------------------------------------------------------------------------

async function extractTripParams(userGoal) {
  if (!genAI) return fallbackExtractTripParams(userGoal);

  try {
    const response = await callGemini({
      model: GEMINI_MODEL,
      contents: `Extract trip parameters from this travel goal. Infer reasonable defaults if missing.\n\nGoal: "${userGoal}"`,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: TRIP_PARAMS_SCHEMA,
        temperature: 0.1,
      },
    });
    return JSON.parse(response.text);
  } catch (err) {
    if (isQuotaError(err)) {
      const reason = geminiFallbackReason(err);
      console.warn('[Gemini] Quota hit on extract — using local parser:', reason);
      return fallbackExtractTripParams(userGoal);
    }
    throw err;
  }
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

  let iterations = 0;
  for (let step = 0; step < MAX_AGENT_LOOP_ITERATIONS; step++) {
    iterations = step + 1;
    const response = await callGemini({
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

  if (iterations === MAX_AGENT_LOOP_ITERATIONS) {
    appendLog(state, 'observation', `Loop capped at ${MAX_AGENT_LOOP_ITERATIONS} iterations.`);
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
  const costByMode = computeCostByTransitMode(tripParams, agentContext.transitOptions, 'balanced');
  const cheapest = [...costByMode].sort((a, b) => a.total - b.total)[0];
  const recommended = costByMode.find((c) => c.recommended);

  return [
    {
      id: 'option_a',
      label: 'Option A — Stay within budget',
      description: `Use budget tier (${cheapest.mode} ~${formatCostINR(cheapest.total)}). Cut premium activities to stay under ${formatCostINR(budget)}.`,
      metadata: { tier: 'budget', estimatedCost: budgetCost, suggestedMode: cheapest.mode },
    },
    {
      id: 'option_b',
      label: 'Option B — Full route experience',
      description: `Keep ${recommended?.mode || agentContext.transitRoute?.mode || 'recommended transit'} and all attractions. Total ~${formatCostINR(premium)} (+${formatCostINR(overrun)} over budget).`,
      metadata: { tier: 'premium', estimatedCost: premium, overrun, suggestedMode: recommended?.mode },
    },
  ];
}

function formatCostINR(amount) {
  return `₹${Number(amount).toLocaleString('en-IN')}`;
}

function serializeAgentPreview(tripParams, agentContext) {
  const details = buildPlanDetails(tripParams, agentContext, agentContext.tier || 'balanced');
  return {
    transitRoute: agentContext.transitRoute,
    transitOptions: details.transitOptions,
    distanceKm: details.distanceKm,
    attractions: details.attractions,
    costBreakdown: details.costBreakdown,
    costByMode: details.costByMode,
  };
}

// ---------------------------------------------------------------------------
// Gemini: detailed final itinerary
// ---------------------------------------------------------------------------

async function generateDetailedItinerary(tripParams, agentContext, userChoice) {
  const tier = userChoice === 'option_a' ? 'budget' : userChoice === 'option_b' ? 'premium' : 'balanced';
  if (userChoice === 'option_a') toolCalculateTotalCost(agentContext, tripParams, 'budget');
  else if (userChoice === 'option_b') toolCalculateTotalCost(agentContext, tripParams, 'premium');

  if (!genAI) {
    return buildLocalItinerary(
      tripParams,
      agentContext,
      userChoice,
      getGeminiKeyInfo().hint || 'Gemini API key not configured.'
    );
  }

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

  try {
    const response = await callGemini({
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
    return enrichPlanWithDetails(
      { ...plan, userChoice, generatedBy: 'gemini' },
      tripParams,
      agentContext,
      tier
    );
  } catch (err) {
    if (isQuotaError(err)) {
      const reason = geminiFallbackReason(err);
      console.warn('[Gemini] Quota hit on itinerary — using local plan builder:', reason);
      return buildLocalItinerary(tripParams, agentContext, userChoice, reason);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.post('/api/agent/run', async (req, res) => {
  try {
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

    // Step 1: Extract trip params (Gemini with local fallback)
    appendLog(state, 'action', 'Extracting trip parameters…');
    const tripParams = await extractTripParams(userGoal);
    state.tripParams = tripParams;
    appendLog(state, 'observation', `${tripParams.origin} → ${tripParams.destination} | ₹${tripParams.budget} | ${tripParams.durationDays} days`);

    await saveSession(sessionId, state);

    // Step 2: Run tools locally (0 Gemini calls — avoids quota spam)
    const agentContext = runDeterministicToolPlan(state, tripParams);

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
        agentPreview: serializeAgentPreview(tripParams, agentContext),
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
    return handleRouteError(res, err, '/api/agent/run');
  }
});

app.post('/api/agent/respond', async (req, res) => {
  try {
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
    return handleRouteError(res, err, '/api/agent/respond');
  }
});

app.get('/health', async (_req, res) => {
  const keyInfo = getGeminiKeyInfo();
  const payload = {
    ok: true,
    timestamp: nowIso(),
    gemini: !!genAI,
    geminiKeyFormat: keyInfo.format,
    geminiKeyHint: keyInfo.hint,
    geminiModel: GEMINI_MODEL,
  };

  if (!genAI) {
    return res.status(200).json(payload);
  }

  try {
    await callGemini({ model: GEMINI_MODEL, contents: 'Reply with exactly: OK' });
    return res.status(200).json({ ...payload, geminiStatus: 'ok' });
  } catch (err) {
    const detail = parseGeminiErrorDetail(err);
    return res.status(200).json({
      ...payload,
      geminiStatus: 'fallback_only',
      geminiError: detail.message,
      geminiFreeTierLimit: detail.freeTierLimit,
      geminiFallbackReason: geminiFallbackReason(err),
    });
  }
});

module.exports = app;
