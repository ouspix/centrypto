"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckCircle2, Eye, RefreshCw, Save, SlidersHorizontal } from "lucide-react"
import { AgentConfig } from "@/lib/agent-config"
import {
    CandidatePromotionConfig,
    CandidatePromotionOverrideAction,
    CandidatePromotionPriorStatus,
    CandidatePromotionStructureRequirement,
    CandidateStructureRule,
    candidatePromotionRulesHash,
    normalizeCandidatePromotionConfig
} from "@/lib/candidate-promotion"
import type { OpportunityDiagnostic, Playbook } from "@/types/trading"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"

type PriorBucketRow = {
    playbook: string;
    side: string;
    regime: string;
    inPlayBucket: string;
    setupBucket: string;
    costBucket: string;
    key: string;
    episodes: number;
    avgNetBps: number;
    status: CandidatePromotionPriorStatus;
    positive: boolean;
};

type PriorBucketSource = {
    source: string;
    updatedAt: string | null;
    sizeBytes: number | null;
};

type CandidatePromotionRulesPanelProps = {
    config?: AgentConfig;
    autoTraderStatus: any;
    isTestnet: boolean;
    hasWalletSession: boolean;
    saving: boolean;
    opportunities?: OpportunityDiagnostic[];
    onSave?: (config: CandidatePromotionConfig) => Promise<void>;
    onDraftChange?: (config: CandidatePromotionConfig) => void;
    embedded?: boolean;
    showOpportunityDrawer?: boolean;
};

type PlaybookOverrideMode = CandidatePromotionOverrideAction | "off";

const STRUCTURE_RULES: CandidateStructureRule[] = ["ALLOW", "NEAR_MISS_ONLY", "BLOCK"];
const PRIOR_STATUSES: CandidatePromotionPriorStatus[] = ["OFF", "SHADOW", "LIVE"];
const PLAYBOOK_MODES: PlaybookOverrideMode[] = ["off", "enabled", "near_miss_only", "disabled"];
const STRUCTURE_REQUIREMENTS: CandidatePromotionStructureRequirement[] = ["fresh_continuation", "pullback_continuation"];
const PLAYBOOKS: Playbook[] = [
    "Momentum:long",
    "Momentum:short",
    "Breakout:long",
    "Breakout:short",
    "Mean Reversion:long",
    "Mean Reversion:short",
    "Pullback Continuation:long",
    "Pullback Continuation:short",
    "Failed Bounce:short",
    "Failed Breakdown:long",
    "Capitulation Bounce:long",
    "Capitulation Bounce:short"
];

