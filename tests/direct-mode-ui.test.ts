import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it, vi } from "vitest";
import { renderDirectMode } from "../src/icons";

const root = path.resolve(__dirname, "..", "com.bad-duck.teamscontrol.sdPlugin");
const html = readFileSync(path.join(root, "ui", "direct-mode.html"), "utf8");

async function inspector() {
	type Handler = (event: { preventDefault: () => void; currentTarget: { href: string } }) => void | Promise<void>;
	const elements = new Map<string, {
		value: string; textContent: string; disabled: boolean; href: string;
		handlers: Map<string, Handler>; addEventListener: (event: string, handler: Handler) => void;
		reportValidity: () => boolean;
	}>();
	for (const id of ["port", "save", "toggle", "refresh", "status", "error", "guide", "action-description"]) {
		const handlers = new Map<string, Handler>();
		elements.set(id, {
			value: "9457", textContent: "", disabled: false,
			href: "https://github.com/danswett/streamdeck-teams-control/blob/main/docs/direct-mode.md",
			handlers, addEventListener: (event, handler) => { handlers.set(event, handler); },
			reportValidity: () => true
		});
	}
	let receive: (event: { payload: Record<string, unknown> }) => void = () => {};
	const send = vi.fn().mockResolvedValue(undefined);
	const sandbox = {
		document: { getElementById: (id: string) => elements.get(id) },
		SDPIComponents: { streamDeckClient: {
			send, sendToPropertyInspector: { subscribe: (fn: typeof receive) => { receive = fn; } },
			getConnectionInfo: async () => ({ actionInfo: { action: "com.bad-duck.teamscontrol.direct-mode" } })
		} }
	};
	const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
	if (!script) throw new Error("Missing inspector script");
	vm.runInNewContext(script, sandbox);
	await Promise.resolve();
	const element = (id: string) => {
		const node = elements.get(id);
		if (!node) throw new Error(`Unknown element ${id}`);
		return node;
	};
	return {
		element, send,
		status: (payload: Record<string, unknown>) => receive({ payload: { event: "direct-mode-status", ...payload } }),
		click: (id: string) => element(id).handlers.get("click")?.({
			preventDefault: vi.fn(), currentTarget: element(id)
		}),
		edit: (value: string) => {
			element("port").value = value;
			element("port").handlers.get("input")?.({ preventDefault: vi.fn(), currentTarget: element("port") });
		}
	};
}

describe("Direct Mode property inspector", () => {
	it("saves the specified shared port and toggles through plugin messages", async () => {
		const ui = await inspector();
		ui.edit("12345");
		await ui.click("save");
		expect(ui.send).toHaveBeenLastCalledWith("sendToPlugin", { event: "direct-mode-port", port: 12345 });
		await ui.click("toggle");
		expect(ui.send).toHaveBeenLastCalledWith("sendToPlugin", { event: "direct-mode-toggle" });
	});

	it("links the explanatory hint to the Direct-mode guide in the default browser", async () => {
		const ui = await inspector();
		expect(html).toContain('href="https://github.com/danswett/streamdeck-teams-control/blob/main/docs/direct-mode.md"');
		await ui.click("guide");
		expect(ui.send).toHaveBeenLastCalledWith("openUrl", {
			url: "https://github.com/danswett/streamdeck-teams-control/blob/main/docs/direct-mode.md"
		});
	});

	it("shows shared state and errors without overwriting an unsaved port edit", async () => {
		const ui = await inspector();
		ui.status({ enabled: true, port: 12345, usable: false, supported: true, reason: "no meeting", error: "" });
		expect(ui.element("port").value).toBe("12345");
		expect(ui.element("status").textContent).toContain("Enabled but unavailable: no meeting");
		ui.edit("54321");
		ui.status({ enabled: true, port: 12345, usable: true, supported: true, reason: "connected", error: "save failed" });
		expect(ui.element("port").value).toBe("54321");
		expect(ui.element("status").textContent).toBe("Active: connected");
		expect(ui.element("error").textContent).toBe("save failed");
	});

	it("surfaces inspector transport failures", async () => {
		const ui = await inspector();
		ui.send.mockRejectedValue(new Error("disconnected"));
		await ui.click("guide");
		expect(ui.element("error").textContent).toContain("Could not open the guide");
	});
});

describe("Direct Mode key states", () => {
	it.each([
		[false, false, "OFF"], [true, false, "WAITING"], [true, true, "ACTIVE"]
	] as const)("renders enabled=%s usable=%s as %s", (enabled, usable, label) => {
		const svg = renderDirectMode(enabled, usable);
		expect(svg).toContain(`>${label}</text>`);
		expect(new Resvg(svg).render().asPng().length).toBeGreaterThan(100);
	});
});
