import "dotenv/config";
import OpenAI from "openai";
import { TOOLS, setSocket, coordination, resetCycleState } from "./tools.mjs";
import { COORDINATION_SYSTEM_PROMPT } from "./prompts.mjs";
import { W } from "../world/state.js";
import {
  isTrustedSender,
  pruneExpiredMissions,
  enqueueTrustedMissionMessage,
  processMissionQueue,
} from "./missions.mjs";

const baseURL = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL;

if (!baseURL) {
  console.error("Error: missing LLM_BASE_URL in .env file");
  process.exit(1);
}

if (!MODEL) {
  console.error("Error: missing LOCAL_MODEL in .env file");
  process.exit(1);
}

console.log("[LLM] Using model", MODEL, "at", baseURL);

const client = new OpenAI({ baseURL, apiKey });

async function callModel(messages, { temperature = 0 } = {}) {
  try {
    console.log("[LLM] Calling model with", messages.length, "messages");
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature,
    });
    return response.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    console.error("[LLM] callModel error:", error);
    return null;
  }
}

function extractAction(text) {
  if (!text) return null;

  const actionLine = text.match(/^Action:\s*(.+?)\s*$/im);
  if (!actionLine) return null;

  const raw = actionLine[1].trim();

  const actionInputBlock = text.match(
    /Action Input:\s*([\s\S]*?)(?=\n(?:Thought:|Action:|Final Answer:)|$)/i
  );

  if (actionInputBlock) {
    const action = raw.replace(/\(\s*\)$/, "").trim();
    return {
      action,
      actionInput: actionInputBlock[1].trim(),
    };
  }

  const inlineCall = raw.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)\s*$/);
  if (inlineCall) {
    return {
      action: inlineCall[1].trim(),
      actionInput: inlineCall[2].trim() || "None",
    };
  }

  return {
    action: raw.replace(/\(\s*\)$/, "").trim(),
    actionInput: "None",
  };
}

function extractFinalAnswer(text) {
  const match = text.match(/Final Answer:\s*([\s\S]+)/is);
  return match ? match[1].trim() : null;
}

function countActions(text) {
  const matches = text.match(/^Action:/gim);
  return matches ? matches.length : 0;
}

function hasBothActionAndFinalAnswer(text) {
  return /^Action:/im.test(text) && /Final Answer:/i.test(text);
}

function parseToolInput(_action, rawInput) {
  if (!rawInput || rawInput === "None") return [];

  const trimmed = String(rawInput).trim();

  try {
    return [JSON.parse(trimmed)];
  } catch {}

  try {
    return [JSON.parse(trimmed.replace(/^[`]+|[`]+$/g, ""))];
  } catch {}

  return trimmed
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

async function runCoordinationCycle(
  userRequest,
  { maxIterations = 2, systemPrompt = COORDINATION_SYSTEM_PROMPT } = {}
) {
  resetCycleState();

  const turnMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userRequest },
  ];

  for (let i = 0; i < maxIterations; i++) {
    console.log(`--- Iteration ${i + 1}/${maxIterations} ---`);

    const assistantMessage = await callModel(turnMessages, { temperature: 0 });

    if (assistantMessage === null) {
      console.log("[LLM] Model call failed, aborting coordination cycle.");
      return {
        success: false,
        answer: "Model call failed.",
        plan: null,
      };
    }

    turnMessages.push({ role: "assistant", content: assistantMessage });

    const cleanedMessage = assistantMessage
      .replace(/^Observation:.*$/gim, "")
      .trim();

    const parsedAction = extractAction(cleanedMessage);
    const finalAnswer = extractFinalAnswer(cleanedMessage);

    const actionCount = countActions(cleanedMessage);
    const mixedOutput = hasBothActionAndFinalAnswer(cleanedMessage);

    if (actionCount > 1) {
      console.log(`[LLM] Warning: ${actionCount} actions detected. Executing first only.`);
    }
    if (mixedOutput) {
      console.log("[LLM] Warning: Both Action and Final Answer detected. Executing Action first.");
    }

    if (parsedAction) {
      const { action, actionInput } = parsedAction;
      let observation;

      if (TOOLS[action]) {
        console.log(`[LLM] Executing tool: ${action}(${actionInput || "None"})`);
        try {
          const args = parseToolInput(action, actionInput);
          observation = await TOOLS[action](...args);
        } catch (error) {
          observation = `Error executing ${action}: ${error.message}`;
        }
      } else {
        observation = `Error: unknown tool "${action}". Available tools: ${Object.keys(TOOLS).join(", ")}`;
      }

      console.log("[LLM] Observation from tool:", observation);

      if (coordination.pendingMessages.length > 0) {
        const last =
          coordination.pendingMessages[coordination.pendingMessages.length - 1];
        console.log("[LLM] Pending message after tool:", last);
      }

      const planNow =
        [...coordination.pendingMessages]
          .reverse()
          .find((m) => m?.type === "llm_plan") ?? null;

      if (planNow) {
        return {
          success: true,
          answer: "PLAN_REGISTERED",
          plan: planNow,
        };
      }

      turnMessages.push({
        role: "user",
        content: `Observation: ${JSON.stringify(
          observation
        )}\n\nNow output your next Thought and Action, or give a Final Answer.`,
      });

      continue;
    }

    if (finalAnswer) {
      const lastPlanMsg =
        [...coordination.pendingMessages]
          .reverse()
          .find((m) => m?.type === "llm_plan") ?? null;

      if (lastPlanMsg) {
        console.log("[LLM] Final pending plan:", lastPlanMsg);
      } else {
        console.log("[LLM] No pending coordination messages at end of cycle.");
      }

      return { success: true, answer: finalAnswer, plan: lastPlanMsg };
    }

    const isWaiting = /please provide.*observation/i.test(assistantMessage);
    const errorMsg = isWaiting
      ? "The Observation was already provided in the previous message. Proceed with exactly one Action or one Final Answer."
      : "Error: invalid format. You must output either one Action or one Final Answer.";

    console.log("[LLM]", errorMsg);

    turnMessages.push({
      role: "user",
      content: `Observation: ${errorMsg}\n\nNow output exactly one Action or one Final Answer.`,
    });
  }

  return {
    success: false,
    answer: "Coordination cycle timed out.",
    plan: null,
  };
}