export function CandidatePromotionRulesPanel({
    config,
    autoTraderStatus,
    isTestnet,
    hasWalletSession,
    saving,
    opportunities,
    onSave,
    onDraftChange,
    embedded = false,
    showOpportunityDrawer = true
}: CandidatePromotionRulesPanelProps) {
    const initialPromotion = useMemo(
        () => normalizeCandidatePromotionConfig(config?.candidate_promotion),
        [config]
    );
    const [draft, setDraft] = useState<CandidatePromotionConfig>(initialPromotion);
    const [priorBuckets, setPriorBuckets] = useState<PriorBucketRow[]>([]);
    const [priorSource, setPriorSource] = useState<PriorBucketSource | null>(null);
    const [loadingPriors, setLoadingPriors] = useState(false);
    const [selectedOpportunity, setSelectedOpportunity] = useState<OpportunityDiagnostic | null>(null);

    useEffect(() => {
        setDraft(initialPromotion);
    }, [initialPromotion]);

    const serverRules = useMemo(
        () => normalizeCandidatePromotionConfig(
            autoTraderStatus?.activeCandidatePromotionSummary?.rules ??
            autoTraderStatus?.configOverride?.candidate_promotion
        ),
        [autoTraderStatus]
    );
    const serverHash = autoTraderStatus?.activeCandidatePromotionSummary?.rules_hash ??
        autoTraderStatus?.candidatePromotionRulesHash ??
        candidatePromotionRulesHash(serverRules);
    const draftHash = candidatePromotionRulesHash(draft);
    const serverConfigured = Boolean(autoTraderStatus?.configured);
    const draftMatchesServer = serverConfigured && draftHash === serverHash;

    const loadPriorBuckets = useCallback(async () => {
        if (!hasWalletSession) {
            setPriorBuckets([]);
            setPriorSource(null);
            return;
        }
        setLoadingPriors(true);
        try {
            const network = isTestnet ? "testnet" : "mainnet";
            const response = await fetch(`/api/auto-trader/prior-buckets?network=${network}&t=${Date.now()}`, {
                cache: "no-store"
            });
            if (!response.ok) throw new Error("Failed to load prior buckets");
            const payload = await response.json();
            setPriorBuckets(Array.isArray(payload.buckets) ? payload.buckets : []);
            setPriorSource({
                source: String(payload.source ?? "data/calibration/latest/rolling_prior.csv"),
                updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null,
                sizeBytes: Number.isFinite(Number(payload.sizeBytes)) ? Number(payload.sizeBytes) : null
            });
        } catch {
            setPriorBuckets([]);
            setPriorSource(null);
        } finally {
            setLoadingPriors(false);
        }
    }, [hasWalletSession, isTestnet]);

    useEffect(() => {
        void loadPriorBuckets();
    }, [loadPriorBuckets, serverHash]);

    const updateGlobalRule = (key: "lateChase" | "extendedBreakoutWithoutPullback", value: CandidateStructureRule) => {
        commitDraft(current => ({
            ...current,
            global_structure_rules: {
                ...current.global_structure_rules,
                [key]: value
            }
        }));
    };

    const updateGlobalBonus = (key: "freshContinuationBonus" | "pullbackContinuationBonus", value: boolean) => {
        commitDraft(current => ({
            ...current,
            global_structure_rules: {
                ...current.global_structure_rules,
                [key]: value
            }
        }));
    };

    const updatePlaybookMode = (playbook: string, mode: PlaybookOverrideMode) => {
        commitDraft(current => {
            const nextOverrides = { ...current.playbook_overrides };
            if (mode === "off") {
                delete nextOverrides[playbook];
            } else {
                const existing = nextOverrides[playbook];
                nextOverrides[playbook] = {
                    action: mode,
                    requireNotLateChase: existing?.requireNotLateChase ?? false,
                    requireAnyStructure: existing?.requireAnyStructure ?? []
                };
            }
            return { ...current, playbook_overrides: nextOverrides };
        });
    };

    const updatePlaybookLateChaseRequirement = (playbook: string, value: boolean) => {
        commitDraft(current => {
            const existing = current.playbook_overrides[playbook];
            if (!existing) return current;
            return {
                ...current,
                playbook_overrides: {
                    ...current.playbook_overrides,
                    [playbook]: { ...existing, requireNotLateChase: value }
                }
            };
        });
    };

    const updatePlaybookStructureRequirement = (
        playbook: string,
        requirement: CandidatePromotionStructureRequirement,
        enabled: boolean
    ) => {
        commitDraft(current => {
            const existing = current.playbook_overrides[playbook];
            if (!existing) return current;
            const nextRequirements = enabled
                ? Array.from(new Set([...existing.requireAnyStructure, requirement]))
                : existing.requireAnyStructure.filter(item => item !== requirement);
            return {
                ...current,
                playbook_overrides: {
                    ...current.playbook_overrides,
                    [playbook]: { ...existing, requireAnyStructure: nextRequirements }
                }
            };
        });
    };

    const updatePriorStatus = (key: string, status: CandidatePromotionPriorStatus) => {
        commitDraft(current => {
            const nextBuckets = { ...current.prior_buckets };
            if (status === "OFF") {
                delete nextBuckets[key];
            } else {
                nextBuckets[key] = { status };
            }
            return { ...current, prior_buckets: nextBuckets };
        });
    };

    const positiveLiveCount = priorBuckets.filter(bucket =>
        bucket.positive && (draft.prior_buckets[bucket.key]?.status ?? bucket.status) === "LIVE"
    ).length;
    const activeOverrideCount = Object.keys(draft.playbook_overrides).length;
    const opportunityList = opportunities ?? [];

    const commitDraft = (updater: (current: CandidatePromotionConfig) => CandidatePromotionConfig) => {
        setDraft(current => {
            const next = normalizeCandidatePromotionConfig(updater(current));
            onDraftChange?.(next);
            return next;
        });
    };

    const resetToServer = () => {
        setDraft(serverRules);
        onDraftChange?.(serverRules);
    };

    return (
        <div className="w-full min-w-0 overflow-hidden rounded-md border border-slate-800 bg-slate-950/40 p-3 text-xs">
            <div className={embedded ? "flex flex-col gap-2" : "flex flex-col gap-2 md:flex-row md:items-center md:justify-between"}>
                <div className="flex min-w-0 items-center gap-2">
                    <SlidersHorizontal className="h-4 w-4 shrink-0 text-emerald-300" />
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-100">Candidate Promotion Rules</div>
                        <div className="text-[11px] text-slate-500">
                            {serverConfigured ? "Server-backed config" : "No server config saved"}
                        </div>
                    </div>
                </div>
                <div className={embedded ? "grid w-full grid-cols-[minmax(0,1fr)_104px] items-center gap-2" : "flex shrink-0 flex-wrap items-center gap-1.5"}>
                    <Badge variant="outline" className={`${embedded ? "h-8 justify-center truncate px-2" : ""} ${draftMatchesServer ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10" : "border-amber-500/40 text-amber-300 bg-amber-500/10"}`}>
                        {draftMatchesServer ? "Draft matches server" : "Draft differs"}
                    </Badge>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={resetToServer}
                        disabled={!serverConfigured || saving}
                        className={`${embedded ? "h-8 w-full" : "h-7"} border-slate-600 bg-slate-900 text-slate-200 hover:bg-slate-800`}
                    >
                        <RefreshCw className="mr-1.5 h-3 w-3" />
                        Reset
                    </Button>
                    {!embedded && onSave && (
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => onSave(draft)}
                            disabled={!hasWalletSession || saving}
                            className="h-7 bg-emerald-600 text-white hover:bg-emerald-500"
                        >
                            <Save className="mr-1.5 h-3 w-3" />
                            Save
                        </Button>
                    )}
                </div>
            </div>

            <div className="mt-3 space-y-3">
                <section className="rounded border border-slate-800/80 bg-slate-900/30 p-2.5">
                    <div className="mb-2 text-[11px] font-semibold uppercase text-slate-400">Global Structure Rules</div>
                    <div className="grid gap-2">
                        <RuleSelect
                            label="Late chase"
                            value={draft.global_structure_rules.lateChase}
                            onValueChange={value => updateGlobalRule("lateChase", value)}
                        />
                        <RuleSelect
                            label="Extended breakout without pullback"
                            value={draft.global_structure_rules.extendedBreakoutWithoutPullback}
                            onValueChange={value => updateGlobalRule("extendedBreakoutWithoutPullback", value)}
                        />
                        <BooleanRule
                            label="Fresh continuation bonus"
                            checked={draft.global_structure_rules.freshContinuationBonus}
                            onCheckedChange={value => updateGlobalBonus("freshContinuationBonus", value)}
                        />
                        <BooleanRule
                            label="Pullback continuation bonus"
                            checked={draft.global_structure_rules.pullbackContinuationBonus}
                            onCheckedChange={value => updateGlobalBonus("pullbackContinuationBonus", value)}
                        />
                    </div>
                </section>

                <section className="rounded border border-slate-800/80 bg-slate-900/30 p-2.5">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold uppercase text-slate-400">Playbook Overrides</div>
                        <Badge variant="outline" className="border-slate-600 text-slate-300">{activeOverrideCount} active</Badge>
                    </div>
                    {embedded ? (
                        <div className="max-h-72 space-y-2 overflow-y-auto rounded border border-slate-800 bg-slate-950/40 p-2">
                            {PLAYBOOKS.map(playbook => {
                                const override = Object.prototype.hasOwnProperty.call(draft.playbook_overrides, playbook)
                                    ? draft.playbook_overrides[playbook]
                                    : undefined;
                                const mode: PlaybookOverrideMode = override?.action ?? "off";
                                const disabled = mode === "off";
                                return (
                                    <div key={playbook} className="rounded border border-slate-800 bg-slate-950/70 p-2">
                                        <div className="grid grid-cols-[minmax(0,1fr)_132px] items-center gap-2">
                                            <div className="truncate font-mono text-[11px] text-slate-200" title={playbook}>{playbook}</div>
                                            <Select value={mode} onValueChange={value => updatePlaybookMode(playbook, value as PlaybookOverrideMode)}>
                                                <SelectTrigger className="h-8 w-full border-slate-700 bg-slate-950 text-[11px] text-slate-100">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                                                    {PLAYBOOK_MODES.map(item => (
                                                        <SelectItem key={item} value={item} className="text-[11px]">
                                                            {formatAction(item)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        {!disabled && (
                                            <div className="mt-2 grid gap-2 rounded border border-slate-800/80 bg-slate-900/40 p-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="text-[11px] text-slate-400">Require not late chase</span>
                                                    <Switch
                                                        checked={Boolean(override?.requireNotLateChase)}
                                                        onCheckedChange={value => updatePlaybookLateChaseRequirement(playbook, value)}
                                                        className="scale-75 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                                                    />
                                                </div>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {STRUCTURE_REQUIREMENTS.map(requirement => (
                                                        <button
                                                            key={requirement}
                                                            type="button"
                                                            onClick={() => updatePlaybookStructureRequirement(
                                                                playbook,
                                                                requirement,
                                                                !override?.requireAnyStructure.includes(requirement)
                                                            )}
                                                            className={`rounded border px-2 py-1 font-mono text-[10px] ${
                                                                override?.requireAnyStructure.includes(requirement)
                                                                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                                                                    : "border-slate-700 bg-slate-950 text-slate-500"
                                                            }`}
                                                        >
                                                            {formatRequirement(requirement)}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="max-h-64 min-w-0 overflow-auto rounded border border-slate-800">
                            <Table className="min-w-[640px] text-[11px]">
                                <TableHeader className="bg-slate-950/80">
                                    <TableRow className="border-slate-800 hover:bg-transparent">
                                        <TableHead className="h-8 text-slate-400">Playbook</TableHead>
                                        <TableHead className="h-8 text-slate-400">Action</TableHead>
                                        <TableHead className="h-8 text-slate-400">Not Late</TableHead>
                                        <TableHead className="h-8 text-slate-400">Require Structure</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {PLAYBOOKS.map(playbook => {
                                        const override = Object.prototype.hasOwnProperty.call(draft.playbook_overrides, playbook)
                                            ? draft.playbook_overrides[playbook]
                                            : undefined;
                                        const mode: PlaybookOverrideMode = override?.action ?? "off";
                                        const disabled = mode === "off";
                                        return (
                                            <TableRow key={playbook} className="border-slate-800 hover:bg-slate-900/80">
                                                <TableCell className="whitespace-nowrap font-mono text-slate-200">{playbook}</TableCell>
                                                <TableCell>
                                                    <Select value={mode} onValueChange={value => updatePlaybookMode(playbook, value as PlaybookOverrideMode)}>
                                                        <SelectTrigger className="h-7 w-36 border-slate-700 bg-slate-950 text-[11px] text-slate-100">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                                                            {PLAYBOOK_MODES.map(item => (
                                                                <SelectItem key={item} value={item} className="text-[11px]">
                                                                    {formatAction(item)}
                                                                </SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </TableCell>
                                                <TableCell>
                                                    <Switch
                                                        checked={Boolean(override?.requireNotLateChase)}
                                                        onCheckedChange={value => updatePlaybookLateChaseRequirement(playbook, value)}
                                                        disabled={disabled}
                                                        className="scale-75 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                                                    />
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex flex-wrap gap-1">
                                                        {STRUCTURE_REQUIREMENTS.map(requirement => (
                                                            <button
                                                                key={requirement}
                                                                type="button"
                                                                disabled={disabled}
                                                                onClick={() => updatePlaybookStructureRequirement(
                                                                    playbook,
                                                                    requirement,
                                                                    !override?.requireAnyStructure.includes(requirement)
                                                                )}
                                                                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                                                                    override?.requireAnyStructure.includes(requirement)
                                                                        ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                                                                        : "border-slate-700 bg-slate-950 text-slate-500"
                                                                } disabled:cursor-not-allowed disabled:opacity-40`}
                                                            >
                                                                {formatRequirement(requirement)}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </section>

                <section className="rounded border border-slate-800/80 bg-slate-900/30 p-2.5">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <div>
                            <div className="text-[11px] font-semibold uppercase text-slate-400">Prior Buckets</div>
                            <div className="text-[10px] text-slate-500">LIVE is available only for positive rolling-prior buckets.</div>
                            <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                                Prior generated: {formatPriorSourceTime(priorSource?.updatedAt)}
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="border-emerald-500/40 text-emerald-300">{positiveLiveCount} LIVE</Badge>
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                onClick={loadPriorBuckets}
                                disabled={loadingPriors || !hasWalletSession}
                                aria-label="Refresh prior buckets"
                                className="h-7 w-7 border-slate-600 bg-slate-900 text-slate-200 hover:bg-slate-800"
                            >
                                <RefreshCw className={`h-3.5 w-3.5 ${loadingPriors ? "animate-spin" : ""}`} />
                            </Button>
                        </div>
                    </div>
                    {embedded ? (
                        <div className="max-h-80 space-y-2 overflow-y-auto rounded border border-slate-800 bg-slate-950/40 p-2">
                            {priorBuckets.length === 0 && (
                                <div className="rounded border border-slate-800 bg-slate-950/70 px-2 py-5 text-center text-slate-500">
                                    {loadingPriors ? "Loading prior buckets" : "No prior buckets loaded"}
                                </div>
                            )}
                            {priorBuckets.map(bucket => {
                                const status = draft.prior_buckets[bucket.key]?.status ?? bucket.status ?? "OFF";
                                return (
                                    <div key={bucket.key} className="rounded border border-slate-800 bg-slate-950/70 p-2">
                                        <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
                                            <div className="min-w-0">
                                                <div className="flex min-w-0 items-center gap-1.5">
                                                    <span className="truncate font-mono text-[11px] text-slate-100" title={bucket.playbook}>{bucket.playbook}</span>
                                                    <Badge variant="outline" className="shrink-0 border-slate-700 px-1.5 py-0 text-[10px] text-slate-400">
                                                        {bucket.side}
                                                    </Badge>
                                                </div>
                                                <div className="mt-1 truncate font-mono text-[10px] text-slate-500">
                                                    {bucket.regime} · {bucket.inPlayBucket} · {bucket.setupBucket} · {bucket.costBucket}
                                                </div>
                                                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-slate-400">
                                                    <span>{bucket.episodes} episodes</span>
                                                    <span className={bucket.avgNetBps > 0 ? "text-emerald-300" : "text-red-300"}>
                                                        {bucket.avgNetBps.toFixed(2)} bps
                                                    </span>
                                                </div>
                                            </div>
                                            <Select value={status} onValueChange={value => updatePriorStatus(bucket.key, value as CandidatePromotionPriorStatus)}>
                                                <SelectTrigger className="h-8 w-full border-slate-700 bg-slate-950 text-[11px] text-slate-100">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                                                    {PRIOR_STATUSES.map(item => (
                                                        <SelectItem
                                                            key={item}
                                                            value={item}
                                                            disabled={item === "LIVE" && !bucket.positive}
                                                            className="text-[11px]"
                                                        >
                                                            {item}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="max-h-72 min-w-0 overflow-auto rounded border border-slate-800">
                            <Table className="min-w-[900px] text-[11px]">
                                <TableHeader className="bg-slate-950/80">
                                    <TableRow className="border-slate-800 hover:bg-transparent">
                                        <TableHead className="h-8 text-slate-400">Playbook</TableHead>
                                        <TableHead className="h-8 text-slate-400">Side</TableHead>
                                        <TableHead className="h-8 text-slate-400">Regime</TableHead>
                                        <TableHead className="h-8 text-slate-400">InPlay</TableHead>
                                        <TableHead className="h-8 text-slate-400">Setup</TableHead>
                                        <TableHead className="h-8 text-slate-400">Cost</TableHead>
                                        <TableHead className="h-8 text-right text-slate-400">Episodes</TableHead>
                                        <TableHead className="h-8 text-right text-slate-400">Avg Net</TableHead>
                                        <TableHead className="h-8 text-slate-400">Status</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {priorBuckets.length === 0 && (
                                        <TableRow className="border-slate-800">
                                            <TableCell colSpan={9} className="py-5 text-center text-slate-500">
                                                {loadingPriors ? "Loading prior buckets" : "No prior buckets loaded"}
                                            </TableCell>
                                        </TableRow>
                                    )}
                                    {priorBuckets.map(bucket => {
                                        const status = draft.prior_buckets[bucket.key]?.status ?? bucket.status ?? "OFF";
                                        return (
                                            <TableRow key={bucket.key} className="border-slate-800 hover:bg-slate-900/80">
                                                <TableCell className="min-w-36 font-mono text-slate-200">{bucket.playbook}</TableCell>
                                                <TableCell className="text-slate-300">{bucket.side}</TableCell>
                                                <TableCell className="text-slate-300">{bucket.regime}</TableCell>
                                                <TableCell className="font-mono text-slate-400">{bucket.inPlayBucket}</TableCell>
                                                <TableCell className="font-mono text-slate-400">{bucket.setupBucket}</TableCell>
                                                <TableCell className="font-mono text-slate-400">{bucket.costBucket}</TableCell>
                                                <TableCell className="text-right font-mono text-slate-300">{bucket.episodes}</TableCell>
                                                <TableCell className={`text-right font-mono ${bucket.avgNetBps > 0 ? "text-emerald-300" : "text-red-300"}`}>
                                                    {bucket.avgNetBps.toFixed(2)}
                                                </TableCell>
                                                <TableCell>
                                                    <Select value={status} onValueChange={value => updatePriorStatus(bucket.key, value as CandidatePromotionPriorStatus)}>
                                                        <SelectTrigger className="h-7 w-24 border-slate-700 bg-slate-950 text-[11px] text-slate-100">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                                                            {PRIOR_STATUSES.map(item => (
                                                                <SelectItem
                                                                    key={item}
                                                                    value={item}
                                                                    disabled={item === "LIVE" && !bucket.positive}
                                                                    className="text-[11px]"
                                                                >
                                                                    {item}
                                                                </SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </section>

                <section className="rounded border border-slate-800/80 bg-slate-900/30 p-2.5">
                    <div className="mb-2 text-[11px] font-semibold uppercase text-slate-400">Active Rule Summary</div>
                    <div className="grid gap-2 sm:grid-cols-2">
                        <SummaryItem label="config_epoch" value={serverRules.config_epoch ?? "--"} />
                        <SummaryItem label="rules_hash" value={serverHash ?? "--"} />
                        <SummaryItem label="lateChase" value={serverRules.global_structure_rules.lateChase} />
                        <SummaryItem label="extendedBreakoutWithoutPullback" value={serverRules.global_structure_rules.extendedBreakoutWithoutPullback} />
                        <SummaryItem label="prior buckets" value={`LIVE ${autoTraderStatus?.activeCandidatePromotionSummary?.live_prior_bucket_count ?? 0} / SHADOW ${autoTraderStatus?.activeCandidatePromotionSummary?.shadow_prior_bucket_count ?? 0}`} />
                        <SummaryItem label="browser draft" value={draftMatchesServer ? "matches saved server rules" : "does not match saved server rules"} />
                    </div>
                </section>

                {showOpportunityDrawer && (
                    <section className="rounded border border-slate-800/80 bg-slate-900/30 p-2.5">
                        <div className="mb-2 flex items-center justify-between gap-2">
                            <div>
                                <div className="text-[11px] font-semibold uppercase text-slate-400">Opportunity Explanation Drawer</div>
                                <div className="text-[10px] text-slate-500">{opportunityList.length} current-run opportunities</div>
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            {opportunityList.length === 0 && (
                                <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-2 text-slate-500">
                                    Run analysis to populate opportunity explanations.
                                </div>
                            )}
                            {opportunityList.slice(0, 20).map(opportunity => (
                                <button
                                    key={`${opportunity.symbol}-${opportunity.side}-${opportunity.playbook ?? "NO_PLAYBOOK"}`}
                                    type="button"
                                    onClick={() => setSelectedOpportunity(opportunity)}
                                    className="flex w-full items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5 text-left hover:border-slate-600 hover:bg-slate-900"
                                >
                                    <span className="min-w-0">
                                        <span className="block truncate font-mono text-slate-100">{opportunity.symbol} · {opportunity.side} · {opportunity.playbook ?? "NO_PLAYBOOK"}</span>
                                        <span className="block truncate text-[10px] text-slate-500">{explainTradeOutcome(opportunity)}</span>
                                    </span>
                                    <span className="flex shrink-0 items-center gap-1.5">
                                        <Badge variant="outline" className={statusClass(opportunity.status)}>{opportunity.status}</Badge>
                                        <Eye className="h-3.5 w-3.5 text-slate-400" />
                                    </span>
                                </button>
                            ))}
                        </div>
                    </section>
                )}
            </div>

            <Sheet open={!!selectedOpportunity} onOpenChange={open => !open && setSelectedOpportunity(null)}>
                <SheetContent side="right" className="w-[400px] sm:w-[520px] overflow-y-auto border-slate-800 bg-slate-950 text-slate-100">
                    <SheetHeader>
                        <SheetTitle className="text-slate-100">
                            {selectedOpportunity?.symbol ?? "Opportunity"}
                        </SheetTitle>
                        <SheetDescription className="text-slate-400">
                            {selectedOpportunity ? `${selectedOpportunity.side} · ${selectedOpportunity.playbook ?? "NO_PLAYBOOK"}` : ""}
                        </SheetDescription>
                    </SheetHeader>
                    {selectedOpportunity && (
                        <OpportunityExplanation opportunity={selectedOpportunity} />
                    )}
                </SheetContent>
            </Sheet>
        </div>
    );
}

function RuleSelect({
    label,
    value,
    onValueChange
}: {
    label: string;
    value: CandidateStructureRule;
    onValueChange: (value: CandidateStructureRule) => void;
}) {
    return (
        <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-2">
            <span className="block min-w-0 text-[11px] font-medium text-slate-200">{label}</span>
            <Select value={value} onValueChange={item => onValueChange(item as CandidateStructureRule)}>
                <SelectTrigger className="mt-1.5 h-8 w-full border-slate-700 bg-slate-950 text-[11px] text-slate-100">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                    {STRUCTURE_RULES.map(item => (
                        <SelectItem key={item} value={item} className="text-[11px]">
                            {item}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

function BooleanRule({
    label,
    checked,
    onCheckedChange
}: {
    label: string;
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
}) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5">
            <span className="min-w-0 text-[11px] font-medium text-slate-200">{label}</span>
            <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-slate-500">{checked ? "on" : "off"}</span>
                <Switch
                    checked={checked}
                    onCheckedChange={onCheckedChange}
                    className="scale-75 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                />
            </div>
        </div>
    );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5">
            <div className="text-[10px] uppercase text-slate-500">{label}</div>
            <div className="mt-0.5 break-all font-mono text-[11px] text-slate-100">{value}</div>
        </div>
    );
}

function OpportunityExplanation({ opportunity }: { opportunity: OpportunityDiagnostic }) {
    const flags = opportunity.structure_flags;
    const reasons = opportunity.reasons ?? [];
    const executionReasons = opportunity.executionBlockReasons ?? [];

    return (
        <div className="mt-6 space-y-4 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
                <SummaryItem label="path_quality" value={opportunity.path_quality ?? "--"} />
                <SummaryItem label="policy_outcome" value={opportunity.policy_outcome ?? "--"} />
                <SummaryItem label="final status" value={opportunity.status ?? "--"} />
                <SummaryItem label="matched_prior_bucket" value={opportunity.matched_prior_bucket ?? "--"} />
                <SummaryItem label="promotion_reason" value={opportunity.promotion_reason ?? "--"} />
                <SummaryItem label="demotion_reason" value={opportunity.demotion_reason ?? "--"} />
            </div>

            <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
                <div className="mb-2 text-[11px] font-semibold uppercase text-slate-400">Structure Flags</div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                    {[
                        ["is_late_chase", flags?.is_late_chase],
                        ["is_fresh_continuation", flags?.is_fresh_continuation],
                        ["is_pullback_continuation", flags?.is_pullback_continuation],
                        ["is_extended_breakout", flags?.is_extended_breakout]
                    ].map(([label, value]) => (
                        <div key={String(label)} className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/60 px-2 py-1">
                            <span className="font-mono text-[11px] text-slate-300">{label}</span>
                            <Badge variant="outline" className={value ? "border-emerald-500/40 text-emerald-300" : "border-slate-700 text-slate-500"}>
                                {value ? "true" : "false"}
                            </Badge>
                        </div>
                    ))}
                </div>
            </div>

            <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase text-slate-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Why Traded / Not Traded
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-2 text-slate-300">
                    {explainTradeOutcome(opportunity)}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                    {[...executionReasons, ...reasons].slice(0, 14).map(reason => (
                        <Badge key={reason} variant="outline" className="border-slate-700 text-slate-300">
                            {formatLabel(reason)}
                        </Badge>
                    ))}
                </div>
            </div>
        </div>
    );
}

function explainTradeOutcome(opportunity: OpportunityDiagnostic): string {
    if (opportunity.demotion_reason) return `Demoted to near miss: ${formatLabel(opportunity.demotion_reason)}`;
    if (opportunity.promotion_reason && opportunity.status === "CANDIDATE") {
        return `Promoted to candidate: ${formatLabel(opportunity.promotion_reason)}`;
    }
    if (opportunity.status === "CANDIDATE") return "Candidate remained eligible under current rules.";
    if (opportunity.executionTradeable === false && opportunity.executionBlockReasons.length > 0) {
        return `Not traded: ${opportunity.executionBlockReasons.map(formatLabel).join(", ")}`;
    }
    if (opportunity.reasons.length > 0) return `Not traded: ${opportunity.reasons.map(formatLabel).join(", ")}`;
    return "No trade decision was produced for this opportunity.";
}

function formatAction(value: PlaybookOverrideMode): string {
    if (value === "off") return "Off";
    if (value === "enabled") return "Enabled";
    if (value === "near_miss_only") return "Near-miss only";
    return "Disabled";
}

function formatRequirement(value: CandidatePromotionStructureRequirement): string {
    return value === "fresh_continuation" ? "fresh" : "pullback";
}

function formatPriorSourceTime(value?: string | null): string {
    if (!value) return "--";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "--";
    return parsed.toLocaleString();
}

function formatLabel(value: string): string {
    return value.replace(/_/g, " ").replace(/:/g, " ").toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

function statusClass(status: string): string {
    if (status === "CANDIDATE") return "border-emerald-500/40 text-emerald-300 bg-emerald-500/10";
    if (status === "NEAR_MISS") return "border-amber-500/40 text-amber-300 bg-amber-500/10";
    if (status === "EXECUTION_BLOCKED") return "border-red-500/40 text-red-300 bg-red-500/10";
    return "border-slate-700 text-slate-400";
}
