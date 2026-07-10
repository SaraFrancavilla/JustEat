# JustEat: DeliverooJS agents

This project implements two autonomous agents for the DeliverooJS parcel delivery game.

Agent A is a fast BDI/A* agent. It handles normal parcel collection and delivery, map exploration, obstacle-aware movement, coordination hints received from Agent B, and an optional PDDL planning extension when `USE_PDDL=true`.

Agent B extends the same baseline with natural-language mission handling. It classifies trusted challenge messages with an LLM, converts them into mission constraints, coordinates with Agent A when required, and manages rules such as delivery counts, movement goals, traffic-light waits, quiz answers, and parcel handoff missions.

## Requirements

- Node.js
- npm
- access to the Unitn GlobalProtect VPN
- a token for llm.bears.disi.unitn.it

## Environment files

env for Agent B:

```env
LLM_BASE_URL=<model_server_url>
LLM_API_KEY=<llm_api_key>
LOCAL_MODEL=<model_name>
```

local env for agent B:

```local.env
LLM_API_KEY=<token>
```

Optional env for agent A:

```env
USE_PDDL=false
PDDL_TIMEOUT_MS=1500
```

## Running the agents

Install dependencies separately in each agent folder:

```bash
cd agentA
npm install
npm start
```

```bash
cd agentB
npm install
npm start
```

When prompted, paste the DeliverooJS token for the corresponding agent.


## Testing missions

Create a third DeliverooJS client named `ChallengeGiver` or `Professor`, then send challenge messages through the chat. Agent B treats messages from trusted senders as mission instructions and relays coordination hints to Agent A when the mission requires both agents.