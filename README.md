# Tokenomics Stress-Test Platform (SWARM Hackathon Idea)

## One-Liner

LLM-powered adversarial agents that stress-test token economies on Solana devnet, validated against historical collapses like LUNA/UST.

## Problem

Bad tokenomics kills more crypto projects than bad code. The current process for validating tokenomics before launch is:

1. Write a whitepaper with assumptions
2. Maybe run spreadsheet simulations
3. Launch and pray
4. Token dumps 90% because nobody modeled what happens when whales coordinate, governance gets captured, or yield incentives create death spirals

There's no way to stress-test tokenomics with adversarial AI agents before going live. Existing tools (TokenLab, Cenit Finance) use rule-based/statistical agents that can't reason about novel attack vectors. Gauntlet does agent-based DeFi risk modeling but is closed-source, enterprise-only, and focused on lending parameters rather than tokenomics design.

## Solution

A simulation platform where 10-100+ LLM-powered agents with distinct personas (whale, retail degen, yield farmer, governance attacker, MEV bot, sybil attacker, long-term holder, arbitrageur) autonomously interact with a token economy deployed on Solana devnet.

Each agent:
- Has a system prompt defining its persona, goals, risk tolerance, and strategy
- Receives current market state every simulation tick (price, supply, staking ratio, governance proposals)
- Makes autonomous financial decisions via local LLM (Qwen 3 8B via Ollama)
- Executes real Solana transactions (buy, sell, stake, unstake, vote, create proposals)

The platform observes emergent behavior and produces a stress-test report identifying failure modes, centralization risks, and attack vectors.

## Backtest Validation

The system is validated by reproducing historical token collapses:

- **LUNA/UST collapse**: Feed the exact tokenomics parameters (algorithmic stablecoin mint/burn, Anchor 19.45% APY, LFG reserves). Agents should reproduce the death spiral.
- **CRV/Curve (resilient model)**: Show WHY veToken model survived attacks, where remaining vulnerabilities are.
- **Solana-native token**: Stress-test a recent Solana token launch relevant to the ecosystem.

"We fed our simulation LUNA's tokenomics. Our agents reproduced the death spiral. Now imagine if Do Kwon had this tool before launch."

## Architecture

### Tech Stack
- **Frontend/Dashboard**: Next.js, TanStack Query, Recharts
- **Simulation Engine**: TypeScript, Bun (tick-based loop)
- **Agent LLM**: Qwen 3 8B via Ollama (local, zero API cost, no rate limits)
- **On-chain**: Anchor programs on Solana devnet (token mint, AMM DEX, staking, governance)
- **Indexing**: Helius RPC, Yellowstone gRPC (real-time observation)
- **Report Generation**: Claude API (single call post-simulation)
- **Storage**: SQLite for simulation state

### Agent Personas
1. **Whale**: Accumulates large positions, dumps strategically
2. **Retail degen**: FOMO buys, panic sells on drawdowns
3. **Yield farmer**: Exploits every incentive loophole, moves capital to highest APY
4. **Governance attacker**: Accumulates voting power, submits self-serving proposals
5. **MEV bot**: Front-runs large trades
6. **Long-term holder**: Stakes and forgets, occasionally votes
7. **Sybil attacker**: Controls 5-20 wallets to game airdrops/governance
8. **Arbitrageur**: Rational exploiter of price discrepancies
9. **Protocol treasury**: Automated defender (buybacks, liquidity provision)

### Simulation Flow
1. User inputs token parameters (supply, allocation, vesting, staking APY, fees, governance thresholds)
2. Engine deploys Anchor programs on devnet with those parameters
3. Each tick: agents observe state -> LLM decides action -> execute on Solana devnet
4. Observation layer (Helius/Yellowstone) computes real-time metrics: Gini coefficient, staking concentration, governance power distribution, price trajectory
5. After N ticks: Claude API generates comprehensive stress-test report

## Why Solana-Native

- **400ms blocks**: Simulation ticks map 1:1 to real block production, preserving transaction ordering and MEV dynamics
- **ZK Compression (Light Protocol)**: Spin up 1000+ agent wallets as compressed accounts for nearly zero cost
- **Yellowstone gRPC**: Real-time streaming of every transaction and account update for the observation layer
- **Anchor program compatibility**: Protocol teams can hand over their actual Anchor programs and we deploy them unchanged on devnet with agents attacking them
- **Solana Agent Kit**: Native SDK for AI agents to interact with Solana programs
- **Target market**: Every Solana token launch needs this. Jupiter, Jito, Marinade, and hundreds of new projects

## Hackathon Track Fit

**RFB 4: Emergent Agent Economies** — Agents with different goals interacting in a real-money Solana environment, observing emergent economic structures.

Also touches **RFB 1 (Discovery/Reputation)** as agents build on-chain interaction history, and **RFB 5 (Multi-Agent Orchestration)** as agents coordinate attacks.

## Judging Criteria Alignment

- **Agentic Sophistication (30%)**: Full autonomy. LLM agents making real financial decisions every tick based on market state reasoning. Not automation, genuine AI decision-making.
- **Traction (30%)**: Every hackathon team building tokenomics is a potential user. Can stress-test other teams' tokens during the event. Backtest results serve as published research. Target: 5-10 LOIs from teams wanting their tokens stress-tested.
- **Innovation (40%)**: Nobody has combined LLM-agent adversarial simulation + on-chain execution + historical backtest validation for tokenomics. TokenLab uses rule-based agents. Gauntlet is closed-source enterprise. This is a new category.

## Business Model (Post-Hackathon)

1. **Self-serve**: Protocol team inputs parameters, standard agent roster runs simulation, automated report. $500-2000 per run.
2. **Custom simulations**: Custom agent personas, specific attack scenarios. $5K-20K.
3. **Continuous monitoring**: Post-launch, ongoing agent simulations detecting emerging risks. Monthly subscription.
4. **Long-term**: Expand beyond tokenomics to DeFi parameter testing, governance attack simulation, airdrop distribution optimization.

## Competitive Landscape

| Competitor | Approach | Gap |
|---|---|---|
| Gauntlet | Agent-based DeFi risk, closed-source, enterprise-only | No self-serve, no tokenomics focus, no LLM agents |
| TokenLab | Python ABM framework, rule-based agents | No LLM reasoning, no on-chain execution, no backtest validation |
| Cenit Finance | No-code simulator, organic price modeling | Explicitly doesn't model adversarial/speculative behavior |
| Tokenomics.com | Consulting + spreadsheet models | Manual process, no agent simulation |

## Questions for Colosseum Copilot

1. Has anyone built an LLM-agent-based tokenomics stress-testing or simulation tool on Solana in any previous hackathon?
2. What agent-based simulation or multi-agent economy projects have been submitted to Solana hackathons?
3. What tokenomics audit, validation, or simulation tools exist in the Solana ecosystem?
4. Are there any projects combining adversarial AI agents with on-chain DeFi simulation?
5. Run a Deep Dive gap analysis on this idea.