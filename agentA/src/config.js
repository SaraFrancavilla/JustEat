export const HOST = process.env.TEST_LOCAL === 'true'
  ? "http://localhost:8080/"
  : "https://deliveroojs.onrender.com/";

export const getToken = () => process.env.DELIVEROO_TOKEN?.trim();

export const LOG_LEVEL = 1;

export const CFG = {
  TICK_RATE_MS: 120,
  REPLAN_STEPS: 14,
  ASTAR_MAX_EXPANSIONS: 4000,
  APPROACH_RADIUS: 10,
  APPROACH_CANDIDATE_LIMIT: 24,
  DELIVER_REWARD_THRESHOLD: 8,
  DELIVER_DIST_THRESHOLD: 4,
  DECAY_WEIGHT: 1.5,
  TEMP_BLOCK_MS: 1200,
  NO_GOAL_MS: 2500,
  NO_PICKUP_AFTER_DELIVERY_MS: 1000,
  CRATE_ASTAR_MAX_EXPANSIONS: 12000,
  CRATE_ASTAR_MAX_PUSHES: 8,
  CRATE_PUSH_PENALTY: 2,
  PARCEL_CANDIDATE_LIMIT: 14,
  PARCEL_CANDIDATE_LIMIT_CRATE: 10,
  REACT_NEAR_PARCEL_DIST: 3,
  REACT_HARD_CARRY_LIMIT: 15,
};

export const debug = (...a) => LOG_LEVEL >= 2 && console.log("DEBUG:", ...a);
export const info  = (...a) => LOG_LEVEL >= 1 && console.log("INFO:", ...a);
export const warn  = (...a) => console.warn("WARNING:", ...a);