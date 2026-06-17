export const inbox = {
  pendingMessages: [],
};

export function pushPlanFromB(plan) {
  inbox.pendingMessages.push({ type: "llm_plan", plan });
}