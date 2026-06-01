import "dotenv/config";
import OpenAI from "openai";
import { TOOLS, setSocket, coordination, resetCycleState } from "./tools.mjs";
import { COORDINATION_SYSTEM_PROMPT } from "./prompts.mjs";
import { W } from "../world/state.js";

const TRUSTED_SENDER_NAME = "ChallengeGiver"; // idk il nome del prof o qualcuno che scrive le challenge


// ============================================================================
// 1. LLM Configuration
// ============================================================================
const baseURL = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL;

if (!baseURL) {
  console.error("Error: missing LLM_BASE_URL in .env file");
  process.exit(1);
}

console.log("[LLM] Using model", MODEL, "at", baseURL);

const client = new OpenAI({ baseURL, apiKey });

// ============================================================================
// 2. LLM Call Wrapper
// ============================================================================
async function callModel(messages, { temperature = 0 } = {}) {
  try {
    console.log("[LLM] Calling model with", messages.length, "messages");
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature,
    });
    const content = response.choices?.[0]?.message?.content ?? "";
    console.log("[LLM]", content);
    return content;
  } catch (error) {
    console.error("[LLM] callModel error:", error);
    return null;
  }
}

// ============================================================================
// 3. Output Parsing
// ============================================================================
function extractAction(text) {
  const actionMatch = text.match(/^Action:\s*(.+?)\s*$/im);
  if (!actionMatch) return null;
  const action = actionMatch[1].trim().replace(/\(\s*\)$/, "");

  const inputMatch = text.match(
    /Action Input:\s*([\s\S]*?)(?=\n(?:Thought:|Action:|Final Answer:)|$)/i
  );
  if (!inputMatch) return null;
  const actionInput = inputMatch[1].trim();

  return { action, actionInput };
}

function extractFinalAnswer(text) {
  const match = text.match(/Final Answer:\s*([\s\S]+)/is);
  if (!match) return null;
  return match[1].trim();
}

function countActions(text) {
  const matches = text.match(/^Action:/gim);
  return matches ? matches.length : 0;
}

function hasBothActionAndFinalAnswer(text) {
  return /^Action:/im.test(text) && /Final Answer:/i.test(text);
}

// ============================================================================
// 4. Tool Input Parser
// ============================================================================
function parseToolInput(action, rawInput) {
  if (!rawInput || rawInput === "None") return [];
  try {
    return [JSON.parse(rawInput)];
  } catch {
    return rawInput
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
  }
}

// ============================================================================
// 5. Agent Execution Loop
// ============================================================================
async function runCoordinationCycle(userRequest, maxIterations = 12) {
  resetCycleState();

  const turnMessages = [
    { role: "system", content: COORDINATION_SYSTEM_PROMPT },
    { role: "user", content: userRequest },
  ];

  console.log("\n=== LLM Coordination Cycle Started ===");
  // console.log("[LLM] Request:", userRequest);
  console.log();

  for (let i = 0; i < maxIterations; i++) {
    console.log(`--- Iteration ${i + 1}/${maxIterations} ---`);

    const assistantMessage = await callModel(turnMessages, {
      temperature: 0,
    });

    if (assistantMessage === null) {
      console.log(
        "[LLM] Model call failed, aborting coordination cycle."
      );
      return {
        success: false,
        answer: "Model call failed.",
        plan: null,
      };
    }

    // Already logged raw output in callModel
    turnMessages.push({ role: "assistant", content: assistantMessage });

    // Strip any hallucinated Observation lines before parsing
    const cleanedMessage = assistantMessage
      .replace(/^Observation:.*$/gim, "")
      .trim();
    const parsedAction = extractAction(cleanedMessage);
    const finalAnswer = extractFinalAnswer(cleanedMessage);

    const actionCount = countActions(cleanedMessage);
    const mixedOutput = hasBothActionAndFinalAnswer(cleanedMessage);

    if (actionCount > 1) {
      console.log(
        `  Warning: ${actionCount} actions detected. Executing first only.`
      );
    }
    if (mixedOutput) {
      console.log(
        "  Warning: Both Action and Final Answer detected. Executing Action first."
      );
    }

    // 5a. Tool call branch
    if (parsedAction) {
      const { action, actionInput } = parsedAction;
      let observation;

      if (TOOLS[action]) {
        console.log(
          ` Executing tool: ${action}(${actionInput || "None"})`
        );
        try {
          const args = parseToolInput(action, actionInput);
          observation = await TOOLS[action](...args);
        } catch (error) {
          observation = `Error executing ${action}: ${error.message}`;
        }
      } else {
        observation = `Error: unknown tool "${action}". Available tools: ${Object.keys(
          TOOLS
        ).join(", ")}`;
      }

      console.log("[LLM] Observation from tool:", observation);
      console.log();

      if (coordination.pendingMessages.length > 0) {
        const last =
          coordination.pendingMessages[
            coordination.pendingMessages.length - 1
          ];
        console.log("[LLM] Pending message after tool:", last);
      }

      turnMessages.push({
        role: "user",
        content: `Observation: ${JSON.stringify(
          observation
        )}\n\nNow output your next Thought and Action, or give a Final Answer.`,
      });

      continue;
    }

    // 5b. Final Answer branch
    if (finalAnswer) {
      console.log("Final Answer:", finalAnswer);
      // console.log("=== Coordination Cycle Complete ===\n");

      const lastPlanMsg =
        coordination.pendingMessages[
          coordination.pendingMessages.length - 1
        ] || null;

      if (lastPlanMsg) {
        console.log(
          // "[LLM] Last pending coordination message:",
          lastPlanMsg
        );
      } else {
        console.log(
          "[LLM] No pending coordination messages at end of cycle."
        );
      }

      return { success: true, answer: finalAnswer, plan: lastPlanMsg };
    }

    // 5c. Invalid format fallback
    const isWaiting =
      /please provide.*observation/i.test(assistantMessage);
    const errorMsg = isWaiting
      ? "The Observation was already provided in the previous message. Proceed with your next Thought and Action."
      : "Error: invalid format. You must output either one Action or one Final Answer.";
    console.log(" ", errorMsg);

    turnMessages.push({
      role: "user",
      content: `Observation: ${errorMsg}\n\nNow output your next Thought and Action, or give a Final Answer.`,
    });
  }

  console.log("  Max iterations reached. Coordination incomplete.");
  console.log("=== Coordination Cycle Timeout ===\n");
  return {
    success: false,
    answer: "Coordination cycle timed out.",
    plan: null,
  };
}

