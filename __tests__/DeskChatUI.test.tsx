import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeskChat } from "@/components/desk/DeskChat";
import type { Book } from "@/components/desk/desk-view";

const book = { id: "chat-book", enabled: false, isTestnet: true } as Book;
afterEach(() => { vi.unstubAllGlobals(); });
function draft() { fireEvent.change(screen.getByLabelText("Message to the desk"), { target: { value: "Why did we pass on AVAX?" } }); }

describe("chat delivery", () => {
    it("sends on HTTP where randomUUID is unavailable and reuses the request ID after a rejected attempt", async () => {
        const getRandomValues = crypto.getRandomValues.bind(crypto);
        vi.stubGlobal("crypto", { getRandomValues });
        const act = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        render(<DeskChat book={book} chat={[]} busy={false} act={act} />);
        draft();
        fireEvent.click(screen.getByRole("button", { name: "Send research request" }));
        await screen.findByRole("alert");
        expect(screen.getByLabelText("Message to the desk")).toHaveValue("Why did we pass on AVAX?");
        fireEvent.click(screen.getByRole("button", { name: "Send research request" }));
        await screen.findByText(/Sent to the desk/);
        expect(act).toHaveBeenCalledTimes(2);
        expect(act.mock.calls[0][0]).toMatchObject({ kind: "research", requestId: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) });
        expect(act.mock.calls[1][0].requestId).toBe(act.mock.calls[0][0].requestId);
        expect(screen.getByLabelText("Message to the desk")).toHaveValue("");
    });
    it("reports client failures beside the preserved draft instead of silently dropping send", async () => {
        vi.stubGlobal("crypto", { getRandomValues: () => { throw new Error("Browser could not create a message ID."); } });
        const act = vi.fn();
        render(<DeskChat book={book} chat={[]} busy={false} act={act} />);
        draft();
        fireEvent.click(screen.getByRole("button", { name: "Send research request" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Browser could not create a message ID.");
        expect(act).not.toHaveBeenCalled();
        expect(screen.getByLabelText("Message to the desk")).toHaveValue("Why did we pass on AVAX?");
        expect(screen.getByRole("button", { name: "Send research request" })).toBeEnabled();
    });
    it("prevents duplicate submissions while a request is in flight and displays rejected network errors", async () => {
        let reject!: (error: Error) => void;
        const act = vi.fn(() => new Promise<boolean>((_, fail) => { reject = fail; }));
        render(<DeskChat book={book} chat={[]} busy={false} act={act} />);
        draft();
        const form = screen.getByLabelText("Message to the desk").closest("form")!;
        fireEvent.submit(form);
        fireEvent.submit(form);
        expect(act).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText("Message to the desk")).toBeDisabled();
        reject(new Error("Connection lost. Try again."));
        expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost. Try again.");
        await waitFor(() => expect(screen.getByLabelText("Message to the desk")).toBeEnabled());
    });
});

