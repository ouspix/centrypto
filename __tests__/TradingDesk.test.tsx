import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/components/desk/DeskOffice", () => ({ DeskOffice: () => <section aria-label="Live analyst office" /> }));
import { TradingDesk } from "@/components/desk/TradingDesk";
import { DEFAULT_DESK_MANDATE } from "@/lib/desk/mandate";
import type { Overview } from "@/components/desk/desk-view";

const initial="0x"+"a".repeat(40), other="0x"+"b".repeat(40);
const account=vi.hoisted(()=>({wallet:null as string|null, testnet:true}));
vi.mock("@/context/TradingContext",()=>({useTrading:()=>({walletSessionAddress:account.wallet,isTestnet:account.testnet})}));
const book={id:"book-a",kind:"directional" as const,ownerAddress:initial,accountAddress:initial,isTestnet:true,version:4,enabled:false,heartbeatAt:null,lastError:null,
    mandateJson:JSON.stringify(DEFAULT_DESK_MANDATE),frequencySeconds:600};
function snapshot():Overview {return {book,books:[book],killSwitch:false,records:[],shifts:[],watches:[],state:{metrics:null,inventory:[],intents:[],fills:[],pairs:[]}};}
const response=(o:unknown)=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(o)} as Response);
beforeEach(()=>{account.wallet=initial;account.testnet=true;vi.mocked(fetch).mockReset();});
describe("desk operator station",()=>{
    it("puts the desk navigation above the book and opens the simulation as its own view", async () => {
        vi.mocked(fetch).mockImplementation(() => response(snapshot()));
        render(<TradingDesk />);

        const nav = await screen.findByRole("navigation", { name: "Desk tools" });
        const simulation = within(nav).getByRole("button", { name: "Desk simulation" });
        const bookHeading = screen.getByRole("heading", { name: "Directional book" });
        expect(nav.compareDocumentPosition(bookHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(simulation).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("region", { name: "Live analyst office" })).toBeVisible();

        fireEvent.click(within(nav).getByRole("button", { name: "Chat" }));
        expect(screen.getByRole("region", { name: "Desk chat" })).toBeVisible();
        expect(screen.queryByRole("region", { name: "Live analyst office" })).not.toBeInTheDocument();

        fireEvent.click(simulation);
        expect(simulation).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("region", { name: "Live analyst office" })).toBeVisible();
    });

    it("keeps the send rejection visible after the activity refresh succeeds", async () => {
        vi.mocked(fetch).mockImplementation(async (_, init) => init?.method === "POST"
            ? { ok: false, status: 403, json: async () => ({ error: "Cross-origin desk request denied." }) } as Response
            : response(snapshot()));
        vi.useFakeTimers();
        try {
            await act(async () => { render(<TradingDesk/>); });
            fireEvent.click(screen.getByRole("button", { name: "Chat" }));
            fireEvent.change(screen.getByLabelText("Message to the desk"), { target: { value: "what happened with INIT" } });
            await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send research request" })); });
            await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
            expect(screen.getByLabelText("Message to the desk")).toHaveValue("what happened with INIT");
            expect(within(screen.getByRole("region", { name: "Desk chat" })).getByRole("alert")).toHaveTextContent("Cross-origin desk request denied.");
        } finally { vi.useRealTimers(); }
    });

    it("only fetches for a verified session and drops an old wallet's late reply",async()=>{
        const callbacks:Array<()=>void>=[];
        vi.mocked(fetch).mockImplementation(()=>new Promise(r=>callbacks.push(()=>{void response(snapshot()).then(r);})));
        account.wallet=null;
        const view=render(<TradingDesk/>);expect(screen.getByText(/Verify your wallet session/)).toBeVisible();expect(fetch).not.toHaveBeenCalled();
        account.wallet=initial;view.rerender(<TradingDesk/>);
        await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
        account.wallet=other;view.rerender(<TradingDesk/>);
        await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
        await act(async()=>{callbacks[0]();});
        expect(screen.queryByRole("heading",{name:"Directional book"})).not.toBeInTheDocument();
    });
    it("submits research with its own idempotency key and keeps live instructions disabled for a stopped book",async()=>{
        const posts:Record<string,unknown>[]=[];
        vi.mocked(fetch).mockImplementation(async(_,init)=>{if(init?.method==="POST"){posts.push(JSON.parse(String(init.body)));return response({ok:true,bookId:book.id});}return response(snapshot());});
        render(<TradingDesk/>);
        fireEvent.click(await screen.findByRole("button",{name:"Chat"}));
        expect(await screen.findByRole("option",{name:"Trading instruction"})).toBeDisabled();
        fireEvent.change(screen.getByLabelText("Message to the desk"),{target:{value:"Review unusual funding"}});
        fireEvent.click(screen.getByRole("button",{name:"Send research request"}));
        await screen.findByText("Message queued for the desk.");
        expect(posts).toEqual([{action:"message",bookId:"book-a",kind:"research",message:"Review unusual funding",requestId:expect.stringMatching(/^[0-9a-f-]{36}$/i)}]);
    });
    it("shows the saved conversation and full answer even when absent from the activity feed", async () => {
        const data = snapshot();
        data.chat = [{ message: { id: 1, role: "operator", kind: "message", shiftId: null, createdAt: "2026-11-09T23:34:59Z", dataJson: JSON.stringify({ message: "Did we miss AVAX?" }) },
            reply: { id: 2, role: "lead", kind: "note", shiftId: "answer", createdAt: "2026-11-09T23:36:00Z", dataJson: JSON.stringify({ summary: "No orders were placed.", thesis: "The news arrived promptly.", dissent: "Our filters kept us out of the rally." }) }, status: "answered" }];
        vi.mocked(fetch).mockImplementation(() => response(data));
        render(<TradingDesk/>);
        fireEvent.click(await screen.findByRole("button", { name: "Chat" }));
        expect(within(screen.getByRole("log", { name: "Messages" })).getByText("Did we miss AVAX?")).toBeVisible();
        expect(screen.getByText("The news arrived promptly.")).toBeVisible();
        expect(screen.getByText(/Our filters kept us out/)).toBeVisible();
        expect(screen.getByText("Answered")).toBeVisible();
    });
    it("saves a mandate without enabling the book, and sends a distinct versioned enable action",async()=>{
        const posts:Record<string,unknown>[]=[];
        vi.mocked(fetch).mockImplementation(async(_,init)=>{if(init?.method==="POST"){posts.push(JSON.parse(String(init.body)));return response({ok:true,bookId:book.id});}return response(snapshot());});
        render(<TradingDesk/>);fireEvent.click(await screen.findByRole("button",{name:"Controls"}));
        fireEvent.change(screen.getByLabelText("Maximum order ($)"),{target:{value:"75"}});
        fireEvent.click(screen.getByRole("button",{name:"Save mandate"}));
        await screen.findByText("Desk updated.");
        expect(posts[0]).toMatchObject({action:"configure",bookId:"book-a",version:4,mandate:{maxOrderUsd:75}});
        expect(posts[0]).not.toHaveProperty("enabled");
        fireEvent.click(screen.getByRole("button",{name:"Activate paper trading (testnet)"}));
        await waitFor(()=>expect(posts).toHaveLength(2));
        expect(posts[1]).toEqual({action:"configure",bookId:"book-a",version:4,enabled:true});
    });
    it("clears drafts across network changes and displays the role's evidence and dissent",async()=>{
        const data=snapshot();data.records.push({id:1,role:"risk",kind:"note",shiftId:"shift",createdAt:"2026-11-02T08:00:00Z",
            dataJson:JSON.stringify({summary:"Position concentration increased",dissent:"The new leg leaves the book exposed",evidenceIds:["event-12"]})});
        vi.mocked(fetch).mockImplementation(async url=>response(String(url).includes("mainnet")?{...snapshot(),book:null,books:[]}:data));
        const view=render(<TradingDesk/>);fireEvent.click(await screen.findByRole("button",{name:"Journal"}));
        expect(screen.getByText("Position concentration increased")).toBeVisible();
        expect(screen.getByText(/The new leg leaves the book exposed/)).toBeVisible();
        expect(screen.getByText(/event-12/)).toBeVisible();
        fireEvent.click(screen.getByRole("button",{name:"Chat"}));
        fireEvent.change(screen.getByLabelText("Message to the desk"),{target:{value:"wallet-private research question"}});
        account.testnet=false;view.rerender(<TradingDesk/>);
        await screen.findByRole("heading",{name:"Create a stopped book"});
        expect(screen.queryByDisplayValue("wallet-private research question")).not.toBeInTheDocument();
        expect(screen.queryByText("Position concentration increased")).not.toBeInTheDocument();
    });
});
