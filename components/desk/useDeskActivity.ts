"use client";
import { useEffect, useState } from "react";
import type { DeskActivity } from "@/lib/desk/activity-types";

export function useDeskActivity(bookId: string, testnet: boolean) {
    const [data, setData] = useState<DeskActivity | null>(null);
    const [lastSuccess, setLastSuccess] = useState(0);
    const [now, setNow] = useState(Date.now());
    const [error, setError] = useState("");
    const [visible, setVisible] = useState(true);
    useEffect(() => {
        let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
        let controller: AbortController | null = null;
        setData(null); setLastSuccess(0); setError("");
        const poll = async () => {
            if (disposed || document.hidden || controller) return;
            const request = new AbortController();
            controller = request;
            const timeout = setTimeout(() => {
                if (!disposed && !request.signal.aborted) {
                    setError("Live activity request timed out");
                    request.abort();
                }
            }, 8000);
            try {
                const params = new URLSearchParams({ bookId, network: testnet ? "testnet" : "mainnet" });
                const response = await fetch("/api/desk/activity?" + params, { signal: request.signal, cache: "no-store" });
                const next = await response.json();
                if (disposed || request.signal.aborted) return;
                if (!response.ok) {
                    if ([401, 403, 404].includes(response.status)) setData(null);
                    throw new Error(next.error || "Activity unavailable");
                }
                if (next.bookId !== bookId || !Array.isArray(next.analysts) || !Number.isFinite(Date.parse(next.serverTime)))
                    throw new Error("Activity context changed");
                setData(next); setLastSuccess(Date.now()); setError("");
            } catch (failure) {
                if (!disposed && !request.signal.aborted) setError(failure instanceof Error ? failure.message : "Activity unavailable");
            } finally {
                clearTimeout(timeout);
                if (controller === request) {
                    controller = null;
                    if (!disposed && !document.hidden) timer = setTimeout(poll, 2000);
                }
            }
        };
        const visibility = () => {
            setVisible(!document.hidden);
            clearTimeout(timer);
            controller?.abort(); controller = null;
            if (!document.hidden) void poll();
        };
        setVisible(!document.hidden);
        document.addEventListener("visibilitychange", visibility);
        void poll();
        const clock = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
        return () => {
            disposed = true; controller?.abort(); clearTimeout(timer); clearInterval(clock);
            document.removeEventListener("visibilitychange", visibility);
        };
    }, [bookId, testnet]);
    const age = Math.max(0, now - lastSuccess);
    const fresh = visible && lastSuccess > 0 && age < 8000 && !error;
    const leaseValid = !data?.shift?.active || (!!data.shift.leaseUntil &&
        Date.parse(data.shift.leaseUntil) > Date.parse(data.serverTime) + age);
    return { data, fresh: fresh && leaseValid, error, visible, lastSuccess };
}
