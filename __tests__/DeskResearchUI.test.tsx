import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Backtester } from "@/components/Backtester";
const context = vi.hoisted(() => ({
  walletSessionAddress: "owner",
  isTestnet: true,
}));
vi.mock("@/context/TradingContext", () => ({ useTrading: () => context }));
const reply = (data: unknown) =>
  Promise.resolve({ ok: true, json: async () => data } as Response);
beforeEach(() => {
  context.walletSessionAddress = "owner";
  context.isTestnet = true;
  vi.mocked(fetch)
    .mockReset()
    .mockImplementation((url, options) => {
      if (String(url).startsWith("/api/desk?"))
        return reply({
          books: [
            {
              id: "paper",
              ownerAddress: "owner",
              accountAddress: "owner",
              isTestnet: true,
              kind: "directional",
              version: 2,
            },
            {
              id: "foreign",
              ownerAddress: "someone",
              accountAddress: "someone",
              isTestnet: true,
            },
          ],
        });
      if (options?.method === "POST") return reply({ runId: "job-one" });
      if (String(url).includes("runId="))
        return reply({ runId: "job-one", status: "queued" });
      return reply({ runs: [] });
    });
});
describe("desk research workspace", () => {
  it("requires authentication before listing research", () => {
    context.walletSessionAddress = "";
    render(<Backtester />);
    expect(screen.getByText(/Connect and authenticate/)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("queues network-scoped explicit rules without allowing mandate changes", async () => {
    render(<Backtester />);
    await screen.findByLabelText("Trading hypothesis");
    expect(
      screen.getAllByRole("option", { name: /Paper \/ testnet/ }),
    ).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Trading hypothesis"), {
      target: { value: "Momentum follows a liquidity expansion" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Queue desk experiment" }),
    );
    await screen.findByRole("heading", { name: /Run job-one.*queued/ });
    const post = vi
      .mocked(fetch)
      .mock.calls.find(([, options]) => options?.method === "POST")!;
    const body = JSON.parse(String(post[1]!.body));
    expect(body).toMatchObject({
      bookId: "paper",
      request: {
        instrumentIds: ["testnet:perp:BTC"],
        engine: "candles", source: "venue_candles", variants: [{ signal: "trend_pullback" }],
      },
    });
    expect(body.request.mandate).toBeUndefined();
  });
  it("discards old network history when the wallet changes network", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Backtester />);
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal;
    context.isTestnet = false;
    view.rerender(<Backtester />);
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () => {
      finish(
        await reply({
          books: [
            {
              id: "late",
              ownerAddress: "owner",
              accountAddress: "owner",
              isTestnet: true,
              kind: "directional",
            },
          ],
        }),
      );
    });
    expect(
      screen.queryByLabelText("Trading hypothesis"),
    ).not.toBeInTheDocument();
  });
});
