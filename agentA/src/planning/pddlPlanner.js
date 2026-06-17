import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildProblem } from './problemBuilder.js';
import { normalizeMissionPolicy } from './mission-policies.js';
import { W } from '../world/state.js';
import { manhattan } from '../utils/math.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Planning.Domains API ────────────────────────────────────────────────────
const PLANNER_URL  = 'https://solver.planning.domains/solve';
const PLANNER_NAME = 'ff';           // Fast-Forward, reliable for this domain
const PLAN_TIMEOUT = 8000;           // ms — abort if planner takes too long

// ── Cache: avoid re-planning every tick for the same mission ───────────────
let cachedPlan       = null;   // array of action strings
let cachedMissionKey = null;   // JSON fingerprint of last mission policy
let lastPlanTime     = 0;
const REPLAN_INTERVAL = 4000;  // re-plan at most every 4 seconds

// ── Domain file (read once) ────────────────────────────────────────────────
const DOMAIN_PATH = path.join(__dirname, 'domain.pddl');
let domainText = null;

function getDomain() {
  if (!domainText) {
    domainText = fs.readFileSync(DOMAIN_PATH, 'utf8');
  }
  return domainText;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns true when the mission has constraints that BDI alone cannot
 * easily handle and that benefit from symbolic planning
 */
export function missionNeedsPlanning(mission) {
  if (!mission) return false;
  const p = normalizeMissionPolicy(mission);
  return (
    Number.isFinite(p.pickup.exactCarry)          ||  // "pick up exactly N"
    p.delivery.preferredTiles.length > 0           ||  // "deliver only to tile X"
    p.delivery.forbiddenTiles.length > 0           ||  // "never deliver to tile Y"
    p.delivery.zeroRewardTiles.length > 0          ||  // zero-reward tiles to avoid
    p.pickup.forbiddenTiles.length > 0             ||  // pickup forbidden zones
    !!p.movement.meetTarget                            // rendezvous mission
  );
}

/**
 * Calls the Planning.Domains HTTP solver
 * Returns an array of action strings, e.g.:
 *   ["(move agent1 t2_3 t3_3)", "(pickup agent1 p_abc t3_3)", ...]
 * Returns null on failure
 */
async function callPlannerAPI(domainStr, problemStr) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT);

  try {
    const body = JSON.stringify({
      domain:  domainStr,
      problem: problemStr,
      planner: PLANNER_NAME,
    });

    const res = await fetch(PLANNER_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn('[PDDL] Planner HTTP error:', res.status);
      return null;
    }

    const data = await res.json();

    // Planning.Domains returns { status, result: { plan: [...] } }
    if (data?.status !== 'ok' || !Array.isArray(data?.result?.plan)) {
      console.warn('[PDDL] Planner returned no plan:', data?.status);
      return null;
    }

    return data.result.plan.map(step => step.name ?? step);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[PDDL] Planner timed out after', PLAN_TIMEOUT, 'ms');
    } else {
      console.warn('[PDDL] Planner error:', err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses a single PDDL action string into a BDI intention.
 * Action formats produced by FF planner:
 *   "(move agent1 t2_3 t3_3)"
 *   "(pickup agent1 p_abc t3_3)"
 *   "(pickup-1 agent1 p_abc t3_3)"
 *   "(deliver agent1 p_abc t5_7)"
 *
 * Returns { type: "PICKUP"|"DELIVER"|"MOVE", target: {x,y} } or null.
 */
function parseAction(actionStr) {
  if (!actionStr) return null;

  // Remove outer parens and lowercase
  const clean = actionStr.replace(/^\(|\)$/g, '').trim().toLowerCase();
  const parts  = clean.split(/\s+/);
  const verb   = parts[0];

  // tile id → {x, y}
  function tileToPos(tid) {
    const m = tid.match(/^t(-?\d+)_(-?\d+)$/);
    if (!m) return null;
    return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
  }

  // parcel id → original parcel id string
  function pidToId(pid) {
    // "p_abc123" → "abc123"
    return pid.replace(/^p_/, '');
  }

  if (verb === 'move') {
    // (move agent to) parts[3] is destination
    const pos = tileToPos(parts[3]);
    if (!pos) return null;
    return { type: 'MOVE', target: pos };
  }

  if (verb.startsWith('pickup')) {
    // (pickup[-N] agent parcel tile) parts[3] is tile
    const pos = tileToPos(parts[3]);
    const pid = pidToId(parts[2]);
    if (!pos) return null;
    // Find matching parcel in world state
    const parcel = W.parcelList?.find(p => p.id === pid) ?? { x: pos.x, y: pos.y };
    return { type: 'PICKUP', target: { x: parcel.x ?? pos.x, y: parcel.y ?? pos.y } };
  }

  if (verb === 'deliver') {
    // (deliver agent parcel tile) parts[3] is delivery tile
    const pos = tileToPos(parts[3]);
    if (!pos) return null;
    return { type: 'DELIVER', target: pos };
  }

  return null;
}

/**
 * Main entry point called from deliberate()
 * Returns the first actionable BDI intention from the PDDL plan, or null
 */
export async function getPDDLIntention(mission) {
  console.log("[PDDL] getPDDLIntention called");
  const now = Date.now();
  const mKey = JSON.stringify(normalizeMissionPolicy(mission));

  // Use cached plan if mission unchanged and not stale
  if (
    cachedPlan &&
    cachedPlan.length > 0 &&
    cachedMissionKey === mKey &&
    now - lastPlanTime < REPLAN_INTERVAL
  ) {
    const next = cachedPlan.shift();
    const intent = parseAction(next);
    console.log('[PDDL] Using cached plan step:', next, '→', intent);
    return intent;
  }

  // Re-plan
  console.log('[PDDL] Planning for mission...');
  const domain  = getDomain();
  const problem = buildProblem(mission);

  console.log('[PDDL] Problem snippet:\n', problem.slice(0, 300), '...');

  const plan = await callPlannerAPI(domain, problem);
  if (!plan || plan.length === 0) {
    console.warn('[PDDL] No plan found, falling back to BDI.');
    return null;
  }

  console.log('[PDDL] Plan received:', plan);

  cachedPlan       = [...plan];
  cachedMissionKey = mKey;
  lastPlanTime     = now;

  const next   = cachedPlan.shift();
  const intent = parseAction(next);
  console.log('[PDDL] Executing first step:', next, '→', intent);
  return intent;
}

/**
 * Call this when a mission ends or changes to clear the plan cache
 */
export function invalidatePDDLCache() {
  cachedPlan       = null;
  cachedMissionKey = null;
  lastPlanTime     = 0;
}