// ============================================================================
// 6. Agent Wrapper Class
// ============================================================================
export class LLMCoordinationAgent {
  constructor(socket) {
    setSocket(socket);
    this.socket = socket;
    console.log(
      "[LLM] Coordination agent created for agent id:",
      W.me?.id
    );
    this.setupMessageListener();
  }

  setupMessageListener() {
    this.socket.onMsg(async (id, name, msg, reply) => {
      console.log(`\n[CHAT] Message from ${name} (${id}):`, msg);

      // Logic for mission evaluation
      if (name === TRUSTED_SENDER_NAME) {
        console.log(`[MISSION] Server mission detected. Evaluating...`);
        await this.evaluateAndExecuteMission(msg, reply, id);
        return; // Stop processing this message as a normal chat
      }

      // Pick up logic for teammate communication
      if (typeof msg === "object" && msg.action === "pickup") {
        const parcelId = msg.parcelId;

        if (coordination.parcelReservations.has(parcelId)) {
          const reservation =
            coordination.parcelReservations.get(parcelId);
          if (reservation.agentId === this.socket.id) {
            console.log(
              `Replying NO: we reserved ${parcelId}`
            );
            if (reply) reply(false);
            return;
          }
        }

        console.log(
          `Replying YES: teammate can take ${parcelId}`
        );
        coordination.parcelReservations.set(parcelId, {
          agentId: id,
          timestamp: Date.now(),
        });
        if (reply) reply(true);
      }
    });
  }

  // Mission Evaluator
  async evaluateAndExecuteMission(missionText, replyCallback, senderId) {
    const currentState = `Position: x=${W.me?.x}, y=${W.me?.y} | Score: ${W.me?.score}`;

    const prompt = `
    You are playing DeliverooJS. The server just sent you a special mission:

    "${missionText}"

    Your current state is: ${currentState}.

    Decide whether this mission should be ignored, answered immediately, or accepted as a temporary behavior-changing mission.

    Rules:
    1. If the mission is bad for score, output Final Answer: IGNORE.
    2. If it is a pure question or quiz, answer it directly with the raw answer only.
    3. If it requires a temporary change in behavior (examples: wait, only deliver N at a time, move to a place, avoid something), then you may use tools if needed and end with Final Answer: MISSION COMPLETE.
    4. Only treat it as an active ongoing mission if it changes behavior over time. One-shot answers do NOT create an active mission.
    5. You must maximize expected points, even if that means answering incorrectly on purpose.

    Only output your Thought, Actions, and a Final Answer.
    `.trim();

    const result = await runCoordinationCycle(prompt, 6);

    if (!result.success || result.answer === "IGNORE") {
      console.log("[MISSION] Mission ignored or failed.");
      W.activeMission = null;
      return;
    }

    const answer = String(result.answer).trim();

    // Decide whether this mission should persist as active state
    const text = String(missionText).toLowerCase();

    const isOngoingBehaviorMission =
      /only deliver|at a time|for \d+ seconds|do not move|don't move|wait|avoid|never|always|until/i.test(text);

    if (isOngoingBehaviorMission) {
      const mission = {
        id: Date.now(),
        text: missionText,
        accepted: true,
        status: "active",
        objectiveType: "custom",
        policy: {},
        createdAt: Date.now()
      };

      if (exactDeliverMatch) {
        const n = Number(exactDeliverMatch[1]);
        mission.objectiveType = "deliver_rule";
        mission.policy.delivery = { exactCount: n };
        mission.policy.pickup = { maxCarry: n };
      }

      const waitMatch = text.match(/(?:wait|stop|do not move|don't move)\s+for\s+(\d+)\s+seconds?/);
      if (waitMatch) {
        const seconds = Number(waitMatch[1]);
        mission.objectiveType = "wait";
        mission.policy.wait = {
          until: Date.now() + seconds * 1000
        };
      }

      W.activeMission = mission;
      console.log("[MISSION] Activated mission:", W.activeMission);
    } else {
      // just a question, no persistent mission state
      W.activeMission = null;
    }

    console.log(`[MISSION] Replying to server with: ${answer}`);
    if (replyCallback) {
      try {
        replyCallback(answer);
      } catch (e) {
        console.error("[MISSION] Failed to reply:", e);
      }
    } else {
      this.socket.say(senderId, answer);
    }
  }

  async coordinate(
    request = "Coordinate the next best action for the team."
  ) {
    const result = await runCoordinationCycle(request);
    console.log("[LLM] Coordination result:", result);
    return result;
  }

  getPendingPlan() {
    if (coordination.pendingMessages.length === 0) return null;
    const lastMessage =
      coordination.pendingMessages[
        coordination.pendingMessages.length - 1
      ];
    if (lastMessage.type === "llm_plan") return lastMessage.plan;
    return null;
  }

  acknowledgePlan() {
    coordination.pendingMessages = [];
  }
}

export { runCoordinationCycle };