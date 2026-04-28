"use client";

import { useMemo } from "react";
import { Plus, X } from "lucide-react";
import type { SimulationConfigParsed } from "@/lib/extraction/types";
import { cn } from "@/lib/utils";
import { FieldBadge, type FieldSource } from "./FieldBadge";

export interface ConfigEditorProps {
  /** Current config (controlled). */
  config: SimulationConfigParsed;
  /** Field paths that came from the LLM (e.g. "token.totalSupply"). */
  extractedFields: string[];
  /** Field paths the user has edited since the LLM populated them. */
  editedFields: Set<string>;
  /** Update a single dotted path. The parent reconciles edited state. */
  onChange: (path: string, next: unknown) => void;
}

export function ConfigEditor(props: ConfigEditorProps) {
  const { config, extractedFields, editedFields, onChange } = props;
  const extractedSet = useMemo(() => new Set(extractedFields), [extractedFields]);

  const sourceFor = (path: string): FieldSource => {
    if (editedFields.has(path)) return "edited";
    if (extractedSet.has(path)) return "extracted";
    return "default";
  };

  const allocSum = config.token.allocations.reduce((s, a) => s + (a.percent || 0), 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Token */}
      <Section title="Token">
        <NumberRow
          label="Total supply"
          path="token.totalSupply"
          value={config.token.totalSupply}
          source={sourceFor("token.totalSupply")}
          onChange={onChange}
          min={0}
        />
        <NumberRow
          label="Decimals"
          path="token.decimals"
          value={config.token.decimals}
          source={sourceFor("token.decimals")}
          onChange={onChange}
          min={0}
          max={18}
          step={1}
        />

        <div className="flex flex-col gap-2 pt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
                Allocations
              </span>
              <FieldBadge source={sourceFor("token.allocations")} />
            </div>
            <span
              className={cn(
                "font-mono text-[10px] tracking-[0.2em]",
                Math.abs(allocSum - 100) < 0.05 ? "text-zinc-500" : "text-amber-700",
              )}
            >
              sum: {allocSum.toFixed(2)}%
            </span>
          </div>

          <div className="grid gap-1.5">
            <div className="grid grid-cols-[1fr_80px_80px_28px] items-center gap-2 px-1 font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-400">
              <span>Name</span>
              <span className="text-right">Percent</span>
              <span className="text-right">Vest mo</span>
              <span />
            </div>
            {config.token.allocations.map((alloc, idx) => (
              <div
                key={idx}
                className="grid grid-cols-[1fr_80px_80px_28px] items-center gap-2"
              >
                <input
                  value={alloc.name}
                  onChange={(e) => updateAllocation(config, onChange, idx, "name", e.target.value)}
                  className="rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[12px] text-zinc-900 outline-none focus:border-zinc-900"
                />
                <input
                  type="number"
                  value={alloc.percent}
                  onChange={(e) =>
                    updateAllocation(config, onChange, idx, "percent", Number(e.target.value))
                  }
                  className="rounded border border-zinc-200 bg-white px-2 py-1 text-right font-mono text-[12px] text-zinc-900 outline-none focus:border-zinc-900"
                />
                <input
                  type="number"
                  value={alloc.vestingMonths}
                  onChange={(e) =>
                    updateAllocation(
                      config,
                      onChange,
                      idx,
                      "vestingMonths",
                      Math.max(0, Math.floor(Number(e.target.value))),
                    )
                  }
                  className="rounded border border-zinc-200 bg-white px-2 py-1 text-right font-mono text-[12px] text-zinc-900 outline-none focus:border-zinc-900"
                />
                <button
                  type="button"
                  onClick={() => removeAllocation(config, onChange, idx)}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                  aria-label="Remove allocation"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => addAllocation(config, onChange)}
              className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-dashed border-zinc-300 bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600 hover:border-zinc-700 hover:text-zinc-900"
            >
              <Plus className="h-3 w-3" /> add row
            </button>
          </div>
        </div>
      </Section>

      {/* Staking */}
      <Section title="Staking">
        <NumberRow
          label="Base APY (%)"
          path="staking.baseAPY"
          value={config.staking.baseAPY}
          source={sourceFor("staking.baseAPY")}
          onChange={onChange}
          min={0}
          step={0.01}
        />
        <NumberRow
          label="Max APY (%)"
          path="staking.maxAPY"
          value={config.staking.maxAPY}
          source={sourceFor("staking.maxAPY")}
          onChange={onChange}
          min={0}
          step={0.01}
        />
        <NumberRow
          label="Lock period (ticks ≈ days)"
          path="staking.lockPeriodTicks"
          value={config.staking.lockPeriodTicks}
          source={sourceFor("staking.lockPeriodTicks")}
          onChange={onChange}
          min={0}
          step={1}
        />
        <NumberRow
          label="Unstake penalty (%)"
          path="staking.unstakePenaltyPercent"
          value={config.staking.unstakePenaltyPercent}
          source={sourceFor("staking.unstakePenaltyPercent")}
          onChange={onChange}
          min={0}
          max={100}
          step={0.1}
        />
      </Section>

      {/* AMM */}
      <Section title="AMM">
        <NumberRow
          label="Initial liquidity (token)"
          path="amm.initialLiquidity"
          value={config.amm.initialLiquidity}
          source={sourceFor("amm.initialLiquidity")}
          onChange={onChange}
          min={0}
        />
        <NumberRow
          label="Initial price (USD)"
          path="amm.initialPrice"
          value={config.amm.initialPrice}
          source={sourceFor("amm.initialPrice")}
          onChange={onChange}
          min={0}
          step={0.01}
        />
        <NumberRow
          label="Fee tier (%)"
          path="amm.feeTier"
          value={config.amm.feeTier}
          source={sourceFor("amm.feeTier")}
          onChange={onChange}
          min={0}
          step={0.01}
        />
      </Section>

      {/* Governance */}
      <Section title="Governance">
        <NumberRow
          label="Proposal threshold (%)"
          path="governance.proposalThresholdPercent"
          value={config.governance.proposalThresholdPercent}
          source={sourceFor("governance.proposalThresholdPercent")}
          onChange={onChange}
          min={0}
          max={100}
          step={0.01}
        />
        <NumberRow
          label="Quorum (%)"
          path="governance.quorumPercent"
          value={config.governance.quorumPercent}
          source={sourceFor("governance.quorumPercent")}
          onChange={onChange}
          min={0}
          max={100}
          step={0.1}
        />
        <NumberRow
          label="Voting period (ticks)"
          path="governance.votingPeriodTicks"
          value={config.governance.votingPeriodTicks}
          source={sourceFor("governance.votingPeriodTicks")}
          onChange={onChange}
          min={0}
          step={1}
        />
        <NumberRow
          label="Timelock (ticks)"
          path="governance.timelockTicks"
          value={config.governance.timelockTicks}
          source={sourceFor("governance.timelockTicks")}
          onChange={onChange}
          min={0}
          step={1}
        />
      </Section>

      {/* Stablecoin */}
      <Section title="Stablecoin module">
        <label className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
              Enabled
            </span>
            <FieldBadge source={sourceFor("stablecoin.enabled")} />
          </span>
          <input
            type="checkbox"
            checked={!!config.stablecoin?.enabled}
            onChange={(e) =>
              onChange("stablecoin", {
                ...(config.stablecoin ?? {
                  enabled: false,
                  targetPeg: 1,
                  mintBurnRatio: 1,
                  reserveAmount: 0,
                }),
                enabled: e.target.checked,
              })
            }
            className="h-4 w-4 cursor-pointer"
          />
        </label>
        {config.stablecoin?.enabled && (
          <>
            <NumberRow
              label="Target peg (USD)"
              path="stablecoin.targetPeg"
              value={config.stablecoin.targetPeg}
              source={sourceFor("stablecoin.targetPeg")}
              onChange={onChange}
              min={0}
              step={0.01}
            />
            <NumberRow
              label="Mint/burn ratio"
              path="stablecoin.mintBurnRatio"
              value={config.stablecoin.mintBurnRatio}
              source={sourceFor("stablecoin.mintBurnRatio")}
              onChange={onChange}
              min={0}
              step={0.01}
            />
            <NumberRow
              label="Reserve at TGE (USD)"
              path="stablecoin.reserveAmount"
              value={config.stablecoin.reserveAmount}
              source={sourceFor("stablecoin.reserveAmount")}
              onChange={onChange}
              min={0}
            />
          </>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2 border-l-2 border-zinc-200 pl-4">
      <legend className="ml-[-1.05rem] bg-white px-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-700">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function NumberRow({
  label,
  path,
  value,
  source,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  path: string;
  value: number;
  source: FieldSource;
  onChange: (path: string, next: unknown) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="grid grid-cols-[1fr_140px] items-center gap-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-600">
          {label}
        </span>
        <FieldBadge source={source} />
      </div>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const raw = e.target.value;
          const next = raw === "" ? 0 : Number(raw);
          onChange(path, Number.isFinite(next) ? next : 0);
        }}
        min={min}
        max={max}
        step={step}
        className="rounded border border-zinc-200 bg-white px-2 py-1 text-right font-mono text-[12px] text-zinc-900 outline-none focus:border-zinc-900"
      />
    </div>
  );
}

// ---- helpers for the allocations array ----

function updateAllocation(
  config: SimulationConfigParsed,
  onChange: (path: string, next: unknown) => void,
  idx: number,
  field: "name" | "percent" | "vestingMonths",
  value: string | number,
) {
  const next = config.token.allocations.map((a, i) => (i === idx ? { ...a, [field]: value } : a));
  onChange("token.allocations", next);
}

function addAllocation(
  config: SimulationConfigParsed,
  onChange: (path: string, next: unknown) => void,
) {
  const next = [...config.token.allocations, { name: "New bucket", percent: 0, vestingMonths: 0 }];
  onChange("token.allocations", next);
}

function removeAllocation(
  config: SimulationConfigParsed,
  onChange: (path: string, next: unknown) => void,
  idx: number,
) {
  const next = config.token.allocations.filter((_, i) => i !== idx);
  onChange("token.allocations", next);
}
