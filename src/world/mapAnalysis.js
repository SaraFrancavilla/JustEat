import { W } from "./state.js";
import { key } from "../utils/math.js";
import { runCoordinationCycle } from "../llm/agent.mjs";

// Basic helper to count walkable neighbors
function countWalkableNeighbors(x, y) {
    const dirs = [[0,1], [1,0], [0,-1], [-1,0]];
    let count = 0;
    for (const [dx, dy] of dirs) {
        const k = key(x + dx, y + dy);
        const tile = W.tiles.get(k);
        if (tile && tile.walkable) count++;
    }
    return count;
}

export function computeMapProfile() {
    let totalNeighbors = 0;
    let chokePoints = 0;
    let walkableCount = 0;

    for (const [k, tile] of W.tiles.entries()) {
        if (!tile.walkable) continue;
        
        walkableCount++;
        const neighbors = countWalkableNeighbors(tile.x, tile.y);
        totalNeighbors += neighbors;
        
        if (neighbors <= 2) chokePoints++; // Corridors and dead-ends
    }

    const avgBranchingFactor = walkableCount > 0 ? (totalNeighbors / walkableCount) : 0;

    const deliveryCount = W.deliveryTiles.length;

    W.mapProfile = {
        walkableTiles: walkableCount,
        deliveryTiles: deliveryCount,
        chokePointRatio: walkableCount > 0 ? (chokePoints / walkableCount).toFixed(2) : 0,
        avgBranchingFactor: avgBranchingFactor.toFixed(2)
    };

    return W.mapProfile;
}

export async function analyzeMapStrategyWithLLM() {
    const profile = computeMapProfile();
    
    const prompt = `
    You are the Strategy Commander for a DeliverooJS agent. 
    Analyze this map profile: ${JSON.stringify(profile)}.
    
    Map Types:
    1. "Open" (Branching factor > 3.5).
    2. "Hallways" (Branching factor < 2.5).
    3. "Hub" (Mixed).

    Carry Strategies:
    - Target 4-5 parcels for Open Arenas.
    - Target 1-2 parcels for Hallways (to avoid getting trapped).

    You must output your decision inside a Final Answer block containing ONLY valid JSON.
    
    Format your response EXACTLY like this:
    Thought: <your brief reasoning>
    Final Answer: {"mapType": "...", "carryTarget": X}
    `;

    try {
        // Run cycle (5 iterations)
        const response = await runCoordinationCycle(prompt, 5);
        
        if (response.success && response.answer) {
            // Clean up the answer in case the LLM wrapped it in markdown code blocks
            const cleanedAnswer = response.answer.replace(/```json/gi, "").replace(/```/g, "").trim();
            
            const strategy = JSON.parse(cleanedAnswer);
            
            if (strategy.carryTarget) {
                W.strategy = strategy;
                console.log("[STRATEGY] LLM set new strategy:", W.strategy);
            }
        } else {
            console.log("[STRATEGY] Coordination cycle failed or timed out.");
        }
    } catch (e) {
        console.error("[STRATEGY] Failed to parse LLM strategy:", e);
    }
}