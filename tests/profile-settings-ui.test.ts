import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it, vi } from "vitest";

const root = path.resolve(__dirname, "..", "com.bad-duck.teamscontrol.sdPlugin", "ui");

async function inspector(page: string, initial: Record<string, unknown>, fail = false) {
	type Handler = () => Promise<void>;
	const elements = new Map<string, {
		textContent: string; checked: boolean; disabled: boolean; handlers: Map<string, Handler>;
		addEventListener: (event: string, handler: Handler) => void;
	}>();
	const scripts: string[] = [];
	function visit(node: DefaultTreeAdapterTypes.Node): void {
		if ("attrs" in node) {
			const id = node.attrs.find((attribute) => attribute.name === "id")?.value;
			if (id) {
				const handlers = new Map<string, Handler>();
				elements.set(id, {
					textContent: "", checked: false, disabled: true, handlers,
					addEventListener: (event, handler) => { handlers.set(event, handler); }
				});
			}
			const src = node.tagName === "script"
				? node.attrs.find((attribute) => attribute.name === "src")?.value : undefined;
			if (src === "profile-settings.js") scripts.push(readFileSync(path.join(root, src), "utf8"));
		}
		if ("childNodes" in node) node.childNodes.forEach(visit);
	}
	visit(parse(readFileSync(path.join(root, `${page}.html`), "utf8")));
	if (scripts.length !== 1) throw new Error(`Missing profile status script in ${page}`);
	let receive: (event: { payload: Record<string, unknown> }) => void = () => {};
	const get = fail ? vi.fn().mockRejectedValue(new Error("disconnected")) : vi.fn().mockResolvedValue(initial);
	const send = vi.fn().mockResolvedValue(undefined);
	vm.runInNewContext(scripts[0], {
		document: { getElementById: (id: string) => elements.get(id) },
		SDPIComponents: { streamDeckClient: {
			getConnectionInfo: get, send,
			sendToPropertyInspector: { subscribe: (fn: typeof receive) => { receive = fn; } }
		} }
	});
	await Promise.resolve();
	await Promise.resolve();
	const status = elements.get("profile-status");
	if (!status) throw new Error(`Missing profile status element in ${page}`);
	const following = elements.get("profile-following");
	if (!following) throw new Error(`Missing profile following control in ${page}`);
	const update = (payload: Record<string, unknown>) => {
		receive({ payload: { event: "profile-following-status", loaded: true, ...payload } });
	};
	if (!fail) update(initial);
	return {
		status, following, send, update,
		change: async (enabled: boolean) => {
			following.checked = enabled;
			await following.handlers.get("change")?.();
		}
	};
}

describe("profile following inspector", () => {
	it.each(["default", "ppt", "ppt-stop"])("shows persistent pauses and explicit retry instructions in %s", async (page) => {
		const ui = await inspector(page, { enabled: true, paused: true });
		expect(ui.status.textContent).toContain("paused");
		expect(ui.status.textContent).toContain("off and on to retry");
		await ui.change(false);
		expect(ui.send).toHaveBeenLastCalledWith("sendToPlugin", {
			event: "profile-following-set", enabled: false
		});
		ui.update({ enabled: false, paused: true });
		expect(ui.status.textContent).toBe("");
		ui.update({ enabled: true, paused: true });
		expect(ui.status.textContent).toContain("paused");
		ui.update({ enabled: true, paused: false });
		expect(ui.status.textContent).toBe("");
		expect(ui.following.checked).toBe(true);
		expect(ui.send).toHaveBeenCalledTimes(2);
	});

	it("surfaces an unavailable settings connection", async () => {
		const ui = await inspector("ppt", {}, true);
		expect(ui.status.textContent).toContain("Could not read profile status: Error: disconnected");
	});

	it("shows plugin errors and keeps explicit retry guidance", async () => {
		const ui = await inspector("ppt", { enabled: true, paused: true, error: "Could not confirm layout" });
		expect(ui.status.textContent).toContain("Could not confirm layout");
		expect(ui.status.textContent).toContain("off and on to retry");
	});

	it("surfaces a failed user-setting request without leaving the toggle disabled", async () => {
		const ui = await inspector("default", { enabled: false, paused: false });
		ui.send.mockRejectedValue(new Error("disconnected"));
		await ui.change(true);
		expect(ui.status.textContent).toContain("Could not contact the plugin: Error: disconnected");
		expect(ui.following.disabled).toBe(false);
	});
});
