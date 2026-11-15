/** Slow analytical downloads share one paced lane per network. Execution never
 * enters this queue, so research cannot delay protective orders or reconciliation. */
export class ResearchReadQueue {
    private tail: Promise<void> = Promise.resolve();
    private lastStarted = 0;
    constructor(private readonly spacingMs = 250) {}
    run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const result = this.tail.catch(() => {}).then(async () => {
            signal?.throwIfAborted();
            const wait = this.spacingMs - (Date.now() - this.lastStarted);
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
            signal?.throwIfAborted();
            this.lastStarted = Date.now();
            return work();
        });
        this.tail = result.then(() => {}, () => {});
        return result;
    }
}
const queues = [new ResearchReadQueue(), new ResearchReadQueue()];
export const deferredResearchRead = <T>(testnet: boolean, work: () => Promise<T>, signal?: AbortSignal) =>
    queues[Number(testnet)].run(work, signal);