export class LLMCoordinationAgent {
  constructor(socket) {
    setSocket(socket);
    this.socket = socket;
    console.log("[LLM] Coordination agent created for agent id:", W.me?.id);
    this.setupMessageListener();
  }

  registerPlan(plan) {
    coordination.pendingMessages.push({
      type: "llm_plan",
      plan,
      timestamp: Date.now(),
    });
  }

  getPendingPlan() {
    if (coordination.pendingMessages.length === 0) return null;

    const lastPlanMsg = [...coordination.pendingMessages]
      .reverse()
      .find((m) => m?.type === "llm_plan");

    return lastPlanMsg?.plan ?? null;
  }

  acknowledgePlan() {
    for (let i = coordination.pendingMessages.length - 1; i >= 0; i--) {
      if (coordination.pendingMessages[i]?.type === "llm_plan") {
        coordination.pendingMessages.splice(i, 1);
        return;
      }
    }
  }

  setupMessageListener() {
    this.socket.onMsg(async (id, name, msg, reply) => {
      console.log(`\n[CHAT] Message from ${name} (${id}):`, msg);

      pruneExpiredMissions();

      const trusted = isTrustedSender(name);
      if (trusted) {
        console.log(`[MISSION] Trusted sender detected: "${name}"`);
      } else {
        console.log(`[MISSION] Non-trusted sender: "${name}"`);
      }

      if (trusted) {
        const textMsg =
          typeof msg === "string"
            ? msg.trim()
            : typeof msg === "object"
              ? JSON.stringify(msg)
              : String(msg ?? "").trim();

        if (!textMsg) {
          console.log("[MISSION] Empty trusted message, ignoring.");
          return;
        }

        console.log("[MISSION] Trusted mission sender detected. Adding to queue...");

        enqueueTrustedMissionMessage({
          callModel,
          runCoordinationCycle,
          missionText: textMsg,
          replyCallback: reply,
          senderId: id,
          socket: this.socket,
        });

        processMissionQueue().catch((error) => {
          console.error("[MISSION] processMissionQueue failed:", error);
        });

        return;
      }

      if (typeof msg === "object" && msg.action === "pickup") {
        const parcelId = msg.parcelId;
        if (parcelId == null) {
          if (reply) reply(false);
          return;
        }

        if (coordination.parcelReservations.has(parcelId)) {
          const reservation = coordination.parcelReservations.get(parcelId);
          if (reservation.agentId === this.socket.id) {
            console.log(`Replying NO: we reserved ${parcelId}`);
            if (reply) reply(false);
            return;
          }
        }

        console.log(`Replying YES: teammate can take ${parcelId}`);
        coordination.parcelReservations.set(parcelId, {
          agentId: id,
          timestamp: Date.now(),
        });
        if (reply) reply(true);
      }
    });
  }

  async coordinate(request = "Coordinate the next best action for the team.") {
    const result = await runCoordinationCycle(request);
    console.log("[LLM] Coordination result:", result);
    return result;
  }
}

export { runCoordinationCycle, callModel };