/** Tool waits do not spend the parent model's budget. The wall deadline still
 * bounds stalled tools and serial consultations, including overlapping calls. */
export function turnDeadline(modelMs: number, wallMs: number, fail: (reason: "model" | "wall") => void) {
    let remaining = modelMs, runningSince = performance.now(), waiting = 0, disposed = false;
    let modelTimer: ReturnType<typeof setTimeout>;
    const expire = (reason: "model" | "wall") => {
        if (disposed) return;
        dispose();
        fail(reason);
    };
    const arm = () => {
        runningSince = performance.now();
        modelTimer = setTimeout(() => expire("model"), Math.max(0, remaining));
    };
    const wallTimer = setTimeout(() => expire("wall"), wallMs);
    const dispose = () => {
        disposed = true;
        clearTimeout(modelTimer);
        clearTimeout(wallTimer);
    };
    arm();
    return {
        pause() {
            if (disposed) return () => {};
            if (waiting++ === 0) {
                remaining -= performance.now() - runningSince;
                clearTimeout(modelTimer);
            }
            let released = false;
            return () => {
                if (released || disposed) return;
                released = true;
                if (--waiting === 0) arm();
            };
        },
        dispose,
    };
}
